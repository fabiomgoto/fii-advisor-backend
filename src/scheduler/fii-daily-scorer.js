'use strict';

const pool = require('../db/connection');
const { calcularScore, getAction, detectarSegmento } = require('../engine/fii-scorer');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function rodarScoringDiario() {
  console.log('[scoring-diario] Iniciando...');
  const inicio = Date.now();

  let { rows: fiis } = await pool.query(
    `SELECT ticker, name, segment, price, dy_12m, pvp, vacancy, liquidity,
            consistency, properties, div_growth, wault, leverage, net_worth
     FROM fiis_market
     WHERE price IS NOT NULL AND price > 0`
  );

  let processados = 0, erros = 0;

  for (const fii of fiis) {
    try {
      const { score, segmento, cobertura_pct, score_breakdown } = calcularScore(fii);
      const action = getAction(score);

      await pool.query(
        `UPDATE fiis_market
         SET score            = $1,
             action           = $2,
             segmento         = $3,
             cobertura_pct    = $4,
             score_breakdown  = $5,
             score_updated_at = NOW()
         WHERE ticker = $6`,
        [score, action, segmento, cobertura_pct, JSON.stringify(score_breakdown), fii.ticker]
      );
      processados++;
    } catch (e) {
      erros++;
      console.warn(`[scoring-diario] erro ${fii.ticker}:`, e.message);
    }

    await delay(50);
  }

  const ms = Date.now() - inicio;
  console.log(`[scoring-diario] ${processados} processados, ${erros} erros — ${ms}ms`);
  return { processados, erros };
}

module.exports = { rodarScoringDiario };
