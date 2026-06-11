const express = require('express');
const router  = express.Router();
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const { calcularScore } = require('../engine/fii-scorer');

router.use(auth);

const RECOMMENDATION_WEIGHTS = {
  dy_12m:    0.20,
  pvp:       0.15,
  vacancy:   0.15,
  liquidity: 0.15,
  leverage:  0.10,
  properties:0.10,
  div_growth:0.10,
  wault:     0.05,
};

function scoreForRecommendation(fii) {
  let pts = 0;
  if (fii.dy_12m != null) {
    const s = fii.dy_12m >= 12 ? 1 : fii.dy_12m >= 9 ? 0.8 : fii.dy_12m >= 7 ? 0.6 : 0.3;
    pts += s * RECOMMENDATION_WEIGHTS.dy_12m * 100;
  }
  if (fii.pvp != null) {
    const s = fii.pvp < 0.9 ? 1 : fii.pvp < 1.0 ? 0.8 : fii.pvp < 1.1 ? 0.5 : 0.2;
    pts += s * RECOMMENDATION_WEIGHTS.pvp * 100;
  }
  if (fii.vacancy != null) {
    const s = fii.vacancy < 3 ? 1 : fii.vacancy < 8 ? 0.7 : fii.vacancy < 15 ? 0.4 : 0.1;
    pts += s * RECOMMENDATION_WEIGHTS.vacancy * 100;
  }
  if (fii.liquidity != null) {
    const s = fii.liquidity > 2000000 ? 1 : fii.liquidity > 500000 ? 0.7 : 0.3;
    pts += s * RECOMMENDATION_WEIGHTS.liquidity * 100;
  }
  if (fii.leverage != null) {
    const s = fii.leverage < 20 ? 1 : fii.leverage < 35 ? 0.6 : 0.2;
    pts += s * RECOMMENDATION_WEIGHTS.leverage * 100;
  }
  if (fii.properties != null) {
    const s = fii.properties > 10 ? 1 : fii.properties > 5 ? 0.6 : 0.3;
    pts += s * RECOMMENDATION_WEIGHTS.properties * 100;
  }
  if (fii.div_growth != null) {
    const s = fii.div_growth > 0 ? 1 : fii.div_growth === 0 ? 0.5 : 0;
    pts += s * RECOMMENDATION_WEIGHTS.div_growth * 100;
  }
  if (fii.wault != null) {
    const s = fii.wault > 5 ? 1 : fii.wault > 3 ? 0.7 : 0.3;
    pts += s * RECOMMENDATION_WEIGHTS.wault * 100;
  }
  return Math.min(100, Math.round(pts));
}

function buildExplanation(fii, wizardData) {
  const objectives = wizardData.step4?.objectives || [];
  const horizon    = wizardData.step5?.horizon;
  const incomeNow  = wizardData.step8?.needs_income_now;
  const reasons    = [];

  if (objectives.includes('renda_passiva') || incomeNow)
    reasons.push('Compatível com seu objetivo de renda passiva');
  if (horizon === '5_10y' || horizon === 'more_10y')
    reasons.push('Adequado para seu horizonte de longo prazo');
  if (fii.liquidity > 1000000)
    reasons.push('Alta liquidez diária no mercado');
  if (fii.pvp != null && fii.pvp < 1)
    reasons.push('Negociando abaixo do valor patrimonial');
  if (fii.dy_12m != null && fii.dy_12m > 9)
    reasons.push('Dividend yield acima da média do segmento');
  if (reasons.length === 0)
    reasons.push('Selecionado pelo modelo de scoring do FII Advisor');

  return reasons;
}

function calculateAllocation(fiis) {
  const total = fiis.reduce((a, f) => a + (f.rec_score || 50), 0);
  return fiis.reduce((obj, f) => {
    obj[f.ticker] = Math.round((f.rec_score / total) * 100);
    return obj;
  }, {});
}

