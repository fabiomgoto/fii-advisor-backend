const axios = require('axios');
const pool  = require('../db/connection');

// Cache em memória (resets no restart)
let memCache = null;
const MEM_TTL_MS = 60 * 60 * 1000; // 1h

// Cache PostgreSQL (sobrevive a restarts) — TTL mais longo
const PG_TTL_H = 6; // 6h: garante dados frescos sem rebuscar frequentemente

function parseBR(s) {
  // Remove % e converte "1.234,56" → 1234.56
  return parseFloat(s.replace('%', '').replace(/\./g, '').replace(',', '.'));
}

function parseHTML(html) {
  const result = {};
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const row = m[1];
    const tickerM = row.match(/papel=([A-Z]{4}1[0-9])/);
    if (!tickerM) continue;
    const ticker = tickerM[1];

    const tds = [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(x => x[1].trim());
    // tds[0]=segmento, tds[1]=cotação, tds[2]=FFO Yield, tds[3]=DY, tds[4]=P/VP
    // tds[5]=Val.Mercado, tds[6]=Liquidez/dia, tds[7]=Qt Imóveis, tds[8]=Vacância
    if (tds.length >= 5) {
      const safe = (i) => { try { const v = parseBR(tds[i]); return isNaN(v) ? null : v; } catch { return null; } };
      result[ticker] = {
        segment:    tds[0] || null,
        price:      safe(1),
        dy_12m:     safe(3),
        pvp:        safe(4),
        liquidity:  safe(6),
        properties: safe(7),
        vacancy:    safe(8),
      };
    }
  }
  return result;
}

// ─── Cache PostgreSQL ─────────────────────────────────────────────────────────

async function getCachedPG() {
  try {
    const { rows } = await pool.query(
      `SELECT dados, updated_at FROM fundamentus_cache WHERE id = 1`
    );
    if (!rows.length) return null;
    const ageH = (Date.now() - new Date(rows[0].updated_at).getTime()) / 3600000;
    if (ageH > PG_TTL_H) return null;
    console.log(`[fundamentus] PG cache hit (${ageH.toFixed(1)}h atrás)`);
    return rows[0].dados; // JSON object
  } catch (e) {
    // Tabela pode não existir ainda — cria e retorna null
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS fundamentus_cache (
          id INT PRIMARY KEY DEFAULT 1,
          dados JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    } catch (_) {}
    return null;
  }
}

async function saveCachePG(dados) {
  try {
    await pool.query(`
      INSERT INTO fundamentus_cache (id, dados, updated_at)
      VALUES (1, $1, NOW())
      ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados, updated_at = NOW()
    `, [JSON.stringify(dados)]);
  } catch (e) {
    console.warn('[fundamentus] erro salvando PG cache:', e.message);
  }
}

// ─── Fetch Fundamentus ────────────────────────────────────────────────────────

async function fetchFundamentus() {
  const { data: html } = await axios.get(
    'https://www.fundamentus.com.br/fii_resultado.php',
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Referer': 'https://www.fundamentus.com.br/',
        'Cache-Control': 'max-age=0',
      },
      timeout: 25000,
    }
  );
  return html;
}

// ─── API pública ──────────────────────────────────────────────────────────────

async function buscarTodosFIIs() {
  const agora = Date.now();

  // 1. Cache em memória (mais rápido, não persiste restart)
  if (memCache && agora - memCache.ts < MEM_TTL_MS) return memCache.data;

  // 2. Cache PostgreSQL (persiste restart, TTL 6h)
  const pgData = await getCachedPG();
  if (pgData) {
    memCache = { data: pgData, ts: agora }; // popula memória também
    return pgData;
  }

  // 3. Busca ao vivo no Fundamentus
  console.log('[fundamentus] buscando lista ao vivo...');
  let html;
  try {
    html = await fetchFundamentus();
  } catch (e) {
    // 403 ou timeout: tenta retornar PG cache mesmo expirado (melhor que nada)
    console.warn('[fundamentus] erro ao vivo:', e.message);
    try {
      const { rows } = await pool.query(
        `SELECT dados FROM fundamentus_cache WHERE id = 1`
      );
      if (rows.length) {
        console.warn('[fundamentus] usando PG cache expirado como fallback');
        memCache = { data: rows[0].dados, ts: agora };
        return rows[0].dados;
      }
    } catch (_) {}
    throw e; // sem fallback disponível
  }

  const result = parseHTML(html);
  const count = Object.keys(result).length;
  console.log(`[fundamentus] ${count} FIIs carregados`);

  // Validação: Fundamentus tem 400+ FIIs. Se vier menos de 100, é página de bloqueio.
  if (count < 100) {
    console.warn(`[fundamentus] resultado suspeito (${count} FIIs) — possível bloqueio. Não salva no cache.`);
    // Tenta retornar PG cache expirado se disponível
    try {
      const { rows } = await pool.query(`SELECT dados FROM fundamentus_cache WHERE id = 1`);
      if (rows.length && Object.keys(rows[0].dados).length >= 100) {
        console.warn('[fundamentus] usando PG cache expirado (mais confiável)');
        memCache = { data: rows[0].dados, ts: agora };
        return rows[0].dados;
      }
    } catch (_) {}
    throw new Error(`Fundamentus retornou apenas ${count} FIIs — possível bloqueio por IP`);
  }

  // Salva nos dois caches
  memCache = { data: result, ts: agora };
  await saveCachePG(result);

  return result;
}

async function buscarFII(ticker) {
  const todos = await buscarTodosFIIs();
  return todos[ticker] ?? null;
}

module.exports = { buscarFII, buscarTodosFIIs };
