'use strict';

const { createClient } = require('@supabase/supabase-js');
const pool = require('../db/connection');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Token ausente' });
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  req.userId = user.id;

  // Carrega plan do DB — necessário para rate limiter e gates de feature
  try {
    const { rows } = await pool.query(
      `SELECT plan FROM user_profiles WHERE user_id = $1`,
      [user.id]
    );
    req.user = { id: user.id, plan: rows[0]?.plan ?? 'free' };
  } catch (_) {
    req.user = { id: user.id, plan: 'free' };
  }

  next();
}

module.exports = authMiddleware;
