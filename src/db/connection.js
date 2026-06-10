const { Pool } = require('pg');
require('dotenv').config();

const url = process.env.DATABASE_URL || '';
const temBanco = url.length > 0 && !url.includes('user:password@host');

let pool;

if (temBanco) {
  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  pool.query('SELECT NOW()')
    .then(() => console.log('[DB] PostgreSQL conectado'))
    .catch(err => console.error('[DB] Falha na conexão:', err.message));
  module.exports = pool;
} else {
  console.log('[DB] Sem banco — modo sem persistência');
  module.exports = { query: async () => ({ rows: [] }) };
}
