'use strict';

/**
 * plans.js — definição central dos planos de assinatura.
 *
 * Fonte única de verdade para preços, limites e recursos de cada tier.
 * Usado pelo gating de features, pelo checkout (Asaas) e pela rota /billing/plans.
 *
 * Hierarquia: free < pro < premium
 */

const PLAN_ORDER = ['free', 'pro', 'premium'];

const PLANS = {
  free: {
    id:          'free',
    nome:        'Gratuito',
    preco:       0,
    cycle:       null,          // sem cobrança
    descricao:   'Para começar a acompanhar seus FIIs.',
    limites: {
      carteira_max:   10,       // nº máximo de FIIs na carteira
      explicacao_ia:  5,        // explicações de IA por mês
      deep_analysis:  0,        // análises profundas por mês
      relatorio_pdf:  false,
      alertas_email:  false,
      proventos_auto: false,
    },
    recursos: [
      'Carteira com até 10 FIIs',
      'Score básico de mercado',
      'Proventos manuais',
      'Top 50 FIIs por score',
      'Comparador de FIIs',
    ],
  },

  pro: {
    id:          'pro',
    nome:        'PRO',
    preco:       29.90,
    cycle:       'MONTHLY',
    descricao:   'Automação, alertas e carteira ilimitada.',
    limites: {
      carteira_max:   null,     // ilimitado
      explicacao_ia:  50,
      deep_analysis:  5,
      relatorio_pdf:  false,
      alertas_email:  true,
      proventos_auto: true,
    },
    recursos: [
      'Carteira ilimitada',
      'Score personalizado por perfil',
      'Proventos automáticos (BRAPI)',
      'Alertas de data COM por e-mail',
      'Varredura diária automática',
      '50 explicações com IA por mês',
    ],
  },

  premium: {
    id:          'premium',
    nome:        'Premium',
    preco:       59.90,
    cycle:       'MONTHLY',
    descricao:   'Tudo do PRO, sem limites, com relatórios e suporte.',
    limites: {
      carteira_max:   null,
      explicacao_ia:  null,     // ilimitado
      deep_analysis:  null,     // ilimitado
      relatorio_pdf:  true,
      alertas_email:  true,
      proventos_auto: true,
    },
    recursos: [
      'Tudo do plano PRO',
      'Explicações com IA ilimitadas',
      'Análise profunda (IA 5 camadas) ilimitada',
      'Relatório mensal em PDF',
      'Suporte prioritário',
    ],
  },
};

/** Retorna a config do plano (fallback para free). */
function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

/** Posição do plano na hierarquia (free=0, pro=1, premium=2). */
function planRank(planId) {
  const idx = PLAN_ORDER.indexOf(planId);
  return idx === -1 ? 0 : idx;
}

/** true se `planId` cobre (é igual ou superior a) `minPlan`. */
function planCovers(planId, minPlan) {
  return planRank(planId) >= planRank(minPlan);
}

/**
 * Retorna o limite de um recurso para um plano.
 * `null` = ilimitado, número = teto, boolean = feature liga/desliga.
 */
function getLimit(planId, recurso) {
  const plan = getPlan(planId);
  return plan.limites?.[recurso];
}

/** Lista pública (sem detalhes internos) para o frontend. */
function listPublicPlans() {
  return PLAN_ORDER.map((id) => {
    const { id: _id, nome, preco, cycle, descricao, recursos, limites } = PLANS[id];
    return { id: _id, nome, preco, cycle, descricao, recursos, limites };
  });
}

module.exports = {
  PLANS,
  PLAN_ORDER,
  getPlan,
  planRank,
  planCovers,
  getLimit,
  listPublicPlans,
};
