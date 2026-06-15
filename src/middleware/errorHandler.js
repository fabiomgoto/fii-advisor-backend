// src/middleware/errorHandler.js
const { logError, ERROR_TYPES, SEVERITY } = require('../services/errorLogService');

async function errorHandler(err, req, res, next) {
  const userId = req.userId || null;

  let type     = ERROR_TYPES.UNKNOWN;
  let severity = SEVERITY.ERROR;

  if (err.source === 'scraping' || err.isScrapingError)       { type = ERROR_TYPES.SCRAPING; }
  else if (err.source === 'brapi'   || err.isBrapiError)      { type = ERROR_TYPES.BRAPI;    }
  else if (err.source === 'database'|| err.code?.startsWith('2') || err.code?.startsWith('4')) {
    type     = ERROR_TYPES.DATABASE;
    severity = SEVERITY.CRITICAL;
  }

  const metadata = {
    method: req.method,
    path:   req.path,
    query:  req.query,
    ip:     req.ip,
    ...(err.metadata || {}),
  };

  await logError({
    type,
    source:   `${req.method} ${req.path}`,
    message:  err.message || 'Erro desconhecido',
    error:    err,
    metadata,
    userId,
    severity,
  });

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production' ? 'Ocorreu um erro interno.' : err.message,
    ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });
}

module.exports = errorHandler;
