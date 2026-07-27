'use strict';

const { createClient } = require('@supabase/supabase-js');
const pool = require('../db/connection');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Admins têm plan='premium' independente do banco
const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS || 'd2083b36-3899-4287-9649-e4b20e1f9103').split(',').map(s => s.trim()).filter(Boolean)
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
    const plan = ADMIN_USER_IDS.has(user.id) ? 'premium' : (rows[0]?.plan ?? 'free');
    req.user = { id: user.id, plan, isAdmin: ADMIN_USER_IDS.has(user.id) };
  } catch (_) {
    const isAdmin = ADMIN_USER_IDS.has(user.id);
    req.user = { id: user.id, plan: isAdmin ? 'premium' : 'free', isAdmin };
  }

  next();
}

module.exports = authMiddleware;
