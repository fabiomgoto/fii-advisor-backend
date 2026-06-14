require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3002;

// ── Middlewares ───────────────────────────────────────────────────────────────
app.use(cors({ origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] }));
app.options('*', cors({ origin: true }));
app.use(express.json());

// ── Rotas ─────────────────────────────────────────────────────────────────────
app.use('/api/fiis',                require('./routes/fiis'));
app.use('/api/profile',             require('./routes/profile'));
app.use('/api/onboarding',          require('./routes/onboarding'));
app.use('/api/recommendations',     require('./routes/recommendations'));
app.use('/api/simulated-portfolio', require('./routes/simulatedPortfolio'));
app.use('/api/admin',               require('./routes/admin'));
app.use('/api/activity',            require('./routes/activity'));

// ── Health check ──────────────────────────────────────────────────────────────
const healthPayload = (req, res) => res.json({
  status:    'ok',
  service:   'fii-advisor-backend',
  version:   '1.0.0',
  timestamp: new Date().toISOString(),
});
app.get('/health',     healthPayload);
app.get('/api/health', healthPayload);

// ── Migrations ────────────────────────────────────────────────────────────────
async function runMigrations() {
  const pool = require('./db/connection');

  // Cada migração roda independentemente — falhas não bloqueiam as demais
  const run = async (label, sql) => {
    try {
      await pool.query(sql);
    } catch (e) {
      console.warn(`[MIGRATION:${label}]`, e.message);
    }
  };

  await run('dividends_constraint', `
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'dividends_user_ticker_exdate_unique'
      ) THEN
        ALTER TABLE dividends
          ADD CONSTRAINT dividends_user_ticker_exdate_unique
          UNIQUE (user_id, ticker, ex_date);
      END IF;
    END $$;
  `);

  await run('user_profiles_create', `
    CREATE TABLE IF NOT EXISTS user_profiles (
      id                  SERIAL PRIMARY KEY,
      user_id             TEXT NOT NULL UNIQUE,
      nome                TEXT,
      avatar_url          TEXT,
      perfil_tipo         TEXT,
      wizard_respostas    JSONB,
      wizard_completo     BOOLEAN DEFAULT FALSE,
      notif_varredura     BOOLEAN DEFAULT TRUE,
      notif_score         BOOLEAN DEFAULT TRUE,
      notif_data_com      BOOLEAN DEFAULT FALSE,
      onboarding_completo BOOLEAN DEFAULT FALSE,
      apresentacao_vista  BOOLEAN DEFAULT FALSE,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run('user_profiles_idx', `CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id)`);

  await run('user_profiles_journey_cols', `
    ALTER TABLE user_profiles
      ADD COLUMN IF NOT EXISTS apresentacao_vista  BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS journey_level       VARCHAR(20),
      ADD COLUMN IF NOT EXISTS investor_score      INTEGER,
      ADD COLUMN IF NOT EXISTS investor_profile    VARCHAR(20),
      ADD COLUMN IF NOT EXISTS tour_completo       BOOLEAN DEFAULT FALSE
  `);

  await run('portfolio_fiis_sell_cols', `
    ALTER TABLE portfolio_fiis
      ADD COLUMN IF NOT EXISTS sold_at       DATE,
      ADD COLUMN IF NOT EXISTS sold_price    NUMERIC(12,4),
      ADD COLUMN IF NOT EXISTS sold_quantity NUMERIC(12,4)
  `);

  await run('fii_scan_history', `
    CREATE TABLE IF NOT EXISTS fii_scan_history (
      id             SERIAL PRIMARY KEY,
      scanned_at     TIMESTAMPTZ DEFAULT NOW(),
      total_scanned  INTEGER,
      top3           JSONB,
      filtrados      INTEGER
    )
  `);

  await run('waitlist', `
    CREATE TABLE IF NOT EXISTS waitlist (
      id         SERIAL PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await run('simulated_portfolios', `
    CREATE TABLE IF NOT EXISTS simulated_portfolios (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          TEXT NOT NULL UNIQUE,
      initial_balance  DECIMAL(12,2) NOT NULL DEFAULT 10000.00,
      current_balance  DECIMAL(12,2) NOT NULL DEFAULT 10000.00,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await run('simulated_positions', `
    CREATE TABLE IF NOT EXISTS simulated_positions (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      portfolio_id   UUID REFERENCES simulated_portfolios(id) ON DELETE CASCADE,
      ticker         VARCHAR(10) NOT NULL,
      quantity       INTEGER NOT NULL DEFAULT 0,
      avg_price      DECIMAL(10,4) NOT NULL,
      current_price  DECIMAL(10,4),
      last_updated   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(portfolio_id, ticker)
    )
  `);

  await run('simulated_transactions', `
    CREATE TABLE IF NOT EXISTS simulated_transactions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      portfolio_id  UUID REFERENCES simulated_portfolios(id) ON DELETE CASCADE,
      ticker        VARCHAR(10) NOT NULL,
      operation     VARCHAR(10) NOT NULL CHECK (operation IN ('buy', 'sell', 'dividend')),
      quantity      INTEGER,
      price         DECIMAL(10,4),
      total         DECIMAL(12,2) NOT NULL,
      executed_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await run('portfolio_recommendations', `
    CREATE TABLE IF NOT EXISTS portfolio_recommendations (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          TEXT NOT NULL UNIQUE,
      generated_at     TIMESTAMPTZ DEFAULT NOW(),
      profile_score    INTEGER,
      investor_profile VARCHAR(20),
      recommendation   JSONB NOT NULL,
      accepted         BOOLEAN DEFAULT FALSE
    )
  `);

  await run('fiis_market', `
    CREATE TABLE IF NOT EXISTS fiis_market (
      ticker     VARCHAR(10) PRIMARY KEY,
      name       TEXT,
      price      DECIMAL(10,4),
      dy_12m     DECIMAL(8,4),
      pvp        DECIMAL(8,4),
      liquidity  DECIMAL(16,2),
      net_worth  DECIMAL(16,2),
      score      INTEGER,
      action     TEXT,
      scanned_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run('fiis_market_cols', `
    ALTER TABLE fiis_market
      ADD COLUMN IF NOT EXISTS segment    TEXT,
      ADD COLUMN IF NOT EXISTS vacancy    DECIMAL(8,4),
      ADD COLUMN IF NOT EXISTS properties INTEGER
  `);

  await run('top10_synthesis', `
    CREATE TABLE IF NOT EXISTS top10_synthesis (
      id           SERIAL PRIMARY KEY,
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      synthesis    TEXT,
      top_tickers  JSONB
    )
  `);

  await run('fii_dados', `
    CREATE TABLE IF NOT EXISTS fii_dados (
      ticker          VARCHAR(10) PRIMARY KEY,
      name            TEXT,
      segment         TEXT,
      price           DECIMAL(10,4),
      dy_12m          DECIMAL(8,4),
      pvp             DECIMAL(8,4),
      vacancy         DECIMAL(8,4),
      liquidity       DECIMAL(16,2),
      leverage        DECIMAL(8,4),
      properties      INTEGER,
      div_growth      DECIMAL(8,4),
      wault           DECIMAL(8,4),
      ultimo_dy_valor DECIMAL(10,6),
      score           INTEGER,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await run('sim_indexes', `
    CREATE INDEX IF NOT EXISTS idx_sim_positions_portfolio
      ON simulated_positions(portfolio_id)
  `);
  await run('sim_tx_index', `
    CREATE INDEX IF NOT EXISTS idx_sim_transactions_portfolio_date
      ON simulated_transactions(portfolio_id, executed_at DESC)
  `);
  await run('rec_index', `
    CREATE INDEX IF NOT EXISTS idx_portfolio_recommendations_user
      ON portfolio_recommendations(user_id)
  `);

  // ── Migration 009: Dual Score Profile System ──────────────────────────────
  await run('dual_score_cols', `
    ALTER TABLE user_profiles
      ADD COLUMN IF NOT EXISTS financial_score       INTEGER CHECK (financial_score BETWEEN 0 AND 100),
      ADD COLUMN IF NOT EXISTS financial_moment      VARCHAR(20) CHECK (financial_moment IN ('saudavel', 'cauteloso', 'restrito')),
      ADD COLUMN IF NOT EXISTS financial_wizard_data JSONB,
      ADD COLUMN IF NOT EXISTS financial_updated_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS financial_wizard_done BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS investor_score_v2     INTEGER CHECK (investor_score_v2 BETWEEN 0 AND 100),
      ADD COLUMN IF NOT EXISTS investor_profile_v2   VARCHAR(20) CHECK (investor_profile_v2 IN ('conservador','moderado','arrojado','sofisticado')),
      ADD COLUMN IF NOT EXISTS investor_wizard_data  JSONB,
      ADD COLUMN IF NOT EXISTS investor_updated_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS investor_wizard_done  BOOLEAN DEFAULT FALSE
  `);

  await run('dual_score_migrate_existing', `
    UPDATE user_profiles
    SET investor_score_v2    = investor_score,
        investor_profile_v2  = investor_profile,
        investor_wizard_done = wizard_completo,
        investor_updated_at  = updated_at
    WHERE investor_score IS NOT NULL
      AND investor_score_v2 IS NULL
  `);

  await run('profile_score_history', `
    CREATE TABLE IF NOT EXISTS profile_score_history (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        TEXT NOT NULL,
      score_type     VARCHAR(20) NOT NULL CHECK (score_type IN ('financial', 'investor')),
      score          INTEGER NOT NULL,
      profile_result VARCHAR(20) NOT NULL,
      wizard_data    JSONB,
      calculated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run('idx_score_history', `
    CREATE INDEX IF NOT EXISTS idx_score_history_user
      ON profile_score_history(user_id, score_type, calculated_at DESC)
  `);

  // ── Migration 010: Reset perfil dos usuários para o novo dual wizard ─────────
  // Marca todos os perfis como pendentes no novo sistema sem apagar dados legados
  await run('reset_dual_wizard_flags', `
    UPDATE user_profiles
    SET investor_wizard_done = FALSE,
        financial_wizard_done = FALSE
    WHERE investor_wizard_done IS TRUE
       OR financial_wizard_done IS TRUE
       OR investor_score_v2 IS NOT NULL
       OR financial_score IS NOT NULL
  `);

  console.log('[MIGRATIONS] concluídas');
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function iniciarScheduler() {
  const cron = require('node-cron');
  const pool = require('./db/connection');
  const { sincronizarTodosProventos } = require('./scheduler/fii-proventos-sync');

  // Sync de proventos: diariamente às 20h30 (Brasília)
  cron.schedule('30 20 * * *', async () => {
    console.log('[CRON] Sincronizando proventos de todos os usuários...');
    try {
      await sincronizarTodosProventos();
    } catch (err) {
      console.error('[CRON] Erro sync proventos:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  // Atualizar preços da carteira simulada: dias úteis às 18h
  cron.schedule('0 18 * * 1-5', async () => {
    console.log('[CRON] Atualizando preços carteira simulada...');
    try {
      const pool = require('./db/connection');
      const { buscarFII } = require('./collectors/fundamentus');
      const { rows } = await pool.query('SELECT DISTINCT ticker FROM simulated_positions');
      for (const { ticker } of rows) {
        try {
          const data = await buscarFII(ticker);
          if (data?.price) {
            await pool.query(
              'UPDATE simulated_positions SET current_price = $1, last_updated = NOW() WHERE ticker = $2',
              [data.price, ticker]
            );
          }
        } catch (_) {}
      }
      console.log(`[CRON] ${rows.length} tickers atualizados`);
    } catch (err) {
      console.error('[CRON] Erro update preços:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  // Varredura de mercado (popula fiis_market para recomendações): dias úteis às 7h
  const { rodarFIIScanner } = require('./scheduler/fii-scanner');
  cron.schedule('0 7 * * 1-5', async () => {
    console.log('[CRON] Rodando varredura de FIIs...');
    try {
      await rodarFIIScanner();
      console.log('[CRON] Varredura concluída');
    } catch (err) {
      console.error('[CRON] Erro varredura:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  // Varredura no startup — sempre, para popular/atualizar fiis_market
  setImmediate(async () => {
    try {
      console.log('[STARTUP] Rodando varredura inicial de FIIs...');
      await rodarFIIScanner();
      console.log('[STARTUP] Varredura inicial concluída.');
    } catch (err) {
      console.warn('[STARTUP] Varredura inicial falhou:', err.message);
    }
  });

  console.log('[CRON] Scheduler FII iniciado');
}

// ── Start ─────────────────────────────────────────────────────────────────────
// Migrations rodam ANTES do servidor aceitar conexões (evita race condition em cold start)
(async () => {
  await runMigrations();
  iniciarScheduler();
  app.listen(PORT, () => {
    console.log(`\n🚀 FII Advisor API rodando na porta ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/health\n`);
  });
})();

module.exports = app;
