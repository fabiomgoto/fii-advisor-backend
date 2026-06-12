'use strict';

// ── SCORE 1: MOMENTO FINANCEIRO (0–100) ──────────────────────────────────────

function calcularFinancialScore(respostas) {
  let score = 0;

  const compRenda = { menos_40: 25, '40_60': 18, '61_80': 8, acima_80: 2 };
  score += compRenda[respostas.gastos_mensais] || 0;

  const dividas = { nenhuma: 25, controlada: 12, pesada: 0 };
  score += dividas[respostas.dividas] || 0;

  const reserva = { nenhuma: 0, menos_3m: 8, '3_6m': 18, '6_12m': 26, mais_12m: 30 };
  score += reserva[respostas.reserva_emergencia] || 0;

  const aporte = { menos_300: 4, '300_1000': 10, '1001_3000': 15, '3001_10000': 18, acima_10000: 20 };
  score += aporte[respostas.aporte_mensal] || 0;

  return Math.min(100, Math.max(0, score));
}

function classificarMomentoFinanceiro(score) {
  if (score >= 65) return 'saudavel';
  if (score >= 35) return 'cauteloso';
  return 'restrito';
}

// ── SCORE 2: PERFIL DE INVESTIDOR (0–100) ────────────────────────────────────

function calcularInvestorScore(respostas) {
  let score = 0;

  const reacao10 = { vende_tudo: 2, vende_parte: 7, aguarda: 11, compra_mais: 13 };
  score += reacao10[respostas.reacao_queda_10] || 0;

  const reacao30 = { vende_tudo: 0, vende_parte: 6, mantem: 11, compra_agressivo: 12 };
  score += reacao30[respostas.reacao_queda_30] || 0;

  const perdaMax = { nenhuma: 0, ate_5pct: 5, ate_15pct: 12, ate_30pct: 17, ilimitada: 20 };
  score += perdaMax[respostas.perda_aceitavel] || 0;

  const horizonte = { menos_1ano: 0, '1_3anos': 5, '3_5anos': 12, '5_10anos': 17, mais_10anos: 20, nunca_resgatar: 20 };
  score += horizonte[respostas.horizonte_principal] || 0;

  const tempoInv = { iniciando: 0, menos_1ano: 4, '1_3anos': 8, '3_5anos': 10, mais_5anos: 12 };
  score += tempoInv[respostas.tempo_investindo] || 0;

  const produtos = respostas.produtos_conhecidos || [];
  const avancados = ['acoes', 'etfs', 'derivativos', 'fiis'];
  score += Math.min(8, produtos.filter(p => avancados.includes(p)).length * 2);

  const usoDiv = { reinvestir_tudo: 10, reinvestir_maioria: 8, metade: 6, renda_complementar: 4, renda_principal: 1 };
  score += usoDiv[respostas.uso_dividendos] || 0;

  const expFii = { nunca: 0, ouviu_falar: 1, ja_teve: 3, acompanha: 4, investidor_ativo: 5 };
  score += expFii[respostas.experiencia_fii] || 0;

  return Math.min(100, Math.max(0, score));
}

function classificarPerfilInvestidor(score) {
  if (score >= 86) return 'sofisticado';
  if (score >= 66) return 'arrojado';
  if (score >= 36) return 'moderado';
  return 'conservador';
}

// ── MATRIX DE RECOMENDAÇÃO (perfil × momento) ────────────────────────────────

const RECOMMENDATION_MATRIX = {
  conservador: {
    saudavel:  { segmentos: ['recebiveis', 'fof_conservador'], maxExposicao: 0.30, focoDY: true,  minDY: 0.06, maxPVP: 1.05 },
    cauteloso: { segmentos: ['recebiveis'],                     maxExposicao: 0.20, focoDY: true,  minDY: 0.07, maxPVP: 1.00 },
    restrito:  { segmentos: [],                                 maxExposicao: 0.00, pausar: true,  mensagem: 'Priorize reserva de emergência antes de investir em FIIs.' },
  },
  moderado: {
    saudavel:  { segmentos: ['recebiveis', 'logistico', 'fof'], maxExposicao: 0.50, focoDY: false, minDY: 0.07, maxPVP: 1.10 },
    cauteloso: { segmentos: ['recebiveis', 'logistico'],         maxExposicao: 0.35, focoDY: true,  minDY: 0.08, maxPVP: 1.00 },
    restrito:  { segmentos: ['recebiveis'],                      maxExposicao: 0.10, pausar: false, mensagem: 'Momento financeiro delicado. Mantenha aportes mínimos apenas em FIIs de baixíssimo risco.' },
  },
  arrojado: {
    saudavel:  { segmentos: ['logistico', 'shopping', 'corporativo', 'agro', 'recebiveis'], maxExposicao: 0.70, focoDY: false, minDY: 0.06, maxPVP: 1.20 },
    cauteloso: { segmentos: ['recebiveis', 'logistico'],         maxExposicao: 0.40, focoDY: false, minDY: 0.07, maxPVP: 1.05 },
    restrito:  { segmentos: ['recebiveis'],                      maxExposicao: 0.15, pausar: false, mensagem: 'Reduza novos aportes e mantenha apenas posições existentes.' },
  },
  sofisticado: {
    saudavel:  { segmentos: ['todos'],                           maxExposicao: 0.90, focoDY: false, minDY: 0.00, maxPVP: 9.99 },
    cauteloso: { segmentos: ['logistico', 'shopping', 'recebiveis'], maxExposicao: 0.50, focoDY: false, minDY: 0.06, maxPVP: 1.10 },
    restrito:  { segmentos: ['recebiveis', 'logistico'],         maxExposicao: 0.25, pausar: false, mensagem: 'Momento restritivo. Mantenha carteira atual e evite novos aportes.' },
  },
};

function getRecommendationConfig(investorProfile, financialMoment) {
  return RECOMMENDATION_MATRIX[investorProfile]?.[financialMoment]
    || RECOMMENDATION_MATRIX.conservador.cauteloso;
}

module.exports = {
  calcularFinancialScore,
  classificarMomentoFinanceiro,
  calcularInvestorScore,
  classificarPerfilInvestidor,
  getRecommendationConfig,
};
