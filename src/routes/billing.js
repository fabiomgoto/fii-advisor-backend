'use strict';

/**
 * billing.js — assinaturas e pagamentos (Asaas).
 *
 * Público:
 *   GET  /api/billing/plans          → catálogo de planos
 *   POST /api/billing/webhook        → eventos do Asaas (autenticado por token)
 *
 * Autenticado (Bearer Supabase):
 *   GET  /api/billing/subscription   → plano/assinatura atual do usuário
 *   POST /api/billing/checkout       → cria assinatura e devolve URL de pagamento
 *   POST /api/billing/cancel         → cancela a assinatura vigente
 */

const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');

const { listPublicPlans, getPlan, PLAN_ORDER } = require('../config/plans');
const asaas = require('../services/asaasService');
const subs  = require('../services/subscriptionService');
const { logError } = require('../services/errorLogService');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

function proximaDataVencimento() {
  const d = new Date();
  d.setDate(d.getDate() + 1); // primeira cobrança amanhã
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── GET /plans ────────────────────────────────────────────────────────────────
router.get('/plans', (req, res) => {
  res.json({ plans: listPublicPlans() });
});

// ── GET /subscription ─────────────────────────────────────────────────────────
router.get('/subscription', auth, async (req, res) => {
  try {
    const [{ plan, status, expiresAt }, sub] = await Promise.all([
      subs.getUserPlan(req.userId),
      subs.getActiveSubscription(req.userId),
    ]);
    res.json({
      plan,
      status,
      expiresAt,
      config: getPlan(plan),
      subscription: sub
        ? {
            id:        sub.asaas_subscription_id,
            status:    sub.status,
            value:     sub.value,
            cycle:     sub.cycle,
            createdAt: sub.created_at,
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /checkout ────────────────────────────────────────────────────────────
// body: { plan: 'pro'|'premium', cpfCnpj, name?, phone?, billingType? }
router.post('/checkout', auth, async (req, res) => {
  const { plan: planId, cpfCnpj, name, phone, billingType } = req.body || {};

  if (!PLAN_ORDER.includes(planId) || planId === 'free') {
    return res.status(400).json({ error: 'Plano inválido para checkout.' });
  }
  if (!cpfCnpj || String(cpfCnpj).replace(/\D/g, '').length < 11) {
    return res.status(400).json({ error: 'CPF/CNPJ é obrigatório para o pagamento.' });
  }
  if (!asaas.isConfigured()) {
    return res.status(503).json({ error: 'Pagamento indisponível: provedor não configurado.' });
  }

  const plan = getPlan(planId);

  try {
    // E-mail do usuário via Supabase (não vem no JWT já validado)
    let email = req.body?.email;
    if (!email) {
      const { data } = await supabaseAdmin.auth.admin.getUserById(req.userId);
      email = data?.user?.email;
    }
    if (!email) return res.status(400).json({ error: 'E-mail do usuário não encontrado.' });

    // Reusa customer do Asaas, se já existir
    let customerId = await subs.getAsaasCustomerId(req.userId);
    if (!customerId) {
      const customer = await asaas.createCustomer({
        name:              name || email.split('@')[0],
        email,
        cpfCnpj,
        mobilePhone:       phone,
        externalReference: req.userId,
      });
      customerId = customer.id;
    }

    const subscription = await asaas.createSubscription({
      customer:          customerId,
      value:             plan.preco,
      cycle:             plan.cycle || 'MONTHLY',
      nextDueDate:       proximaDataVencimento(),
      description:       `FII Advisor ${plan.nome}`,
      billingType:       billingType || 'UNDEFINED',
      externalReference: `${req.userId}:${planId}`,
    });

    await subs.upsertSubscription({
      userId:              req.userId,
      plan:                planId,
      asaasCustomerId:     customerId,
      asaasSubscriptionId: subscription.id,
      status:              'pending',
      value:               plan.preco,
      cycle:               plan.cycle || 'MONTHLY',
    });

    // URL de pagamento da primeira cobrança
    let paymentUrl = null;
    try {
      const payments = await asaas.listSubscriptionPayments(subscription.id);
      paymentUrl = payments[0]?.invoiceUrl || null;
    } catch (_) {}

    res.json({
      ok: true,
      subscriptionId: subscription.id,
      plan: planId,
      paymentUrl,
    });
  } catch (err) {
    await logError({
      type: 'unknown', source: 'billing/checkout', message: err.message,
      error: err, userId: req.userId, metadata: { plan: planId },
    });
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── POST /cancel ──────────────────────────────────────────────────────────────
router.post('/cancel', auth, async (req, res) => {
  try {
    const sub = await subs.getActiveSubscription(req.userId);
    if (!sub || sub.status === 'canceled') {
      return res.status(404).json({ error: 'Nenhuma assinatura ativa encontrada.' });
    }
    if (asaas.isConfigured()) {
      try { await asaas.cancelSubscription(sub.asaas_subscription_id); } catch (_) {}
    }
    await subs.cancelSubscription(sub);
    res.json({ ok: true, plan: 'free' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook ─────────────────────────────────────────────────────────────
// Asaas envia o header `asaas-access-token` = valor configurado no painel.
router.post('/webhook', async (req, res) => {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  const received = req.headers['asaas-access-token'];
  if (expected && received !== expected) {
    return res.status(401).json({ error: 'Token de webhook inválido.' });
  }

  const body    = req.body || {};
  const event   = body.event;
  const payment = body.payment || {};
  const asaasSubId = payment.subscription || body.subscription?.id || body.subscription;
  const externalId = body.id || payment.id || `${event}:${asaasSubId}:${Date.now()}`;

  // Responde 200 cedo — Asaas reenvia em não-2xx; processamos idempotentemente.
  res.json({ received: true });

  try {
    const novo = await subs.recordEvent({
      eventType: event, externalId, payload: body,
    });
    if (!novo) return; // evento duplicado

    if (!asaasSubId) return; // evento sem assinatura associada
    const sub = await subs.findByAsaasSubscriptionId(asaasSubId);
    if (!sub) return;

    switch (event) {
      case 'PAYMENT_CONFIRMED':
      case 'PAYMENT_RECEIVED':
        await subs.activateSubscription(sub);
        break;
      case 'PAYMENT_OVERDUE':
        await subs.markOverdue(sub);
        break;
      case 'PAYMENT_DELETED':
      case 'PAYMENT_REFUNDED':
      case 'PAYMENT_CHARGEBACK_REQUESTED':
      case 'SUBSCRIPTION_DELETED':
        await subs.cancelSubscription(sub);
        break;
      default:
        // demais eventos apenas registrados
        break;
    }
  } catch (err) {
    await logError({
      type: 'unknown', source: 'billing/webhook', message: err.message,
      error: err, metadata: { event, asaasSubId },
    });
  }
});

module.exports = router;
