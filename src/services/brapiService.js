'use strict';

const axios = require('axios');
const pool  = require('../db/connection');

const BRAPI_TOKEN = process.env.BRAPI_TOKEN;
const BRAPI_BASE  = 'https://brapi.dev/api';
const BATCH_SIZE  = 20;

async function fetchFiisBrapi(tickers) {
  const results = [];
  const batches = [];

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    batches.push(tickers.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    const inicio = Date.now();
    const tickerStr = batch.join(',');
    const endpoint = `/quote/${tickerStr}`;

    try {
      const response = await axios.get(`${BRAPI_BASE}${endpoint}`, {
        params: {
          token: BRAPI_TOKEN,
          dividends: true,
          range: '1y',
          interval: '1mo',
        },
        timeout: 15000,
      });

      const latencia = Date.now() - inicio;
      await logConsumo(endpoint, batch, response.status, latencia, null);

      if (response.data?.results) {
        results.push(...response.data.results);
      }
    } catch (err) {
      const latencia = Date.now() - inicio;
      await logConsumo(endpoint, batch, err.response?.status || 0, latencia, err.message);
      console.error(`[brapiService] Erro no lote ${tickerStr}:`, err.message);
    }

    await new Promise(r => setTimeout(r, 100));
  }

  return results;
}

function normalizarFii(raw) {
  const divs = (raw.dividendsData?.cashDividends || []).slice(0, 24);
  const dividendos = divs
    .map(d => ({
      mes:       d.paymentDate?.substring(0, 7) || null,
      valor:     d.rate || 0,
      data_com:  d.lastDatePrior?.substring(0, 10) || null,
      data_pgto: d.paymentDate?.substring(0, 10)   || null,
    }))
    .reverse();

  // Calcular DY 12m a partir dos dividendos quando Brapi não retorna diretamente
  const preco = raw.regularMarketPrice || 0;
  const soma12m = divs.slice(0, 12).reduce((s, d) => s + (d.rate || 0), 0);
  const dyCalculado = preco > 0 ? soma12m / preco : null;

  const normalizado = {
    ticker:              raw.symbol,
    nome:                raw.longName || raw.shortName || null,
    segmento:            raw.fundType || null,
    preco:               preco || null,
    valor_patrimonial:   raw.bookValue || null,
    pvp:                 raw.priceToBook || null,
    dy_12m:              raw.dividendYield ? raw.dividendYield / 100 : dyCalculado,
    ultimo_dividendo:    divs[0]?.rate || null,
    data_com:            divs[0]?.lastDatePrior?.substring(0, 10) || null,
    data_pagamento:      divs[0]?.paymentDate?.substring(0, 10) || null,
    dy_cagr:             null,
    cota_cagr:           null,
    vacancia_fisica:     null,
    num_imoveis:         null,
    wault:               null,
    liquidez_diaria:     raw.averageDailyVolume3Month || (raw.regularMarketVolume && preco ? raw.regularMarketVolume * preco : null),
    patrimonio_liquido:  raw.marketCap || null,
    num_cotistas:        null,
    pl:                  raw.priceEarnings || null,
    roe:                 raw.returnOnEquity || null,
    ev_ebitda:           raw.enterpriseToEbitda || null,
    dividendos_historico: dividendos,
    fonte:               'brapi',
    brapi_endpoint:      `/quote/${raw.symbol}?dividends=true`,
  };

  const camposEssenciais = [
    'preco', 'pvp', 'dy_12m', 'vacancia_fisica',
    'liquidez_diaria', 'patrimonio_liquido', 'dy_cagr',
  ];
  const camposAusentes = camposEssenciais.filter(c => normalizado[c] == null);
  const camposPreenchidos = Object.values(normalizado)
    .filter(v => v != null && v !== '[]').length;

  normalizado.campos_ausentes    = camposAusentes;
  normalizado.campos_preenchidos = camposPreenchidos;

  return normalizado;
}

