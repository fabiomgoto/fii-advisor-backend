-- Sprint 16: scoring segmentado + breakdown
-- Adicionar colunas em fiis_market

ALTER TABLE fiis_market
  ADD COLUMN IF NOT EXISTS segmento         VARCHAR(30),
  ADD COLUMN IF NOT EXISTS score_breakdown  JSONB,
  ADD COLUMN IF NOT EXISTS cobertura_pct    SMALLINT,
  ADD COLUMN IF NOT EXISTS score_updated_at TIMESTAMP;

-- View auxiliar para top50 com breakdown
CREATE OR REPLACE VIEW vw_market_top50 AS
SELECT
  ticker, name, segment, segmento, price, dy_12m, pvp, vacancy,
  liquidity, score, action, consistency, properties,
  score_breakdown, cobertura_pct, score_updated_at, scanned_at
FROM fiis_market
WHERE score IS NOT NULL AND price IS NOT NULL AND price > 0
ORDER BY score DESC
LIMIT 50;
