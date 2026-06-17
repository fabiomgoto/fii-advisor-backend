#!/usr/bin/env node
/**
 * node src/scripts/backfillSnapshots.js [--days=30]
 *
 * Gera snapshots retroativos usando os preços atuais do fiis_market.
 * Usa ON CONFLICT DO NOTHING — não sobrescreve dados reais se existirem.
 */
'use strict';

require('dotenv').config();
const pool = require('../db/connection');

const days = parseInt(
  (process.argv.find(a => a.startsWith('--days=')) || '--days=30').split('=')[1]
) || 30;

async function run() {
  console.log(`[Backfill] Gerando snapshots retroativos dos últimos ${days} dias...`);

  // Preços atuais
  const { rows: precos } = await pool.query(
    'SELECT ticker, price FROM fiis_market WHERE price IS NOT NULL'
  );
  const precoMap = {};
  for (const r of precos) precoMap[r.ticker] = parseFloat(r.price) || 0;

  // Usuários com carteira
  const { rows: users } = await pool.query(
    'SELECT DISTINCT user_id FROM contributions'
  );

  if (!users.length) {
    console.log('[Backfill] Nenhum usuário com carteira.');
    return;
  }

  let inserted = 0;

  for (const { user_id } of users) {
    const { rows: posicoes } = await pool.query(
      `SELECT ticker, SUM(quantity) AS cotas, SUM(total) AS investido
       FROM contributions WHERE user_id = $1 GROUP BY ticker`,
      [user_id]
    );
    if (!posicoes.length) continue;

    let valor_atual    = 0;
    let total_investido = 0;
    const detalhes = {};

    for (const p of posicoes) {
      const cotas    = parseFloat(p.cotas)    || 0;
      const investido = parseFloat(p.investido) || 0;
      const preco    = precoMap[p.ticker] ?? 0;
      const valor    = cotas * preco;

      valor_atual    += valor;
      total_investido += investido;
      detalhes[p.ticker] = { cotas, preco_atual: preco, valor: Math.round(valor * 100) / 100 };
    }

    valor_atual    = Math.round(valor_atual    * 100) / 100;
    total_investido = Math.round(total_investido * 100) / 100;

    // Inserir um registro por dia dos últimos N dias
    for (let d = days - 1; d >= 0; d--) {
      const { rowCount } = await pool.query(
        `INSERT INTO portfolio_snapshots
           (user_id, snapshot_date, valor_atual, total_investido, variacao_dia, variacao_pct, detalhes)
         VALUES ($1, CURRENT_DATE - ($2 * INTERVAL '1 day'), $3, $4, NULL, NULL, $5)
         ON CONFLICT (user_id, snapshot_date) DO NOTHING`,
        [user_id, d, valor_atual, total_investido, JSON.stringify(detalhes)]
      );
      inserted += rowCount;
    }

    console.log(`[Backfill] ${user_id.substring(0, 8)}: R$${valor_atual.toFixed(2)} — ${days} dias inseridos`);
  }

  console.log(`[Backfill] Concluído — ${inserted} registros inseridos`);
}

run().catch(err => {
  console.error('[Backfill] Erro:', err.message);
  process.exit(1);
}).finally(() => pool.end());
