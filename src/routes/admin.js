'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');

const ADMIN_IDS = new Set([
  '4897248a-f6e3-46c0-b801-6b7c5ac2ea82', // fabiomgoto@yahoo.com.br
  'd2083b36-3899-4287-9649-e4b20e1f9103', // fabiomgoto@gmail.com
]);

function requireAdmin(req, res, next) {
  if (!ADMIN_IDS.has(req.userId)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
}

router.use(auth);
router.use(requireAdmin);

// GET /api/admin/users — lista todos os usuários com perfil
router.get('/users', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supaAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const [{ data: authData }, profilesRes] = await Promise.all([
      supaAdmin.auth.admin.listUsers({ perPage: 1000 }),
      pool.query(`
        SELECT user_id, journey_level, onboarding_completo,
               investor_wizard_done, financial_wizard_done,
               investor_profile_v2, financial_moment,
               investor_score_v2, financial_score,
               created_at, updated_at
        FROM user_profiles
      `),
    ]);

    const profileMap = {};
    for (const p of profilesRes.rows) profileMap[p.user_id] = p;

    const users = authData.users.map(u => {
      const p = profileMap[u.id] || {};
      return {
        id:                   u.id,
        email:                u.email,
        created_at:           u.created_at,
        last_sign_in:         u.last_sign_in_at,
        journey_level:        p.journey_level        || null,
        onboarding_completo:  p.onboarding_completo  || false,
        investor_wizard_done: p.investor_wizard_done || false,
        financial_wizard_done:p.financial_wizard_done|| false,
        investor_profile:     p.investor_profile_v2  || null,
        financial_moment:     p.financial_moment     || null,
        investor_score:       p.investor_score_v2    || null,
        financial_score:      p.financial_score      || null,
        profile_updated_at:   p.updated_at           || null,
      };
    });

    // Mais recentes primeiro
    users.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ users, total: users.length });
  } catch (err) {
    console.error('[admin] listUsers:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/:userId/reset-wizard — reseta flags do dual wizard
router.post('/users/:userId/reset-wizard', async (req, res) => {
  try {
    await pool.query(
      `UPDATE user_profiles
       SET investor_wizard_done = false, financial_wizard_done = false,
           investor_score_v2 = null, investor_profile_v2 = null,
           financial_score = null, financial_moment = null,
           updated_at = NOW()
       WHERE user_id = $1`,
      [req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/users/:userId/journey — altera nível de jornada
router.patch('/users/:userId/journey', async (req, res) => {
  const { journey_level } = req.body;
  const VALID = ['iniciante', 'intermediario', 'avancado'];
  if (!VALID.includes(journey_level)) {
    return res.status(400).json({ error: 'journey_level inválido' });
  }
  try {
    await pool.query(
      `UPDATE user_profiles SET journey_level = $1, updated_at = NOW() WHERE user_id = $2`,
      [journey_level, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users/:userId/portfolio — carteira detalhada do usuário
router.get('/users/:userId/portfolio', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pf.ticker, pf.quantity, pf.avg_price,
              fm.price, fm.dy_12m, fm.pvp, fm.score,
              COALESCE(c.total_aportado, 0)  AS total_aportado,
              COALESCE(pr.total_proventos, 0) AS total_proventos
       FROM portfolio_fiis pf
       LEFT JOIN fiis_market fm ON fm.ticker = pf.ticker
       LEFT JOIN (
         SELECT ticker, SUM(quantity * price_paid) AS total_aportado
         FROM contributions WHERE user_id = $1 GROUP BY ticker
       ) c  ON c.ticker  = pf.ticker
       LEFT JOIN (
         SELECT ticker, SUM(total_recebido) AS total_proventos
         FROM fii_proventos WHERE user_id = $1 GROUP BY ticker
       ) pr ON pr.ticker = pf.ticker
       WHERE pf.user_id = $1
       ORDER BY (pf.quantity * COALESCE(fm.price, pf.avg_price, 0)) DESC`,
      [req.params.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/carteiras — resumo de todas as carteiras (admin overview)
router.get('/carteiras', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        pf.user_id,
        COUNT(DISTINCT pf.ticker)                                             AS num_fiis,
        SUM(pf.quantity * COALESCE(fm.price, pf.avg_price, 0))               AS valor_atual,
        SUM(pf.quantity * pf.avg_price)                                       AS total_investido,
        COALESCE(pr.total_proventos, 0)                                       AS total_proventos,
        up.investor_profile_v2  AS perfil,
        up.financial_moment     AS momento,
        up.journey_level
      FROM portfolio_fiis pf
      LEFT JOIN fiis_market fm   ON fm.ticker   = pf.ticker
      LEFT JOIN user_profiles up ON up.user_id  = pf.user_id
      LEFT JOIN (
        SELECT user_id, SUM(total_recebido) AS total_proventos
        FROM fii_proventos GROUP BY user_id
      ) pr ON pr.user_id = pf.user_id
      GROUP BY pf.user_id, pr.total_proventos, up.investor_profile_v2, up.financial_moment, up.journey_level
      ORDER BY valor_atual DESC NULLS LAST
    `);

    // Busca emails via Supabase Admin
    const { createClient } = require('@supabase/supabase-js');
    const supaAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: { users: authUsers } } = await supaAdmin.auth.admin.listUsers({ perPage: 1000 });
    const emailMap = {};
    for (const u of authUsers) emailMap[u.id] = u.email;

    res.json(rows.map(r => ({ ...r, email: emailMap[r.user_id] || r.user_id })));
  } catch (err) {
    console.error('[admin/carteiras]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stats — métricas gerais da plataforma
router.get('/stats', async (req, res) => {
  try {
    const [userRes, portfolioRes, scanRes, proventosRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total_users,
          COUNT(*) FILTER (WHERE onboarding_completo) AS onboarding_ok,
          COUNT(*) FILTER (WHERE investor_wizard_done AND financial_wizard_done) AS dual_ok,
          COUNT(*) FILTER (WHERE journey_level = 'iniciante') AS iniciante,
          COUNT(*) FILTER (WHERE journey_level = 'intermediario') AS intermediario,
          COUNT(*) FILTER (WHERE journey_level = 'avancado') AS avancado
        FROM user_profiles
      `),
      pool.query(`
        SELECT COUNT(DISTINCT user_id) AS users_with_portfolio,
               COUNT(*) AS total_positions,
               COUNT(DISTINCT ticker) AS unique_tickers
        FROM portfolio_fiis
      `),
      pool.query(`
        SELECT COUNT(*) AS total_scans,
               MAX(scanned_at) AS last_scan,
               (SELECT total_scanned FROM fii_scan_history ORDER BY scanned_at DESC LIMIT 1) AS last_total
        FROM fii_scan_history
      `),
      pool.query(`
        SELECT COUNT(*) AS total_dividends,
               COUNT(DISTINCT user_id) AS users_with_dividends
        FROM dividends
      `),
    ]);
    res.json({
      users:     userRes.rows[0],
      portfolio: portfolioRes.rows[0],
      scan:      scanRes.rows[0],
      proventos: proventosRes.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/scan-history — histórico de varreduras (admin view)
router.get('/scan-history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, scanned_at, total_scanned, top3, filtrados
       FROM fii_scan_history ORDER BY scanned_at DESC LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:userId — exclui conta
router.delete('/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM profile_score_history     WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM portfolio_recommendations WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM dividends                 WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM contributions             WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM portfolio_fiis            WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM simulated_portfolios      WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_profiles             WHERE user_id = $1', [userId]);
    await client.query('COMMIT');

    const { createClient } = require('@supabase/supabase-js');
    const supaAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    await supaAdmin.auth.admin.deleteUser(userId);

    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