// ── POST /api/recommendations/generate ──────────────────────────────────────
router.post('/generate', async (req, res) => {
  const userId = req.userId;
  try {
    const profileRes = await pool.query(
      'SELECT investor_score, investor_profile, wizard_respostas FROM user_profiles WHERE user_id = $1',
      [userId]
    );
    const row = profileRes.rows[0];
    if (!row?.investor_profile) {
      return res.status(400).json({ error: 'Wizard não concluído. Complete seu perfil primeiro.' });
    }

    const { investor_score, investor_profile, wizard_respostas: wizardData } = row;
    const restrictions = wizardData?.step10 || {};
    const preferences  = wizardData?.step9  || {};
    const incomeNeed   = wizardData?.step8?.needs_income_now || false;

    // Buscar top FIIs com score
    const fiisRes = await pool.query(
      `SELECT ticker, segment, dy_12m, pvp, vacancy, liquidity, leverage,
              properties, div_growth, wault, ultimo_dy_valor, price
       FROM fii_dados
       WHERE score IS NOT NULL
       ORDER BY score DESC
       LIMIT 100`
    );

    let eligible = fiisRes.rows;

    // Aplicar restrições do wizard
    if (restrictions.no_papel)   eligible = eligible.filter(f => f.segment !== 'Recebíveis');
    if (restrictions.no_shopping) eligible = eligible.filter(f => f.segment !== 'Shopping');
    if (restrictions.min_dy)     eligible = eligible.filter(f => (f.dy_12m || 0) >= restrictions.min_dy);
    if (restrictions.max_pvp)    eligible = eligible.filter(f => (f.pvp || 99) <= restrictions.max_pvp);
    if (restrictions.min_liquidity) eligible = eligible.filter(f => (f.liquidity || 0) >= restrictions.min_liquidity);

    // Priorizar renda se necessário
    if (incomeNeed || investor_profile === 'conservador') {
      eligible.sort((a, b) => (b.dy_12m || 0) - (a.dy_12m || 0));
    }

    // Pontuar
    eligible = eligible.map(f => ({ ...f, rec_score: scoreForRecommendation(f) }));
    eligible.sort((a, b) => b.rec_score - a.rec_score);

    const selected = eligible.slice(0, 5);
    const allocation = calculateAllocation(selected);

    const fiisWithExplanation = selected.map(f => ({
      ticker:      f.ticker,
      segment:     f.segment,
      dy:          f.dy_12m,
      pvp:         f.pvp,
      liquidity:   f.liquidity,
      price:       f.price,
      rec_score:   f.rec_score,
      weight:      allocation[f.ticker] || 20,
      explanation: buildExplanation(f, wizardData || {}),
    }));

    // Alocação por segmento
    const segAlloc = {};
    fiisWithExplanation.forEach(f => {
      const seg = f.segment || 'Outros';
      segAlloc[seg] = (segAlloc[seg] || 0) + (f.weight || 0);
    });

    const recommendation = {
      profile:            investor_profile,
      fiis:               fiisWithExplanation,
      segment_allocation: segAlloc,
    };

    // Persistir recomendação
    const saved = await pool.query(
      `INSERT INTO portfolio_recommendations
         (user_id, profile_score, investor_profile, recommendation)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET profile_score = $2, investor_profile = $3,
             recommendation = $4, generated_at = NOW(), accepted = FALSE
       RETURNING id`,
      [userId, investor_score, investor_profile, JSON.stringify(recommendation)]
    );

    res.json({ id: saved.rows[0].id, recommendation });
  } catch (e) {
    console.error('[recommendations] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/recommendations/latest ─────────────────────────────────────────
router.get('/latest', async (req, res) => {
  const userId = req.userId;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM portfolio_recommendations
       WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 1`,
      [userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Nenhuma recomendação encontrada' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/recommendations/:id/accept ────────────────────────────────────
router.post('/:id/accept', async (req, res) => {
  const userId = req.userId;
  try {
    await pool.query(
      'UPDATE portfolio_recommendations SET accepted = TRUE WHERE user_id = $1 AND id = $2',
      [userId, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/recommendations/:id/explain/:ticker ─────────────────────────────
router.get('/:id/explain/:ticker', async (req, res) => {
  const { ticker } = req.params;
  const userId = req.userId;
  try {
    const { rows } = await pool.query(
      'SELECT recommendation FROM portfolio_recommendations WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 1',
      [userId]
    );
    const rec = rows[0]?.recommendation;
    const fii = rec?.fiis?.find(f => f.ticker === ticker);
    if (!fii) return res.status(404).json({ error: 'FII não encontrado na recomendação' });
    res.json({ ticker, explanation: fii.explanation });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
