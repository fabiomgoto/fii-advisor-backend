/**
 * fiis.js — collector de dados de mercado para FIIs
 *
 * Fonte primária: brapi Pro — price, liquidity, dividends (cashDividends)
 * Complemento:   dataProvider (enricher) — pvp, vacancy, properties, wault (scraping permanece)
 */

'use strict';
const axios = require('../services/axiosConfig');
const { calcularDY12m, extrairProximoRendimento } = require('../utils/dividendUtils');

const BRAPI_TOKEN = process.env.BRAPI_TOKEN;
const BASE_URL    = 'https://brapi.dev/api';

/**
 * Busca preço + dividendos de um lote de tickers em uma única chamada Brapi Pro.
 * Retorna mapa ticker → { price, liquidity, dy_12m, proximo }
 */
async function buscarLoteBrapi(tickers) {
  const batch = tickers.join(',');
  const { data } = await axios.get(
    `${BASE_URL}/quote/${batch}?token=${BRAPI_TOKEN}&dividends=true`,
    { timeout: 20000 }
  );
  const map = {};
  for (const q of (data?.results || [])) {
    const divs = q.dividendsData?.cashDividends || [];
    map[q.symbol] = {
      name:      q.longName || q.shortName || q.symbol,
      price:     q.regularMarketPrice  ?? null,
      liquidity: q.regularMarketVolume ?? null,
      dy_12m:    calcularDY12m(divs),
      proximo:   extrairProximoRendimento(divs),
    };
  }
  return map;
}

async function buscarLoteFIIs(tickers) {
  const { getEnrichedData } = require('../services/dataProvider');

  // 1. Uma chamada Brapi Pro para todos os tickers (price + dividends)
  let brapiMap = {};
  try {
    brapiMap = await buscarLoteBrapi(tickers);
    console.log(`[fiis-collector] brapi batch OK: ${Object.keys(brapiMap).length}/${tickers.length} tickers`);
  } catch (err) {
    console.warn('[fiis-collector] brapi batch erro:', err.message);
  }

  // 2. Enricher por ticker (pvp, vacancy, properties — scraping permanece)
  const resultados = [];
  for (const ticker of tickers) {
    const brapi = brapiMap[ticker] || {};
    let enriched = {};
    try {
      enriched = await getEnrichedData(ticker) || {};
    } catch (e) {
      console.warn(`[fiis-collector] enricher ${ticker}: ${e.message}`);
    }

    const dado = {
      ticker,
      name:       brapi.name       || ticker,
      price:      brapi.price      ?? null,
      dy_12m:     enriched.dy_12m  ?? brapi.dy_12m  ?? null,
      liquidity:  brapi.liquidity  ?? enriched.liquidity ?? null,
      net_worth:  enriched.net_worth ?? null,
      pvp:        enriched.pvp        ?? null,
      vacancy:    enriched.vacancy    ?? null,
      properties: enriched.properties ?? null,
      div_growth: enriched.div_growth ?? null,
      wault:      enriched.wault      ?? null,
      leverage:   enriched.leverage   ?? null,
    };
    console.log(`[fiis-collector] ${ticker}: price=${dado.price}, dy=${dado.dy_12m?.toFixed(2)}, pvp=${dado.pvp}`);
    resultados.push(dado);
  }
  return resultados;
}

// Mantido para compatibilidade com qualquer chamada isolada
async function buscarDadosBrapiBasico(ticker) {
  const map = await buscarLoteBrapi([ticker]);
  const d   = map[ticker];
  if (!d) throw new Error(`Sem dados para ${ticker}`);
  return { ticker, ...d };
}

module.exports = { buscarDadosBrapiBasico, buscarLoteFIIs, buscarLoteBrapi };
