'use strict';
const rateLimit = require('express-rate-limit');

const UPGRADE_URL = process.env.UPGRADE_URL || 'https://fiiadvisor.com.br/planos';

function isPro(req) {
  return req.user?.plan === 'pro' || req.user?.isPro === true;
}

function keyGenerator(req) {
  return req.userId || req.user?.id || req.ip;
}

function onLimitReached(req, res) {
  const isApi = req.headers['accept']?.includes('application/json')
    || req.path.startsWith('/api/');

  if (isApi) {
    return res.status(429).json({
      error:      'rate_limit_exceeded',
      message:    'Limite de requisições atingido. Faça upgrade para o plano PRO.',
      upgradeUrl: UPGRADE_URL,
    });
  }
  return res.redirect(302, UPGRADE_URL);
}

function createLimiter({ freeMax, proMax, windowMs }) {
  return rateLimit({
    windowMs,
    max: (req) => isPro(req) ? proMax : freeMax,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders:   false,
    handler:         onLimitReached,
    validate:        false,
    skip: (req) => {
      const cronSecret = process.env.CRON_SECRET;
      if (cronSecret && req.headers['x-cron-secret'] === cronSecret) return true;
      if (req.headers['x-internal-token'] === process.env.INTERNAL_TOKEN) return true;
      return false;
    },
  });
}

const globalLimiter = createLimiter({ freeMax: 100, proMax: 500, windowMs: 60 * 60 * 1000 });
const rankingLimiter = createLimiter({ freeMax: 10, proMax: 60, windowMs: 60 * 60 * 1000 });
const tickerLimiter = createLimiter({ freeMax: 20, proMax: 120, windowMs: 60 * 60 * 1000 });
const aiLimiter = createLimiter({ freeMax: 5, proMax: 30, windowMs: 60 * 60 * 1000 });
const carteiraLimiter = createLimiter({ freeMax: 30, proMax: 200, windowMs: 60 * 60 * 1000 });

// Mantém os limiters legados para não quebrar imports existentes
const scanLimiter = createLimiter({ freeMax: 3, proMax: 10, windowMs: 15 * 60 * 1000 });
const diagnosticoLimiter = createLimiter({ freeMax: 10, proMax: 30, windowMs: 5 * 60 * 1000 });
const importLimiter = createLimiter({ freeMax: 5, proMax: 15, windowMs: 10 * 60 * 1000 });

module.exports = {
  globalLimiter,
  rankingLimiter,
  tickerLimiter,
  aiLimiter,
  carteiraLimiter,
  scanLimiter,
  diagnosticoLimiter,
  importLimiter,
};
