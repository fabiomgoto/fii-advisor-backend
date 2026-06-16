/**
 * fiis.js — collector de dados de mercado para FIIs
 *
 * Fonte primária: brapi quote básico (price, dy_12m, liquidity) — plano gratuito
 * Complemento:   enrichFII → FundsExplorer + StatusInvest (pvp, vacancy, etc.)
 */

const axios = require('axios');

const BRAPI_TOKEN = process.env.BRAPI_TOKEN;
const BASE_URL    = 'https://brapi.dev/api';

/** Busca apenas campos básicos do brapi (funciona no plano gratuito para FIIs) */
async function buscarDadosBrapiBasico(ticker) {
  const url = `${BASE_URL}/quote/${ticker}?token=${BRAPI_TOKEN}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  const q = data?.results?.[0];
  if (!q) throw new Error(`Sem dados para ${ticker}`);

  // dividendYield vem como percentual (ex: 12.5 = 12.5%)
  const dy = q.dividendYield ?? null;

  return {
    ticker,
    name:      q.longName || q.shortName || ticker,
    price:     q.regularMarketPrice    ?? null,
    dy_12m:    dy,
    liquidity: q.regularMarketVolume   ?? null,
    net_worth: q.marketCap             ?? null,
  };
}

async function buscarLoteFIIs(tickers) {
  const { getEnrichedData } = require('../services/dataProvider');

  const resultados = [];
  for (const ticker of tickers) {
    let dado = { ticker, name: ticker };

    // 1. brapi básico (price, dy_12m, liquidity)
    try {
      dado = await buscarDadosBrapiBasico(ticker);
      console.log(`[fiis-collector] brapi OK ${ticker}: price=${dado.price}, dy=${dado.dy_12m}`);
    } catch (err) {
      console.warn(`[fiis-collector] brapi ${ticker}: ${err.message}`);
    }

    // 2. enricher (pvp, dy_12m, vacancy, properties, div_growth — sempre)
    try {
      const enriched = await getEnrichedData(ticker) || {};
      dado = {
        ...dado,
        pvp:        enriched.pvp        ?? dado.pvp        ?? null,
        dy_12m:     enriched.dy_12m     ?? dado.dy_12m     ?? null,
        liquidity:  dado.liquidity  ?? enriched.liquidity  ?? null,
        net_worth:  dado.net_worth  ?? enriched.net_worth  ?? null,
        vacancy:    enriched.vacancy    ?? null,
        properties: enriched.properties ?? null,
        div_growth: enriched.div_growth ?? null,
        wault:      enriched.wault      ?? null,
        leverage:   enriched.leverage   ?? null,
      };
      console.log(`[fiis-collector] enricher ${ticker}: pvp=${dado.pvp}, vacancy=${dado.vacancy}`);
    } catch (e) {
      console.warn(`[fiis-collector] enricher ${ticker}: ${e.message}`);
    }

    resultados.push(dado);
  }
  return resultados;
}

module.exports = { buscarDadosBrapiBasico, buscarLoteFIIs };
