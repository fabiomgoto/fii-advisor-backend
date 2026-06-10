require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3002;

// ── Middlewares ───────────────────────────────────────────────────────────────
app.use(cors({ origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.options('*', cors({ origin: true }));
app.use(express.json());

// ── Rotas ─────────────────────────────────────────────────────────────────────
app.use('/api/fiis',    require('./routes/fiis'));
app.use('/api/profile', require('./routes/profile'));

// ── Health check (Railway usa /health; alias /api/health para compatibilidade) ─
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

    // Migration: adicionar apresentacao_vista se não existir
    await pool.query(`
      ALTER TABLE user_profiles
        ADD COLUMN IF NOT EXISTS apresentacao_vista BOOLEAN DEFAULT FALSE;
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
