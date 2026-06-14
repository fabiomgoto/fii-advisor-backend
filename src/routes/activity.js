'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../db/connection');
const auth    = require('../middleware/auth');

// Garante que a tabela existe
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_activity (
      user_id      UUID        NOT NULL,
      screen       VARCHAR(60) NOT NULL,
      visits       INT         NOT NULL DEFAULT 1,
      first_visited TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_visited  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, screen)
    )
  `);
}
ensureTable().catch(e => console.warn('[activity] ensureTable:', e.message));

// POST /api/activity/track — registra visita a uma tela
router.post('/track', auth, async (req, res) => {
  const { screen } = req.body;
  if (!screen || typeof screen !== 'string') return res.status(400).json({ error: 'screen required' });

  const safe = screen.slice(0, 60);
  try {
    await pool.query(
      `INSERT INTO user_activity (user_id, screen, visits, first_visited, last_visited)
       VALUES ($1, $2, 1, NOW(), NOW())
       ON CONFLICT (user_id, screen) DO UPDATE
         SET visits = user_activity.visits + 1,
             last_visited = NOW()`,
      [req.userId, safe]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/activity/mine — resumo do próprio usuário (opcional, para uso futuro)
router.get('/mine', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT screen, visits, last_visited FROM user_activity WHERE user_id = $1 ORDER BY visits DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
