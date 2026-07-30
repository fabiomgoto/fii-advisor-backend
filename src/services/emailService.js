'use strict';

const nodemailer = require('nodemailer');

function createTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   parseInt(SMTP_PORT || '587'),
    secure: parseInt(SMTP_PORT || '587') === 465,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendMail({ to, subject, html, text }) {
  const transport = createTransport();
  if (!transport) {
    console.warn('[email] SMTP não configurado — e-mail não enviado');
    return false;
  }
  const from = process.env.SMTP_FROM || process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER;
  await transport.sendMail({ from, to, subject, html, text });
  return true;
}

module.exports = { sendMail };
