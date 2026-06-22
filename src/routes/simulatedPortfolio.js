const express = require('express');
const router  = express.Router();
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');
const { buscarFII } = require('../collectors/fundamentus');

router.use(auth);

async function getCurrentPrice(ticker) {
  try {
    const data = await buscarFII(ticker);
    return data?.price || null;
  } catch (_) { return null; }
}

async function getPortfolio(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM simulated_portfolios WHERE user_id = $1',
    [userId]
  );
  return rows[0] || null;
}

// ── POST /api/simulated-portfolio/create ─────────────────────────────────────
router.post('/create', async (req, res) => {
  const userId = req.userId;
  try {
    // INSERT ... ON CONFLICT elimina TOCTOU de SELECT+INSERT separados
    const { rows } = await pool.query(
      `INSERT INTO simulated_portfolios (user_id, initial_balance, current_balance)
       VALUES ($1, 10000.00, 10000.00)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [userId]
    );
    res.json({ success: true, portfolio: rows[0] });
  } catch (e) {
    console.error('[simulated-portfolio/create]', e.message);
    res.status(500).json({ error: 'Erro ao criar carteira simulada' });
  }
});

// ── GET /api/simulated-portfolio ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  const userId = req.userId;
  try {
    const portfolio = await getPortfolio(userId);
    if (!portfolio) return res.status(404).json({ error: 'Carteira simulada não encontrada' });

    const { rows: positions } = await pool.query(
      `SELECT * FROM simulated_positions WHERE portfolio_id = $1 ORDER BY ticker`,
      [portfolio.id]
    );

    let positionsValue = 0;
    const enriched = positions.map(p => {
      const curPrice  = p.current_price || p.avg_price;
      const curValue  = curPrice * p.quantity;
      const costBasis = p.avg_price * p.quantity;
      const variation = costBasis > 0 ? ((curValue - costBasis) / costBasis) * 100 : 0;
      positionsValue += curValue;
      return { ...p, current_value: curValue, variation_pct: variation };
    });

    const totalValue = portfolio.current_balance + positionsValue;
    res.json({
      portfolio: {
        ...portfolio,
        positions_value: positionsValue,
        total_value: totalValue,
        total_variation_pct: ((totalValue - portfolio.initial_balance) / portfolio.initial_balance) * 100,
      },
      positions: enriched,
    });
  } catch (e) {
    console.error('[simulated-portfolio/get]', e.message);
    res.status(500).json({ error: 'Erro ao carregar carteira' });
  }
});

// ── POST /api/simulated-portfolio/buy ────────────────────────────────────────
router.post('/buy', async (req, res) => {
  const { ticker, quantity } = req.body;
  const userId = req.userId;
  const qty = Number(quantity);

  if (!ticker || !qty || qty <= 0 || !Number.isInteger(qty)) {
    return res.status(400).json({ error: 'Ticker e quantidade inteira positiva são obrigatórios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: pRows } = await client.query(
      'SELECT * FROM simulated_portfolios WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const portfolio = pRows[0];
    if (!portfolio) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Carteira não encontrada. Crie-a primeiro.' }); }

    const price = await getCurrentPrice(ticker.toUpperCase());
    if (!price) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Preço de ${ticker} indisponível no momento` }); }

    const total = price * qty;
    if (total > portfolio.current_balance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Saldo insuficiente', available: portfolio.current_balance, needed: total });
    }

    await client.query(
      `INSERT INTO simulated_transactions (portfolio_id, ticker, operation, quantity, price, total)
       VALUES ($1, $2, 'buy', $3, $4, $5)`,
      [portfolio.id, ticker.toUpperCase(), qty, price, total]
    );

    await client.query(
      `INSERT INTO simulated_positions (portfolio_id, ticker, quantity, avg_price, current_price)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (portfolio_id, ticker) DO UPDATE SET
         quantity      = simulated_positions.quantity + $3,
         avg_price     = ((simulated_positions.avg_price * simulated_positions.quantity) + ($4 * $3))
                         / (simulated_positions.quantity + $3),
         current_price = $4,
         last_updated  = NOW()`,
      [portfolio.id, ticker.toUpperCase(), qty, price]
    );

    await client.query(
      `UPDATE simulated_portfolios SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2`,
      [total, portfolio.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, ticker: ticker.toUpperCase(), quantity: qty, price, total });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[simulated-portfolio/buy]', e.message);
    res.status(500).json({ error: 'Erro ao processar compra' });
  } finally {
    client.release();
  }
});

