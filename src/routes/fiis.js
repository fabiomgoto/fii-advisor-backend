const express = require('express');
const router = express.Router();
const axios = require('../services/axiosConfig');
const pool = require('../db/connection');
const { calcularScore, calcularScorePerfil, getAction } = require('../engine/fii-scorer');
const { buscarFII: buscarFundamentus, buscarTodosFIIs } = require('../collectors/fundamentus');
const { gerarSintese, gerarSintesePersonalizada } = require('../engine/fii-ai');
const { getRecommendationConfig, normalizeSegmento } = require('../services/profileScoringService');
const { getEnrichedData } = require('../services/dataProvider');
const { sincronizarProventos } = require('../scheduler/fii-proventos-sync');
const authMiddleware = require('../middleware/auth');
const { scanLimiter, diagnosticoLimiter, importLimiter } = require('../middleware/rateLimiter');
const { validateTicker, validateTickerList } = require('../middleware/validateTicker');
const { extrairProximoRendimento, brapiDividsToDB } = require('../utils/dividendUtils');

const BRAPI_TOKEN = process.env.BRAPI_TOKEN;

// Rotas protegidas — exigem JWT válido do Supabase
// /market, /search, /top10, /top50 são públicas (dados de mercado)
router.use(['/portfolio', '/contributions', '/dividends', '/rentabilidade', '/proventos'], authMiddleware);

const PRICE_CACHE = {}; // ticker → { price, dy_12m, pvp, ts }
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

// user_id vem do authMiddleware (JWT Supabase validado)
function getUserId(req) {
  return req.userId;
}

async function fetchPrecos(tickers) {
  const agora    = Date.now();
  const precisam = tickers.filter(t => !PRICE_CACHE[t] || agora - PRICE_CACHE[t].ts > CACHE_TTL_MS);

  if (precisam.length > 0) {
    // Brapi Pro em lote: price + pvp + dy_12m + div_growth em uma chamada só
    try {
      const { buscarLoteBrapi } = require('../collectors/fiis');
      const brapiMap = await buscarLoteBrapi(precisam);
      for (const [ticker, d] of Object.entries(brapiMap)) {
        if (!d.price) continue;
        PRICE_CACHE[ticker] = { ...d, ts: agora };
        pool.query(
          `INSERT INTO fiis_market (ticker, price, dy_12m, pvp, scanned_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (ticker) DO UPDATE SET
             price=COALESCE(EXCLUDED.price, fiis_market.price),
             dy_12m=COALESCE(EXCLUDED.dy_12m, fiis_market.dy_12m),
             pvp=COALESCE(EXCLUDED.pvp, fiis_market.pvp),
             scanned_at=NOW()`,
          [ticker, d.price, d.dy_12m ?? null, d.pvp ?? null]
        ).catch(e => console.warn(`[fiis/prices] upsert ${ticker}:`, e.message));
      }
    } catch (err) {
      console.warn('[fiis/prices] brapi batch:', err.message);
    }
  }

  return Object.fromEntries(tickers.map(t => [t, PRICE_CACHE[t] || {}]));
}

// GET /api/fiis/market — ranking FIIs mercado
router.get('/market', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM fiis_market
       WHERE ticker != ALL(ARRAY['XPIN11','FIGS11','RBVO11','NVHO11','CVBI11'])
       ORDER BY score DESC NULLS LAST`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiis/market/scan — força varredura manual (atualiza fiis_market agora)
router.post('/market/scan', scanLimiter, async (req, res) => {
  try {
    const { rodarFIIScanner } = require('../scheduler/fii-scanner');
    rodarFIIScanner()
      .then(n => console.log(`[scan-manual] ${n} FIIs processados`))
      .catch(e => console.warn('[scan-manual] erro:', e.message));
    res.json({ ok: true, msg: 'Varredura iniciada em background' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fiis/search?q=HGLG — autocomplete de ticker
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').toUpperCase().trim();
  if (!q || q.length < 2) return res.json([]);
  try {
    const todos = await buscarTodosFIIs();
    const matches = Object.entries(todos)
      .filter(([ticker]) => ticker.startsWith(q) || ticker.includes(q))
      .slice(0, 12)
      .map(([ticker, d]) => ({
        ticker,
        segment: d.segment || null,
        price:   d.price   || null,
        dy_12m:  d.dy_12m  || null,
        pvp:     d.pvp     || null,
      }));
    res.json(matches);
  } catch (_) {
    res.json([]); // sem cache disponível — retorna vazio
  }
});

// GET /api/fiis/portfolio — carteira com preços reais da brapi
router.get('/portfolio', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { rows: fiis } = await pool.query(
      'SELECT * FROM portfolio_fiis WHERE user_id = $1 ORDER BY created_at ASC',
      [userId]
    );
    const tickers = fiis.map(f => f.ticker);
    if (!tickers.length) return res.json([]);

    // Busca preços (cache 15 min)
    const precos = await fetchPrecos(tickers);

    // Dados do banco (score calculado pelo scanner)
    const { rows: market } = await pool.query(
      'SELECT * FROM fiis_market WHERE ticker = ANY($1)',
      [tickers]
    );
    const marketMap = Object.fromEntries(market.map(m => [m.ticker, m]));

    // Consistência de dividendos: meses distintos com pagamento nos últimos 12m / 12 * 10
    const { rows: consistRows } = await pool.query(
      `SELECT ticker,
         ROUND(
           COUNT(DISTINCT TO_CHAR(ex_date, 'YYYY-MM')) / 12.0 * 10
         , 1) AS consistency
       FROM dividends
       WHERE ticker = ANY($1)
         AND user_id = $2
         AND ex_date >= NOW() - INTERVAL '12 months'
       GROUP BY ticker`,
      [tickers, userId]
    );
    const consistMap = Object.fromEntries(consistRows.map(r => [r.ticker, parseFloat(r.consistency)]));

    // Enriquece cada FII com dados de vacancy, properties, div_growth do cache (assíncrono)
    const enrichedMap = {};
    const proximoMap = {};
    await Promise.all([
      ...fiis.map(async f => {
        try {
          enrichedMap[f.ticker] = await getEnrichedData(f.ticker) || {};
        } catch (_) {
          enrichedMap[f.ticker] = {};
        }
      }),
      ...fiis.map(async f => {
        proximoMap[f.ticker] = await getProximoRendimento(f.ticker);
      }),
    ]);

    // Busca perfil do usuário para score personalizado
    let perfilUsuario = null;
    try {
      const { rows: profRows } = await pool.query(
        'SELECT perfil_tipo, wizard_respostas FROM user_profiles WHERE user_id = $1',
        [userId]
      );
      if (profRows.length) {
        perfilUsuario = profRows[0].perfil_tipo
          || profRows[0].wizard_respostas?.objetivo
          || null;
      }
    } catch (_) {}

    const result = fiis.map(f => {
      const live    = precos[f.ticker]    || {};
      const db      = marketMap[f.ticker] || {};
      const enrich  = enrichedMap[f.ticker] || {};
      const dados = {
        price:      live.price      ?? db.price      ?? null,
        dy_12m:     live.dy_12m     ?? db.dy_12m     ?? null,
        pvp:        enrich.pvp      ?? live.pvp      ?? db.pvp      ?? null,
        liquidity:  enrich.liquidity ?? live.liquidity ?? db.liquidity ?? null,
        properties: enrich.properties ?? live.properties ?? db.properties ?? null,
        vacancy:    enrich.vacancy  ?? live.vacancy  ?? db.vacancy  ?? null,
        div_growth: enrich.div_growth ?? null,
        segment:    live.segment    ?? f.segment     ?? null,
      };
      const { score }   = calcularScore(dados);
      const scorePerfil = perfilUsuario ? calcularScorePerfil(dados, perfilUsuario) : null;
      return {
        ...f,
        ...db,
        ...dados,
        score,
        scorePerfil,
        perfil: perfilUsuario,
        action: getAction(score),
        consistency: consistMap[f.ticker] ?? db.consistency ?? 0,
        proximo_dy_valor:  proximoMap[f.ticker]?.valor    ?? null,
        proximo_dy_com:    proximoMap[f.ticker]?.data_com ?? null,
        proximo_dy_pgto:   proximoMap[f.ticker]?.data_pgto ?? null,
        proximo_dy_recente: proximoMap[f.ticker]?.recente ?? false,
        data_quality: enrich._stale ? 'stale' : 'fresh',
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiis/portfolio — adicionar FII
router.post('/portfolio', async (req, res) => {
  const { ticker, name, segment } = req.body;
  const TICKER_RE = /^[A-Z]{4}\d{1,2}F?$/;
  const tickerNorm = (ticker || '').toUpperCase().trim();
  if (!tickerNorm || !TICKER_RE.test(tickerNorm)) {
    return res.status(400).json({ error: 'Ticker inválido. Formato: 4 letras + 2 números (ex: HGLG11)' });
  }
  const userId = getUserId(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO portfolio_fiis (ticker, name, segment, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ticker, user_id) DO UPDATE SET name = EXCLUDED.name, segment = EXCLUDED.segment
       RETURNING *`,
      [ticker.toUpperCase(), name, segment, userId]
    );
    res.status(201).json(rows[0]);

    // Busca dados do novo ticker em background para popular fiis_market imediatamente
    fetchPrecos([ticker.toUpperCase()]).catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiis/portfolio/:ticker/sell — declarar venda (mantém histórico de proventos)