async function upsertBrapiCache(fiis) {
  if (!fiis.length) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const fii of fiis) {
      await client.query(`
        INSERT INTO brapi_fii_cache (
          ticker, nome, segmento,
          preco, valor_patrimonial, pvp,
          dy_12m, ultimo_dividendo, data_com, data_pagamento,
          dy_cagr, cota_cagr,
          vacancia_fisica, num_imoveis, wault,
          liquidez_diaria, patrimonio_liquido, num_cotistas,
          pl, roe, ev_ebitda,
          dividendos_historico,
          fonte, brapi_endpoint,
          campos_preenchidos, campos_ausentes,
          atualizado_em, expira_em, tentativas
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24,$25,$26,
          NOW(), NOW() + INTERVAL '24 hours', 1
        )
        ON CONFLICT (ticker) DO UPDATE SET
          nome                 = EXCLUDED.nome,
          segmento             = EXCLUDED.segmento,
          preco                = EXCLUDED.preco,
          valor_patrimonial    = EXCLUDED.valor_patrimonial,
          pvp                  = EXCLUDED.pvp,
          dy_12m               = EXCLUDED.dy_12m,
          ultimo_dividendo     = EXCLUDED.ultimo_dividendo,
          data_com             = EXCLUDED.data_com,
          data_pagamento       = EXCLUDED.data_pagamento,
          dy_cagr              = EXCLUDED.dy_cagr,
          cota_cagr            = EXCLUDED.cota_cagr,
          vacancia_fisica      = EXCLUDED.vacancia_fisica,
          num_imoveis          = EXCLUDED.num_imoveis,
          wault                = EXCLUDED.wault,
          liquidez_diaria      = EXCLUDED.liquidez_diaria,
          patrimonio_liquido   = EXCLUDED.patrimonio_liquido,
          num_cotistas         = EXCLUDED.num_cotistas,
          pl                   = EXCLUDED.pl,
          roe                  = EXCLUDED.roe,
          ev_ebitda            = EXCLUDED.ev_ebitda,
          dividendos_historico = EXCLUDED.dividendos_historico,
          brapi_endpoint       = EXCLUDED.brapi_endpoint,
          campos_preenchidos   = EXCLUDED.campos_preenchidos,
          campos_ausentes      = EXCLUDED.campos_ausentes,
          atualizado_em        = NOW(),
          expira_em            = NOW() + INTERVAL '24 hours',
          tentativas           = brapi_fii_cache.tentativas + 1
      `, [
        fii.ticker, fii.nome, fii.segmento,
        fii.preco, fii.valor_patrimonial, fii.pvp,
        fii.dy_12m, fii.ultimo_dividendo, fii.data_com, fii.data_pagamento,
        fii.dy_cagr, fii.cota_cagr,
        fii.vacancia_fisica, fii.num_imoveis, fii.wault,
        fii.liquidez_diaria, fii.patrimonio_liquido, fii.num_cotistas,
        fii.pl, fii.roe, fii.ev_ebitda,
        JSON.stringify(fii.dividendos_historico),
        fii.fonte, fii.brapi_endpoint,
        fii.campos_preenchidos, fii.campos_ausentes,
      ]);
    }

    await client.query('COMMIT');
    console.log(`[brapiService] ${fiis.length} FIIs upsertados em brapi_fii_cache`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function logConsumo(endpoint, tickers, status, latencia, erro) {
  try {
    await pool.query(`
      INSERT INTO brapi_consumption_log
        (endpoint, tickers, num_tickers, status_http, latencia_ms, erro)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [endpoint, tickers, tickers.length, status, latencia, erro]);
  } catch (e) {
    console.error('[brapiService] Erro ao logar consumo:', e.message);
  }
}

async function getConsumoMes() {
  const result = await pool.query(`
    SELECT
      COUNT(*)                                          AS total_chamadas,
      COALESCE(SUM(num_tickers), 0)                    AS total_tickers,
      ROUND(AVG(latencia_ms))                          AS latencia_media_ms,
      COUNT(*) FILTER (WHERE erro IS NOT NULL)         AS erros,
      500000 - COALESCE(SUM(num_tickers), 0)           AS requisicoes_restantes,
      ROUND(COALESCE(SUM(num_tickers), 0)::NUMERIC / 500000 * 100, 1) AS pct_consumido
    FROM brapi_consumption_log
    WHERE chamado_em >= DATE_TRUNC('month', NOW())
  `);
  return result.rows[0];
}

async function getCoberturaComparativa() {
  const result = await pool.query(`
    SELECT
      COUNT(*)                                            AS total_fiis,
      COUNT(pvp)                                         AS com_pvp,
      COUNT(dy_12m)                                      AS com_dy,
      COUNT(vacancia_fisica)                             AS com_vacancia,
      COUNT(liquidez_diaria)                             AS com_liquidez,
      COUNT(dy_cagr)                                     AS com_dy_cagr,
      COUNT(dividendos_historico) FILTER (
        WHERE jsonb_array_length(dividendos_historico) > 0
      )                                                  AS com_dividendos_historico,
      ROUND(AVG(campos_preenchidos), 1)                  AS media_campos_preenchidos
    FROM brapi_fii_cache
  `);
  return result.rows[0];
}

module.exports = {
  fetchFiisBrapi,
  normalizarFii,
  upsertBrapiCache,
  getConsumoMes,
  getCoberturaComparativa,
  logConsumo,
};
