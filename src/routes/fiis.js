const express = require('express');
const router = express.Router();
const axios = require('axios');
const pool = require('../db/connection');
const { calcularScore, calcularScorePerfil, getAction } = require('../engine/fii-scorer');
const { buscarFII: buscarFundamentus, buscarTodosFIIs } = require('../collectors/fundamentus');
const { gerarSintese } = require('../engine/fii-ai');
const { enrichFII }   = require('../engine/fii-enricher');
const { sincronizarProventos } = require('../scheduler/fii-proventos-sync');
const authMiddleware = require('../middleware/auth');

// Rotas protegidas — exigem JWT válido do Supabase
// /market, /search, /top10, /top50 são públicas (dados de mercado)
router.use(['/portfolio', '/contributions', '/dividends', '/rentabilidade', '/proventos'], authMiddleware);

const BRAPI_TOKEN = process.env.BRAPI_TOKEN;
const PRICE_CACHE = {}; // ticker → { price, dy_12m, pvp, ts }
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

// user_id vem do authMiddleware (JWT Supabase validado)
function getUserId(req) {
  return req.userId;
}

async function fetchPrecos(tickers) {
  const agora   = Date.now();
  const precisam = tickers.filter(t => !PRICE_CACHE[t] || agora - PRICE_CACHE[t].ts > CACHE_TTL_MS);

  if (precisam.length > 0) {
    await Promise.all(precisam.map(async (ticker) => {
      let dado = null;

      try {
        // 1ª opção: Fundamentus (price + DY + PVP)
        const fund = await buscarFundamentus(ticker);
        if (fund?.price) dado = { ...fund };
      } catch (_) {}

      if (!dado) {
        try {
          // 2ª opção: mfinance (price + DY + segment)
          const { data } = await axios.get(
            `https://mfinance.com.br/api/v1/fiis/${ticker}`,
            { timeout: 8000 }
          );
          dado = {
            price:   data.lastPrice ?? data.closingPrice ?? null,
            dy_12m:  data.dividendYield ?? null,
            segment: data.segment ?? null,
          };
        } catch (_) {}
      }

      if (!dado) {
        try {
          // 3ª opção: brapi (price + dy + pvp)
          const { data } = await axios.get(
            `https://brapi.dev/api/quote/${ticker}?token=${BRAPI_TOKEN}`,
            { timeout: 8000 }
          );
          const q = data?.results?.[0];
          if (q) dado = {
            price:  q.regularMarketPrice ?? null,
            dy_12m: q.dividendYield      ?? null,
            pvp:    q.priceToBook        ?? null,
          };
        } catch (e) {
          console.warn(`[fiis/prices] erro ${ticker}:`, e.message);
        }
      }

      if (dado?.price) {
        PRICE_CACHE[ticker] = { ...dado, ts: agora };
        // Persiste preço no fiis_market para não perder entre restarts
        pool.query(
          `INSERT INTO fiis_market (ticker, price, dy_12m, pvp, segment, scanned_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (ticker) DO UPDATE SET
             price=COALESCE(EXCLUDED.price, fiis_market.price),
             dy_12m=COALESCE(EXCLUDED.dy_12m, fiis_market.dy_12m),
             pvp=COALESCE(EXCLUDED.pvp, fiis_market.pvp),
             segment=COALESCE(EXCLUDED.segment, fiis_market.segment),
             scanned_at=NOW()`,
          [ticker, dado.price, dado.dy_12m ?? null, dado.pvp ?? null, dado.segment ?? null]
        ).catch(e => console.warn(`[fiis/prices] upsert ${ticker}:`, e.message));
      }
    }));
  }

  return Object.fromEntries(tickers.map(t => [t, PRICE_CACHE[t] || {}]));
}

