require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const { generalLimiter } = require('./middleware/rateLimiter');

const app  = express();
const PORT = process.env.PORT || 3002;

// ── Middlewares ───────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://brapi.dev', 'https://statusinvest.com.br'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] }));
app.options('*', cors({ origin: true }));
app.use(express.json());
app.use(generalLimiter);

// ── Rotas ─────────────────────────────────────────────────────────────────────
app.use('/api/fiis',                require('./routes/fiis'));
app.use('/api/profile',             require('./routes/profile'));
app.use('/api/onboarding',          require('./routes/onboarding'));
app.use('/api/recommendations',     require('./routes/recommendations'));
app.use('/api/simulated-portfolio', require('./routes/simulatedPortfolio'));
app.use('/api/admin',               require('./routes/admin'));
app.use('/api/activity',            require('./routes/activity'));
app.use(require('./middleware/errorHandler'));

// ── Health check (rico) ───────────────────────────────────────────────────────
app.get(['/health', '/api/health'], async (req, res) => {
  try {
    const pool = require('./db/connection');
    const { getSourceStatus } = require('./services/dataProvider');

    const [{ rows }, scrapingSources] = await Promise.all([
      pool.query(`
        SELECT DISTINCT ON (source)
          source, status, response_time_ms, checked_at, error_message
        FROM health_checks
        ORDER BY source, checked_at DESC
      `),
      getSourceStatus(),
    ]);

    const checks = rows.map(r => ({
      source:           r.source,
      status:           r.status,
      response_time_ms: r.response_time_ms,
      last_checked:     r.checked_at,
      error:            r.error_message || null,
    }));

    const summary = {
      total: checks.length,
      ok:    checks.filter(c => c.status === 'ok').length,
      warn:  checks.filter(c => c.status === 'warn').length,
      fail:  checks.filter(c => c.status === 'fail').length,
    };

    const status = summary.fail > 0 ? 'down' : summary.warn > 0 ? 'degraded' : 'ok';

    res.json({ status, timestamp: new Date().toISOString(), checks, summary, scraping_sources: scrapingSources });
  } catch (_) {
    res.json({
      status:    'ok',
      service:   'fii-advisor-backend',
      version:   '1.0.0',
      timestamp: new Date().toISOString(),
      checks:    [],
      summary:   { total: 0, ok: 0, warn: 0, fail: 0 },
      scraping_sources: [],
    });
  }
});

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
      ADD COLUMN IF NOT EXISTS segment         TEXT,
      ADD COLUMN IF NOT EXISTS vacancy         DECIMAL(8,4),
      ADD COLUMN IF NOT EXISTS properties      INTEGER,
      ADD COLUMN IF NOT EXISTS segmento        TEXT,
      ADD COLUMN IF NOT EXISTS score_breakdown JSONB,
      ADD COLUMN IF NOT EXISTS cobertura_pct   DECIMAL(5,2),
      ADD COLUMN IF NOT EXISTS score_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS wault           DECIMAL(8,4),
      ADD COLUMN IF NOT EXISTS leverage        DECIMAL(8,4),
      ADD COLUMN IF NOT EXISTS div_growth      DECIMAL(8,4),
      ADD COLUMN IF NOT EXISTS consistency     DECIMAL(5,2)
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

  // ── Migration 010: Reset perfil (one-time, já aplicado) ─────────────────────
  // Removido: resetava wizard_done em cada startup, impedindo login.

  // ── Migration 009a: Portfolio Snapshots ──────────────────────────────────
  await run('portfolio_snapshots_table', `
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id              SERIAL PRIMARY KEY,
      user_id         UUID         NOT NULL,
      snapshot_date   DATE         NOT NULL DEFAULT CURRENT_DATE,
      valor_atual     NUMERIC(14,2) NOT NULL,
      total_investido NUMERIC(14,2) NOT NULL,
      variacao_dia    NUMERIC(14,2),
      variacao_pct    NUMERIC(6,4),
      detalhes        JSONB,
      created_at      TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE (user_id, snapshot_date)
    )
  `);
  await run('portfolio_snapshots_idx', `
    CREATE INDEX IF NOT EXISTS idx_snapshots_user_date
      ON portfolio_snapshots (user_id, snapshot_date DESC)
  `);

  // ── Migration 009b: DataProvider — evolução fii_enriched_cache ──────────
  await run('enriched_cache_source_col', `
    ALTER TABLE fii_enriched_cache
      ADD COLUMN IF NOT EXISTS source       VARCHAR(50),
      ADD COLUMN IF NOT EXISTS is_stale     BOOLEAN      DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS stale_since  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS versioned_at TIMESTAMPTZ  DEFAULT NOW()
  `);
  await run('enriched_cache_versioned_idx', `
    CREATE INDEX IF NOT EXISTS idx_enriched_ticker_versioned
      ON fii_enriched_cache (ticker, versioned_at DESC)
  `);
  await run('scraping_source_status', `
    CREATE TABLE IF NOT EXISTS scraping_source_status (
      source           VARCHAR(50) PRIMARY KEY,
      is_active        BOOLEAN     DEFAULT TRUE,
      fail_count       INTEGER     DEFAULT 0,
      last_fail_at     TIMESTAMPTZ,
      disabled_until   TIMESTAMPTZ,
      last_success_at  TIMESTAMPTZ,
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run('scraping_source_status_seed', `
    INSERT INTO scraping_source_status (source) VALUES
      ('funds_explorer'), ('status_invest'), ('fundamentus')
    ON CONFLICT (source) DO NOTHING
  `);

  // ── Migration 010: Health Checks ─────────────────────────────────────────
  await run('health_checks_table', `
    CREATE TABLE IF NOT EXISTS health_checks (
      id               SERIAL PRIMARY KEY,
      checked_at       TIMESTAMPTZ DEFAULT NOW(),
      source           VARCHAR(50)  NOT NULL,
      status           VARCHAR(10)  NOT NULL CHECK (status IN ('ok','fail','warn')),
      response_time_ms INTEGER,
      sample_ticker    VARCHAR(20),
      error_message    TEXT,
      fields_returned  JSONB
    )
  `);
  await run('health_checks_idx', `
    CREATE INDEX IF NOT EXISTS idx_health_checks_source_date
      ON health_checks (source, checked_at DESC)
  `);

  // ── Migration 011: Error Logs ─────────────────────────────────────────────
  await run('error_logs_table', `
    CREATE TABLE IF NOT EXISTS error_logs (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type        VARCHAR(50)  NOT NULL,
      source      VARCHAR(200),
      message     TEXT         NOT NULL,
      stack       TEXT,
      metadata    JSONB,
      user_id     UUID,
      severity    VARCHAR(20)  NOT NULL DEFAULT 'error',
      resolved    BOOLEAN      NOT NULL DEFAULT FALSE,
      resolved_at TIMESTAMP,
      resolved_by VARCHAR(100),
      created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
    )
  `);
  await run('error_logs_idx_type',     `CREATE INDEX IF NOT EXISTS idx_error_logs_type     ON error_logs(type)`);
  await run('error_logs_idx_severity', `CREATE INDEX IF NOT EXISTS idx_error_logs_severity ON error_logs(severity)`);
  await run('error_logs_idx_resolved', `CREATE INDEX IF NOT EXISTS idx_error_logs_resolved ON error_logs(resolved)`);
  await run('error_logs_idx_created',  `CREATE INDEX IF NOT EXISTS idx_error_logs_created  ON error_logs(created_at DESC)`);

  // ── Cleanup: remove fii_scan_history rows where top3 stored full calcularScore() object ──
  await run('cleanup_stale_scan_history_top3', `
    DELETE FROM fii_scan_history
    WHERE top3::text LIKE '%score_breakdown%'
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

  // Varredura completa diária: todos os ~400 FIIs + score segmentado
  // 07h: importa Fundamentus + enriquece cache + aplica scorer segmentado
  // 18h30: rescore com preços do fechamento (sem rebuscar tudo)
  const { rodarVarreduraCompleta, rodarScoringDiario } = require('./scheduler/fii-daily-scorer');

  cron.schedule('0 7 * * 1-5', async () => {
    console.log('[CRON] Varredura completa (400+ FIIs)...');
    try {
      const r = await rodarVarreduraCompleta();
      console.log(`[CRON] Varredura completa: ${r.importados} importados, ${r.erros} erros`);
    } catch (err) {
      console.error('[CRON] Erro varredura completa:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  cron.schedule('30 18 * * 1-5', async () => {
    console.log('[CRON] Scoring diário segmentado...');
    try {
      await rodarScoringDiario();
    } catch (err) {
      console.error('[CRON] Erro scoring diário:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  // Snapshots de carteira: logo após varredura das 07h (07h30, dias úteis)
  const { runPortfolioSnapshots } = require('./services/portfolioSnapshotService');
  cron.schedule('30 7 * * 1-5', async () => {
    console.log('[CRON] Gerando snapshots de carteira...');
    try {
      await runPortfolioSnapshots();
      console.log('[CRON] Snapshots de carteira gerados');
    } catch (err) {
      console.error('[CRON] Erro snapshots:', err.message);
    }
  }, { timezone: 'America/Sao_Paulo' });

  // Startup: varredura completa só se fiis_market estiver vazio ou desatualizado (> 25h)
  setImmediate(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS n FROM fiis_market WHERE score_updated_at > NOW() - INTERVAL '25 hours'`
      );
      if (parseInt(rows[0]?.n || 0) > 50) {
        console.log('[STARTUP] fiis_market atualizado, pulando varredura inicial.');
        return;
      }
      console.log('[STARTUP] Rodando varredura completa inicial...');
      const r = await rodarVarreduraCompleta();
      console.log(`[STARTUP] Varredura inicial: ${r.importados} importados.`);
    } catch (err) {
      console.warn('[STARTUP] Varredura inicial falhou:', err.message);
    }
  });

  // Health check diário às 08:30 (Brasília = UTC-3 → '30 11 * * *')
  const { runHealthChecks } = require('./services/healthCheckService');
  cron.schedule('30 11 * * *', async () => {
    console.log('[CRON] Rodando health check das fontes de dados...');
    try {
      await runHealthChecks();
      console.log('[CRON] Health check concluído');
    } catch (err) {
      console.error('[CRON] Erro no health check:', err.message);
    }
  }, { timezone: 'UTC' });

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
