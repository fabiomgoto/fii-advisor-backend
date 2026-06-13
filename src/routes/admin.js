'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');

const ADMIN_IDS = new Set([
  '4897248a-f6e3-46c0-b801-6b7c5ac2ea82', // fabiomgoto@yahoo.com.br
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
