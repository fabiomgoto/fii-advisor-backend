'use strict';

/**
 * Alerta de data COM — enviado diariamente às 8h para usuários Pro/Premium
 * que tenham notif_data_com=true e FIIs com ex_date amanhã.
 */

const pool        = require('../db/connection');
const { sendMail } = require('../services/emailService');

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtR(v) {
  if (v == null) return '—';
  return `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

function buildHtml(nome, alertas) {
  const rows = alertas.map(a => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #2a2a2a;font-weight:600;color:#f0ede8">${a.ticker}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #2a2a2a;color:#c9a84c;font-family:monospace">${fmtDate(a.ex_date)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #2a2a2a;color:#c9a84c;font-family:monospace">${fmtR(a.value_per_share)}/cota</td>
      <td style="padding:10px 14px;border-bottom:1px solid #2a2a2a;color:#888">${fmtDate(a.payment_date)}</td>
    </tr>
  `).join('');

  const saudacao = nome ? `Olá, ${nome}!` : 'Olá!';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">

    <div style="margin-bottom:28px">
      <span style="font-size:11px;color:#c9a84c;font-family:monospace;text-transform:uppercase;letter-spacing:.1em">FII Advisor</span>
      <h1 style="margin:8px 0 4px;font-size:20px;color:#f0ede8;font-weight:600">📅 Data COM amanhã</h1>
      <p style="margin:0;font-size:13px;color:#666">${saudacao} Os FIIs abaixo têm data COM amanhã — você precisa estar posicionado hoje para receber o provento.</p>
    </div>

    <table style="width:100%;border-collapse:collapse;background:#1a1a1a;border-radius:8px;overflow:hidden;border:1px solid #2a2a2a">
      <thead>
        <tr style="background:#141414">
          <th style="padding:8px 14px;text-align:left;font-size:10px;color:#555;font-family:monospace;text-transform:uppercase;letter-spacing:.08em;font-weight:400">Ticker</th>
          <th style="padding:8px 14px;text-align:left;font-size:10px;color:#555;font-family:monospace;text-transform:uppercase;letter-spacing:.08em;font-weight:400">COM</th>
          <th style="padding:8px 14px;text-align:left;font-size:10px;color:#555;font-family:monospace;text-transform:uppercase;letter-spacing:.08em;font-weight:400">Valor/cota</th>
          <th style="padding:8px 14px;text-align:left;font-size:10px;color:#555;font-family:monospace;text-transform:uppercase;letter-spacing:.08em;font-weight:400">Pagamento</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="margin:24px 0 0;font-size:11px;color:#444;line-height:1.6">
      Para desativar estes alertas, acesse seu <a href="https://fiiadvisor.com.br/perfil" style="color:#c9a84c">perfil</a> e desmarque "Alertas de data COM".<br>
      Este e-mail não constitui recomendação de investimento.
    </p>
  </div>
</body>
</html>`;
}

function buildText(nome, alertas) {
  const saudacao = nome ? `Olá, ${nome}!` : 'Olá!';
  let text = `FII Advisor — Data COM amanhã\n\n${saudacao}\n\n`;
  alertas.forEach(a => {
    text += `${a.ticker} — COM ${fmtDate(a.ex_date)} | ${fmtR(a.value_per_share)}/cota | Pgto ${fmtDate(a.payment_date)}\n`;
  });
  text += '\nPara desativar: https://fiiadvisor.com.br/perfil\nNão é recomendação de investimento.';
  return text;
}

async function dispararAlertasCOM() {
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  const amanhaStr = amanha.toISOString().substring(0, 10);

  // Busca usuários Pro/Premium com notif_data_com=true que têm FII com ex_date amanhã
  const { rows } = await pool.query(`
    SELECT
      up.user_id,
      up.nome,
      sa.email,
      json_agg(
        json_build_object(
          'ticker',          d.ticker,
          'ex_date',         d.ex_date,
          'payment_date',    d.payment_date,
          'value_per_share', d.value_per_share
        ) ORDER BY d.ticker
      ) AS alertas
    FROM user_profiles up
    JOIN dividends d ON d.user_id = up.user_id
    JOIN (
      SELECT id, email FROM auth.users
    ) sa ON sa.id = up.user_id
    WHERE up.notif_data_com = TRUE
      AND up.plan IN ('pro', 'premium')
      AND d.ex_date = $1
    GROUP BY up.user_id, up.nome, sa.email
  `, [amanhaStr]);

  if (!rows.length) {
    console.log('[com-alert] Nenhum alerta COM para amanhã');
    return;
  }

  console.log(`[com-alert] Enviando alertas para ${rows.length} usuário(s) — ex_date ${amanhaStr}`);

  for (const row of rows) {
    try {
      await sendMail({
        to:      row.email,
        subject: `📅 Data COM amanhã — ${row.alertas.map(a => a.ticker).join(', ')}`,
        html:    buildHtml(row.nome, row.alertas),
        text:    buildText(row.nome, row.alertas),
      });
      console.log(`[com-alert] ✓ ${row.email} — ${row.alertas.length} ticker(s)`);
    } catch (e) {
      console.error(`[com-alert] ✗ ${row.email}:`, e.message);
    }
  }
}

module.exports = { dispararAlertasCOM };
