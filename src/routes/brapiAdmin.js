'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../db/connection');
const {
  fetchFiisBrapi,
  normalizarFii,
  upsertBrapiCache,
  getConsumoMes,
  getCoberturaComparativa,
} = require('../services/brapiService');

router.get('/consumption', async (req, res) => {
  try {
    const consumo = await getConsumoMes();
    res.json({ ok: true, data: consumo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/coverage', async (req, res) => {
  try {
    const cobertura = await getCoberturaComparativa();
    res.json({ ok: true, data: cobertura });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/compare/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const [scraping, brapi] = await Promise.all([
      pool.query('SELECT dados FROM fii_enriched_cache WHERE ticker = $1', [ticker]),
      pool.query('SELECT * FROM brapi_fii_cache WHERE ticker = $1', [ticker]),
    ]);
    res.json({
      ok: true,
      ticker,
      scraping: scraping.rows[0]?.dados || null,
      brapi:    brapi.rows[0] || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/scan', async (req, res) => {
  try {
    let tickers = req.body?.tickers;

    if (!tickers || !tickers.length) {
      const result = await pool.query(
        'SELECT DISTINCT ticker FROM fiis_market ORDER BY ticker'
      );
      tickers = result.rows.map(r => r.ticker);
    }

    res.json({
      ok: true,
      message: `Varredura Brapi iniciada para ${tickers.length} tickers`,
      tickers_count: tickers.length,
    });

    setImmediate(async () => {
      try {
        const rawData = await fetchFiisBrapi(tickers);
        const normalized = rawData.map(normalizarFii);
        await upsertBrapiCache(normalized);
        console.log(`[brapiAdmin] Varredura concluída: ${normalized.length} FIIs`);
      } catch (err) {
        console.error('[brapiAdmin] Erro na varredura background:', err.message);
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/shadow-stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM brapi_fii_cache)                       AS brapi_total,
        (SELECT COUNT(*) FROM fiis_market)                           AS producao_total,
        (SELECT COUNT(*) FROM brapi_fii_cache WHERE expira_em > NOW()) AS brapi_validos,
        (SELECT MAX(atualizado_em) FROM brapi_fii_cache)             AS ultima_atualizacao,
        (SELECT ROUND(AVG(campos_preenchidos), 1) FROM brapi_fii_cache) AS media_cobertura
    `);
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
