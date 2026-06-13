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

// GET /api/profile/analytics — dados estatísticos completos para módulo Análise
router.get('/analytics', async (req, res) => {
  const { getRecommendationConfig } = require('../services/profileScoringService');
  try {
    const userId = req.userId;

    const [profileRes, historyRes, platformRes, portfolioRes] = await Promise.all([
      pool.query(`
        SELECT financial_score, financial_moment, financial_wizard_data,
               financial_wizard_done, financial_updated_at,
               investor_score_v2  AS investor_score,
               investor_profile_v2 AS investor_profile,
               investor_wizard_data, investor_wizard_done, investor_updated_at
        FROM user_profiles WHERE user_id = $1
      `, [userId]),

      pool.query(`
        SELECT score_type, score, profile_result, calculated_at
        FROM profile_score_history
        WHERE user_id = $1
        ORDER BY calculated_at ASC
      `, [userId]),

      pool.query(`
        SELECT
          ROUND(AVG(financial_score))   AS avg_financial,
          ROUND(AVG(investor_score_v2)) AS avg_investor,
          ROUND(STDDEV(financial_score))   AS std_financial,
          ROUND(STDDEV(investor_score_v2)) AS std_investor,
          COUNT(*) FILTER (WHERE financial_score IS NOT NULL)   AS n_financial,
          COUNT(*) FILTER (WHERE investor_score_v2 IS NOT NULL) AS n_investor,
          COUNT(*) FILTER (WHERE financial_moment = 'saudavel')  AS f_saudavel,
          COUNT(*) FILTER (WHERE financial_moment = 'cauteloso') AS f_cauteloso,
          COUNT(*) FILTER (WHERE financial_moment = 'restrito')  AS f_restrito,
          COUNT(*) FILTER (WHERE investor_profile_v2 = 'conservador') AS i_conservador,
          COUNT(*) FILTER (WHERE investor_profile_v2 = 'moderado')    AS i_moderado,
          COUNT(*) FILTER (WHERE investor_profile_v2 = 'arrojado')    AS i_arrojado,
          COUNT(*) FILTER (WHERE investor_profile_v2 = 'sofisticado') AS i_sofisticado,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY financial_score)   AS p25_financial,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY financial_score)   AS p50_financial,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY financial_score)   AS p75_financial,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY investor_score_v2) AS p25_investor,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY investor_score_v2) AS p50_investor,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY investor_score_v2) AS p75_investor
        FROM user_profiles
        WHERE financial_score IS NOT NULL OR investor_score_v2 IS NOT NULL
      `),

      pool.query(`
        SELECT COUNT(*) AS total_fiis,
               COUNT(DISTINCT ticker) AS unique_tickers,
               SUM(CASE WHEN quantity > 0 THEN 1 ELSE 0 END) AS posicoes_ativas
        FROM portfolio_fiis WHERE user_id = $1
      `, [userId]),
    ]);

    const p   = profileRes.rows[0] || {};
    const plat = platformRes.rows[0] || {};
    const port = portfolioRes.rows[0] || {};

    // Percentil do usuário em relação à plataforma
    let financialPct = null;
    let investorPct  = null;
    if (p.financial_score != null && plat.n_financial > 1) {
      const { rows: pctF } = await pool.query(
        `SELECT COUNT(*) AS below FROM user_profiles WHERE financial_score < $1 AND financial_score IS NOT NULL`,
        [p.financial_score]
      );
      financialPct = Math.round((pctF[0].below / plat.n_financial) * 100);
    }
    if (p.investor_score != null && plat.n_investor > 1) {
      const { rows: pctI } = await pool.query(
        `SELECT COUNT(*) AS below FROM user_profiles WHERE investor_score_v2 < $1 AND investor_score_v2 IS NOT NULL`,
        [p.investor_score]
      );
      investorPct = Math.round((pctI[0].below / plat.n_investor) * 100);
    }

    // Breakdown das dimensões do score financeiro
    let financialBreakdown = null;
    if (p.financial_wizard_data) {
      const r = p.financial_wizard_data;
      const compRenda = { menos_40: 25, '40_60': 18, '61_80': 8, acima_80: 2 };
      const dividas   = { nenhuma: 25, controlada: 12, pesada: 0 };
      const reserva   = { nenhuma: 0, menos_3m: 8, '3_6m': 18, '6_12m': 26, mais_12m: 30 };
      const aporte    = { menos_300: 4, '300_1000': 10, '1001_3000': 15, '3001_10000': 18, acima_10000: 20 };
      financialBreakdown = [
        { dim: 'Comprometimento de renda', max: 25, earned: compRenda[r.gastos_mensais] || 0 },
        { dim: 'Controle de dívidas',      max: 25, earned: dividas[r.dividas] || 0 },
        { dim: 'Reserva de emergência',    max: 30, earned: reserva[r.reserva_emergencia] || 0 },
        { dim: 'Capacidade de aporte',     max: 20, earned: aporte[r.aporte_mensal] || 0 },
      ];
    }

    // Breakdown das dimensões do score de investidor
    let investorBreakdown = null;
    if (p.investor_wizard_data) {
      const r = p.investor_wizard_data;
      const reacao10  = { vende_tudo: 2, vende_parte: 7, aguarda: 11, compra_mais: 13 };
      const reacao30  = { vende_tudo: 0, vende_parte: 6, mantem: 11, compra_agressivo: 12 };
      const perdaMax  = { nenhuma: 0, ate_5pct: 5, ate_15pct: 12, ate_30pct: 17, ilimitada: 20 };
      const horizonte = { menos_1ano: 0, '1_3anos': 5, '3_5anos': 12, '5_10anos': 17, mais_10anos: 20, nunca_resgatar: 20 };
      const tempoInv  = { iniciando: 0, menos_1ano: 4, '1_3anos': 8, '3_5anos': 10, mais_5anos: 12 };
      const avancados = ['acoes', 'etfs', 'derivativos', 'fiis'];
      const prodScore = Math.min(8, ((r.produtos_conhecidos || []).filter(x => avancados.includes(x)).length) * 2);
      const usoDiv    = { reinvestir_tudo: 10, reinvestir_maioria: 8, metade: 6, renda_complementar: 4, renda_principal: 1 };
      const expFii    = { nunca: 0, ouviu_falar: 1, ja_teve: 3, acompanha: 4, investidor_ativo: 5 };
      investorBreakdown = [
        { dim: 'Tolerância a queda 10%',   max: 13, earned: reacao10[r.reacao_queda_10] || 0 },
        { dim: 'Tolerância a queda 30%',   max: 12, earned: reacao30[r.reacao_queda_30] || 0 },
        { dim: 'Perda máxima aceitável',   max: 20, earned: perdaMax[r.perda_aceitavel] || 0 },
        { dim: 'Horizonte de investimento',max: 20, earned: horizonte[r.horizonte_principal] || 0 },
        { dim: 'Tempo como investidor',    max: 12, earned: tempoInv[r.tempo_investindo] || 0 },
        { dim: 'Conhecimento de produtos', max: 8,  earned: prodScore },
        { dim: 'Estratégia de dividendos', max: 10, earned: usoDiv[r.uso_dividendos] || 0 },
        { dim: 'Experiência com FIIs',     max: 5,  earned: expFii[r.experiencia_fii] || 0 },
      ];
    }

    const matrix = (p.investor_profile && p.financial_moment)
      ? getRecommendationConfig(p.investor_profile, p.financial_moment)
      : null;

    res.json({
      user: {
        financialScore:   p.financial_score,
        financialMomento: p.financial_moment,
        financialDone:    p.financial_wizard_done,
        financialUpdated: p.financial_updated_at,
        investorScore:    p.investor_score,
        investorPerfil:   p.investor_profile,
        investorDone:     p.investor_wizard_done,
        investorUpdated:  p.investor_updated_at,
      },
      breakdown: { financial: financialBreakdown, investor: investorBreakdown },
      history: historyRes.rows,
      platform: {
        avgFinancial:  Number(plat.avg_financial),
        avgInvestor:   Number(plat.avg_investor),
        nFinancial:    Number(plat.n_financial),
        nInvestor:     Number(plat.n_investor),
        financial: {
          p25: Number(plat.p25_financial), p50: Number(plat.p50_financial), p75: Number(plat.p75_financial),
          saudavel:  Number(plat.f_saudavel),
          cauteloso: Number(plat.f_cauteloso),
          restrito:  Number(plat.f_restrito),
        },
        investor: {
          p25: Number(plat.p25_investor), p50: Number(plat.p50_investor), p75: Number(plat.p75_investor),
          conservador: Number(plat.i_conservador),
          moderado:    Number(plat.i_moderado),
          arrojado:    Number(plat.i_arrojado),
          sofisticado: Number(plat.i_sofisticado),
        },
      },
      percentil: { financial: financialPct, investor: investorPct },
      matrix,
      portfolio: { totalFiis: Number(port.total_fiis || 0) },
    });
  } catch (err) {
    console.error('[profile/analytics]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
