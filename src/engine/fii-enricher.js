/**
 * fii-enricher.js
 *
 * Enriquece dados de FIIs com campos que o brapi não fornece gratuitamente.
 *
 * Fontes (ordem de prioridade):
 *   1. FundsExplorer  — vacancy, properties, div_growth, liquidity, pvp, net_worth
 *   2. StatusInvest   — dy_12m, pvp, vacancy, liquidity, properties, wault (fallback)
 *   3. brapi dividends — div_growth calculado (fallback)
 *
 * Cache: tabela PostgreSQL fii_enriched_cache (TTL 24h)
 */

const axios = require('axios');
const pool  = require('../db/connection');

const CACHE_TTL_H = 24;
const BRAPI_TOKEN = process.env.BRAPI_TOKEN;

const delay    = (ms) => new Promise(r => setTimeout(r, ms));
const safeFloat = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };

/** Calcula div_growth a partir de dividendos brapi (últimos 3m vs 3m anteriores) */
function calcDivGrowth(dividends) {
  if (!Array.isArray(dividends) || dividends.length < 6) return null;
  const sorted     = [...dividends].sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));
  const recentes   = sorted.slice(0, 3).reduce((s, d) => s + (d.rate || 0), 0);
  const anteriores = sorted.slice(3, 6).reduce((s, d) => s + (d.rate || 0), 0);
  if (anteriores === 0) return null;
  return ((recentes - anteriores) / anteriores) * 100;
}

// ─── Fonte 1: FundsExplorer ───────────────────────────────────────────────────

