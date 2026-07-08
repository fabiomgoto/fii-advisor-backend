'use strict';

/**
 * subscriptionService.js — camada de negócio das assinaturas.
 *
 * Fonte de verdade do plano do usuário = tabela `subscriptions` (estado do Asaas)
 * refletida em `user_profiles.plan` para leitura barata no gating.
 *
 * Estados possíveis de `status`:
 *   pending   — assinatura criada, aguardando 1º pagamento
 *   active    — pagamento confirmado/recebido, plano liberado
 *   overdue   — pagamento em atraso (mantém acesso até plan_expires_at)
 *   canceled  — cancelada pelo usuário ou pelo Asaas
 */

const pool = require('../db/connection');
const { getPlan } = require('../config/plans');

/**
 * Retorna o plano efetivo do usuário considerando expiração.
 * Se a assinatura expirou (plan_expires_at no passado), rebaixa para 'free'.
 * @returns {Promise<{plan:string, status:string|null, expiresAt:string|null}>}
 */
async function getUserPlan(userId) {
  const { rows } = await pool.query(
    `SELECT plan, plan_status, plan_expires_at
       FROM user_profiles
      WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row || !row.plan || row.plan === 'free') {
    return { plan: 'free', status: row?.plan_status || null, expiresAt: null };
  }

  const expirado =
    row.plan_expires_at && new Date(row.plan_expires_at).getTime() < Date.now();

  if (expirado) {
    return { plan: 'free', status: 'expired', expiresAt: row.plan_expires_at };
  }
  return { plan: row.plan, status: row.plan_status, expiresAt: row.plan_expires_at };
}

/** Reflete o plano no user_profiles (leitura rápida no gating). */
async function setUserProfilePlan(userId, { plan, status, expiresAt }) {
  await pool.query(
    `INSERT INTO user_profiles (user_id, plan, plan_status, plan_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET plan            = EXCLUDED.plan,
           plan_status     = EXCLUDED.plan_status,
           plan_expires_at = EXCLUDED.plan_expires_at,
           updated_at      = NOW()`,
    [userId, plan, status, expiresAt || null]
  );
}

/** Cria/atualiza o registro da assinatura (idempotente por asaas_subscription_id). */
async function upsertSubscription({
  userId, plan, asaasCustomerId, asaasSubscriptionId,
  status = 'pending', value, cycle,
}) {
  const { rows } = await pool.query(
    `INSERT INTO subscriptions
       (user_id, plan, asaas_customer_id, asaas_subscription_id, status, value, cycle, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
     ON CONFLICT (asaas_subscription_id) DO UPDATE
       SET plan       = EXCLUDED.plan,
           status     = EXCLUDED.status,
           value      = EXCLUDED.value,
           cycle      = EXCLUDED.cycle,
           updated_at = NOW()
     RETURNING *`,
    [userId, plan, asaasCustomerId, asaasSubscriptionId, status, value, cycle]
  );
  return rows[0];
}

/** Recupera o customer_id já salvo para o usuário (reuso entre assinaturas). */
async function getAsaasCustomerId(userId) {
  const { rows } = await pool.query(
    `SELECT asaas_customer_id
       FROM subscriptions
      WHERE user_id = $1 AND asaas_customer_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId]
  );
  return rows[0]?.asaas_customer_id || null;
}

/** Busca a assinatura ativa/mais recente do usuário. */
async function getActiveSubscription(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions
      WHERE user_id = $1
      ORDER BY (status = 'active') DESC, created_at DESC
      LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

function cycleToMs(cycle) {
  return cycle === 'YEARLY'
    ? 366 * 24 * 60 * 60 * 1000
    : 32 * 24 * 60 * 60 * 1000; // MONTHLY + folga
}

/**
 * Ativa a assinatura após pagamento confirmado.
 * Estende plan_expires_at conforme o ciclo.
 */
async function activateSubscription(subscription) {
  const expiresAt = new Date(Date.now() + cycleToMs(subscription.cycle));
  await pool.query(
    `UPDATE subscriptions SET status = 'active', updated_at = NOW()
      WHERE asaas_subscription_id = $1`,
    [subscription.asaas_subscription_id]
  );
  await setUserProfilePlan(subscription.user_id, {
    plan: subscription.plan,
    status: 'active',
    expiresAt,
  });
}

/** Marca em atraso, mas mantém o acesso vigente até plan_expires_at. */
async function markOverdue(subscription) {
  await pool.query(
    `UPDATE subscriptions SET status = 'overdue', updated_at = NOW()
      WHERE asaas_subscription_id = $1`,
    [subscription.asaas_subscription_id]
  );
  await pool.query(
    `UPDATE user_profiles SET plan_status = 'overdue', updated_at = NOW()
      WHERE user_id = $1`,
    [subscription.user_id]
  );
}

/** Cancela a assinatura e rebaixa o usuário para free imediatamente. */
async function cancelSubscription(subscription) {
  await pool.query(
    `UPDATE subscriptions SET status = 'canceled', updated_at = NOW()
      WHERE asaas_subscription_id = $1`,
    [subscription.asaas_subscription_id]
  );
  await setUserProfilePlan(subscription.user_id, {
    plan: 'free',
    status: 'canceled',
    expiresAt: null,
  });
}

/** Busca a assinatura local pelo id do Asaas. */
async function findByAsaasSubscriptionId(asaasSubscriptionId) {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions WHERE asaas_subscription_id = $1`,
    [asaasSubscriptionId]
  );
  return rows[0] || null;
}

/** Registra o evento bruto do webhook (auditoria + idempotência). */
async function recordEvent({ provider = 'asaas', eventType, externalId, payload }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO payment_events (provider, event_type, external_id, payload, created_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (provider, external_id) DO NOTHING
       RETURNING id`,
      [provider, eventType, externalId, JSON.stringify(payload)]
    );
    return rows.length > 0; // true = novo evento, false = duplicado
  } catch (_) {
    return true; // em caso de tabela ausente, não bloqueia o processamento
  }
}

module.exports = {
  getUserPlan,
  setUserProfilePlan,
  upsertSubscription,
  getAsaasCustomerId,
  getActiveSubscription,
  activateSubscription,
  markOverdue,
  cancelSubscription,
  findByAsaasSubscriptionId,
  recordEvent,
  getPlan,
};
