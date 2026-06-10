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
    // Verificar se já existe
    const existing = await pool.query(
      'SELECT id FROM simulated_portfolios WHERE user_id = $1', [userId]
    );
    if (existing.rows.length) {
      return res.json({ message: 'Carteira já existe', portfolio: existing.rows[0] });
    }

    const { rows } = await pool.query(
      `INSERT INTO simulated_portfolios (user_id, initial_balance, current_balance)
       VALUES ($1, 10000.00, 10000.00) RETURNING *`,
      [userId]
    );
    res.json({ success: true, portfolio: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

    // Calcular valor total das posições
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
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/simulated-portfolio/buy ────────────────────────────────────────
router.post('/buy', async (req, res) => {
  const { ticker, quantity } = req.body;
  const userId = req.userId;

  if (!ticker || !quantity || quantity <= 0 || !Number.isInteger(Number(quantity))) {
    return res.status(400).json({ error: 'Ticker e quantidade inteira positiva são obrigatórios' });
  }

  try {
    const portfolio = await getPortfolio(userId);
    if (!portfolio) return res.status(404).json({ error: 'Carteira não encontrada. Crie-a primeiro.' });

    const price = await getCurrentPrice(ticker.toUpperCase());
    if (!price) return res.status(400).json({ error: `Preço de ${ticker} indisponível no momento` });

    const total = price * Number(quantity);
    if (total > portfolio.current_balance) {
      return res.status(400).json({
        error: 'Saldo insuficiente',
        available: portfolio.current_balance,
        needed: total,
      });
    }

    // Registrar transação
    await pool.query(
      `INSERT INTO simulated_transactions (portfolio_id, ticker, operation, quantity, price, total)
       VALUES ($1, $2, 'buy', $3, $4, $5)`,
      [portfolio.id, ticker.toUpperCase(), Number(quantity), price, total]
    );

    // Upsert posição com preço médio
    await pool.query(
      `INSERT INTO simulated_positions (portfolio_id, ticker, quantity, avg_price, current_price)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (portfolio_id, ticker) DO UPDATE SET
         quantity      = simulated_positions.quantity + $3,
         avg_price     = ((simulated_positions.avg_price * simulated_positions.quantity) + ($4 * $3))
                         / (simulated_positions.quantity + $3),
         current_price = $4,
         last_updated  = NOW()`,
      [portfolio.id, ticker.toUpperCase(), Number(quantity), price]
    );

    // Deduzir saldo
    await pool.query(
      `UPDATE simulated_portfolios
       SET current_balance = current_balance - $1, updated_at = NOW()
       WHERE id = $2`,
      [total, portfolio.id]
    );

    res.json({ success: true, ticker: ticker.toUpperCase(), quantity: Number(quantity), price, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/simulated-portfolio/sell ───────────────────────────────────────
router.post('/sell', async (req, res) => {
  const { ticker, quantity } = req.body;
  const userId = req.userId;

  if (!ticker || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'Ticker e quantidade são obrigatórios' });
  }

  try {
    const portfolio = await getPortfolio(userId);
    if (!portfolio) return res.status(404).json({ error: 'Carteira não encontrada' });

    const { rows: pos } = await pool.query(
      'SELECT * FROM simulated_positions WHERE portfolio_id = $1 AND ticker = $2',
      [portfolio.id, ticker.toUpperCase()]
    );

    if (!pos.length) return res.status(404).json({ error: 'Posição não encontrada' });
    if (Number(quantity) > pos[0].quantity) {
      return res.status(400).json({
        error: 'Quantidade insuficiente',
        available: pos[0].quantity,
      });
    }

    const price = await getCurrentPrice(ticker.toUpperCase()) || pos[0].current_price || pos[0].avg_price;
    const total = price * Number(quantity);

    await pool.query(
      `INSERT INTO simulated_transactions (portfolio_id, ticker, operation, quantity, price, total)
       VALUES ($1, $2, 'sell', $3, $4, $5)`,
      [portfolio.id, ticker.toUpperCase(), Number(quantity), price, total]
    );

    if (Number(quantity) === pos[0].quantity) {
      await pool.query(
        'DELETE FROM simulated_positions WHERE portfolio_id = $1 AND ticker = $2',
        [portfolio.id, ticker.toUpperCase()]
      );
    } else {
      await pool.query(
        `UPDATE simulated_positions SET quantity = quantity - $1, last_updated = NOW()
         WHERE portfolio_id = $2 AND ticker = $3`,
        [Number(quantity), portfolio.id, ticker.toUpperCase()]
      );
    }

    await pool.query(
      `UPDATE simulated_portfolios
       SET current_balance = current_balance + $1, updated_at = NOW()
       WHERE id = $2`,
      [total, portfolio.id]
    );

    res.json({ success: true, ticker: ticker.toUpperCase(), quantity: Number(quantity), price, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
      initial_balance:      portfolio.initial_balance,
      cash_balance:         portfolio.current_balance,
      positions_value:      positionsValue,
      total_value:          totalValue,
      total_return_value:   totalValue - portfolio.initial_balance,
      total_return_pct:     ((totalValue - portfolio.initial_balance) / portfolio.initial_balance) * 100,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
