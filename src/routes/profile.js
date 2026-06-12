/**
 * profile.js — rotas de perfil do usuário
 *
 * GET    /api/profile              → busca ou cria perfil
 * PUT    /api/profile              → atualiza nome/avatar
 * PUT    /api/profile/wizard       → salva respostas + calcula perfil_tipo
 * PUT    /api/profile/notificacoes → atualiza prefs de notificação
 * PUT    /api/profile/onboarding   → marca onboarding como completo
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');

// Todas as rotas de perfil exigem autenticação
router.use(auth);

function getUserId(req) {
  return req.userId;
}

/** Classifica perfil_tipo a partir das respostas do wizard */
function classificarPerfil(respostas) {
  const { objetivo, horizonte, dy_minimo } = respostas;
  if (objetivo === 'renda' && (parseFloat(dy_minimo) >= 10 || dy_minimo === 'acima_12' || dy_minimo === 'acima_10')) {
    return 'renda';
  }
  if (objetivo === 'crescimento' && (horizonte === '5_10anos' || horizonte === 'mais_10anos')) {
    return 'crescimento';
  }
  if (objetivo === 'seguranca') {
    return 'seguranca';
  }
  return 'equilibrio';
}

// GET /api/profile — busca ou cria perfil
router.get('/', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { rows } = await pool.query(
      'SELECT * FROM user_profiles WHERE user_id = $1',
      [userId]
    );
    if (rows.length) return res.json(rows[0]);

    // Cria perfil vazio
    const { rows: created } = await pool.query(
      `INSERT INTO user_profiles (user_id) VALUES ($1) RETURNING *`,
      [userId]
    );
    res.json(created[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/profile — atualiza nome/avatar/apresentacao_vista
router.put('/', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { nome, avatar_url, apresentacao_vista } = req.body;

    // Monta SET dinâmico
    const sets = ['updated_at = NOW()'];
    const vals = [userId];
    if (nome             !== undefined) { vals.push(nome);             sets.push(`nome = $${vals.length}`); }
    if (avatar_url       !== undefined) { vals.push(avatar_url);       sets.push(`avatar_url = $${vals.length}`); }
    if (apresentacao_vista !== undefined) { vals.push(apresentacao_vista); sets.push(`apresentacao_vista = $${vals.length}`); }

    const { rows } = await pool.query(
      `INSERT INTO user_profiles (user_id, updated_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET ${sets.join(', ')}
       RETURNING *`,
      vals
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/profile/wizard — salva respostas + calcula perfil_tipo
router.put('/wizard', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { respostas } = req.body;
    if (!respostas) return res.status(400).json({ error: 'respostas obrigatório' });

    const perfil_tipo = classificarPerfil(respostas);

    const { rows } = await pool.query(
      `INSERT INTO user_profiles (user_id, wizard_respostas, wizard_completo, perfil_tipo, updated_at)
       VALUES ($1, $2, TRUE, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET wizard_respostas = EXCLUDED.wizard_respostas,
             wizard_completo  = TRUE,
             perfil_tipo      = EXCLUDED.perfil_tipo,
             updated_at       = NOW()
       RETURNING *`,
      [userId, JSON.stringify(respostas), perfil_tipo]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/profile/notificacoes — atualiza preferências
router.put('/notificacoes', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { notif_varredura, notif_score, notif_data_com } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO user_profiles (user_id, notif_varredura, notif_score, notif_data_com, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET notif_varredura = EXCLUDED.notif_varredura,
             notif_score     = EXCLUDED.notif_score,
             notif_data_com  = EXCLUDED.notif_data_com,
             updated_at      = NOW()
       RETURNING *`,
      [userId,
       notif_varredura != null ? notif_varredura : true,
       notif_score     != null ? notif_score     : true,
       notif_data_com  != null ? notif_data_com  : false]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/profile/onboarding — marca como completo
router.put('/onboarding', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { rows } = await pool.query(
      `INSERT INTO user_profiles (user_id, onboarding_completo, updated_at)
       VALUES ($1, TRUE, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET onboarding_completo = TRUE,
             updated_at = NOW()
       RETURNING *`,
      [userId]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/profile/account — exclui todos os dados do usuário e a conta Supabase
router.delete('/account', async (req, res) => {
  const userId = getUserId(req);
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

    // Deleta o usuário no Supabase Auth (requer service_role key)
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey) {
      const { createClient } = require('@supabase/supabase-js');
      const admin = createClient(process.env.SUPABASE_URL, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      await admin.auth.admin.deleteUser(userId);
    }

    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[profile] deleteAccount:', err.message);
    res.status(500).json({ error: 'Erro ao excluir conta: ' + err.message });
  } finally {
    client.release();
  }
});

// ── Dual Score endpoints ──────────────────────────────────────────────────────
const dualCtrl = require('../controllers/profileController');

router.post('/financial-score', dualCtrl.saveFinancialScore);
router.post('/investor-score',  dualCtrl.saveInvestorScore);
router.get('/dual-score',       dualCtrl.getDualScore);
router.get('/score-history',    dualCtrl.getScoreHistory);

module.exports = router;
