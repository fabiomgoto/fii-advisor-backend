'use strict';
const rateLimit = require('express-rate-limit');

const scanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições de varredura. Aguarde 15 minutos.' },
  skip: (req) => {
    const cronSecret = process.env.CRON_SECRET;
    return !!(cronSecret && req.headers['x-cron-secret'] === cronSecret);
  },
});

const diagnosticoLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições de diagnóstico. Aguarde 5 minutos.' },
});

const importLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições de import. Aguarde 10 minutos.' },
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em breve.' },
});

module.exports = { scanLimiter, diagnosticoLimiter, importLimiter, generalLimiter };