// ── POST /api/simulated-portfolio/sell ───────────────────────────────────────
router.post('/sell', async (req, res) => {
  const { ticker, quantity } = req.body;
  const userId = req.userId;
  const qty = Number(quantity);

  if (!ticker || !qty || qty <= 0 || !Number.isInteger(qty)) {
    return res.status(400).json({ error: 'Ticker e quantidade inteira positiva são obrigatórios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: pRows } = await client.query(
      'SELECT * FROM simulated_portfolios WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const portfolio = pRows[0];
    if (!portfolio) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Carteira não encontrada' }); }

    const { rows: pos } = await client.query(
      'SELECT * FROM simulated_positions WHERE portfolio_id = $1 AND ticker = $2 FOR UPDATE',
      [portfolio.id, ticker.toUpperCase()]
    );
    if (!pos.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Posição não encontrada' }); }
    if (qty > pos[0].quantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Quantidade insuficiente', available: pos[0].quantity });
    }

    const price = await getCurrentPrice(ticker.toUpperCase()) || pos[0].current_price || pos[0].avg_price;
    const total = price * qty;

    await client.query(
      `INSERT INTO simulated_transactions (portfolio_id, ticker, operation, quantity, price, total)
       VALUES ($1, $2, 'sell', $3, $4, $5)`,
      [portfolio.id, ticker.toUpperCase(), qty, price, total]
    );

    if (qty === pos[0].quantity) {
      await client.query(
        'DELETE FROM simulated_positions WHERE portfolio_id = $1 AND ticker = $2',
        [portfolio.id, ticker.toUpperCase()]
      );
    } else {
      await client.query(
        `UPDATE simulated_positions SET quantity = quantity - $1, last_updated = NOW()
         WHERE portfolio_id = $2 AND ticker = $3`,
        [qty, portfolio.id, ticker.toUpperCase()]
      );
    }

    await client.query(
      `UPDATE simulated_portfolios SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2`,
      [total, portfolio.id]
    );

    await client.query('COMMIT');
    res.json({ success: true, ticker: ticker.toUpperCase(), quantity: qty, price, total });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[simulated-portfolio/sell]', e.message);
    res.status(500).json({ error: 'Erro ao processar venda' });
  } finally {
    client.release();
  }
});

// ── GET /api/simulated-portfolio/history ─────────────────────────────────────
router.get('/history', async (req, res) => {
  const userId = req.userId;
  try {
    const portfolio = await getPortfolio(userId);
    if (!portfolio) return res.status(404).json({ error: 'Carteira não encontrada' });

    const { rows } = await pool.query(
      `SELECT * FROM simulated_transactions
       WHERE portfolio_id = $1 ORDER BY executed_at DESC LIMIT 50`,
      [portfolio.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[simulated-portfolio/history]', e.message);
    res.status(500).json({ error: 'Erro ao carregar histórico' });
  }
});

// ── GET /api/simulated-portfolio/performance ──────────────────────────────────
router.get('/performance', async (req, res) => {
  const userId = req.userId;
  try {
    const portfolio = await getPortfolio(userId);
    if (!portfolio) return res.status(404).json({ error: 'Carteira não encontrada' });

    const { rows: positions } = await pool.query(
      'SELECT * FROM simulated_positions WHERE portfolio_id = $1',
      [portfolio.id]
    );

    const positionsValue = positions.reduce((acc, p) => acc + ((p.current_price || p.avg_price) * p.quantity), 0);
    const totalValue = portfolio.current_balance + positionsValue;

    res.json({
      initial_balance:    portfolio.initial_balance,
      cash_balance:       portfolio.current_balance,
      positions_value:    positionsValue,
      total_value:        totalValue,
      total_return_value: totalValue - portfolio.initial_balance,
      total_return_pct:   ((totalValue - portfolio.initial_balance) / portfolio.initial_balance) * 100,
    });
  } catch (e) {
    console.error('[simulated-portfolio/performance]', e.message);
    res.status(500).json({ error: 'Erro ao calcular performance' });
  }
});

// ── POST /api/simulated-portfolio/refresh ────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const userId = req.userId;
  try {
    const portfolio = await getPortfolio(userId);
    if (!portfolio) return res.status(404).json({ error: 'Carteira não encontrada' });

    const { rows: positions } = await pool.query(
      'SELECT DISTINCT ticker FROM simulated_positions WHERE portfolio_id = $1',
      [portfolio.id]
    );

    let updated = 0;
    for (const { ticker } of positions) {
      const price = await getCurrentPrice(ticker);
      if (price) {
        await pool.query(
          'UPDATE simulated_positions SET current_price = $1, last_updated = NOW() WHERE portfolio_id = $2 AND ticker = $3',
          [price, portfolio.id, ticker]
        );
        updated++;
      }
    }

    res.json({ success: true, updated });
  } catch (e) {
    console.error('[simulated-portfolio/refresh]', e.message);
    res.status(500).json({ error: 'Erro ao atualizar preços' });
  }
});

// GET /simulated-portfolio/backtest/:ticker?qty=100
// Simula: "se eu tivesse comprado X cotas há 3m, 6m, 12m, 18m — quanto teria hoje?"
// Compara com CDI, IBOV e Poupança no mesmo período
router.get('/backtest/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const qty = Math.max(1, parseInt(req.query.qty) || 1);

  try {
    const axios = require('../services/axiosConfig');
    const BRAPI_TOKEN = process.env.BRAPI_TOKEN;

    // Buscar histórico de preços (2 anos) e dividendos do FII
    const { data: brapiData } = await axios.get(
      `https://brapi.dev/api/quote/${ticker}?range=2y&interval=1mo&dividends=true&token=${BRAPI_TOKEN}`,
      { timeout: 12000 }
    );
    const result = brapiData?.results?.[0];
    if (!result) return res.status(404).json({ error: 'Ticker não encontrado' });

    const hist = (result.historicalDataPrice || []).map(p => ({
      date:  new Date(p.date * 1000).toISOString().substring(0, 10),
      close: p.close,
    })).filter(p => p.close > 0);

    const precoAtual = result.regularMarketPrice || hist[hist.length - 1]?.close || 0;
    const divs = (result.dividendsData?.cashDividends || []).map(d => ({
      date: d.paymentDate?.substring(0, 10) || d.lastDatePrior?.substring(0, 10),
      rate: d.rate || 0,
    }));

    // IBOV histórico
    let ibovHist = [];
    // Tenta Yahoo Finance, fallback Brapi
    for (const source of [
      { url: 'https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP?range=2y&interval=1mo', headers: { 'User-Agent': 'Mozilla/5.0' } },
      { url: `https://brapi.dev/api/quote/%5EBVSP?range=2y&interval=1mo&token=${BRAPI_TOKEN}`, headers: {} },
    ]) {
      if (ibovHist.length) break;
      try {
        const { data: ibov } = await axios.get(source.url, { timeout: 10000, headers: source.headers });
        const r = (ibov.chart?.result || ibov.results)?.[0];
        if (r?.timestamp) {
          ibovHist = r.timestamp.map((t, i) => ({
            date: new Date(t * 1000).toISOString().substring(0, 10),
            close: r.indicators.quote[0].close[i],
          })).filter(p => p.close > 0);
        } else if (r?.historicalDataPrice) {
          ibovHist = r.historicalDataPrice.map(p => ({
            date: new Date(p.date * 1000).toISOString().substring(0, 10),
            close: p.close,
          })).filter(p => p.close > 0);
        }
      } catch (e) {
        console.warn('[backtest] IBOV source falhou:', e.message?.substring(0, 60));
      }
    }

    // Taxas CDI mensais aproximadas
    const CDI_MENSAL = {
      '2024-12': 0.0091, '2025-01': 0.0100, '2025-02': 0.0108, '2025-03': 0.0108,
      '2025-04': 0.0108, '2025-05': 0.0116, '2025-06': 0.0116, '2025-07': 0.0108,
      '2025-08': 0.0108, '2025-09': 0.0108, '2025-10': 0.0108, '2025-11': 0.0108,
      '2025-12': 0.0108, '2026-01': 0.0116, '2026-02': 0.0116, '2026-03': 0.0116,
      '2026-04': 0.0116, '2026-05': 0.0116, '2026-06': 0.0116,
    };
    function getCdi(mes) { return CDI_MENSAL[mes] ?? 0.0100; }

    const hoje = new Date();
    const periodos = [3, 6, 12, 18];
    const cenarios = [];

    for (const meses of periodos) {
      const dataInicio = new Date(hoje);
      dataInicio.setMonth(dataInicio.getMonth() - meses);
      const isoInicio = dataInicio.toISOString().substring(0, 10);

      // Preço do FII na data de início
      const precoInicio = hist.reduce((best, p) => {
        if (p.date <= isoInicio && (!best || p.date > best.date)) return p;
        return best;
      }, null)?.close || hist[0]?.close;

      if (!precoInicio) continue;

      const investido = precoInicio * qty;
      const valorAtualFII = precoAtual * qty;

      // Dividendos recebidos no período
      const divsNoPeriodo = divs.filter(d => d.date >= isoInicio).reduce((s, d) => s + d.rate * qty, 0);
      const totalFII = valorAtualFII + divsNoPeriodo;
      const retornoFII = ((totalFII - investido) / investido) * 100;

      // CDI composto
      let cdiTotal = investido;
      const mesInicio = isoInicio.substring(0, 7);
      for (let m = new Date(dataInicio); m <= hoje; m.setMonth(m.getMonth() + 1)) {
        const mes = m.toISOString().substring(0, 7);
        if (mes >= mesInicio) cdiTotal *= (1 + getCdi(mes));
      }
      const retornoCDI = ((cdiTotal - investido) / investido) * 100;

      // Poupança (~0.5% + 70% CDI)
      let poupTotal = investido;
      for (let m = new Date(dataInicio); m <= hoje; m.setMonth(m.getMonth() + 1)) {
        const mes = m.toISOString().substring(0, 7);
        if (mes >= mesInicio) poupTotal *= (1 + getCdi(mes) * 0.7 * 0.5 + 0.005);
      }
      const retornoPoup = ((poupTotal - investido) / investido) * 100;

      // IBOV
      const ibovInicio = ibovHist.reduce((best, p) => {
        if (p.date <= isoInicio && (!best || p.date > best.date)) return p;
        return best;
      }, null)?.close;
      const ibovAtual = ibovHist[ibovHist.length - 1]?.close;
      const retornoIBOV = ibovInicio && ibovAtual ? ((ibovAtual / ibovInicio) - 1) * 100 : null;

      cenarios.push({
        meses,
        investido:   Math.round(investido * 100) / 100,
        precoInicio: Math.round(precoInicio * 100) / 100,
        fii:       { valor: Math.round(totalFII * 100) / 100,    retorno: Math.round(retornoFII * 100) / 100,   dividendos: Math.round(divsNoPeriodo * 100) / 100 },
        cdi:       { valor: Math.round(cdiTotal * 100) / 100,    retorno: Math.round(retornoCDI * 100) / 100 },
        poupanca:  { valor: Math.round(poupTotal * 100) / 100,   retorno: Math.round(retornoPoup * 100) / 100 },
        ibov:      retornoIBOV != null ? { retorno: Math.round(retornoIBOV * 100) / 100 } : null,
      });
    }

    res.json({ ticker, qty, precoAtual, cenarios });
  } catch (err) {
    console.error('[backtest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
