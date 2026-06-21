-- Tabela shadow: espelho de fii_enriched_cache populada exclusivamente via Brapi Pro
-- Objetivo: comparar cobertura e qualidade de dados vs. scraping atual
-- Não afeta produção — tabela paralela isolada

CREATE TABLE IF NOT EXISTS brapi_fii_cache (
  ticker              VARCHAR(10)   PRIMARY KEY,
  nome                TEXT,
  segmento            TEXT,

  preco               NUMERIC(12,4),
  valor_patrimonial   NUMERIC(12,4),
  pvp                 NUMERIC(8,4),

  dy_12m              NUMERIC(8,4),
  ultimo_dividendo    NUMERIC(10,6),
  data_com            DATE,
  data_pagamento      DATE,

  dy_cagr             NUMERIC(8,4),
  cota_cagr           NUMERIC(8,4),

  vacancia_fisica     NUMERIC(6,4),
  num_imoveis         INTEGER,
  wault               NUMERIC(6,2),

  liquidez_diaria     NUMERIC(18,2),
  patrimonio_liquido  NUMERIC(18,2),
  num_cotistas        INTEGER,

  pl                  NUMERIC(10,4),
  roe                 NUMERIC(8,4),
  ev_ebitda           NUMERIC(10,4),

  dividendos_historico JSONB         DEFAULT '[]',

  fonte               VARCHAR(20)   DEFAULT 'brapi',
  brapi_endpoint      TEXT,
  campos_preenchidos  INTEGER,
  campos_ausentes     TEXT[],

  atualizado_em       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expira_em           TIMESTAMPTZ   NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  tentativas          INTEGER       DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_brapi_fii_cache_segmento    ON brapi_fii_cache(segmento);
CREATE INDEX IF NOT EXISTS idx_brapi_fii_cache_atualizado  ON brapi_fii_cache(atualizado_em DESC);
CREATE INDEX IF NOT EXISTS idx_brapi_fii_cache_expira      ON brapi_fii_cache(expira_em);
CREATE INDEX IF NOT EXISTS idx_brapi_fii_cache_pvp         ON brapi_fii_cache(pvp);
CREATE INDEX IF NOT EXISTS idx_brapi_fii_cache_dy          ON brapi_fii_cache(dy_12m DESC);

CREATE TABLE IF NOT EXISTS brapi_consumption_log (
  id              SERIAL PRIMARY KEY,
  chamado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  endpoint        TEXT        NOT NULL,
  tickers         TEXT[],
  num_tickers     INTEGER,
  status_http     INTEGER,
  latencia_ms     INTEGER,
  tokens_usados   INTEGER,
  erro            TEXT
);

CREATE INDEX IF NOT EXISTS idx_brapi_log_chamado ON brapi_consumption_log(chamado_em DESC);
