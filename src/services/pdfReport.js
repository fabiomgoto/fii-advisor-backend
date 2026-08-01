'use strict';

const PDFDocument = require('pdfkit');

// ── Paleta ───────────────────────────────────────────────────────────────────
const C = {
  bg:     '#0f0f0f',
  card:   '#1a1a1a',
  border: '#2a2a2a',
  text:   '#f0ede8',
  sub:    '#aaa',
  hint:   '#666',
  gold:   '#c9a84c',
  green:  '#2ecc71',
  red:    '#e74c3c',
  white:  '#ffffff',
};

function hex(h) {
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return [r, g, b];
}

function fmtR(v) {
  if (v == null) return '—';
  return `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(v) {
  if (v == null) return '—';
  return `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function mesLabel() {
  return new Date().toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
}

/**
 * Gera PDF de relatório mensal da carteira FII.
 * @param {object} data - { nome, fiis[], proventos[], resumo }
 * @returns {Buffer}
 */
function gerarRelatorio(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: {
        Title:    `Relatório FII Advisor — ${mesLabel()}`,
        Author:   'FII Advisor',
        Subject:  'Relatório mensal de carteira de FIIs',
        Keywords: 'FII, fundos imobiliários, proventos, carteira',
      },
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;   // 595
    const H = doc.page.height;  // 842
    const M = 40;               // margem lateral
    const CW = W - M * 2;      // content width

    // ── Funções auxiliares ────────────────────────────────────────────────────
    function fillBg() {
      doc.rect(0, 0, W, H).fill(hex(C.bg));
    }

    function hrLine(y, color = C.border) {
      doc.moveTo(M, y).lineTo(W - M, y).stroke(hex(color));
    }

    function sectionTitle(text, y) {
      doc.font('Helvetica-Bold').fontSize(9)
        .fillColor(hex(C.hint))
        .text(text.toUpperCase(), M, y, { characterSpacing: 1.5 });
      return y + 18;
    }

    function statCard(label, value, x, y, w, color = C.gold) {
      doc.rect(x, y, w, 54).fill(hex(C.card));
      doc.rect(x, y, w, 54).stroke(hex(C.border));
      doc.font('Helvetica').fontSize(9).fillColor(hex(C.hint))
        .text(label, x + 12, y + 10, { width: w - 24 });
      doc.font('Helvetica-Bold').fontSize(15).fillColor(hex(color))
        .text(value, x + 12, y + 25, { width: w - 24 });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PÁGINA 1 — CAPA + RESUMO
    // ══════════════════════════════════════════════════════════════════════════
    fillBg();

    // Barra de topo dourada
    doc.rect(0, 0, W, 4).fill(hex(C.gold));

    // Título
    doc.font('Helvetica-Bold').fontSize(28).fillColor(hex(C.gold))
      .text('FII Advisor', M, 40);
    doc.font('Helvetica').fontSize(13).fillColor(hex(C.sub))
      .text(`Relatório mensal — ${mesLabel()}`, M, 78);

    // Linha divisória
    hrLine(105, C.border);

    // Saudação
    const saudacao = data.nome ? `Olá, ${data.nome}` : 'Sua carteira';
    doc.font('Helvetica-Bold').fontSize(16).fillColor(hex(C.text))
      .text(saudacao, M, 120);
    doc.font('Helvetica').fontSize(11).fillColor(hex(C.sub))
      .text('Aqui está o resumo da sua carteira de fundos imobiliários.', M, 142);

    // ── Cards de resumo ───────────────────────────────────────────────────────
    const { resumo } = data;
    const cardGap = 8;
    const cardW   = (CW - cardGap * 2) / 3;
    const cardY   = 175;

    statCard('Total investido',     fmtR(resumo.totalInvestido),    M,                         cardY, cardW);
    statCard('Valor atual',         fmtR(resumo.valorAtual),        M + cardW + cardGap,       cardY, cardW);
    statCard('Rentabilidade',       fmtPct(resumo.rentabilidade),   M + (cardW + cardGap) * 2, cardY, cardW,
      resumo.rentabilidade >= 0 ? C.green : C.red);

    const cardY2 = cardY + 54 + cardGap;
    statCard('DY mensal (R$)',      fmtR(resumo.dyMesTotal),        M,                         cardY2, cardW);
    statCard('Yield médio (a.m.)',  fmtPct(resumo.yieldMedio),      M + cardW + cardGap,       cardY2, cardW);
    statCard('Qtd de FIIs',         String(resumo.qtdFiis),         M + (cardW + cardGap) * 2, cardY2, cardW, C.text);

    // ── Tabela de carteira ────────────────────────────────────────────────────
    let y = cardY2 + 54 + 28;
    y = sectionTitle('Carteira', y);
    hrLine(y, C.border);
    y += 10;

    // Cabeçalho da tabela
    const cols = [
      { label: 'Ticker',       x: M,          w: 60,  align: 'left'  },
      { label: 'Cotas',        x: M + 60,     w: 50,  align: 'right' },
      { label: 'P. Médio',     x: M + 110,    w: 75,  align: 'right' },
      { label: 'Valor Atual',  x: M + 185,    w: 80,  align: 'right' },
      { label: 'DY mês',       x: M + 265,    w: 70,  align: 'right' },
      { label: 'Yield m.',     x: M + 335,    w: 60,  align: 'right' },
      { label: 'Segmento',     x: M + 395,    w: 120, align: 'left'  },
    ];

    doc.font('Helvetica-Bold').fontSize(8).fillColor(hex(C.hint));
    cols.forEach(c => {
      doc.text(c.label, c.x, y, { width: c.w, align: c.align, characterSpacing: 0.5 });
    });
    y += 14;
    hrLine(y, C.border);
    y += 6;

    // Linhas de dados
    const fiis = data.fiis || [];
    for (let i = 0; i < fiis.length; i++) {
      const fii = fiis[i];

      // Nova página se necessário
      if (y > H - 80) {
        doc.addPage({ size: 'A4', margin: 0 });
        fillBg();
        doc.rect(0, 0, W, 4).fill(hex(C.gold));
        y = M + 10;

        doc.font('Helvetica-Bold').fontSize(8).fillColor(hex(C.hint));
        cols.forEach(c => {
          doc.text(c.label, c.x, y, { width: c.w, align: c.align, characterSpacing: 0.5 });
        });
        y += 14;
        hrLine(y, C.border);
        y += 6;
      }

      // Fundo alternado
      if (i % 2 === 0) {
        doc.rect(M - 4, y - 3, CW + 8, 18).fill(hex(C.card));
      }

      const valorAtual  = fii.preco_atual != null && fii.totalCotas != null
        ? fii.preco_atual * fii.totalCotas : null;
      const dyMes       = fii.div_mes_valor != null && fii.totalCotas != null
        ? fii.div_mes_valor * fii.totalCotas : null;
      const yieldMensal = fii.preco_atual && fii.div_mes_valor
        ? (fii.div_mes_valor / fii.preco_atual) * 100 : null;

      const rowData = [
        { col: cols[0], text: fii.ticker,                             color: C.gold,  bold: true  },
        { col: cols[1], text: String(fii.totalCotas ?? '—'),          color: C.text               },
        { col: cols[2], text: fmtR(fii.preco_medio),                  color: C.text               },
        { col: cols[3], text: fmtR(valorAtual),                       color: C.text               },
        { col: cols[4], text: fmtR(dyMes),                            color: C.green              },
        { col: cols[5], text: fmtPct(yieldMensal),                    color: C.green              },
        { col: cols[6], text: fii.segmento || '—',                    color: C.sub                },
      ];

      rowData.forEach(({ col, text, color, bold }) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8.5).fillColor(hex(color))
          .text(text, col.x, y, { width: col.w, align: col.align });
      });

      y += 18;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PÁGINA 2 — PROVENTOS DO MÊS
    // ══════════════════════════════════════════════════════════════════════════
    const proventos = data.proventos || [];
    if (proventos.length > 0) {
      doc.addPage({ size: 'A4', margin: 0 });
      fillBg();
      doc.rect(0, 0, W, 4).fill(hex(C.gold));

      y = M + 10;
      doc.font('Helvetica-Bold').fontSize(16).fillColor(hex(C.gold))
        .text('Proventos recebidos', M, y);
      y += 26;
      doc.font('Helvetica').fontSize(11).fillColor(hex(C.sub))
        .text(`Dividendos e rendimentos creditados em ${mesLabel()}.`, M, y);
      y += 30;

      y = sectionTitle('Histórico de proventos', y);
      hrLine(y, C.border);
      y += 10;

      const pcols = [
        { label: 'Ticker',      x: M,        w: 70,  align: 'left'  },
        { label: 'Tipo',        x: M + 70,   w: 90,  align: 'left'  },
        { label: 'Valor/cota',  x: M + 160,  w: 90,  align: 'right' },
        { label: 'Suas cotas',  x: M + 250,  w: 70,  align: 'right' },
        { label: 'Total',       x: M + 320,  w: 90,  align: 'right' },
        { label: 'Pagamento',   x: M + 410,  w: 105, align: 'right' },
      ];

      doc.font('Helvetica-Bold').fontSize(8).fillColor(hex(C.hint));
      pcols.forEach(c => doc.text(c.label, c.x, y, { width: c.w, align: c.align, characterSpacing: 0.5 }));
      y += 14;
      hrLine(y, C.border);
      y += 6;

      let totalProventos = 0;
      proventos.forEach((p, i) => {
        if (y > H - 80) {
          doc.addPage({ size: 'A4', margin: 0 });
          fillBg();
          doc.rect(0, 0, W, 4).fill(hex(C.gold));
          y = M + 10;
          doc.font('Helvetica-Bold').fontSize(8).fillColor(hex(C.hint));
          pcols.forEach(c => doc.text(c.label, c.x, y, { width: c.w, align: c.align, characterSpacing: 0.5 }));
          y += 14;
          hrLine(y, C.border);
          y += 6;
        }

        if (i % 2 === 0) doc.rect(M - 4, y - 3, CW + 8, 18).fill(hex(C.card));

        const total = p.value_per_share != null && p.cotas != null
          ? p.value_per_share * p.cotas : null;
        if (total != null) totalProventos += total;

        const pdata = [
          { col: pcols[0], text: p.ticker,                    color: C.gold, bold: true },
          { col: pcols[1], text: p.type || 'Rendimento',      color: C.sub               },
          { col: pcols[2], text: fmtR(p.value_per_share),     color: C.text              },
          { col: pcols[3], text: String(p.cotas ?? '—'),      color: C.text              },
          { col: pcols[4], text: fmtR(total),                 color: C.green             },
          { col: pcols[5], text: fmtDate(p.payment_date),     color: C.sub               },
        ];
        pdata.forEach(({ col, text, color, bold }) => {
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(8.5).fillColor(hex(color))
            .text(text, col.x, y, { width: col.w, align: col.align });
        });
        y += 18;
      });

      // Total de proventos
      y += 8;
      hrLine(y, C.gold);
      y += 12;
      doc.font('Helvetica').fontSize(10).fillColor(hex(C.sub))
        .text('Total de proventos no mês:', M, y);
      doc.font('Helvetica-Bold').fontSize(14).fillColor(hex(C.gold))
        .text(fmtR(totalProventos || null), M + 180, y - 2);
    }

    // ── Rodapé (última página) ────────────────────────────────────────────────
    const pageCount = doc.bufferedPageRange().count + 1;
    for (let p = 0; p < pageCount; p++) {
      doc.switchToPage(p);
      doc.font('Helvetica').fontSize(8).fillColor(hex(C.hint))
        .text(
          `FII Advisor  ·  Relatório gerado em ${new Date().toLocaleDateString('pt-BR')}  ·  Não constitui recomendação de investimento`,
          M, H - 28, { width: CW, align: 'center' }
        );
    }

    doc.end();
  });
}

module.exports = { gerarRelatorio };
