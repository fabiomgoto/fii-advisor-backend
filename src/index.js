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
  try {
    const pool = require('./db/connection');

    await pool.query(`
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

    await pool.query(`
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
      );
      CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
    `);

    // Colunas de jornada (adicionadas no Sprint das jornadas)
    await pool.query(`
      ALTER TABLE user_profiles
        ADD COLUMN IF NOT EXISTS apresentacao_vista  BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS journey_level       VARCHAR(20),
        ADD COLUMN IF NOT EXISTS investor_score      INTEGER,
        ADD COLUMN IF NOT EXISTS investor_profile    VARCHAR(20),
        ADD COLUMN IF NOT EXISTS tour_completo       BOOLEAN DEFAULT FALSE;
    `);

    // Histórico de varreduras
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fii_scan_history (
        id             SERIAL PRIMARY KEY,
        scanned_at     TIMESTAMPTZ DEFAULT NOW(),
        total_scanned  INTEGER,
        top3           JSONB,
        filtrados      INTEGER
      );
    `);

    // Waitlist PRO
    await pool.query(`
      CREATE TABLE IF NOT EXISTS waitlist (
        id         SERIAL PRIMARY KEY,
        email      TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Carteira simulada
    await pool.query(`
      CREATE TABLE IF NOT EXISTS simulated_portfolios (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          TEXT NOT NULL UNIQUE,
        initial_balance  DECIMAL(12,2) NOT NULL DEFAULT 10000.00,
        current_balance  DECIMAL(12,2) NOT NULL DEFAULT 10000.00,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS simulated_positions (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        portfolio_id   UUID REFERENCES simulated_portfolios(id) ON DELETE CASCADE,
        ticker         VARCHAR(10) NOT NULL,
        quantity       INTEGER NOT NULL DEFAULT 0,
        avg_price      DECIMAL(10,4) NOT NULL,
        current_price  DECIMAL(10,4),
        last_updated   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(portfolio_id, ticker)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS simulated_transactions (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        portfolio_id  UUID REFERENCES simulated_portfolios(id) ON DELETE CASCADE,
        ticker        VARCHAR(10) NOT NULL,
        operation     VARCHAR(10) NOT NULL CHECK (operation IN ('buy', 'sell', 'dividend')),
        quantity      INTEGER,
        price         DECIMAL(10,4),
        total         DECIMAL(12,2) NOT NULL,
        executed_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Recomendações de carteira
    await pool.query(`
      CREATE TABLE IF NOT EXISTS portfolio_recommendations (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          TEXT NOT NULL UNIQUE,
        generated_at     TIMESTAMPTZ DEFAULT NOW(),
        profile_score    INTEGER,
        investor_profile VARCHAR(20),
        recommendation   JSONB NOT NULL,
        accepted         BOOLEAN DEFAULT FALSE
      );
    `);

    // Cache de dados de FIIs para recomendações
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fii_dados (
        ticker       VARCHAR(10) PRIMARY KEY,
        name         TEXT,
        segment      TEXT,
        price        DECIMAL(10,4),
        dy_12m       DECIMAL(8,4),
        pvp          DECIMAL(8,4),
        vacancy      DECIMAL(8,4),
        liquidity    DECIMAL(16,2),
        leverage     DECIMAL(8,4),
        properties   INTEGER,
        div_growth   DECIMAL(8,4),
        wault        DECIMAL(8,4),
        ultimo_dy_valor DECIMAL(10,6),
        score        INTEGER,
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log('[MIGRATIONS] OK');
  } catch (e) {
    console.warn('[MIGRATIONS]', e.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function iniciarScheduler() {
  const cron = require('node-cron');
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

  console.log('[CRON] Scheduler FII iniciado');
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 FII Advisor API rodando na porta ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
  await runMigrations();
  iniciarScheduler();
});

module.exports = app;
