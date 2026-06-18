/**
 * fiis.js — collector de dados de mercado para FIIs
 *
 * Brapi Pro (uma chamada por lote, modules=defaultKeyStatistics):
 *   price, liquidity, pvp (priceToBook), dy_12m, div_growth, proximo rendimento
 *
 * Scraping via dataProvider (FundsExplorer → StatusInvest) — apenas o que o Brapi não tem:
 *   vacancy, properties, wault, leverage
 */

'use strict';
const axios = require('../services/axiosConfig');
const { calcularDY12m, calcularDivGrowth, extrairProximoRendimento } = require('../utils/dividendUtils');

const BRAPI_TOKEN = process.env.BRAPI_TOKEN;
const BASE_URL    = 'https://brapi.dev/api';

/**
 * Busca de uma vez: preço, pvp, dy_12m, div_growth e dividendos de um lote de tickers.
 * Retorna mapa ticker → campos prontos para uso.
 */
async function buscarLoteBrapi(tickers) {
  const batch = tickers.join(',');
  const { data } = await axios.get(
    `${BASE_URL}/quote/${batch}?token=${BRAPI_TOKEN}&dividends=true&modules=defaultKeyStatistics`,
    { timeout: 20000 }
  );
  const map = {};
  for (const q of (data?.results || [])) {
    const divs  = q.dividendsData?.cashDividends || [];
    const ks    = q.defaultKeyStatistics || {};
    const price = q.regularMarketPrice ?? null;
    const soma12m = calcularDY12m(divs);
    // DY 12m = (soma dividendos 12m / preço) * 100  → percentual correto
    const dy12m = (soma12m && price) ? parseFloat(((soma12m / price) * 100).toFixed(4)) : null;
    map[q.symbol] = {
      name:       q.longName || q.shortName || q.symbol,
      price,
      liquidity:  q.regularMarketVolume ?? null,
      pvp:        ks.priceToBook        ?? null,
      dy_12m:     dy12m,
      div_growth: calcularDivGrowth(divs),
      proximo:    extrairProximoRendimento(divs),
    };
  }
  return map;
}

async function buscarLoteFIIs(tickers) {
  const { getEnrichedData } = require('../services/dataProvider');

  // 1. Uma chamada Brapi Pro para o lote inteiro
  let brapiMap = {};
  try {
    brapiMap = await buscarLoteBrapi(tickers);
    console.log(`[fiis-collector] brapi batch OK: ${Object.keys(brapiMap).length}/${tickers.length} tickers`);
  } catch (err) {
    console.warn('[fiis-collector] brapi batch erro:', err.message);
  }

  // 2. Scraping por ticker — só campos que o Brapi não tem
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
      // Brapi Pro — fonte primária
      price:      brapi.price      ?? null,
      pvp:        brapi.pvp        ?? enriched.pvp       ?? null,
      dy_12m:     brapi.dy_12m     ?? enriched.dy_12m    ?? null,
      div_growth: brapi.div_growth ?? enriched.div_growth ?? null,
      liquidity:  brapi.liquidity  ?? enriched.liquidity ?? null,
      // Scraping — campos ausentes no Brapi
      vacancy:    enriched.vacancy    ?? null,
      properties: enriched.properties ?? null,
      wault:      enriched.wault      ?? null,
      leverage:   enriched.leverage   ?? null,
      net_worth:  enriched.net_worth  ?? null,
    };
    console.log(`[fiis-collector] ${ticker}: price=${dado.price}, pvp=${dado.pvp?.toFixed(2)}, dy=${dado.dy_12m?.toFixed(2)}, vacancy=${dado.vacancy}`);
    resultados.push(dado);
  }
  return resultados;
}

async function buscarDadosBrapiBasico(ticker) {
  const map = await buscarLoteBrapi([ticker]);
  const d   = map[ticker];
  if (!d) throw new Error(`Sem dados para ${ticker}`);
  return { ticker, ...d };
}

module.exports = { buscarDadosBrapiBasico, buscarLoteFIIs, buscarLoteBrapi };
