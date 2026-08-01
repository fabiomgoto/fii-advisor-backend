'use strict';

/**
 * Rotas de cobrança via Stripe.
 *
 * Variáveis de ambiente necessárias:
 *   STRIPE_SECRET_KEY          sk_live_... ou sk_test_...
 *   STRIPE_WEBHOOK_SECRET      whsec_...  (do webhook no dashboard Stripe)
 *   STRIPE_PRICE_PRO           price_...  (preço mensal Pro)
 *   STRIPE_PRICE_PREMIUM       price_...  (preço mensal Premium)
 *   FRONTEND_URL               https://fiiadvisor.com.br
 */

const express        = require('express');
const router         = express.Router();
const Stripe         = require('stripe');
const pool           = require('../db/connection');
const authMiddleware = require('../middleware/auth');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

// Mapeamento price_id → plan
const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_PRO]:     'pro',
  [process.env.STRIPE_PRICE_PREMIUM]: 'premium',
};

const PLAN_TO_PRICE = {
  pro:     process.env.STRIPE_PRICE_PRO,
  premium: process.env.STRIPE_PRICE_PREMIUM,
};

const FRONTEND = process.env.FRONTEND_URL || 'https://fiiadvisor.com.br';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getOrCreateCustomer(userId, email) {
  // Verifica se já tem customer_id no banco
  const { rows } = await pool.query(
    'SELECT stripe_customer_id FROM user_profiles WHERE user_id = $1',
    [userId]
  );
  if (rows[0]?.stripe_customer_id) return rows[0].stripe_customer_id;

  // Cria novo customer no Stripe
  const customer = await stripe.customers.create({
    email,
    metadata: { user_id: userId },
  });

  // Salva no banco
  await pool.query(`
    INSERT INTO user_profiles (user_id, stripe_customer_id, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET stripe_customer_id = EXCLUDED.stripe_customer_id, updated_at = NOW()
  `, [userId, customer.id]);

  return customer.id;
}

async function upsertPlan(userId, plan) {
  await pool.query(`
    INSERT INTO user_profiles (user_id, plan, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET plan = EXCLUDED.plan, updated_at = NOW()
  `, [userId, plan]);
}

// ── Rotas protegidas ─────────────────────────────────────────────────────────

// POST /api/billing/checkout — cria sessão de checkout Stripe
router.post('/checkout', authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body; // 'pro' | 'premium'
    const priceId  = PLAN_TO_PRICE[plan];

    if (!priceId) {
      return res.status(400).json({ error: 'Plano inválido. Use "pro" ou "premium".' });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: 'Gateway de pagamento não configurado.' });
    }

    const userId = req.user.id;

    // Busca email do usuário via Supabase (já validado no middleware)
    const { createClient } = require('@supabase/supabase-js');
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
    );
    const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(userId);
    const email = user?.email || '';

    const customerId = await getOrCreateCustomer(userId, email);

    // Verifica se já tem assinatura ativa → redireciona para portal
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });
    if (subs.data.length > 0) {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer:   customerId,
        return_url: `${FRONTEND}/carteira`,
      });
      return res.json({ url: portalSession.url, portal: true });
    }

    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode:                 'subscription',
      success_url:          `${FRONTEND}/planos/sucesso?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${FRONTEND}/planos`,
      subscription_data: {
        metadata: { user_id: userId, plan },
      },
      locale: 'pt-BR',
      allow_promotion_codes: true,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[billing] checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/portal — link para o customer portal (gerenciar/cancelar)
router.post('/portal', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT stripe_customer_id FROM user_profiles WHERE user_id = $1',
      [req.user.id]
    );
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) {
      return res.status(404).json({ error: 'Nenhuma assinatura encontrada.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${FRONTEND}/perfil`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/status — status atual da assinatura
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT plan, stripe_customer_id FROM user_profiles WHERE user_id = $1',
      [req.user.id]
    );
    const profile    = rows[0] || {};
    const customerId = profile.stripe_customer_id;

    if (!customerId || !process.env.STRIPE_SECRET_KEY) {
      return res.json({ plan: profile.plan || 'free', subscription: null });
    }

    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status:   'all',
      limit:    1,
      expand:   ['data.default_payment_method'],
    });

    const sub = subs.data[0] || null;
    res.json({
      plan:         profile.plan || 'free',
      subscription: sub ? {
        id:             sub.id,
        status:         sub.status,
        current_period_end: sub.current_period_end,
        cancel_at_period_end: sub.cancel_at_period_end,
        price_id:       sub.items.data[0]?.price.id,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Webhook Stripe (sem authMiddleware — usa assinatura Stripe) ───────────────

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.warn('[billing] STRIPE_WEBHOOK_SECRET não configurado');
    return res.sendStatus(200);
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[billing] Webhook signature inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[billing] webhook: ${event.type}`);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session    = event.data.object;
        const customerId = session.customer;
        const subId      = session.subscription;

        // Busca plan dos metadados da subscription
        const sub  = await stripe.subscriptions.retrieve(subId);
        const plan = sub.metadata?.plan
          || PRICE_TO_PLAN[sub.items.data[0]?.price.id]
          || 'pro';

        // Descobre user_id pelo customer_id
        const { rows } = await pool.query(
          'SELECT user_id FROM user_profiles WHERE stripe_customer_id = $1',
          [customerId]
        );
        if (rows.length) await upsertPlan(rows[0].user_id, plan);
        break;
      }

      case 'customer.subscription.updated': {
        const sub        = event.data.object;
        const customerId = sub.customer;
        const priceId    = sub.items.data[0]?.price.id;
        const plan       = PRICE_TO_PLAN[priceId] || sub.metadata?.plan;

        if (!plan) break;

        // Ativo ou trial → aplica plano; cancelado → volta para free
        const effectivePlan = ['active', 'trialing'].includes(sub.status) ? plan : 'free';

        const { rows } = await pool.query(
          'SELECT user_id FROM user_profiles WHERE stripe_customer_id = $1',
          [customerId]
        );
        if (rows.length) await upsertPlan(rows[0].user_id, effectivePlan);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub        = event.data.object;
        const customerId = sub.customer;

        const { rows } = await pool.query(
          'SELECT user_id FROM user_profiles WHERE stripe_customer_id = $1',
          [customerId]
        );
        if (rows.length) await upsertPlan(rows[0].user_id, 'free');
        break;
      }

      case 'invoice.payment_failed': {
        const invoice    = event.data.object;
        const customerId = invoice.customer;
        console.warn(`[billing] Pagamento falhou para customer ${customerId}`);
        // Mantém plano atual — Stripe tenta novamente automaticamente
        break;
      }
    }
  } catch (err) {
    console.error('[billing] Erro ao processar webhook:', err.message);
    return res.status(500).send('Webhook handler error');
  }

  res.sendStatus(200);
});

module.exports = router;
