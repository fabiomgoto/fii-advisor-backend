// src/services/errorLogService.js
const pool = require('../db/connection');

const ERROR_TYPES = {
  SCRAPING:  'scraping',
  BRAPI:     'brapi',
  AUTH:      'auth',
  FRONTEND:  'frontend',
  DATABASE:  'database',
  CRON:      'cron',
  UNKNOWN:   'unknown',
};

const SEVERITY = {
  INFO:     'info',
  WARNING:  'warning',
  ERROR:    'error',
  CRITICAL: 'critical',
};

async function logError({ type, source, message, error, metadata = {}, userId = null, severity = SEVERITY.ERROR }) {
  try {
    const stack = error?.stack || null;
    const meta = {
      ...metadata,
      ...(error?.code       ? { errorCode: error.code }               : {}),
      ...(error?.statusCode ? { statusCode: error.statusCode }        : {}),
      ...(error?.response   ? { responseStatus: error.response?.status } : {}),
    };
    await pool.query(
      `INSERT INTO error_logs (type, source, message, stack, metadata, user_id, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [type, source, message, stack, JSON.stringify(meta), userId, severity]
    );
  } catch (dbErr) {
    console.error('[ErrorLog] Falha ao salvar log no banco:', dbErr.message);
  }
}

async function logScrapingError(message, error, metadata = {}) {
  return logError({ type: ERROR_TYPES.SCRAPING, source: metadata.source || 'scraper', message, error, metadata });
}

async function logBrapiError(message, error, metadata = {}) {
  return logError({ type: ERROR_TYPES.BRAPI, source: metadata.source || 'brapiService', message, error, metadata });
}

async function logDatabaseError(message, error, metadata = {}) {
  return logError({ type: ERROR_TYPES.DATABASE, source: metadata.source || 'db', message, error, metadata, severity: SEVERITY.CRITICAL });
}

async function logCronError(message, error, metadata = {}) {
  return logError({ type: ERROR_TYPES.CRON, source: metadata.source || 'cron', message, error, metadata, severity: SEVERITY.WARNING });
}

async function logAuthError(message, error, metadata = {}, userId = null) {
  return logError({ type: ERROR_TYPES.AUTH, source: metadata.source || 'auth', message, error, metadata, userId });
}

async function logFrontendError(message, stack, metadata = {}, userId = null) {
  return logError({ type: ERROR_TYPES.FRONTEND, source: metadata.source || 'frontend', message, error: { stack }, metadata, userId, severity: SEVERITY.WARNING });
}

module.exports = {
  logError,
  logScrapingError,
  logBrapiError,
  logDatabaseError,
  logCronError,
  logAuthError,
  logFrontendError,
  ERROR_TYPES,
  SEVERITY,
};
