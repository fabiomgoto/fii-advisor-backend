'use strict';

const axios = require('axios');
const pool  = require('../db/connection');
const { fetchFundsExplorer, fetchStatusInvest } = require('../engine/fii-enricher');

const SCRAPE_TIMEOUT_MS = 8_000;

// ── Timeout helper ────────────────────────────────────────────────────────────

function timeoutPromise(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), ms)
  );
}

function withTimeout(promise) {
  return Promise.race([promise, timeoutPromise(SCRAPE_TIMEOUT_MS)]);
}

// ── Fundamentus scraper (terceira fonte) ──────────────────────────────────────

async function scrapeFundamentus(ticker) {
  const { data: raw } = await axios.get(
    `https://fundamentus.com.br/detalhes.php?papel=${ticker}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Referer': 'https://fundamentus.com.br/',
      },
      timeout: SCRAPE_TIMEOUT_MS,
      responseType: 'arraybuffer',
    }
  );

  const html = Buffer.from(raw).toString('latin1');
  const safeF = (s) => { const v = parseFloat(String(s).replace(',', '.')); return isNaN(v) ? null : v; };

  const pvpM  = html.match(/P\/VP<\/span>[^<]*<\/td>\s*<td[^>]*>\s*([\d,.]+)/i);
  const dyM   = html.match(/Div\. Yield<\/span>[^<]*<\/td>\s*<td[^>]*>\s*([\d,.]+)\s*%/i);
  const liqM  = html.match(/Liq\. 2 meses<\/span>[^<]*<\/td>\s*<td[^>]*>\s*([\d,.]+)/i);

  const pvp      = pvpM  ? safeF(pvpM[1])  : null;
  const dy_12m   = dyM   ? safeF(dyM[1])   : null;
  const liquidity = liqM ? safeF(liqM[1].replace(/\./g, '').replace(',', '.')) : null;

  // Cloudflare blocks return partial HTML without real data
  if (pvp == null && dy_12m == null && liquidity == null) {
    throw new Error('nenhum campo extraído — Cloudflare ou bloqueio');
  }

  return { pvp, dy_12m, liquidity, source: 'fundamentus' };
}

// ── Circuit breaker helpers ───────────────────────────────────────────────────

async function isSourceActive(source) {
  try {
    const { rows } = await pool.query(
      `SELECT is_active, disabled_until FROM scraping_source_status WHERE source = $1`,
      [source]
    );
    if (!rows.length) return true;
    const { is_active, disabled_until } = rows[0];
    if (!is_active && disabled_until && new Date(disabled_until) > new Date()) return false;
    // If disabled_until passed, re-enable automatically
    if (!is_active && (!disabled_until || new Date(disabled_until) <= new Date())) {
      await pool.query(
        `UPDATE scraping_source_status SET is_active = TRUE, disabled_until = NULL, fail_count = 0, updated_at = NOW() WHERE source = $1`,
        [source]
      );
    }
    return true;
  } catch (_) {
    return true; // if status table missing, assume active
  }
}

async function registerSuccess(source) {
  try {
    await pool.query(
      `UPDATE scraping_source_status
       SET fail_count = 0, is_active = TRUE, disabled_until = NULL,
           last_success_at = NOW(), updated_at = NOW()
       WHERE source = $1`,
      [source]
    );
  } catch (_) {}
}

async function registerFailure(source) {
  try {
    await pool.query(
      `UPDATE scraping_source_status
       SET fail_count = fail_count + 1, last_fail_at = NOW(), updated_at = NOW()
       WHERE source = $1`,
      [source]
    );
    const { rows } = await pool.query(
      `SELECT fail_count FROM scraping_source_status WHERE source = $1`, [source]
    );
    if (rows.length && rows[0].fail_count >= 3) {
      await pool.query(
        `UPDATE scraping_source_status
         SET is_active = FALSE, disabled_until = NOW() + INTERVAL '1 hour', updated_at = NOW()
         WHERE source = $1`,
        [source]
      );
      console.warn(`[DataProvider] ⚠️ fonte desativada por 1h: ${source}`);
    }
  } catch (_) {}
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

async function getFreshCache(ticker) {
  const { rows } = await pool.query(
    `SELECT dados FROM fii_enriched_cache
     WHERE ticker = $1 AND is_stale = FALSE
       AND versioned_at > NOW() - INTERVAL '24 hours'
     ORDER BY versioned_at DESC LIMIT 1`,
    [ticker]
  );
  return rows.length ? rows[0].dados : null;
}

async function getStaleCache(ticker) {
  const { rows } = await pool.query(
    `SELECT dados, versioned_at FROM fii_enriched_cache
     WHERE ticker = $1
       AND versioned_at > NOW() - INTERVAL '7 days'
     ORDER BY versioned_at DESC LIMIT 1`,
    [ticker]
  );
  return rows.length ? rows[0] : null;
}

async function saveToCache(ticker, dados, source) {
  await pool.query(
    `INSERT INTO fii_enriched_cache (ticker, dados, source, is_stale, versioned_at, updated_at)
     VALUES ($1, $2, $3, FALSE, NOW(), NOW())
     ON CONFLICT (ticker) DO UPDATE
       SET dados       = EXCLUDED.dados,
           source      = EXCLUDED.source,
           is_stale    = FALSE,
           stale_since = NULL,
           versioned_at = NOW(),
           updated_at  = NOW()`,
    [ticker, JSON.stringify(dados), source]
  );
}

// ── Scraping cascade ──────────────────────────────────────────────────────────

const SOURCES = [
  { name: 'funds_explorer', fn: (t) => fetchFundsExplorer(t) },
  { name: 'status_invest',  fn: (t) => fetchStatusInvest(t)  },
  { name: 'fundamentus',    fn: (t) => scrapeFundamentus(t)  },
];

async function tryLiveScraping(ticker) {
  for (const { name, fn } of SOURCES) {
    const active = await isSourceActive(name);
    if (!active) {
      console.log(`[DataProvider] ${name} desativado — pulando`);
      continue;
    }

    try {
      const data = await withTimeout(fn(ticker));
      if (!data) throw new Error('retornou null');

      console.log(`[DataProvider] scraping ${name} OK — ${ticker}`);
      await registerSuccess(name);
      await saveToCache(ticker, data, name);
      return { ...data, _source: name, _stale: false };
    } catch (e) {
      console.warn(`[DataProvider] scraping ${name} FAIL — ${ticker}: ${e.message}`);
      await registerFailure(name);
    }
  }
  return null;
}

// ── API pública ───────────────────────────────────────────────────────────────

async function getEnrichedData(ticker) {
  ticker = ticker.toUpperCase();

  // PASSO 1 — Cache fresco (<24h)
  try {
    const cached = await getFreshCache(ticker);
    if (cached) {
      console.log(`[DataProvider] cache fresco — ${ticker}`);
      return { ...cached, _source: 'cache', _stale: false };
    }
  } catch (e) {
    console.warn('[DataProvider] erro lendo cache fresco:', e.message);
  }

  // PASSO 2 — Scraping ao vivo (cascata)
  const live = await tryLiveScraping(ticker);
  if (live) return live;

  // PASSO 3 — Dados stale (até 7 dias)
  try {
    const stale = await getStaleCache(ticker);
    if (stale) {
      console.log(`[DataProvider] dados stale — ${ticker} (desde ${stale.versioned_at})`);
      await pool.query(
        `UPDATE fii_enriched_cache
         SET is_stale = TRUE, stale_since = versioned_at
         WHERE ticker = $1 AND versioned_at = $2`,
        [ticker, stale.versioned_at]
      );
      return { ...stale.dados, _source: 'stale_cache', _stale: true, _stale_since: stale.versioned_at };
    }
  } catch (e) {
    console.warn('[DataProvider] erro lendo cache stale:', e.message);
  }

  // PASSO 4 — sem dados
  return null;
}

async function getSourceStatus() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM scraping_source_status ORDER BY source`
    );
    return rows;
  } catch (_) {
    return [];
  }
}

module.exports = { getEnrichedData, getSourceStatus, registerSuccess, registerFailure };