async function fetchFundsExplorer(ticker) {
  try {
    const { data: html } = await axios.get(
      `https://fundsexplorer.com.br/funds/${ticker}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Referer': 'https://fundsexplorer.com.br/',
        },
        timeout: 20000,
      }
    );

    const extractField = (key) => {
      const m = html.match(new RegExp(`"${key}"\\s*:\\s*(-?[\\d.]+)`));
      return m ? safeFloat(m[1]) : null;
    };

    // Vacância física mais recente
    let maxVacIdx = -1, latestVac = null;
    const vacRe = /"vacancia_(\d+)_vacancia_fisica"\s*:\s*(-?[\d.]+)/g;
    let vm;
    while ((vm = vacRe.exec(html)) !== null) {
      const idx = parseInt(vm[1]);
      const val = safeFloat(vm[2]);
      if (val !== null && idx > maxVacIdx) { maxVacIdx = idx; latestVac = val; }
    }

    const vacancy    = latestVac;
    const properties = extractField('assets_number');
    const divGrowth  = extractField('dividend_cagr3');
    const liquidity  = extractField('liquidezmediadiaria');
    const pvp        = extractField('pvp');
    const patrimonio = extractField('patrimonio');
    const lastDivValor = extractField('lastdividend');
    const fmtDate = (s) => s ? new Date(s).toISOString().substring(0, 10) : null;
    const lastDivComM  = html.match(/"ur_data_base"\s*:\s*"([^"]+)"/);
    const lastDivPgtoM = html.match(/"ur_data_pagamento"\s*:\s*"([^"]+)"/);

    // Extrai DY 12m do FundsExplorer (dy_ano ou dividendyield)
    const dy12m = extractField('dividendyield') ?? extractField('dy_ano');

    console.log(`[enricher] FundsExplorer OK ${ticker}: vacancy=${vacancy}, props=${properties}, pvp=${pvp}, dy12m=${dy12m}`);

    return {
      vacancy, properties, div_growth: divGrowth,
      liquidity, pvp, net_worth: patrimonio,
      dy_12m: dy12m,
      ultimo_dy_valor: lastDivValor,
      ultimo_dy_com:   lastDivComM  ? fmtDate(lastDivComM[1])  : null,
      ultimo_dy_pgto:  lastDivPgtoM ? fmtDate(lastDivPgtoM[1]) : null,
      descricao: null,
      source: 'fundsexplorer',
    };
  } catch (e) {
    console.warn(`[enricher] FundsExplorer erro ${ticker}:`, e.message);
    return null;
  }
}

// ─── Fonte 2: StatusInvest ────────────────────────────────────────────────────

async function fetchStatusInvest(ticker) {
  try {
    const { data } = await axios.get(
      `https://statusinvest.com.br/fundos-imobiliarios/${ticker.toLowerCase()}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Referer': 'https://statusinvest.com.br/',
        },
        timeout: 20000,
      }
    );

    const html = data;

    // Helper: extrai primeiro número após label (texto visível na página)
    const extractAfterLabel = (label) => {
      const re = new RegExp(label + '[^<]*<[^>]+>\\s*<[^>]+>([\\d.,]+)', 'i');
      const m  = html.match(re);
      if (!m) return null;
      return safeFloat(m[1].replace('.', '').replace(',', '.'));
    };

    // DY 12m — aparece como "12,34%" em vários pontos
    const dyMatch = html.match(/dy[^<]{0,80}?(\d{1,2}[,.]?\d{0,2})\s*%/i);
    const dy12m   = dyMatch ? safeFloat(dyMatch[1].replace(',', '.')) : null;

    // P/VP — "0,93" ou "1.02"
    const pvpMatch = html.match(/p\s*\/\s*vp[^<]{0,80}?([0-9]+[,.]?[0-9]*)/i);
    const pvp      = pvpMatch ? safeFloat(pvpMatch[1].replace(',', '.')) : null;

    // Vacância física — "vacância" seguido de número
    const vacMatch = html.match(/vac[aâ]ncia[^<]{0,120}?(\d{1,2}[,.]?\d{0,2})\s*%/i);
    const vacancy  = vacMatch ? safeFloat(vacMatch[1].replace(',', '.')) : null;

    // Liquidez média diária — valor em R$ (pode ser grande)
    const liqMatch = html.match(/liquidez[^<]{0,200}?([\d.]+[\d,]+)/i);
    const liquidity = liqMatch ? safeFloat(liqMatch[1].replace(/\./g, '').replace(',', '.')) : null;

    // Número de imóveis / ativos
    const propMatch = html.match(/im[oó]veis?[^<]{0,60}?(\d+)/i) ||
                      html.match(/ativos?[^<]{0,60}?(\d+)/i);
    const properties = propMatch ? safeFloat(propMatch[1]) : null;

    // WAULT — "WAULT" seguido de número de anos
    const waultMatch = html.match(/wault[^<]{0,80}?([\d]+[,.]?[\d]*)\s*anos?/i);
    const wault      = waultMatch ? safeFloat(waultMatch[1].replace(',', '.')) : null;

    console.log(`[enricher] StatusInvest ${ticker}: dy12m=${dy12m}, pvp=${pvp}, vacancy=${vacancy}, liq=${liquidity}, wault=${wault}`);

    if (dy12m == null && pvp == null && vacancy == null) {
      console.warn(`[enricher] StatusInvest ${ticker}: nenhum campo extraído — possível bloqueio`);
      return null;
    }

    return { dy_12m: dy12m, pvp, vacancy, liquidity, properties, wault, leverage: null, source: 'statusinvest' };
  } catch (e) {
    console.warn(`[enricher] StatusInvest erro ${ticker}:`, e.message);
    return null;
  }
}

// ─── Fonte 3: brapi (div_growth e descricao) ─────────────────────────────────

async function fetchBrapiDivGrowth(ticker) {
  if (!BRAPI_TOKEN) return null;
  try {
    const { data } = await axios.get(
      `https://brapi.dev/api/quote/${ticker}/dividends?token=${BRAPI_TOKEN}`,
      { timeout: 10000 }
    );
    const dividends = data?.results?.[0]?.cashDividends || data?.cashDividends;
    return calcDivGrowth(dividends);
  } catch (e) {
    console.warn(`[enricher] brapi dividends erro ${ticker}:`, e.message);
    return null;
  }
}

