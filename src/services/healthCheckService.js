'use strict';

const axios     = require('axios');
const nodemailer = require('nodemailer');
const pool      = require('../db/connection');

const TICKER    = 'HGLG11';
const TIMEOUT   = 10_000; // 10s por verificação

// ── Helpers ───────────────────────────────────────────────────────────────────

function elapsed(start) {
  return Math.round(performance.now() - start);
}

async function save(source, status, response_time_ms, sample_ticker, error_message, fields_returned) {
  try {
    await pool.query(
      `INSERT INTO health_checks (source, status, response_time_ms, sample_ticker, error_message, fields_returned)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [source, status, response_time_ms, sample_ticker || null, error_message || null,
       fields_returned ? JSON.stringify(fields_returned) : null]
    );
  } catch (e) {
    console.error(`[HEALTH] falha ao salvar resultado de ${source}:`, e.message);
  }
}

// ── Verificação 1 — brapi.dev ─────────────────────────────────────────────────

async function checkBrapi() {
  const t = performance.now();
  try {
    const token = process.env.BRAPI_TOKEN;
    const url   = `https://brapi.dev/api/quote/${TICKER}?token=${token}`;
    const { data } = await axios.get(url, { timeout: TIMEOUT });
    const price = data?.results?.[0]?.regularMarketPrice;
    if (!price || price <= 0) throw new Error('preço inválido ou zero');
    const ms = elapsed(t);
    console.log(`[HEALTH] brapi: ok (${ms}ms)`);
    await save('brapi', 'ok', ms, TICKER, null, { price, dividendYield: data?.results?.[0]?.dividendYield });
    return { source: 'brapi', status: 'ok', ms };
  } catch (e) {
    const ms = elapsed(t);
    console.log(`[HEALTH] brapi: fail (${ms}ms) — ${e.message}`);
    await save('brapi', 'fail', ms, TICKER, e.message, null);
    return { source: 'brapi', status: 'fail', ms, error: e.message };
  }
}

// ── Verificação 2 — FundsExplorer (scraping) ──────────────────────────────────

async function checkFundsExplorer() {
  const t = performance.now();
  try {
    const { data: html } = await axios.get(
      `https://fundsexplorer.com.br/funds/${TICKER}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
        timeout: TIMEOUT,
      }
    );

    const extract = (key) => {
      const m = html.match(new RegExp(`"${key}"\\s*:\\s*(-?[\\d.]+)`));
      return m ? parseFloat(m[1]) : null;
    };

    const pvp      = extract('pvp');
    const dy12m    = extract('dividendyield') ?? extract('dy_ano');

    const vacRe = /"vacancia_(\d+)_vacancia_fisica"\s*:\s*(-?[\d.]+)/g;
    let maxIdx = -1, vacancy = null, vm;
    while ((vm = vacRe.exec(html)) !== null) {
      const idx = parseInt(vm[1]);
      if (idx > maxIdx) { maxIdx = idx; vacancy = parseFloat(vm[2]); }
    }

    const fields = { pvp, dy12m, vacancy };
    const hasData = Object.values(fields).some(v => v !== null);
    if (!hasData) throw new Error('nenhum campo extraído — possível bloqueio');

    const ms = elapsed(t);
    console.log(`[HEALTH] fundsexplorer: ok (${ms}ms)`);
    await save('fundsexplorer', 'ok', ms, TICKER, null, fields);
    return { source: 'fundsexplorer', status: 'ok', ms };
  } catch (e) {
    const ms = elapsed(t);
    console.log(`[HEALTH] fundsexplorer: fail (${ms}ms) — ${e.message}`);
    await save('fundsexplorer', 'fail', ms, TICKER, e.message, null);
    return { source: 'fundsexplorer', status: 'fail', ms, error: e.message };
  }
}

// ── Verificação 3 — StatusInvest (scraping) ───────────────────────────────────

async function checkStatusInvest() {
  const t = performance.now();
  try {
    const { data: html } = await axios.get(
      `https://statusinvest.com.br/fundos-imobiliarios/${TICKER.toLowerCase()}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Referer': 'https://statusinvest.com.br/',
        },
        timeout: TIMEOUT,
      }
    );

    const safeF = (s) => { const v = parseFloat(String(s).replace(',', '.')); return isNaN(v) ? null : v; };

    const dyMatch  = html.match(/dy[^<]{0,80}?(\d{1,2}[,.]?\d{0,2})\s*%/i);
    const pvpMatch = html.match(/p\s*\/\s*vp[^<]{0,80}?([0-9]+[,.]?[0-9]*)/i);
    const dy12m    = dyMatch  ? safeF(dyMatch[1])  : null;
    const pvp      = pvpMatch ? safeF(pvpMatch[1]) : null;

    const fields   = { dy12m, pvp };
    const hasData  = Object.values(fields).some(v => v !== null);
    if (!hasData) throw new Error('nenhum campo extraído — possível bloqueio');

    const ms = elapsed(t);
    console.log(`[HEALTH] statusinvest: ok (${ms}ms)`);
    await save('statusinvest', 'ok', ms, TICKER, null, fields);
    return { source: 'statusinvest', status: 'ok', ms };
  } catch (e) {
    const ms = elapsed(t);
    console.log(`[HEALTH] statusinvest: fail (${ms}ms) — ${e.message}`);
    await save('statusinvest', 'fail', ms, TICKER, e.message, null);
    return { source: 'statusinvest', status: 'fail', ms, error: e.message };
  }
}

