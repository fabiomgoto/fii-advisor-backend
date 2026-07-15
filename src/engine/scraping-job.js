'use strict';

/**
 * scraping-job.js
 *
 * Ciclo de 6h:
 *  1. Busca todos os tickers de fiis_market
 *  2. Para cada ticker (sequencial, 1.5s de intervalo):
 *     - Raspa StatusInvest → dy_12m, pvp, vacancy, liquidity, properties, wault
 *     - Atualiza fiis_market com os dados frescos
 *  3. Busca IBOV e IFIX do Yahoo Finance → grava em macro_snapshot
 *
 * Rotas lêem do banco (<10ms). StatusInvest nunca é consultado durante requests.
 */

const axios = require('../services/axiosConfig');
const pool  = require('../db/connection');
const { fetchStatusInvest } = require('./fii-enricher');

const DELAY_MS     = 1_500;
const INTERVAL_MS  = 6 * 60 * 60 * 1_000; // 6h

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── IBOV + IFIX: cache em macro_snapshot ─────────────────────────────────────

async function syncMacroIndex(symbol, yahooSymbol) {
  try {
    const encoded = encodeURIComponent(yahooSymbol);
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=5y&interval=1mo`,
      { timeout: 15_000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const r = data?.chart?.result?.[0];
    if (!r) return;

    const series = {};
    r.timestamp.forEach((t, i) => {
      const mes   = new Date(t * 1000).toISOString().substring(0, 7);
      const close = r.indicators.quote[0].close[i];
      if (close) series[mes] = close;
    });

    await pool.query(
      `INSERT INTO macro_snapshot (symbol, range, data, updated_at)
       VALUES ($1, '5y', $2, NOW())
       ON CONFLICT (symbol, range)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [symbol, JSON.stringify(series)]
    );
    console.log(`[scraping-job] macro_snapshot atualizado: ${symbol} (${Object.keys(series).length} meses)`);
  } catch (e) {
    console.warn(`[scraping-job] macro sync ${symbol}:`, e.message);
  }
}

// ── Proventos / dados de mercado por ticker ───────────────────────────────────

async function scrapeTicker(ticker) {
  const enriched = await fetchStatusInvest(ticker);
  if (!enriched) return false;

  const sets = [];
  const vals = [ticker];
  let i = 2;

  const fields = {
    dy_12m:     enriched.dy_12m,
    pvp:        enriched.pvp,
    vacancy:    enriched.vacancy,
    liquidity:  enriched.liquidity,
    properties: enriched.properties,
    wault:      enriched.wault,
  };

  for (const [col, val] of Object.entries(fields)) {
    if (val != null) { sets.push(`${col} = $${i++}`); vals.push(val); }
  }

  if (!sets.length) return false;

  sets.push(`scanned_at = NOW()`);
  await pool.query(
    `UPDATE fiis_market SET ${sets.join(', ')} WHERE ticker = $1`,
    vals
  );
  return true;
}

// ── Ciclo principal ───────────────────────────────────────────────────────────

async function runCycle() {
  console.log('[scraping-job] Iniciando ciclo...');
  const start = Date.now();

  // 1. Macro primeiro (não depende de tickers)
  await Promise.all([
    syncMacroIndex('IBOV', '^BVSP'),
    syncMacroIndex('IFIX', 'IFIX.SA'),
  ]);

  // 2. Tickers sequenciais
  const { rows } = await pool.query(
    `SELECT ticker FROM fiis_market ORDER BY ticker`
  );
  console.log(`[scraping-job] ${rows.length} tickers para raspar`);

  let ok = 0, fail = 0;
  for (const { ticker } of rows) {
    try {
      const updated = await scrapeTicker(ticker);
      if (updated) ok++; else fail++;
    } catch (e) {
      console.warn(`[scraping-job] erro ${ticker}:`, e.message);
      fail++;
    }
    await sleep(DELAY_MS);
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`[scraping-job] Ciclo concluído em ${elapsed}s — ok=${ok} fail=${fail}`);
}

// ── Exportação pública ────────────────────────────────────────────────────────

function startScrapingJob() {
  // Roda imediatamente no startup (sem bloquear o boot do servidor)
  setImmediate(() => {
    runCycle().catch(e => console.error('[scraping-job] ciclo inicial falhou:', e.message));
  });

  // Agenda ciclo a cada 6h
  setInterval(() => {
    runCycle().catch(e => console.error('[scraping-job] ciclo periódico falhou:', e.message));
  }, INTERVAL_MS);

  console.log('[scraping-job] Job agendado (ciclo a cada 6h)');
}

module.exports = { startScrapingJob, runCycle };
