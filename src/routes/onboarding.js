const express = require('express');
const router  = express.Router();
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const { calculateInvestorScore } = require('../engine/wizard-scorer');

// Todas as rotas de onboarding exigem auth
router.use(auth);

// ── POST /api/onboarding/triagem ─────────────────────────────────────────────
// Salva o nível de jornada escolhido na triagem
router.post('/triagem', async (req, res) => {
  const { journey_level } = req.body;
  const userId = req.userId;

  const VALID = ['iniciante', 'intermediario', 'avancado'];
  if (!VALID.includes(journey_level)) {
    return res.status(400).json({ error: 'journey_level inválido. Use: iniciante, intermediario ou avancado' });
  }

  try {
    await pool.query(
      `INSERT INTO user_profiles (user_id, journey_level)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET journey_level = $2, updated_at = NOW()`,
      [userId, journey_level]
    );
    res.json({ success: true, journey_level });
  } catch (e) {
    console.error('[onboarding/triagem]', e.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── GET /api/onboarding/status ───────────────────────────────────────────────
router.get('/status', async (req, res) => {
  const userId = req.userId;
  try {
    const { rows } = await pool.query(
      `SELECT journey_level, wizard_completo, onboarding_completo,
              tour_completo, investor_score, investor_profile,
              apresentacao_vista
       FROM user_profiles WHERE user_id = $1`,
      [userId]
    );
    if (!rows.length) {
      return res.json({
        journey_level: null, wizard_completo: false,
        onboarding_completo: false, tour_completo: false,
        investor_score: null, investor_profile: null,
      });
    }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── POST /api/onboarding/wizard/step/:step ───────────────────────────────────
// Salva a resposta de uma etapa do wizard (merge no JSONB wizard_respostas)
router.post('/wizard/step/:step', async (req, res) => {
  const { step } = req.params;
  const { data } = req.body;
  const userId = req.userId;

  try {
    // Merge atômico com || JSONB — elimina race condition de read-modify-write
    const stepKey = `step${parseInt(step)}`;
    const stepJson = JSON.stringify({ [stepKey]: data });

    await pool.query(
      `INSERT INTO user_profiles (user_id, wizard_respostas)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET wizard_respostas = COALESCE(user_profiles.wizard_respostas, '{}') || $2::jsonb,
             updated_at = NOW()`,
      [userId, stepJson]
    );
    res.json({ success: true, step: parseInt(step) });
  } catch (e) {
    console.error('[wizard/step]', e.message);
    res.status(500).json({ error: 'Erro ao salvar etapa do wizard' });
  }
});

// ── GET /api/onboarding/wizard/progress ──────────────────────────────────────
router.get('/wizard/progress', async (req, res) => {
  const userId = req.userId;
  try {
    const { rows } = await pool.query(
      'SELECT wizard_respostas, wizard_completo FROM user_profiles WHERE user_id = $1',
      [userId]
    );
    const wizardData = rows[0]?.wizard_respostas || {};
    const completedSteps = Object.keys(wizardData).length;
    res.json({ wizard_data: wizardData, completed_steps: completedSteps, total_steps: 10 });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── POST /api/onboarding/wizard/complete ─────────────────────────────────────
// Calcula score e classifica perfil
router.post('/wizard/complete', async (req, res) => {
  const userId = req.userId;
  try {
    const { rows } = await pool.query(
      'SELECT wizard_respostas FROM user_profiles WHERE user_id = $1',
      [userId]
    );

    // wizardData pode ser null se nenhum step foi salvo — usa objeto vazio (score resultará em ~50)
    const wizardData = rows[0]?.wizard_respostas || {};

    const { score, profile, blocks } = calculateInvestorScore(wizardData);

    // Tenta UPDATE; se a row não existir, cria com INSERT
    const updated = await pool.query(
      `UPDATE user_profiles
       SET wizard_completo  = TRUE,
           investor_score   = $1,
           investor_profile = $2,
           perfil_tipo      = $2,
           updated_at       = NOW()
       WHERE user_id = $3
       RETURNING user_id`,
      [score, profile, userId]
    );

    if (updated.rowCount === 0) {
      // Linha não existe — cria
      await pool.query(
        `INSERT INTO user_profiles (user_id, wizard_completo, investor_score, investor_profile, perfil_tipo)
         VALUES ($1, TRUE, $2, $3, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET wizard_completo = TRUE, investor_score = $2, investor_profile = $3, perfil_tipo = $3, updated_at = NOW()`,
        [userId, score, profile]
      );
    }

    res.json({ score, profile, blocks });
  } catch (e) {
    console.error('[wizard/complete] erro:', e.message);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── GET /api/onboarding/wizard/result ────────────────────────────────────────
router.get('/wizard/result', async (req, res) => {
  const userId = req.userId;
  try {
    const { rows } = await pool.query(
      'SELECT investor_score, investor_profile, wizard_respostas FROM user_profiles WHERE user_id = $1',
      [userId]
    );
    if (!rows[0]?.investor_score) return res.status(404).json({ error: 'Resultado não disponível' });
    res.json({ score: rows[0].investor_score, profile: rows[0].investor_profile });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── POST /api/onboarding/tour/complete ───────────────────────────────────────
router.post('/tour/complete', async (req, res) => {
  const userId = req.userId;
  try {
    await pool.query(
      `UPDATE user_profiles
       SET tour_completo = TRUE, onboarding_completo = TRUE, updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── PATCH /api/onboarding/tour/reset ────────────────────────────────────────
router.patch('/tour/reset', async (req, res) => {
  const userId = req.userId;
  try {
    await pool.query(
      'UPDATE user_profiles SET tour_completo = FALSE, updated_at = NOW() WHERE user_id = $1',
      [userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// ── POST /api/onboarding/complete ────────────────────────────────────────────
// Marca onboarding como concluído sem tour
router.post('/complete', async (req, res) => {
  const userId = req.userId;
  try {
    await pool.query(
      `UPDATE user_profiles
       SET onboarding_completo = TRUE, updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

module.exports = router;
