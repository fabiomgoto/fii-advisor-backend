const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Valida o JWT Bearer do Supabase e popula req.userId.
 * Rotas públicas (market data, top10, etc.) não usam este middleware.
 */
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
  next();
}

module.exports = authMiddleware;