// ── Verificação 4 — Anthropic API ────────────────────────────────────────────

async function checkAnthropic() {
  const t = performance.now();
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada');

    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT,
      }
    );

    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const ms = elapsed(t);
    console.log(`[HEALTH] anthropic: ok (${ms}ms)`);
    await save('anthropic', 'ok', ms, null, null, { status: res.status });
    return { source: 'anthropic', status: 'ok', ms };
  } catch (e) {
    const ms = elapsed(t);
    console.log(`[HEALTH] anthropic: fail (${ms}ms) — ${e.message}`);
    await save('anthropic', 'fail', ms, null, e.message, null);
    return { source: 'anthropic', status: 'fail', ms, error: e.message };
  }
}

// ── Verificação 5 — PostgreSQL ────────────────────────────────────────────────

async function checkDatabase() {
  const t = performance.now();
  try {
    await pool.query('SELECT NOW()');
    const ms = elapsed(t);
    console.log(`[HEALTH] database: ok (${ms}ms)`);
    await save('database', 'ok', ms, null, null, null);
    return { source: 'database', status: 'ok', ms };
  } catch (e) {
    const ms = elapsed(t);
    console.log(`[HEALTH] database: fail (${ms}ms) — ${e.message}`);
    // não pode salvar no banco se o banco falhou — apenas console
    return { source: 'database', status: 'fail', ms, error: e.message };
  }
}

// ── Alerta por e-mail ─────────────────────────────────────────────────────────

async function sendAlertIfNeeded(results) {
  const failures = results.filter(r => r.status === 'fail');
  if (failures.length === 0) return;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL_FROM, ALERT_EMAIL_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL_FROM || !ALERT_EMAIL_TO) {
    console.warn('[HEALTH] SMTP não configurado — e-mail de alerta não enviado');
    return;
  }

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587'),
    secure: parseInt(SMTP_PORT || '587') === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const rows = results.map(r => `
    <tr style="background:${r.status === 'fail' ? '#fff0f0' : r.status === 'warn' ? '#fffbe6' : '#f0fff0'}">
      <td style="padding:8px 12px;border:1px solid #ddd;font-weight:600">${r.source}</td>
      <td style="padding:8px 12px;border:1px solid #ddd;color:${r.status === 'fail' ? '#c00' : r.status === 'warn' ? '#b85c00' : '#0a0'};font-weight:700;text-transform:uppercase">${r.status}</td>
      <td style="padding:8px 12px;border:1px solid #ddd;font-family:monospace">${r.ms ?? '—'}ms</td>
      <td style="padding:8px 12px;border:1px solid #ddd;color:#888;font-size:12px">${r.error || '—'}</td>
    </tr>`).join('');

  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const html = `
  <div style="font-family:sans-serif;max-width:700px;margin:0 auto">
    <h2 style="color:#c00">⚠️ FII Advisor — Alerta de saúde</h2>
    <p><strong>${failures.length}</strong> fonte(s) falharam no check das ${now} (Brasília)</p>
    <table style="border-collapse:collapse;width:100%;margin:16px 0">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">Fonte</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">Status</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">Tempo</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">Erro</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#888;font-size:12px">
      Verifique o endpoint: <a href="${process.env.BASE_URL || 'https://fii-advisor-backend.railway.app'}/api/health">/api/health</a>
    </p>
  </div>`;

  try {
    await transport.sendMail({
      from:    ALERT_EMAIL_FROM,
      to:      ALERT_EMAIL_TO,
      subject: `[FII Advisor] ALERTA — falha em ${failures.length} fonte(s) de dados`,
      html,
    });
    console.log(`[HEALTH] alerta enviado para ${ALERT_EMAIL_TO}`);
  } catch (e) {
    console.error('[HEALTH] falha ao enviar e-mail:', e.message);
  }
}

// ── Execução principal ────────────────────────────────────────────────────────

async function runHealthChecks() {
  console.log('[HEALTH] iniciando verificações...');

  const settled = await Promise.allSettled([
    checkBrapi(),
    checkFundsExplorer(),
    checkStatusInvest(),
    checkAnthropic(),
    checkDatabase(),
  ]);

  const results = settled.map(s =>
    s.status === 'fulfilled' ? s.value : { source: 'unknown', status: 'fail', error: s.reason?.message }
  );

  await sendAlertIfNeeded(results);
  console.log('[HEALTH] verificações concluídas');
  return results;
}

module.exports = { runHealthChecks };
