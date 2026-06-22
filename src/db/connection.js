'use strict';
const { Pool } = require('pg');
require('dotenv').config();

const url = process.env.DATABASE_URL || '';
const temBanco = url.length > 0 && !url.includes('user:password@host');
const isProduction = process.env.NODE_ENV === 'production';

if (!temBanco) {
  console.log('[DB] Sem banco — modo sem persistência');
  module.exports = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }) };
  return;
}

const pool = new Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 20,
  min: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

pool.on('connect', () => {
  if (!isProduction) {
    console.log(`[DB] Pool: ${pool.totalCount} total, ${pool.idleCount} idle`);
  }
});

pool.on('error', (err) => {
  console.error('[DB] Erro em conexão idle:', err.message);
});

pool.query('SELECT NOW()')
  .then(() => console.log('[DB] PostgreSQL conectado'))
  .catch(err => console.error('[DB] Falha na conexão:', err.message));

// Proxy: intercepta query para log de performance
const originalQuery = pool.query.bind(pool);
pool.query = async function(text, params) {
  const start = Date.now();
  try {
    const result = await originalQuery(text, params);
    const duration = Date.now() - start;
    if (!isProduction && duration > 200) {
      console.warn(`[DB] Query lenta (${duration}ms):`, String(text).slice(0, 80));
    }
    return result;
  } catch (err) {
    console.error('[DB] Erro na query:', err.message, '\nSQL:', String(text).slice(0, 120));
    throw err;
  }
};

pool.getPoolStats = () => ({
  total:   pool.totalCount,
  idle:    pool.idleCount,
  waiting: pool.waitingCount,
});

module.exports = pool;
