'use strict';

/**
 * requirePlan.js — middleware de gating por plano.
 *
 * Deve rodar DEPOIS do middleware de auth (precisa de req.userId).
 * Carrega o plano efetivo do usuário, popula req.plan / req.userPlan e,
 * quando `minPlan` é informado, bloqueia (402) quem não tiver o tier necessário.
 *
 * Uso:
 *   router.get('/rota-pro',     auth, requirePlan('pro'),     handler);
 *   router.get('/rota-premium', auth, requirePlan('premium'), handler);
 *   router.use(auth, attachPlan); // só anexa req.plan, sem bloquear
 */

const { planCovers, getPlan } = require('../config/plans');
const { getUserPlan } = require('../services/subscriptionService');

const UPGRADE_URL = process.env.UPGRADE_URL || 'https://fiiadvisor.com.br/planos';

/** Anexa req.plan / req.userPlan sem bloquear. */
async function attachPlan(req, res, next) {
  try {
    if (req.userId) {
      const { plan, status, expiresAt } = await getUserPlan(req.userId);
      req.plan = plan;
      req.planStatus = status;
      req.planExpiresAt = expiresAt;
    } else {
      req.plan = 'free';
    }
  } catch (_) {
    req.plan = req.plan || 'free';
  }
  // compat com rateLimiter.isPro (req.user?.plan)
  req.user = { ...(req.user || {}), plan: req.plan, isPro: req.plan !== 'free' };
  next();
}

/** Exige um plano mínimo; responde 402 se não atender. */
function requirePlan(minPlan = 'pro') {
  return async function (req, res, next) {
    await attachPlan(req, res, () => {});
    if (planCovers(req.plan, minPlan)) return next();

    return res.status(402).json({
      error:       'plan_required',
      message:     `Este recurso exige o plano ${getPlan(minPlan).nome}.`,
      requiredPlan: minPlan,
      currentPlan:  req.plan,
      upgradeUrl:   UPGRADE_URL,
    });
  };
}

module.exports = { requirePlan, attachPlan };
