'use strict';

const express        = require('express');
const router         = express.Router();
const pool           = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const { gerarRelatorio } = require('../services/pdfReport');

router.use(authMiddleware);

const PLAN_PDF = new Set(['premium']);

// GET /api/relatorio/pdf — gera e devolve o PDF mensal da carteira
router.get('/pdf', async (req, res) => {
  try {
    const plan = req.user?.plan ?? 'free';
    if (!PLAN_PDF.has(plan)) {
      return res.status(403).json({
        error:      'plan_required',
        message:    'O relatório em PDF está disponível apenas no plano Premium.',
        upgradeUrl: '/planos',
      });
    }

    const userId = req.user.id;

    // Dados da carteira com preço atual e proventos
    const { rows: fiis } = await pool.query(`
      SELECT
        pf.ticker,
        pf.total_cotas        AS "totalCotas",
        pf.preco_medio,
        f.segmento,
        f.preco_atual,
        -- DY do mês corrente (prioridade StatusInvest)
        (
          SELECT d.value_per_share
          FROM dividends d
          WHERE d.user_id = pf.user_id
            AND d.ticker  = pf.ticker
            AND date_trunc('month', d.payment_date) = date_trunc('month', NOW())
          ORDER BY d.payment_date DESC
          LIMIT 1
        ) AS div_mes_valor
      FROM (
        SELECT
          user_id,
          ticker,
          SUM(cotas) FILTER (WHERE sold_at IS NULL) AS total_cotas,
          SUM(preco_compra * cotas) FILTER (WHERE sold_at IS NULL)
            / NULLIF(SUM(cotas) FILTER (WHERE sold_at IS NULL), 0) AS preco_medio
        FROM portfolio_fiis
        WHERE user_id = $1
        GROUP BY user_id, ticker
        HAVING SUM(cotas) FILTER (WHERE sold_at IS NULL) > 0
      ) pf
      LEFT JOIN fiis f ON f.ticker = pf.ticker
      ORDER BY pf.ticker
    `, [userId]);

    // Proventos do mês corrente
    const { rows: proventos } = await pool.query(`
      SELECT
        d.ticker,
        d.type,
        d.value_per_share,
        d.payment_date,
        pf.total_cotas AS cotas
      FROM dividends d
      JOIN (
        SELECT ticker, SUM(cotas) AS total_cotas
        FROM portfolio_fiis
        WHERE user_id = $1 AND sold_at IS NULL
        GROUP BY ticker
      ) pf ON pf.ticker = d.ticker
      WHERE d.user_id = $1
        AND date_trunc('month', d.payment_date) = date_trunc('month', NOW())
      ORDER BY d.payment_date DESC, d.ticker
    `, [userId]);

    // Perfil do usuário
    const { rows: profileRows } = await pool.query(
      'SELECT nome FROM user_profiles WHERE user_id = $1', [userId]
    );
    const nome = profileRows[0]?.nome || null;

    // Cálculo do resumo
    let totalInvestido = 0;
    let valorAtual     = 0;
    let dyMesTotal     = 0;

    for (const f of fiis) {
      const inv = (f.preco_medio ?? 0) * (f.totalCotas ?? 0);
      const atu = (f.preco_atual ?? 0) * (f.totalCotas ?? 0);
      const dy  = (f.div_mes_valor ?? 0) * (f.totalCotas ?? 0);
      totalInvestido += inv;
      valorAtual     += atu;
      dyMesTotal     += dy;
    }

    const rentabilidade = totalInvestido > 0
      ? ((valorAtual - totalInvestido) / totalInvestido) * 100
      : null;

    const yieldMedio = valorAtual > 0 ? (dyMesTotal / valorAtual) * 100 : null;

    const resumo = {
      totalInvestido: totalInvestido || null,
      valorAtual:     valorAtual     || null,
      rentabilidade,
      dyMesTotal:     dyMesTotal     || null,
      yieldMedio,
      qtdFiis:        fiis.length,
    };

    const pdfBuffer = await gerarRelatorio({ nome, fiis, proventos, resumo });

    const mes = new Date().toLocaleString('pt-BR', { month: 'long', year: 'numeric' })
      .replace(' de ', '-').replace(' ', '-');
    const filename = `relatorio-fii-${mes}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[relatorio] Erro ao gerar PDF:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