async function fetchBrapiDescricao(ticker) {
  if (!BRAPI_TOKEN) return null;
  try {
    const { data } = await axios.get(
      `https://brapi.dev/api/quote/${ticker}?modules=summaryProfile&token=${BRAPI_TOKEN}`,
      { timeout: 10000 }
    );
    const summary = data?.results?.[0]?.summaryProfile?.longBusinessSummary;
    if (!summary || summary.length < 10) return null;
    return summary.substring(0, 200);
  } catch (e) {
    console.warn(`[enricher] brapi summaryProfile erro ${ticker}:`, e.message);
    return null;
  }
}

// ─── Cache PostgreSQL ─────────────────────────────────────────────────────────

async function getCached(ticker) {
  try {
    const { rows } = await pool.query(
      `SELECT dados, updated_at FROM fii_enriched_cache WHERE ticker = $1`, [ticker]
    );
    if (!rows.length) return null;
    const ageH = (Date.now() - new Date(rows[0].updated_at).getTime()) / 3600000;
    if (ageH > CACHE_TTL_H) return null;
    return rows[0].dados;
  } catch (e) {
    console.warn('[enricher] erro lendo cache:', e.message);
    return null;
  }
}

async function saveCache(ticker, dados) {
  try {
    await pool.query(
      `INSERT INTO fii_enriched_cache (ticker, dados, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (ticker) DO UPDATE SET dados = EXCLUDED.dados, updated_at = NOW()`,
      [ticker, JSON.stringify(dados)]
    );
  } catch (e) {
    console.warn('[enricher] erro salvando cache:', e.message);
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * enrichFII(ticker, dadosBase?)
 * Estratégia:
 *   1. Cache PostgreSQL (TTL 24h)
 *   2. FundsExplorer (primary)
 *   3. StatusInvest (fallback se FE falhar ou campos críticos nulos)
 *   4. brapi dividends (div_growth fallback)
 */
async function enrichFII(ticker, dadosBase = {}) {
  ticker = ticker.toUpperCase();

  const cached = await getCached(ticker);
  if (cached) {
    console.log(`[enricher] cache hit ${ticker}`);
    return { ...dadosBase, ...cached };
  }

  let result = {};
  let source = 'none';

  // 1. FundsExplorer
  const fe = await fetchFundsExplorer(ticker);
  if (fe) {
    result = { ...fe };
    source = 'fundsexplorer';
  }

  // 2. StatusInvest — sempre tenta para preencher lacunas ou como fonte primária
  const si = await fetchStatusInvest(ticker);
  if (si) {
    // Preenche apenas campos ainda nulos
    for (const [k, v] of Object.entries(si)) {
      if (k === 'source') continue;
      if (result[k] == null && v != null) result[k] = v;
    }
    if (source === 'none') source = 'statusinvest';
    else if (Object.values(si).some(v => v != null)) source = 'fundsexplorer+statusinvest';
  }

  // 3. brapi div_growth (se ainda nulo)
  if (result.div_growth == null) {
    const dg = await fetchBrapiDivGrowth(ticker);
    if (dg != null) {
      result.div_growth = dg;
      source += '+brapi_div';
    }
  }

  // 4. brapi descricao (se ainda nulo)
  if (!result.descricao) {
    result.descricao = await fetchBrapiDescricao(ticker);
  }

  // WAULT e leverage — ainda não disponíveis em fontes públicas gratuitas
  if (result.wault    == null) result.wault    = null;
  if (result.leverage == null) result.leverage = null;

  result.source = source;

  await saveCache(ticker, result);
  return { ...dadosBase, ...result };
}

/**
 * enrichBatch — processa múltiplos tickers com delay anti-bloqueio
 */
async function enrichBatch(tickers, dadosBasePorTicker = {}, delayMs = 2000) {
  const results = {};
  for (const ticker of tickers) {
    results[ticker] = await enrichFII(ticker, dadosBasePorTicker[ticker] || {});
    await delay(delayMs);
  }
  return results;
}

module.exports = { enrichFII, enrichBatch, fetchFundsExplorer, fetchStatusInvest };