// GET /api/fiis/market — ranking FIIs mercado
router.get('/market', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM fiis_market ORDER BY score DESC NULLS LAST'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fiis/market/scan — força varredura manual (atualiza fiis_market agora)
router.post('/market/scan', async (req, res) => {
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
    await Promise.all(fiis.map(async f => {
      try {
        // Passa {} como base — dados do Fundamentus são mesclados abaixo via ??
        enrichedMap[f.ticker] = await enrichFII(f.ticker, {});
      } catch (_) {
        enrichedMap[f.ticker] = {};
      }
    }));

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
      const score       = calcularScore(dados);
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
  if (!ticker) return res.status(400).json({ error: 'ticker obrigatório' });
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
router.post('/portfolio/:ticker/sell', async (req, res) => {
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
router.delete('/portfolio/:ticker/sell', async (req, res) => {
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
router.delete('/portfolio/:ticker', async (req, res) => {
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
router.get('/contributions/:ticker', async (req, res) => {
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
router.get('/dividends/:ticker', async (req, res) => {
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
router.get('/rentabilidade/:ticker', async (req, res) => {
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
router.get('/proventos/:ticker', async (req, res) => {
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

// POST /api/fiis/dividends/import-brapi/:ticker — importa 1 ticker via StatusInvest
router.post('/dividends/import-brapi/:ticker', async (req, res) => {
  const userId = getUserId(req);
  const ticker = req.params.ticker.toUpperCase();

  function parseDateBR(s) {
    if (!s || !s.includes('/')) return null;
    const [d, m, y] = s.split('/');
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // Helper: insere lista de { exDate, paymentDate, rate } na tabela dividends
  async function upsertDividends(lista) {
    let inseridos = 0;
    for (const { exDate, paymentDate, rate } of lista) {
      if (!exDate || rate <= 0) continue;
      await pool.query(`DELETE FROM dividends WHERE user_id=$1 AND ticker=$2 AND ex_date=$3`, [userId, ticker, exDate]);
      await pool.query(
        `INSERT INTO dividends (user_id, ticker, ex_date, payment_date, value_per_share) VALUES ($1,$2,$3,$4,$5)`,
        [userId, ticker, exDate, paymentDate || null, rate]
      );
      inseridos++;
    }
    return inseridos;
  }

  try {
    let proventos = [];
    let fonte = '';

    // 1ª tentativa: mfinance.com.br — histórico completo desde IPO
    try {
      const { data } = await axios.get(
        `https://mfinance.com.br/api/v1/fiis/dividends/${ticker}`,
        { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
      );
      const list = data?.dividends || [];
      if (list.length > 0) {
        proventos = list.map(p => ({
          exDate:      (p.declaredDate || '').substring(0, 10),
          paymentDate: (p.payDate      || '').substring(0, 10) || null,
          rate:        parseFloat(p.value || 0),
        }));
        fonte = 'mfinance';
      }
    } catch (_) {}

    // 2ª tentativa: StatusInvest (fallback — limita a 17 meses)
    if (proventos.length === 0) {
      function parseDateBR(s) {
        if (!s || !s.includes('/')) return null;
        const [d, m, y] = s.split('/');
        return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
      const endDate = new Date().toISOString().substring(0, 10);
      const { data } = await axios.get(
        `https://statusinvest.com.br/fii/companytickerprovents?ticker=${ticker}&type=1&datetype=3&startDate=2018-01-01&endDate=${endDate}`,
        { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': `https://statusinvest.com.br/fundos-imobiliarios/${ticker.toLowerCase()}`, 'Accept': 'application/json' } }
      );
      const list = data?.assetEarningsModels || [];
      proventos = list.map(p => ({
        exDate:      parseDateBR(p.ed),
        paymentDate: parseDateBR(p.pd),
        rate:        parseFloat(p.v || 0),
      }));
      fonte = 'statusinvest';
    }

    const inseridos = await upsertDividends(proventos);
    console.log(`[IMPORT] ${ticker}: ${inseridos} dividendos (${fonte})`);
    res.json({ ok: true, ticker, importados: inseridos, fonte });
  } catch (err) {
    console.warn(`[IMPORT] Erro ${ticker}:`, err.message);
    res.status(500).json({ error: err.message, ticker });
  }
});

// POST /api/fiis/dividends/import-brapi — importa histórico de dividendos via StatusInvest
router.post('/dividends/import-brapi', async (req, res) => {
  const userId = getUserId(req);

  // Helper: converte "DD/MM/YYYY" → "YYYY-MM-DD"
  function parseDateBR(s) {
    if (!s || !s.includes('/')) return null;
    const [d, m, y] = s.split('/');
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  try {
    const { rows: fiis } = await pool.query(
      'SELECT ticker FROM portfolio_fiis WHERE user_id = $1',
      [userId]
    );
    if (!fiis.length) return res.json({ ok: true, importados: 0, tickers: 0 });

    let totalImportados = 0;
    const erros = [];
    const startDate = '2018-01-01';
    const endDate   = new Date().toISOString().substring(0, 10);

    for (const { ticker } of fiis) {
      try {
        const url = `https://statusinvest.com.br/fii/companytickerprovents?ticker=${ticker}&type=1&datetype=3&startDate=${startDate}&endDate=${endDate}`;
        const { data } = await axios.get(url, {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Referer':    `https://statusinvest.com.br/fundos-imobiliarios/${ticker.toLowerCase()}`,
            'Accept':     'application/json, text/plain, */*',
          },
        });

        const proventos = data?.assetEarningsModels || [];
        if (!proventos.length) continue;

        let inseridos = 0;
        for (const p of proventos) {
          // ed = data COM (DD/MM/YYYY), pd = data pgto (DD/MM/YYYY), v = valor
          const exDate      = parseDateBR(p.ed);
          const paymentDate = parseDateBR(p.pd);
          const rate        = parseFloat(p.v || 0);

          if (!exDate || rate <= 0) continue;

          // Upsert sem depender de constraint: deleta e re-insere
          await pool.query(
            `DELETE FROM dividends WHERE user_id=$1 AND ticker=$2 AND ex_date=$3`,
            [userId, ticker.toUpperCase(), exDate]
          );
          await pool.query(
            `INSERT INTO dividends (user_id, ticker, ex_date, payment_date, value_per_share)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, ticker.toUpperCase(), exDate, paymentDate || null, rate]
          );
          inseridos++;
        }

        totalImportados += inseridos;
        console.log(`[IMPORT-SI] ${ticker}: ${inseridos}/${proventos.length} dividendos importados`);
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        console.warn(`[IMPORT-SI] Erro ${ticker}:`, e.message);
        erros.push(ticker);
      }
    }

    // Sync proventos após importação
    const { sincronizarTodosProventos } = require('../scheduler/fii-proventos-sync');
    const syncResult = await sincronizarTodosProventos(userId);

    res.json({
      ok:            true,
      importados:    totalImportados,
      tickers:       fiis.length - erros.length,
      erros,
      sincronizados: syncResult.sincronizados,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TOP 10 ──────────────────────────────────────────────────────────────────

let top10Cache = null;
const TOP10_TTL_MS = 60 * 60 * 1000; // 1h

// Blacklist permanente — FIIs com problemas jurídicos ou em recuperação judicial
const BLACKLIST = ['XPIN11', 'FIGS11', 'RBVO11', 'NVHO11'];

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
    .map(([ticker, d]) => ({ ticker, ...d, score: calcularScore(d) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 100); // enriquece os 100 melhores candidatos

  console.log(`[TOP10] ${pre.length} candidatos pré-filtrados, enriquecendo...`);

  // 2. Enriquecimento com Funds Explorer (max 5 simultâneos, cache 24h)
  const enriched = await limitConcurrency(pre, async (fii) => {
    try {
      // Passa {} como base para não contaminar o cache com dados do Fundamentus
      const extra = await enrichFII(fii.ticker, {});

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
        source: extra.source ?? 'fundamentus',
      };

      const score = calcularScore(dadosCompletos);

      // Log de diagnóstico para comparação (pode remover após estabilizar)
      console.log(`[score] ${fii.ticker}: dy=${dadosCompletos.dy_12m} pvp=${dadosCompletos.pvp} vac=${dadosCompletos.vacancy} props=${dadosCompletos.properties} divg=${dadosCompletos.div_growth} liq=${dadosCompletos.liquidity} → ${score}pts`);

      return { ...dadosCompletos, score, action: getAction(score) };
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
router.post('/top10/scan', async (req, res) => {
  try {
    top10Cache = null;
    const result = await rodarVarredura();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fiis/top50 — retorna top 50 do cache
router.get('/top50', async (req, res) => {
  try {
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
router.get('/score/diagnostico', async (req, res) => {
  const tickers = (req.query.tickers || 'HGLG11,RZTR11,SNCI11,SNAG11,RZAK11,KNCR11')
    .split(',').map(t => t.trim().toUpperCase()).filter(Boolean);

  const resultados = [];

  for (const ticker of tickers) {
    // 1. Dados brapi (dy_12m, pvp, liquidity)
    let brapi = {};
    let brapiSource = 'null';
    try {
      // Usa endpoint básico (sem modules) — funciona no plano gratuito para FIIs
      const { data } = await axios.get(
        `https://brapi.dev/api/quote/${ticker}?token=${BRAPI_TOKEN}`,
        { timeout: 10000 }
      );
      const q = data?.results?.[0];
      if (q) {
        brapi = {
          dy_12m:    q.dividendYield       ?? null,
          pvp:       q.priceToBook         ?? null,
          liquidity: q.regularMarketVolume ?? null,
        };
        brapiSource = 'brapi';
      }
    } catch (e) {
      brapiSource = `brapi_erro:${e.message.substring(0, 40)}`;
    }

    // 2. Enricher (pvp, dy_12m, vacancy, properties, div_growth, wault, leverage)
    let enriched = {};
    let enrichSource = 'null';
    try {
      const r = await enrichFII(ticker, {});
      enriched = {
        pvp:        r.pvp        ?? null,
        dy_12m:     r.dy_12m     ?? null,
        vacancy:    r.vacancy    ?? null,
        properties: r.properties ?? null,
        div_growth: r.div_growth ?? null,
        wault:      r.wault      ?? null,
        leverage:   r.leverage   ?? null,
      };
      enrichSource = r.source || 'enricher';
    } catch (e) {
      enrichSource = `enricher_erro:${e.message.substring(0, 40)}`;
    }

    // 3. Merge final — enricher tem prioridade sobre brapi para pvp e dy_12m
    const fii = {
      ...brapi,
      pvp:    enriched.pvp    ?? brapi.pvp    ?? null,
      dy_12m: enriched.dy_12m ?? brapi.dy_12m ?? null,
      ...enriched,
    };

    // Fonte efetiva de cada campo
    const fonteDY  = fii.dy_12m  != null && enriched.dy_12m  != null ? enrichSource : brapiSource;
    const fontePVP = fii.pvp     != null && enriched.pvp     != null ? enrichSource : brapiSource;

    // 4. Pontuação por critério (null-safe — igual ao fii-scorer.js)
    const criterios = [];

    // DY Sustentável 20pts
    let ptsDY = 0;
    if (fii.dy_12m != null) {
      if (fii.dy_12m >= 10) ptsDY = 20;
      else if (fii.dy_12m >= 8) ptsDY = 15;
      else if (fii.dy_12m >= 6) ptsDY = 10;
      else ptsDY = 5;
    }
    criterios.push({ nome: 'DY Sustentável', max: 20, pts: ptsDY,
      campo: 'dy_12m', valor: fii.dy_12m, fonte: fonteDY,
      null: fii.dy_12m == null });

    // P/VP 15pts
    let ptsPVP = 0;
    if (fii.pvp != null) {
      if (fii.pvp < 0.90) ptsPVP = 15;
      else if (fii.pvp < 1.00) ptsPVP = 12;
      else if (fii.pvp < 1.10) ptsPVP = 8;
      else ptsPVP = 3;
    }
    criterios.push({ nome: 'P/VP', max: 15, pts: ptsPVP,
      campo: 'pvp', valor: fii.pvp, fonte: fontePVP,
      null: fii.pvp == null });

    // Vacância 15pts
    let ptsVac = 0;
    if (fii.vacancy != null) {
      if (fii.vacancy < 3) ptsVac = 15;
      else if (fii.vacancy < 8) ptsVac = 10;
      else if (fii.vacancy < 15) ptsVac = 5;
    }
    criterios.push({ nome: 'Vacância', max: 15, pts: ptsVac,
      campo: 'vacancy', valor: fii.vacancy, fonte: enrichSource,
      null: fii.vacancy == null });

    // Crescimento DY 15pts
    let ptsDG = 0;
    if (fii.div_growth != null) {
      if (fii.div_growth > 0) ptsDG = 15;
      else if (fii.div_growth === 0) ptsDG = 8;
    }
    criterios.push({ nome: 'Crescimento DY', max: 15, pts: ptsDG,
      campo: 'div_growth', valor: fii.div_growth, fonte: enrichSource,
      null: fii.div_growth == null });

    // WAULT 10pts
    let ptsWault = 0;
    if (fii.wault != null) {
      if (fii.wault > 5) ptsWault = 10;
      else if (fii.wault > 3) ptsWault = 7;
      else ptsWault = 3;
    }
    criterios.push({ nome: 'WAULT', max: 10, pts: ptsWault,
      campo: 'wault', valor: fii.wault, fonte: enrichSource,
      null: fii.wault == null });

    // Alavancagem 10pts
    let ptsLev = 0;
    if (fii.leverage != null) {
      if (fii.leverage < 20) ptsLev = 10;
      else if (fii.leverage < 35) ptsLev = 6;
      else ptsLev = 2;
    }
    criterios.push({ nome: 'Alavancagem', max: 10, pts: ptsLev,
      campo: 'leverage', valor: fii.leverage, fonte: enrichSource,
      null: fii.leverage == null });

    // Diversificação 10pts
    let ptsProp = 0;
    if (fii.properties != null) {
      if (fii.properties > 10) ptsProp = 10;
      else if (fii.properties > 5) ptsProp = 6;
      else ptsProp = 3;
    }
    criterios.push({ nome: 'Diversificação', max: 10, pts: ptsProp,
      campo: 'properties', valor: fii.properties, fonte: enrichSource,
      null: fii.properties == null });

    // Liquidez 5pts
    let ptsLiq = 0;
    if (fii.liquidity != null) {
      if (fii.liquidity > 2000000) ptsLiq = 5;
      else if (fii.liquidity > 500000) ptsLiq = 3;
      else ptsLiq = 1;
    }
    criterios.push({ nome: 'Liquidez', max: 5, pts: ptsLiq,
      campo: 'liquidity', valor: fii.liquidity, fonte: brapiSource,
      null: fii.liquidity == null });

    const scoreTotal = Math.min(criterios.reduce((s, c) => s + c.pts, 0), 100);
    const nullCount  = criterios.filter(c => c.null).length;

    // Log no servidor também
    console.log(`\n=== DIAGNÓSTICO ${ticker} ===`);
    criterios.forEach(c => {
      const flag = c.null ? ' ← NULL' : '';
      console.log(`  ${c.nome}: ${c.valor ?? 'null'} (${c.fonte}) → ${c.pts}/${c.max}pts${flag}`);
    });
    console.log(`  SCORE: ${scoreTotal}/100  |  ${nullCount} campos null`);

    resultados.push({ ticker, criterios, scoreTotal, nullCount, campos_raw: fii });

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
