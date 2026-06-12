'use strict';

const pool = require('../db/connection');
const {
  calcularFinancialScore,
  classificarMomentoFinanceiro,
  calcularInvestorScore,
  classificarPerfilInvestidor,
  getRecommendationConfig,
} = require('../services/profileScoringService');

// POST /api/profile/financial-score
async function saveFinancialScore(req, res) {
  try {
    const userId    = req.userId;
    const respostas = req.body.respostas;
    if (!respostas || typeof respostas !== 'object') {
      return res.status(400).json({ error: 'Respostas inválidas' });
    }

    const score   = calcularFinancialScore(respostas);
    const momento = classificarMomentoFinanceiro(score);

    await pool.query(
      `INSERT INTO user_profiles (user_id, financial_score, financial_moment, financial_wizard_data, financial_wizard_done, financial_updated_at, updated_at)
       VALUES ($1, $2, $3, $4, true, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         financial_score       = $2,
         financial_moment      = $3,
         financial_wizard_data = $4,
         financial_wizard_done = true,
         financial_updated_at  = NOW(),
         updated_at            = NOW()`,
      [userId, score, momento, JSON.stringify(respostas)]
    );

    await pool.query(
      `INSERT INTO profile_score_history (user_id, score_type, score, profile_result, wizard_data)
       VALUES ($1, 'financial', $2, $3, $4)`,
      [userId, score, momento, JSON.stringify(respostas)]
    );

    res.json({ score, momento, success: true });
  } catch (err) {
    console.error('[profileController] saveFinancialScore:', err.message);
    res.status(500).json({ error: 'Erro ao salvar score financeiro' });
  }
}

// POST /api/profile/investor-score
async function saveInvestorScore(req, res) {
  try {
    const userId    = req.userId;
    const respostas = req.body.respostas;
    if (!respostas || typeof respostas !== 'object') {
      return res.status(400).json({ error: 'Respostas inválidas' });
    }

    const score  = calcularInvestorScore(respostas);
    const perfil = classificarPerfilInvestidor(score);

    await pool.query(
      `INSERT INTO user_profiles (user_id, investor_score_v2, investor_profile_v2, investor_wizard_data, investor_wizard_done, investor_updated_at, updated_at)
       VALUES ($1, $2, $3, $4, true, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         investor_score_v2    = $2,
         investor_profile_v2  = $3,
         investor_wizard_data = $4,
         investor_wizard_done = true,
         investor_updated_at  = NOW(),
         updated_at           = NOW()`,
      [userId, score, perfil, JSON.stringify(respostas)]
    );

    await pool.query(
      `INSERT INTO profile_score_history (user_id, score_type, score, profile_result, wizard_data)
       VALUES ($1, 'investor', $2, $3, $4)`,
      [userId, score, perfil, JSON.stringify(respostas)]
    );

    // Sincroniza campos legados para compatibilidade
    await pool.query(
      `UPDATE user_profiles SET investor_score = $2, investor_profile = $3, wizard_completo = true WHERE user_id = $1`,
      [userId, score, perfil]
    );

    res.json({ score, perfil, success: true });
  } catch (err) {
    console.error('[profileController] saveInvestorScore:', err.message);
    res.status(500).json({ error: 'Erro ao salvar score de investidor' });
  }
}

// GET /api/profile/dual-score
async function getDualScore(req, res) {
  try {
    const userId = req.userId;
    const { rows } = await pool.query(
      `SELECT
         financial_score, financial_moment, financial_wizard_done, financial_updated_at,
         investor_score_v2   AS investor_score,
         investor_profile_v2 AS investor_profile,
         investor_wizard_done, investor_updated_at
       FROM user_profiles WHERE user_id = $1`,
      [userId]
    );

    if (!rows.length) {
      return res.json({ financial: null, investor: null, matrix: null, complete: false });
    }

    const p = rows[0];
    const matrix = (p.financial_moment && p.investor_profile)
      ? getRecommendationConfig(p.investor_profile, p.financial_moment)
      : null;

    res.json({
      financial: {
        score:     p.financial_score,
        momento:   p.financial_moment,
        done:      p.financial_wizard_done,
        updatedAt: p.financial_updated_at,
      },
      investor: {
        score:     p.investor_score,
        perfil:    p.investor_profile,
        done:      p.investor_wizard_done,
        updatedAt: p.investor_updated_at,
      },
      matrix,
      complete: !!(p.financial_wizard_done && p.investor_wizard_done),
    });
  } catch (err) {
    console.error('[profileController] getDualScore:', err.message);
    res.status(500).json({ error: 'Erro ao buscar scores' });
  }
}

// GET /api/profile/score-history
async function getScoreHistory(req, res) {
  try {
    const userId = req.userId;
    const { rows } = await pool.query(
      `SELECT score_type, score, profile_result, calculated_at
       FROM profile_score_history
       WHERE user_id = $1
       ORDER BY calculated_at DESC
       LIMIT 20`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[profileController] getScoreHistory:', err.message);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
}

module.exports = { saveFinancialScore, saveInvestorScore, getDualScore, getScoreHistory };
