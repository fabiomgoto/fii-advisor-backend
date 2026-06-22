'use strict';

const TTL = {
  EXPLICACAO:            6 * 60 * 60 * 1000,
  SINTESE:               1 * 60 * 60 * 1000,
  SINTESE_PERSONALIZADA: 2 * 60 * 60 * 1000,
};

const _cache = new Map();
const stats = { hits: 0, misses: 0, evictions: 0 };

function _set(key, value, ttl) {
  _cache.set(key, { value, expiresAt: Date.now() + ttl, hits: 0 });
}

function _get(key) {
  const entry = _cache.get(key);
  if (!entry) { stats.misses++; return null; }
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    stats.evictions++;
    stats.misses++;
    return null;
  }
  entry.hits++;
  stats.hits++;
  return entry.value;
}

function _keyExplicacao(ticker) {
  const hoje = new Date().toISOString().slice(0, 10);
  return `explicacao:${ticker.toUpperCase()}:${hoje}`;
}

function _keySintese(tickers) {
  const sorted = [...tickers].sort().join(',');
  const hora = Math.floor(Date.now() / TTL.SINTESE);
  return `sintese:${sorted}:${hora}`;
}

function _keySintesePersonalizada(perfil, momento) {
  const bucket = Math.floor(Date.now() / TTL.SINTESE_PERSONALIZADA);
  return `sintese_personalizada:${perfil}:${momento}:${bucket}`;
}

const aiCache = {
  async explicacao(ticker, fn) {
    const key = _keyExplicacao(ticker);
    const cached = _get(key);
    if (cached) { console.log(`[aiCache] HIT explicacao:${ticker}`); return cached; }
    const result = await fn();
    _set(key, result, TTL.EXPLICACAO);
    console.log(`[aiCache] MISS explicacao:${ticker} → cacheado por 6h`);
    return result;
  },

  async sintese(tickers, fn) {
    const key = _keySintese(tickers);
    const cached = _get(key);
    if (cached) { console.log(`[aiCache] HIT sintese top10`); return cached; }
    const result = await fn();
    _set(key, result, TTL.SINTESE);
    console.log(`[aiCache] MISS sintese top10 → cacheado por 1h`);
    return result;
  },

  async sintesePersonalizada(perfil, momento, fn) {
    const key = _keySintesePersonalizada(perfil, momento);
    const cached = _get(key);
    if (cached) { console.log(`[aiCache] HIT sintese_personalizada:${perfil}:${momento}`); return cached; }
    const result = await fn();
    _set(key, result, TTL.SINTESE_PERSONALIZADA);
    console.log(`[aiCache] MISS sintese_personalizada:${perfil}:${momento} → cacheado por 2h`);
    return result;
  },

  invalidate(key) { const d = _cache.delete(key); if (d) stats.evictions++; return d; },
  clear() { const s = _cache.size; _cache.clear(); stats.evictions += s; console.log(`[aiCache] Cache limpo. ${s} entradas removidas.`); },

  getStats() {
    const hitRate = stats.hits + stats.misses > 0
      ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) : '0.0';
    return { entries: _cache.size, hits: stats.hits, misses: stats.misses, evictions: stats.evictions, hitRate: `${hitRate}%` };
  },

  startEvictionLoop(intervalMs = 15 * 60 * 1000) {
    setInterval(() => {
      const now = Date.now();
      let removed = 0;
      for (const [key, entry] of _cache.entries()) {
        if (now > entry.expiresAt) { _cache.delete(key); removed++; }
      }
      if (removed > 0) { stats.evictions += removed; console.log(`[aiCache] Eviction: ${removed} entradas removidas.`); }
    }, intervalMs);
  },
};

module.exports = aiCache;