router.post('/portfolio/:ticker/sell', validateTicker, async (req, res) => {
  const userId = getUserId(req);
  const ticker = req.params.ticker.toUpperCase();
  const { sold_at, sold_price, sold_quantity } = req.body;
  if (!sold_at || !sold_price) return res.status(400).json({ error: 'sold_at e sold_price são obrigatórios' });
  try {
    const { rows } = await pool.query(
      `UPDATE portfolio_fiis SET sold_at = $1, sold_price = $2, sold_quantity = $3
       WHERE ticker = $4 AND user_id = $5 RETURNING *`,
      [sold_at, sold_price, sold_quantity || null, ticker, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'FII não encontrado na carteira' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fiis/portfolio/:ticker/sell — desfazer venda declarada
router.delete('/portfolio/:ticker/sell', validateTicker, async (req, res) => {
  const userId = getUserId(req);
  const ticker = req.params.ticker.toUpperCase();
  try {
    await pool.query(
      `UPDATE portfolio_fiis SET sold_at = NULL, sold_price = NULL, sold_quantity = NULL
       WHERE ticker = $1 AND user_id = $2`,
      [ticker, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fiis/portfolio/:ticker — remover FII da carteira
router.delete('/portfolio/:ticker', validateTicker, async (req, res) => {
  const userId = getUserId(req);
  const ticker = req.params.ticker.toUpperCase();
  try {
    await pool.query('DELETE FROM portfolio_fiis WHERE ticker = $1 AND user_id = $2', [ticker, userId]);
    await pool.query('DELETE FROM contributions  WHERE ticker = $1 AND user_id = $2', [ticker, userId]);
    await pool.query('DELETE FROM dividends      WHERE ticker = $1 AND user_id = $2', [ticker, userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fiis/contributions/:ticker — histórico de aportes
router.get('/contributions/:ticker', validateTicker, async (req, res) => {
  const userId = getUserId(req);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM contributions WHERE ticker = $1 AND user_id = $2 ORDER BY date DESC',
      [req.params.ticker.toUpperCase(), userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiis/contributions — registrar aporte
router.post('/contributions', async (req, res) => {
  const { ticker, date, quantity, price_paid, broker } = req.body;
  if (!ticker || !date || !quantity || !price_paid) {
    return res.status(400).json({ error: 'ticker, date, quantity e price_paid são obrigatórios' });
  }
  const userId = getUserId(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO contributions (ticker, date, quantity, price_paid, broker, user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [ticker.toUpperCase(), date, quantity, price_paid, broker, userId]
    );
    res.status(201).json(rows[0]);

    // Trigger assíncrono: re-sync proventos do ticker após novo aporte
    setImmediate(async () => {
      try {
        const { rows: aportes } = await pool.query(
          'SELECT date, quantity FROM contributions WHERE ticker = $1 AND user_id = $2 ORDER BY date',
          [ticker.toUpperCase(), userId]
        );
        await sincronizarProventos(userId, ticker.toUpperCase(), aportes);
      } catch (e) {
        console.warn('[proventos] sync após aporte falhou:', e.message);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/fiis/contributions/:id — editar aporte
router.put('/contributions/:id', async (req, res) => {
  const { date, quantity, price_paid, broker } = req.body;
  const userId = getUserId(req); // garante que só o dono pode editar (evita IDOR)
  try {
    const { rows } = await pool.query(
      `UPDATE contributions
       SET date = COALESCE($1, date),
           quantity = COALESCE($2, quantity),
           price_paid = COALESCE($3, price_paid),
           broker = COALESCE($4, broker)
       WHERE id = $5 AND user_id = $6 RETURNING *`,
      [date, quantity, price_paid, broker, req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Aporte não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[contributions/update]', err.message);
    res.status(500).json({ error: 'Erro ao atualizar aporte' });
  }
});

// DELETE /api/fiis/contributions/:id — remover aporte
router.delete('/contributions/:id', async (req, res) => {
  const userId = getUserId(req);
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM contributions WHERE id = $1 AND user_id = $2',
      [req.params.id, userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Aporte não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiis/dividends — registrar dividendo
router.post('/dividends', async (req, res) => {
  const { ticker, ex_date, payment_date, value_per_share } = req.body;
  if (!ticker || !ex_date || !value_per_share) {
    return res.status(400).json({ error: 'ticker, ex_date e value_per_share são obrigatórios' });
  }
  const userId = getUserId(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO dividends (ticker, ex_date, payment_date, value_per_share, user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [ticker.toUpperCase(), ex_date, payment_date, value_per_share, userId]
    );
    res.status(201).json(rows[0]);

    // Trigger assíncrono: re-sync proventos após novo dividendo
    setImmediate(async () => {
      try {
        const { rows: aportes } = await pool.query(
          'SELECT date, quantity FROM contributions WHERE ticker = $1 AND user_id = $2 ORDER BY date',
          [ticker.toUpperCase(), userId]
        );
        await sincronizarProventos(userId, ticker.toUpperCase(), aportes);
      } catch (e) {
        console.warn('[proventos] sync após dividendo falhou:', e.message);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fiis/dividends/:id — remover dividendo
router.delete('/dividends/:id', async (req, res) => {
  const userId = getUserId(req);
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM dividends WHERE id = $1 AND user_id = $2',
      [req.params.id, userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Dividendo não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fiis/dividends/:ticker — histórico dividendos
router.get('/dividends/:ticker', validateTicker, async (req, res) => {
  const userId = getUserId(req);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM dividends WHERE ticker = $1 AND user_id = $2 ORDER BY ex_date DESC',
      [req.params.ticker.toUpperCase(), userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fiis/rentabilidade/:ticker — rentabilidade mês a mês
router.get('/rentabilidade/:ticker', validateTicker, async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const userId = getUserId(req);
  try {
    const { rows: aportes } = await pool.query(
      'SELECT * FROM contributions WHERE ticker = $1 AND user_id = $2 ORDER BY date',
      [ticker, userId]
    );
    const { rows: divs } = await pool.query(
      'SELECT * FROM dividends WHERE ticker = $1 AND user_id = $2 ORDER BY ex_date',
      [ticker, userId]
    );
    const precos = await fetchPrecos([ticker]);
    const precoAtual = precos[ticker]?.price ?? null;

    let totalInvestido = 0;
    let totalCotas = 0;
    for (const a of aportes) {
      totalInvestido += parseFloat(a.total);
      totalCotas += parseFloat(a.quantity);
    }

    const totalDividendos = divs.reduce((acc, d) => acc + parseFloat(d.value_per_share) * totalCotas, 0);
    const valorAtual = precoAtual ? totalCotas * precoAtual : null;
    const retornoCapital = valorAtual && valorAtual > 0 ? ((valorAtual - totalInvestido) / totalInvestido) * 100 : null;
    const retornoTotal = valorAtual && valorAtual > 0 ? (((valorAtual + totalDividendos - totalInvestido) / totalInvestido) * 100) : null;

    res.json({
      ticker,
      totalInvestido,
      totalCotas,
      totalDividendos,
      precoAtual,
      valorAtual,
      retornoCapital,
      retornoTotal,
      aportes,
      dividendos: divs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fiis/rentabilidade — rentabilidade consolidada da carteira
router.get('/rentabilidade', async (req, res) => {
  const userId = getUserId(req);
  try {
    const { rows: fiis } = await pool.query(
      'SELECT ticker FROM portfolio_fiis WHERE user_id = $1',
      [userId]
    );
    const tickers = fiis.map(f => f.ticker);
    if (!tickers.length) return res.json({ tickers: [], total: {} });

    const { rows: aportes } = await pool.query(
      'SELECT * FROM contributions WHERE ticker = ANY($1) AND user_id = $2',
      [tickers, userId]
    );
    const { rows: divs } = await pool.query(
      'SELECT * FROM dividends WHERE ticker = ANY($1) AND user_id = $2',
      [tickers, userId]
    );
    const precosLive = await fetchPrecos(tickers);

    let totalInvestido = 0;
    let valorAtual = 0;
    let totalDividendos = 0;

    const porTicker = {};
    for (const ticker of tickers) {
      const ta = aportes.filter(a => a.ticker === ticker);
      const td = divs.filter(d => d.ticker === ticker);
      const cotas = ta.reduce((s, a) => s + parseFloat(a.quantity), 0);
      const investido = ta.reduce((s, a) => s + parseFloat(a.total), 0);
      const dividendos = td.reduce((s, d) => s + parseFloat(d.value_per_share) * cotas, 0);
      const preco = precosLive[ticker]?.price ?? null;
      const atual = preco ? cotas * preco : null;

      porTicker[ticker] = { cotas, investido, dividendos, valorAtual: atual };
      totalInvestido += investido;
      if (atual) valorAtual += atual;
      totalDividendos += dividendos;
    }

    res.json({
      porTicker,
      total: {
        totalInvestido,
        valorAtual,
        totalDividendos,
        retornoCapital: totalInvestido && valorAtual > 0 ? ((valorAtual - totalInvestido) / totalInvestido) * 100 : null,
        retornoTotal: totalInvestido && valorAtual > 0 ? (((valorAtual + totalDividendos - totalInvestido) / totalInvestido) * 100) : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SNAPSHOTS ───────────────────────────────────────────────────────────────

// GET /api/fiis/portfolio/snapshots — histórico diário de valor da carteira
router.get('/portfolio/snapshots', async (req, res) => {
  try {
    const userId = req.userId;
    const days   = Math.min(parseInt(req.query.days) || 30, 365);

    const { rows } = await pool.query(
      `SELECT
         snapshot_date   AS data,
         valor_atual,
         total_investido,
         variacao_dia,
         variacao_pct
       FROM portfolio_snapshots
       WHERE user_id = $1
         AND snapshot_date >= CURRENT_DATE - ($2 * INTERVAL '1 day')
       ORDER BY snapshot_date ASC`,
      [userId, days]
    );

    if (!rows.length) return res.json({ snapshots: [], resumo: null });

    const ultimo = rows[rows.length - 1];
    const primeiro = rows[0];
    const variacao_total = parseFloat(ultimo.valor_atual) - parseFloat(primeiro.total_investido);
    const variacao_total_pct = parseFloat(primeiro.total_investido) > 0
      ? variacao_total / parseFloat(primeiro.total_investido)
      : null;

    const maior_alta  = rows.reduce((best, r) => {
      const v = parseFloat(r.variacao_pct ?? -Infinity);
      return v > parseFloat(best?.variacao_pct ?? -Infinity) ? r : best;
    }, null);
    const maior_baixa = rows.reduce((worst, r) => {
      const v = parseFloat(r.variacao_pct ?? Infinity);
      return v < parseFloat(worst?.variacao_pct ?? Infinity) ? r : worst;
    }, null);

    const fmtRow = (r) => r ? {
      data:         r.data instanceof Date ? r.data.toISOString().substring(0, 10) : String(r.data).substring(0, 10),
      valor:        parseFloat(r.valor_atual),
      variacao_pct: parseFloat(r.variacao_pct),
    } : null;

    res.json({
      snapshots: rows.map(r => ({
        data:            r.data instanceof Date ? r.data.toISOString().substring(0, 10) : String(r.data).substring(0, 10),
        valor_atual:     parseFloat(r.valor_atual),
        total_investido: parseFloat(r.total_investido),
        variacao_dia:    r.variacao_dia   != null ? parseFloat(r.variacao_dia)  : null,
        variacao_pct:    r.variacao_pct   != null ? parseFloat(r.variacao_pct)  : null,
      })),
      resumo: {
        valor_atual:        parseFloat(ultimo.valor_atual),
        total_investido:    parseFloat(ultimo.total_investido),
        variacao_total:     Math.round(variacao_total * 100) / 100,
        variacao_total_pct: variacao_total_pct != null ? Math.round(variacao_total_pct * 10000) / 10000 : null,
        maior_alta:  fmtRow(maior_alta),
        maior_baixa: fmtRow(maior_baixa),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PROVENTOS ───────────────────────────────────────────────────────────────

// GET /api/fiis/proventos/resumo — totais e médias (antes de :ticker para não conflitar)
router.get('/proventos/resumo', async (req, res) => {
  const userId = getUserId(req);
  try {
    // Total geral
    const { rows: [tot] } = await pool.query(
      `SELECT COALESCE(SUM(total_recebido), 0) AS total_geral
       FROM fii_proventos WHERE user_id = $1`,
      [userId]
    );

    // Por ticker — inclui min_competencia para detectar histórico incompleto
    const { rows: porTicker } = await pool.query(
      `SELECT
         p.ticker,
         SUM(p.total_recebido)  AS total,
         MIN(p.competencia)::text AS min_competencia,
         MIN(c.date)::text        AS primeiro_aporte
       FROM fii_proventos p
       LEFT JOIN contributions c ON c.ticker = p.ticker AND c.user_id = p.user_id
       WHERE p.user_id = $1
       GROUP BY p.ticker ORDER BY total DESC`,
      [userId]
    );

    // Melhor mês
    const { rows: [melhorMes] } = await pool.query(
      `SELECT competencia, SUM(total_recebido) AS total
       FROM fii_proventos WHERE user_id = $1
       GROUP BY competencia ORDER BY total DESC LIMIT 1`,
      [userId]
    );

    // Média mensal últimos 12 meses
    const { rows: [media12] } = await pool.query(
      `SELECT AVG(mes_total) AS media FROM (
         SELECT competencia, SUM(total_recebido) AS mes_total
         FROM fii_proventos
         WHERE user_id = $1
           AND competencia >= NOW() - INTERVAL '12 months'
         GROUP BY competencia
       ) t`,
      [userId]
    );

    res.json({
      total_geral:      parseFloat(tot.total_geral || 0),
      por_ticker: porTicker.map(r => {
        // historico_completo = false quando proventos começam mais de 60 dias após o primeiro aporte
        const diffDias = r.primeiro_aporte && r.min_competencia
          ? (new Date(r.min_competencia) - new Date(r.primeiro_aporte)) / 86400000
          : 0;
        return {
          ticker:             r.ticker,
          total:              parseFloat(r.total),
          min_competencia:    r.min_competencia,
          primeiro_aporte:    r.primeiro_aporte,
          historico_completo: diffDias <= 60,
        };
      }),
      melhor_mes:       melhorMes ? { competencia: melhorMes.competencia, total: parseFloat(melhorMes.total) } : null,
      media_mensal_12m: parseFloat(media12?.media || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fiis/proventos — proventos agregados por mês (todos os FIIs)
router.get('/proventos', async (req, res) => {
  const userId = getUserId(req);
  try {
    const { rows } = await pool.query(
      `WITH por_mes_ticker AS (
         SELECT
           DATE_TRUNC('month', competencia) AS mes_trunc,
           ticker,
           SUM(total_recebido) AS total_recebido
         FROM fii_proventos
         WHERE user_id = $1
         GROUP BY DATE_TRUNC('month', competencia), ticker
       )
       SELECT
         TO_CHAR(mes_trunc, 'YYYY-MM')  AS mes,
         SUM(total_recebido)            AS total_mes,
         JSON_AGG(
           JSON_BUILD_OBJECT(
             'ticker',         ticker,
             'total_recebido', total_recebido
           ) ORDER BY ticker
         ) AS por_ticker
       FROM por_mes_ticker
       GROUP BY mes_trunc
       ORDER BY mes_trunc DESC`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fiis/proventos/:ticker — histórico de um ticker
router.get('/proventos/:ticker', validateTicker, async (req, res) => {
  const userId = getUserId(req);
  const ticker = req.params.ticker.toUpperCase();
  try {
    const { rows } = await pool.query(
      `SELECT competencia, data_com, valor_por_cota, cotas_na_data, total_recebido, fonte
       FROM fii_proventos
       WHERE user_id = $1 AND ticker = $2
       ORDER BY competencia DESC`,
      [userId, ticker]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiis/proventos/sync — trigger manual de sincronização
router.post('/proventos/sync', async (req, res) => {
  const userId = getUserId(req);
  try {
    const { sincronizarTodosProventos } = require('../scheduler/fii-proventos-sync');
    const result = await sincronizarTodosProventos(userId);
    res.json({ ok: true, sincronizados: result.sincronizados, tickers: result.tickers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiis/dividends/import-brapi/:ticker — importa histórico de 1 ticker via Brapi Pro
router.post('/dividends/import-brapi/:ticker', importLimiter, validateTicker, async (req, res) => {
  const userId = getUserId(req);
  const ticker = req.params.ticker;
  try {
    const { data } = await axios.get(
      `https://brapi.dev/api/quote/${ticker}?token=${BRAPI_TOKEN}&dividends=true`,
      { timeout: 15000 }
    );
    const divs = data?.results?.[0]?.dividendsData?.cashDividends || [];
    if (!divs.length) return res.status(404).json({ error: 'Nenhum dividendo encontrado no Brapi', ticker });

    const lista = brapiDividsToDB(divs);
    let importados = 0;
    for (const { exDate, paymentDate, rate } of lista) {
      await pool.query(
        `INSERT INTO dividends (user_id, ticker, ex_date, payment_date, value_per_share)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, ticker, ex_date)
         DO UPDATE SET value_per_share = EXCLUDED.value_per_share, payment_date = EXCLUDED.payment_date`,
        [userId, ticker, exDate, paymentDate || null, rate]
      );
      importados++;
    }
    console.log(`[IMPORT] ${ticker}: ${importados} dividendos (brapi)`);
    res.json({ ok: true, ticker, importados, fonte: 'brapi' });
  } catch (err) {
    console.warn(`[IMPORT] Erro ${ticker}:`, err.message);
    res.status(500).json({ error: err.message, ticker });
  }
});

// POST /api/fiis/dividends/import-brapi — importa histórico de toda a carteira via Brapi Pro
router.post('/dividends/import-brapi', importLimiter, async (req, res) => {
  const userId = getUserId(req);
  try {
    const { rows: fiis } = await pool.query(
      'SELECT ticker FROM portfolio_fiis WHERE user_id = $1',
      [userId]
    );
    if (!fiis.length) return res.json({ ok: true, importados: 0, tickers: 0 });

    let totalImportados = 0;
    const erros = [];

    for (const { ticker } of fiis) {
      try {
        const { data } = await axios.get(
          `https://brapi.dev/api/quote/${ticker}?token=${BRAPI_TOKEN}&dividends=true`,
          { timeout: 15000 }
        );
        const divs = data?.results?.[0]?.dividendsData?.cashDividends || [];
        if (!divs.length) continue;

        const lista = brapiDividsToDB(divs);
        let inseridos = 0;
        for (const { exDate, paymentDate, rate } of lista) {
          await pool.query(
            `INSERT INTO dividends (user_id, ticker, ex_date, payment_date, value_per_share)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (user_id, ticker, ex_date)
             DO UPDATE SET value_per_share = EXCLUDED.value_per_share, payment_date = EXCLUDED.payment_date`,
            [userId, ticker.toUpperCase(), exDate, paymentDate || null, rate]
          );
          inseridos++;
        }
        totalImportados += inseridos;
        console.log(`[IMPORT] ${ticker}: ${inseridos} dividendos (brapi)`);
      } catch (e) {
        console.warn(`[IMPORT] Erro ${ticker}:`, e.message);
        erros.push(ticker);
      }
    }

    const { sincronizarTodosProventos } = require('../scheduler/fii-proventos-sync');
    const syncResult = await sincronizarTodosProventos(userId);

    res.json({ ok: true, importados: totalImportados, tickers: fiis.length - erros.length, erros, sincronizados: syncResult.sincronizados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TOP 10 ──────────────────────────────────────────────────────────────────

let top10Cache = null;
const TOP10_TTL_MS = 60 * 60 * 1000; // 1h

// Cache de síntese personalizada por célula de perfil × momento (12 combinações)
const profileSinteseCache = {}; // key: "conservador_saudavel" → { sintese, top, ts }
const PROFILE_SINTESE_TTL = 60 * 60 * 1000; // 1h

// Blacklist permanente — FIIs com problemas jurídicos ou em recuperação judicial
// Inclui tickers extintos/incorporados que não existem mais na B3
const BLACKLIST = ['XPIN11', 'FIGS11', 'RBVO11', 'NVHO11', 'CVBI11'];

function aplicarFiltros(ticker, d) {
  if (BLACKLIST.includes(ticker)) {
    console.log(`[TOP10] ${ticker} excluído: blacklist permanente`);
    return false;
  }
  if (!d.dy_12m || d.dy_12m <= 0) {
    return false; // sem dados
  }
  if (d.dy_12m > 25) {
    console.log(`[TOP10] ${ticker} excluído: DY anômalo (${d.dy_12m.toFixed(1)}%)`);
    return false;
  }
  if (d.price != null && d.price < 10) {
    console.log(`[TOP10] ${ticker} excluído: preço muito baixo (R$${d.price.toFixed(2)})`);
    return false;
  }
  if (d.liquidity != null && d.liquidity < 100000) {
    console.log(`[TOP10] ${ticker} excluído: liquidez insuficiente (R$${Math.round(d.liquidity).toLocaleString()}/dia)`);
    return false;
  }
  if (d.pvp != null && d.pvp < 0.50) {
    console.log(`[TOP10] ${ticker} excluído: P/VP anômalo (${d.pvp.toFixed(2)})`);
    return false;
  }
  if (!d.pvp || d.pvp <= 0) {
    return false; // sem dados
  }
  return true;
}

// Semáforo para limitar concorrência no enriquecimento
function limitConcurrency(items, fn, limit = 5) {
  return new Promise((resolve, reject) => {
    const results = new Array(items.length);
    let idx = 0, running = 0, done = 0;
    function next() {
      while (running < limit && idx < items.length) {
        const i = idx++;
        running++;
        fn(items[i], i).then(r => {
          results[i] = r;
          running--;
          done++;
          if (done === items.length) resolve(results);
          else next();
        }).catch(err => {
          results[i] = null;
          running--;
          done++;
          if (done === items.length) resolve(results);
          else next();
        });
      }
    }
    next();
  });
}

async function rodarVarredura() {
  const todos = await buscarTodosFIIs();

  // 1. Filtros básicos e pré-score com dados do Fundamentus
  const pre = Object.entries(todos)
    .filter(([ticker, d]) => aplicarFiltros(ticker, d))
    .map(([ticker, d]) => { const { score, segmento } = calcularScore(d); return { ticker, ...d, score, segmento }; })
    .sort((a, b) => b.score - a.score)
    .slice(0, 100); // enriquece os 100 melhores candidatos

  console.log(`[TOP10] ${pre.length} candidatos pré-filtrados, enriquecendo...`);

  // 2. Enriquecimento com Funds Explorer (max 5 simultâneos, cache 24h)
  const enriched = await limitConcurrency(pre, async (fii) => {
    try {
      const extra = await getEnrichedData(fii.ticker) || {};

      // Usa ?? (nullish coalescing) igual à rota /portfolio:
      // se Funds Explorer retornar null (ex: vacancy em fundo de papel), preserva o dado do Fundamentus
      const dadosCompletos = {
        ...fii,
        pvp:        extra.pvp        ?? fii.pvp,
        liquidity:  extra.liquidity  ?? fii.liquidity,
        properties: extra.properties ?? fii.properties,
        vacancy:    extra.vacancy    ?? fii.vacancy,
        div_growth: extra.div_growth ?? null,
        // Campos exclusivos do enricher
        net_worth:       extra.net_worth       ?? null,
        wault:           extra.wault           ?? null,
        leverage:        extra.leverage        ?? null,
        ultimo_dy_valor: extra.ultimo_dy_valor ?? null,
        ultimo_dy_com:   extra.ultimo_dy_com   ?? null,
        ultimo_dy_pgto:  extra.ultimo_dy_pgto  ?? null,
        descricao:       extra.descricao       ?? null,
        source: extra._source ?? extra.source ?? 'enricher',
        data_quality: extra._stale ? 'stale' : 'fresh',
      };

      const { score, segmento, cobertura_pct, score_breakdown } = calcularScore(dadosCompletos);

      console.log(`[score] ${fii.ticker}: dy=${dadosCompletos.dy_12m} pvp=${dadosCompletos.pvp} vac=${dadosCompletos.vacancy} props=${dadosCompletos.properties} divg=${dadosCompletos.div_growth} liq=${dadosCompletos.liquidity} → ${score}pts`);

      return { ...dadosCompletos, score, segmento, cobertura_pct, score_breakdown, action: getAction(score) };
    } catch (err) {
      console.warn(`[score] ${fii.ticker} enrich erro:`, err.message);
      return { ...fii, action: getAction(fii.score) };
    }
  }, 5);

  // 3. Re-ranking com scores enriquecidos e salva top 50
  const top50 = enriched
    .filter(f => f != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  const top10 = top50.slice(0, 10);

  // 4. Síntese IA sobre o top 10
  let sintese = null;
  try {
    sintese = await gerarSintese(
      top10.map(f => ({ ticker: f.ticker, dy_12m: f.dy_12m, pvp: f.pvp, score: f.score, vacancy: f.vacancy }))
    );
  } catch (e) {
    console.warn('[top10] síntese IA falhou:', e.message);
  }

  // 5. Salva no banco (síntese + histórico de varredura)
  try {
    await pool.query(
      `INSERT INTO top10_synthesis (generated_at, synthesis, top_tickers)
       VALUES (NOW(), $1, $2)`,
      [sintese, JSON.stringify(top10.map(f => f.ticker))]
    );
  } catch (e) {
    console.warn('[top10] erro ao salvar no banco:', e.message);
  }
  try {
    await pool.query(
      `INSERT INTO fii_scan_history (total_scanned, top3, filtrados)
       VALUES ($1, $2, $3)`,
      [
        enriched.filter(f => f != null).length,
        JSON.stringify(top10.slice(0, 3).map(f => ({ ticker: f.ticker, score: f.score }))),
        enriched.filter(f => f != null).length - top50.length,
      ]
    );
  } catch (e) {
    console.warn('[scan-history] erro ao salvar:', e.message);
  }

  const gerado_em = new Date().toISOString();
  const result = { top10, top50, sintese, gerado_em };
  top10Cache = { data: result, ts: Date.now() };
  return result;
}

// GET /api/fiis/top10 — retorna top 10 do cache ou roda varredura
// ── GET /api/fiis/market-for-profile ──────────────────────────────────────────
// Retorna top FIIs + síntese personalizados para o perfil dual do usuário autenticado.
// Cache por célula (perfil × momento), TTL 1h — independente do cache global.
router.get('/market-for-profile', authMiddleware, async (req, res) => {
  try {
    // 1. Ler perfil dual do usuário
    const userId = req.userId;
    const { rows } = await pool.query(
      `SELECT investor_profile_v2, financial_moment
       FROM user_profiles WHERE user_id = $1`,
      [userId]
    );
    const perfil  = rows[0]?.investor_profile_v2 || null;
    const momento = rows[0]?.financial_moment    || null;

    // Se não tem perfil completo, devolve top50 genérico sem personalização
    if (!perfil || !momento) {
      const top50 = top10Cache?.data?.top50 || [];
      return res.json({ top: top50.slice(0, 20), sintese: null, perfil: null, momento: null, personalizado: false });
    }

    const cacheKey = `${perfil}_${momento}`;

    // 2. Cache hit
    if (profileSinteseCache[cacheKey] && Date.now() - profileSinteseCache[cacheKey].ts < PROFILE_SINTESE_TTL) {
      return res.json({ ...profileSinteseCache[cacheKey].data, from_cache: true });
    }

    // 3. Garantir que o top50 global existe
    if (!top10Cache?.data?.top50?.length) {
      // Roda varredura se não houver cache global ainda
      await rodarVarredura();
    }
    const top50 = top10Cache?.data?.top50 || [];

    if (!top50.length) {
      return res.status(503).json({ error: 'Base de FIIs ainda não disponível. Tente novamente em alguns minutos.' });
    }

    // 4. Aplicar filtros da matriz perfil × momento
    const matrix = getRecommendationConfig(perfil, momento);

    let eligible = [...top50];

    if (matrix.pausar) {
      // Momento restritivo — não filtra FIIs, mas avisa para não aportar
      const sintese = await gerarSintesePersonalizada(perfil, momento, [], {}).catch(() => null)
        || 'Seu momento financeiro atual recomenda pausar novos aportes em FIIs. Priorize a reserva de emergência e a quitação de dívidas.';
      const payload = { top: eligible.slice(0, 20), sintese, perfil, momento, personalizado: true, pausar: true, mensagem: matrix.mensagem };
      profileSinteseCache[cacheKey] = { data: payload, ts: Date.now() };
      return res.json(payload);
    }

    // Filtro de segmento
    if (matrix.segmentos?.length && !matrix.segmentos.includes('todos')) {
      eligible = eligible.filter(f => {
        const seg = normalizeSegmento(f.segment);
        return !seg || matrix.segmentos.includes(seg);
      });
    }
    // Filtro de DY mínimo
    if (matrix.minDY) eligible = eligible.filter(f => (f.dy_12m || 0) >= matrix.minDY);
    // Filtro de P/VP máximo
    if (matrix.maxPVP && matrix.maxPVP < 9) eligible = eligible.filter(f => (f.pvp || 99) <= matrix.maxPVP);

    // 5. Ordenação: focoDY → por DY; caso contrário por score geral
    if (matrix.focoDY) {
      eligible.sort((a, b) => (b.dy_12m || 0) - (a.dy_12m || 0));
    }
    // (já ordenado por score do top50 para o caso !focoDY)

    // Garante pelo menos alguns FIIs mesmo se filtros forem muito restritivos
    const top = eligible.length >= 5 ? eligible.slice(0, 20) : top50.slice(0, 20);

    // 6. Síntese personalizada
    const sintese = await gerarSintesePersonalizada(perfil, momento, top.slice(0, 10), {}).catch(() => null);

    const payload = { top, sintese, perfil, momento, personalizado: true, pausar: false, matrix };
    profileSinteseCache[cacheKey] = { data: payload, ts: Date.now() };

    res.json(payload);
  } catch (err) {
    console.error('[market-for-profile]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/top10', async (req, res) => {
  try {
    // Tenta cache em memória
    if (top10Cache && Date.now() - top10Cache.ts < TOP10_TTL_MS) {
      return res.json({ ...top10Cache.data, from_cache: true });
    }

    // Tenta banco (última varredura salva)
    const { rows } = await pool.query(
      `SELECT * FROM top10_synthesis ORDER BY generated_at DESC LIMIT 1`
    );
    if (rows.length && Date.now() - new Date(rows[0].generated_at).getTime() < TOP10_TTL_MS) {
      const saved = rows[0];
      return res.json({
        top10: null, // tickers apenas — frontend mostra resumo até nova varredura
        sintese: saved.synthesis,
        top_tickers: saved.top_tickers,
        gerado_em: saved.generated_at,
        from_cache: true,
        needs_scan: true,
      });
    }

    // Roda varredura completa
    const result = await rodarVarredura();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiis/top10/scan — força nova varredura (ignora cache)
router.post('/top10/scan', scanLimiter, async (req, res) => {
  try {
    top10Cache = null;
    const result = await rodarVarredura();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fiis/top50 — retorna top 50 do banco (scored) com breakdown
router.get('/top50', async (req, res) => {
  try {
    // Tenta banco primeiro (scoring diário persiste aqui)
    const { rows } = await pool.query(
      `SELECT ticker, name, segment, segmento, price, dy_12m, pvp, vacancy,
              liquidity, score, action, consistency, properties,
              score_breakdown, cobertura_pct, score_updated_at, scanned_at
       FROM fiis_market
       WHERE score IS NOT NULL AND price IS NOT NULL AND price > 0
       ORDER BY score DESC
       LIMIT 50`
    );
    if (rows.length > 0) {
      const top50 = rows.map(r => ({
        ...r,
        score_breakdown: r.score_breakdown || null,
        cobertura_pct:   r.cobertura_pct   || null,
        score_updated_at: r.score_updated_at
          ? (r.score_updated_at instanceof Date ? r.score_updated_at.toISOString() : String(r.score_updated_at))
          : null,
      }));
      return res.json({ top50, from_db: true });
    }
    // Fallback: cache em memória
    if (top10Cache?.data?.top50) {
      return res.json({ top50: top10Cache.data.top50, gerado_em: top10Cache.data.gerado_em, from_cache: true });
    }
    res.json({ top50: [], needs_scan: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiis/enriched-cache/clear — limpa cache do enricher para forçar re-fetch
router.post('/enriched-cache/clear', async (req, res) => {
  try {
    const tickers = req.body?.tickers;
    if (tickers?.length) {
      await pool.query('DELETE FROM fii_enriched_cache WHERE ticker = ANY($1)', [tickers]);
      res.json({ ok: true, cleared: tickers });
    } else {
      await pool.query('DELETE FROM fii_enriched_cache');
      res.json({ ok: true, cleared: 'all' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fiis/score/diagnostico?tickers=HGLG11,RZTR11,...
// Diagnóstico completo: campos recebidos, fontes e pontuação parcial por critério
router.get('/score/diagnostico', authMiddleware, diagnosticoLimiter, validateTickerList, async (req, res) => {
  const tickers = req.validatedTickers || ['HGLG11', 'RZTR11', 'SNCI11', 'SNAG11', 'RZAK11', 'KNCR11'];

  const resultados = [];

  for (const ticker of tickers) {
    // 1. Dados brapi Pro (dy_12m rolling, pvp, liquidity)
    let brapi = {};
    let brapiSource = 'null';
    try {
      const { buscarLoteBrapi } = require('../collectors/fiis');
      const bmap = await buscarLoteBrapi([ticker]);
      const b = bmap[ticker];
      if (b) {
        brapi = {
          dy_12m:    b.dy_12m    ?? null,
          pvp:       b.pvp       ?? null,
          liquidity: b.liquidity ?? null,
        };
        brapiSource = 'brapi_pro';
      }
    } catch (e) {
      brapiSource = `brapi_erro:${e.message.substring(0, 40)}`;
    }

    // 2. Enricher (pvp, dy_12m, vacancy, properties, div_growth, wault, leverage)
    let enriched = {};
    let enrichSource = 'null';
    try {
      const r = await getEnrichedData(ticker) || {};
      enriched = {
        pvp:        r.pvp        ?? null,
        dy_12m:     r.dy_12m     ?? null,
        vacancy:    r.vacancy    ?? null,
        properties: r.properties ?? null,
        div_growth: r.div_growth ?? null,
        wault:      r.wault      ?? null,
        leverage:   r.leverage   ?? null,
        data_quality: r._stale ? 'stale' : 'fresh',
      };
      enrichSource = r._source ?? r.source ?? 'enricher';
    } catch (e) {
      enrichSource = `enricher_erro:${e.message.substring(0, 40)}`;
    }

    // 3. Merge final — brapi Pro tem prioridade para dy_12m, pvp, div_growth
    const fii = {
      ticker,
      name:       enriched.name       || brapi.name       || ticker,
      pvp:        brapi.pvp           ?? enriched.pvp      ?? null,
      dy_12m:     brapi.dy_12m        ?? enriched.dy_12m   ?? null,
      div_growth: brapi.div_growth    ?? enriched.div_growth ?? null,
      liquidity:  brapi.liquidity     ?? enriched.liquidity ?? null,
      vacancy:    enriched.vacancy    ?? null,
      properties: enriched.properties ?? null,
      wault:      enriched.wault      ?? null,
      leverage:   enriched.leverage   ?? null,
      consistency: enriched.consistency ?? null,
    };

    // 4. Scoring segmentado via novo engine
    const { calcularScore: calcScore, detectarSegmento } = require('../engine/fii-scorer');
    const { score: scoreTotal, segmento, cobertura_pct, score_breakdown } = calcScore(fii);

    const criterios = score_breakdown.criterios.map(c => ({
      nome:   c.campo, campo: c.campo, max: c.peso,
      pts:    c.pontos, valor: c.valor, pct: c.pct,
      fonte:  ['dy_12m','pvp','div_growth','liquidity'].includes(c.campo) ? brapiSource : enrichSource,
      null:   false,
    }));
    const nullCount = score_breakdown.criterios_sem_dado.length;

    // Log no servidor
    console.log(`\n=== DIAGNÓSTICO ${ticker} [${segmento}] cobertura=${cobertura_pct}% ===`);
    criterios.forEach(c => console.log(`  ${c.campo}: ${c.valor} (${c.fonte}) → ${c.pts}/${c.max}pts`));
    score_breakdown.criterios_sem_dado.forEach(c => console.log(`  ${c.campo}: NULL (excluído)`));
    console.log(`  SCORE: ${scoreTotal}/100`);

    resultados.push({
      ticker, segmento, cobertura_pct, criterios,
      criterios_sem_dado: score_breakdown.criterios_sem_dado,
      scoreTotal, nullCount, campos_raw: fii,
    });

    // Delay entre tickers para não sobrecarregar APIs
    await new Promise(r => setTimeout(r, 800));
  }

  res.json({ diagnostico: resultados, gerado_em: new Date().toISOString() });
});

// GET /api/fiis/scan-history — últimas 10 varreduras
router.get('/scan-history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, scanned_at, total_scanned, top3, filtrados
       FROM fii_scan_history ORDER BY scanned_at DESC LIMIT 10`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cache StatusInvest (todos os FIIs, TTL 6h)
let _siCache = null;
let _siCacheTs = 0;
const SI_TTL = 6 * 60 * 60 * 1000;

// Busca próximo/último rendimento via Brapi Pro (substitui scraping do StatusInvest).
async function getProximoRendimento(ticker) {
  try {
    const { data } = await axios.get(
      `https://brapi.dev/api/quote/${ticker}?token=${BRAPI_TOKEN}&dividends=true`,
      { timeout: 10000 }
    );
    const divs = data?.results?.[0]?.dividendsData?.cashDividends || [];
    return extrairProximoRendimento(divs);
  } catch (_) { return null; }
}

async function getStatusInvestData(ticker) {
  try {
    if (!_siCache || Date.now() - _siCacheTs > SI_TTL) {
      const { data } = await axios.get(
        'https://statusinvest.com.br/category/advancedsearchresultpaginated?search=%7B%7D&categoryType=2&page=0&take=600',
        { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://statusinvest.com.br/' } }
      );
      _siCache = {};
      for (const item of (data?.list || [])) _siCache[item.ticker] = item;
      _siCacheTs = Date.now();
    }
    return _siCache[ticker] || null;
  } catch (_) { return null; }
}

// GET /api/fiis/:ticker/detail?range=1mo|3mo
router.get('/:ticker/detail', validateTicker, async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const range  = ['1mo', '3mo'].includes(req.query.range) ? req.query.range : '1mo';
  try {
    const [marketRes, enrichedRes, dadosRes, si, proximo] = await Promise.all([
      pool.query('SELECT * FROM fiis_market WHERE ticker = $1', [ticker]),
      pool.query('SELECT dados FROM fii_enriched_cache WHERE ticker = $1', [ticker]),
      pool.query('SELECT * FROM fii_dados WHERE ticker = $1', [ticker]),
      getStatusInvestData(ticker),
      getProximoRendimento(ticker),
    ]);

    const market   = marketRes.rows[0]       || null;
    const enriched = enrichedRes.rows[0]?.dados || null;
    const dados    = dadosRes.rows[0]        || null;

    // brapi: cotação atual + chart + 52w range
    let brapi = null;
    try {
      const url = `https://brapi.dev/api/quote/${ticker}?range=${range}&interval=1d&token=${BRAPI_TOKEN}`;
      const { data } = await axios.get(url, { timeout: 8000 });
      const q = data?.results?.[0];
      if (q) {
        const hist = (q.historicalDataPrice || []).map(p => ({
          date:   new Date(p.date * 1000).toISOString().substring(0, 10),
          close:  p.close,
          volume: p.volume,
        })).filter(p => p.close);

        // Min/Máx do mês corrente (últimos 30 dias)
        const last30 = hist.slice(-22);
        const minMes  = last30.length ? Math.min(...last30.map(p => p.close)) : null;
        const maxMes  = last30.length ? Math.max(...last30.map(p => p.close)) : null;

        brapi = {
          price:      q.regularMarketPrice,
          change_pct: q.regularMarketChangePercent,
          day_high:   q.regularMarketDayHigh,
          day_low:    q.regularMarketDayLow,
          volume:     q.regularMarketVolume,
          low_52w:    q.fiftyTwoWeekLow,
          high_52w:   q.fiftyTwoWeekHigh,
          name:       q.longName || q.shortName,
          min_mes:    minMes,
          max_mes:    maxMes,
          chart:      hist,
        };
      }
    } catch (_) {}

    if (!market && !brapi && !si) {
      return res.status(404).json({ error: 'FII não encontrado' });
    }

    // Valorização 12m: não disponível sem range=1y — usa cota_cagr do SI como proxy
    const price = brapi?.price ?? market?.price ?? si?.price ?? null;

    res.json({
      ticker,
      name:     brapi?.name || si?.companyname || market?.name || ticker,
      segment:  si?.subsectorname || si?.segment || market?.segment || null,

      // Cotação
      price,
      change_pct: brapi?.change_pct ?? null,
      day_high:   brapi?.day_high   ?? null,
      day_low:    brapi?.day_low    ?? null,
      volume:     brapi?.volume     ?? null,
      low_52w:    brapi?.low_52w    ?? null,
      high_52w:   brapi?.high_52w   ?? null,
      min_mes:    brapi?.min_mes    ?? null,
      max_mes:    brapi?.max_mes    ?? null,

      // Indicadores fundamentais
      dy_12m:    si?.dy           ?? market?.dy_12m  ?? dados?.dy_12m  ?? null,
      pvp:       si?.p_vp         ?? market?.pvp     ?? dados?.pvp     ?? null,
      vpa:       si?.valorpatrimonialcota ?? null,   // val. patrimonial p/cota
      liquidity: si?.liquidezmediadiaria  ?? market?.liquidity ?? enriched?.liquidity ?? null,
      net_worth: si?.patrimonio   ?? market?.net_worth ?? enriched?.net_worth ?? null,
      valor_mercado: (price && si?.numerocotas) ? price * si.numerocotas : null,
      pct_caixa: si?.percentualcaixa ?? null,        // valor em caixa %
      dividend_cagr: si?.dividend_cagr ?? enriched?.div_growth ?? null,
      cota_cagr:     si?.cota_cagr     ?? null,
      num_cotistas:  si?.numerocotistas ?? null,
      num_cotas:     si?.numerocotas    ?? null,
      vacancy:   market?.vacancy  ?? enriched?.vacancy  ?? null,
      properties:market?.properties ?? enriched?.properties ?? null,
      wault:     enriched?.wault  ?? dados?.wault ?? null,
      score:     market?.score    ?? null,
      action:    market?.action   ?? null,

      // Último rendimento
      ultimo_dy_valor: si?.lastdividend   ?? enriched?.ultimo_dy_valor ?? null,
      ultimo_dy_com:   enriched?.ultimo_dy_com  ?? null,
      ultimo_dy_pgto:  enriched?.ultimo_dy_pgto ?? null,

      // Próximo rendimento declarado
      proximo_dy_valor:  proximo?.valor    ?? null,
      proximo_dy_com:    proximo?.data_com ?? null,
      proximo_dy_pgto:   proximo?.data_pgto ?? null,
      proximo_dy_recente: proximo?.recente ?? false,

      // Descrição
      descricao: enriched?.descricao ?? null,

      // Chart
      chart:     brapi?.chart || [],
      range,
    });
  } catch (err) {
    console.error('[fiis/detail]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/waitlist — lista de espera plano PRO
router.post('/waitlist', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido' });
  try {
    await pool.query(
      `INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [email]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
