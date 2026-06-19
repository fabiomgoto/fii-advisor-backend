'use strict';

const pool = require('../db/connection');
const { calcularScore, getAction } = require('../engine/fii-scorer');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Rescora todos os FIIs já presentes em fiis_market (sem buscar dados novos)
async function rodarScoringDiario() {
  console.log('[scoring-diario] Iniciando...');
  const inicio = Date.now();

  const { rows: fiis } = await pool.query(
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

// Importa TODOS os FIIs do Fundamentus (400+) para fiis_market e aplica score segmentado
async function rodarVarreduraCompleta() {
  console.log('[varredura-completa] Iniciando importação de todos os FIIs do Fundamentus...');
  const inicio = Date.now();

  const { buscarTodosFIIs } = require('../collectors/fundamentus');
  const todos = await buscarTodosFIIs();
  const tickers = Object.keys(todos);
  console.log(`[varredura-completa] ${tickers.length} FIIs recebidos do Fundamentus`);

  let importados = 0, erros = 0;

  for (const ticker of tickers) {
    try {
      const d = todos[ticker];
      const fii = {
        ticker,
        name:      d.name      ?? null,
        price:     d.price     ?? null,
        dy_12m:    d.dy_12m    ?? null,
        pvp:       d.pvp       ?? null,
        liquidity: d.liquidity ?? null,
        net_worth: d.net_worth ?? null,
        vacancy:   d.vacancy   ?? null,
        properties:d.properties ?? null,
        segment:   d.segment   ?? null,
      };

      if (!fii.price || fii.price <= 0) continue;

      const { score, segmento, cobertura_pct, score_breakdown } = calcularScore(fii);
      const action = getAction(score);

      await pool.query(
        `INSERT INTO fiis_market
           (ticker, name, price, dy_12m, pvp, liquidity, net_worth, vacancy, properties, segment,
            score, action, segmento, cobertura_pct, score_breakdown, score_updated_at, scanned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
         ON CONFLICT (ticker) DO UPDATE SET
           name=EXCLUDED.name, price=EXCLUDED.price, dy_12m=EXCLUDED.dy_12m,
           pvp=EXCLUDED.pvp, liquidity=EXCLUDED.liquidity, net_worth=EXCLUDED.net_worth,
           vacancy=EXCLUDED.vacancy, properties=EXCLUDED.properties, segment=EXCLUDED.segment,
           score=EXCLUDED.score, action=EXCLUDED.action,
           segmento=EXCLUDED.segmento, cobertura_pct=EXCLUDED.cobertura_pct,
           score_breakdown=EXCLUDED.score_breakdown,
           score_updated_at=NOW(), scanned_at=NOW()`,
        [
          ticker, fii.name, fii.price, fii.dy_12m, fii.pvp,
          fii.liquidity, fii.net_worth, fii.vacancy, fii.properties, fii.segment,
          score, action, segmento, cobertura_pct, JSON.stringify(score_breakdown),
        ]
      );
      importados++;
    } catch (e) {
      erros++;
      console.warn(`[varredura-completa] erro ${ticker}:`, e.message);
    }
  }

  const ms = Date.now() - inicio;
  console.log(`[varredura-completa] ${importados} importados, ${erros} erros — ${ms}ms`);
  return { importados, erros, total: tickers.length };
}

module.exports = { rodarScoringDiario, rodarVarreduraCompleta };
