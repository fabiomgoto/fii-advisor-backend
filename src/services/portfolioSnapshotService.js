'use strict';

const pool = require('../db/connection');

/**
 * Calcula e salva o snapshot diário de valor de carteira para todos os usuários.
 * Fonte de preço: fiis_market.price (populada pelo scanner diário).
 */
async function runPortfolioSnapshots() {
  // 1. Usuários distintos com aportes registrados
  const { rows: users } = await pool.query(
    'SELECT DISTINCT user_id FROM contributions'
  );

  if (!users.length) {
    console.log('[Snapshot] Nenhum usuário com carteira — nada a fazer');
    return;
  }

  // 2. Preços atuais de todos os tickers em fiis_market
  const { rows: precos } = await pool.query(
    'SELECT ticker, price FROM fiis_market WHERE price IS NOT NULL'
  );
  const precoMap = {};
  for (const r of precos) precoMap[r.ticker] = parseFloat(r.price) || 0;

  for (const { user_id } of users) {
    try {
      // 2a. Posições: ticker, total de cotas e custo médio por ticker
      const { rows: posicoes } = await pool.query(
        `SELECT
           ticker,
           SUM(quantity) AS cotas,
           SUM(total)    AS investido
         FROM contributions
         WHERE user_id = $1
         GROUP BY ticker`,
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

        if (!preco) {
          console.warn(`[Snapshot] preço não encontrado para ${p.ticker} — usando 0`);
        }

        const valor = cotas * preco;
        valor_atual    += valor;
        total_investido += investido;

        detalhes[p.ticker] = {
          cotas,
          preco_atual: preco,
          valor: Math.round(valor * 100) / 100,
        };
      }

      // 2e. Variação em relação ao dia anterior
      const { rows: prev } = await pool.query(
        `SELECT valor_atual FROM portfolio_snapshots
         WHERE user_id = $1 AND snapshot_date < CURRENT_DATE
         ORDER BY snapshot_date DESC LIMIT 1`,
        [user_id]
      );

      const prevValor    = prev.length ? parseFloat(prev[0].valor_atual) : null;
      const variacao_dia  = prevValor != null ? valor_atual - prevValor : null;
      const variacao_pct  = prevValor && prevValor > 0
        ? (variacao_dia / prevValor)
        : null;

      // 2f. UPSERT
      await pool.query(
        `INSERT INTO portfolio_snapshots
           (user_id, snapshot_date, valor_atual, total_investido, variacao_dia, variacao_pct, detalhes)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, snapshot_date) DO UPDATE
           SET valor_atual     = EXCLUDED.valor_atual,
               total_investido = EXCLUDED.total_investido,
               variacao_dia    = EXCLUDED.variacao_dia,
               variacao_pct    = EXCLUDED.variacao_pct,
               detalhes        = EXCLUDED.detalhes`,
        [
          user_id,
          Math.round(valor_atual    * 100) / 100,
          Math.round(total_investido * 100) / 100,
          variacao_dia  != null ? Math.round(variacao_dia  * 100) / 100 : null,
          variacao_pct  != null ? Math.round(variacao_pct  * 10000) / 10000 : null,
          JSON.stringify(detalhes),
        ]
      );

      const pct = variacao_pct != null ? (variacao_pct * 100).toFixed(2) + '%' : 'n/a';
      console.log(`[Snapshot] usuário ${user_id.substring(0, 8)}: R$${valor_atual.toFixed(2)} (variação: ${pct})`);
    } catch (err) {
      console.error(`[Snapshot] erro para usuário ${user_id.substring(0, 8)}:`, err.message);
    }
  }
}

module.exports = { runPortfolioSnapshots };
