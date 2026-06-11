/**
 * Motor de score do wizard de perfil de investidor.
 * 7 blocos ponderados → score 0–100 → perfil (conservador/moderado/arrojado/sofisticado)
 */

const WEIGHTS = {
  financial_capacity: 20,
  emergency_reserve:  15,
  horizon:            15,
  experience:         15,
  risk_tolerance:     20,
  income_need:        10,
  fii_knowledge:       5,
};

function calculateInvestorScore(wizardData = {}) {
  const s2 = wizardData.step2 || {};
  const s3 = wizardData.step3 || {};
  const s5 = wizardData.step5 || {};
  const s6 = wizardData.step6 || {};
  const s7 = wizardData.step7 || {};
  const s8 = wizardData.step8 || {};

  const blocks = {
    financial_capacity: scoreFinancialCapacity(s2, s3),
    emergency_reserve:  scoreEmergencyReserve(s3),
    horizon:            scoreHorizon(s5),
    experience:         scoreExperience(s6),
    risk_tolerance:     scoreRiskTolerance(s7),
    income_need:        scoreIncomeNeed(s8),
    fii_knowledge:      scoreFIIKnowledge(s6),
  };

  const total = Object.entries(blocks).reduce((acc, [key, val]) => {
    return acc + (val * WEIGHTS[key] / 100);
  }, 0);

  const score = Math.min(100, Math.max(0, Math.round(total)));

  return { score, blocks, profile: classifyProfile(score) };
}

function classifyProfile(score) {
  if (score <= 35) return 'conservador';
  if (score <= 65) return 'moderado';
  if (score <= 85) return 'arrojado';
  return 'sofisticado';
}

function scoreFinancialCapacity(s2, s3) {
  const income   = parseFloat(s2.monthly_income)   || 0;
  const expenses = parseFloat(s3.monthly_expenses) || 0;
  const surplus  = income - expenses;
  if (surplus <= 0)    return 10;
  if (surplus < 1000)  return 30;
  if (surplus < 3000)  return 60;
  if (surplus < 8000)  return 80;
  return 100;
}

function scoreEmergencyReserve(s3) {
  // Normaliza: aceita boolean ou string "true"/"false"
  const hasReserve = s3.has_reserve === true || s3.has_reserve === 'true';
  if (!hasReserve) return 0;
  const months = parseInt(s3.reserve_months) || 0;
  if (months < 3)  return 20;
  if (months < 6)  return 50;
  if (months < 12) return 80;
  return 100;
}

function scoreHorizon(s5) {
  const map = {
    less_1y:  10,
    '1_3y':   30,
    '3_5y':   60,
    '5_10y':  85,
    more_10y: 100,
  };
  return map[s5.horizon] ?? 0; // 0 quando não respondido, não infla o score
}

function scoreExperience(s6) {
  const map = {
    never:    0,
    less_1y:  20,
    '1_3y':   50,
    '3_5y':   75,
    more_5y:  100,
  };
  return map[s6.investment_time] ?? 0;
}

function scoreRiskTolerance(s7) {
  const dropMap = { sell_all: 10, sell_part: 40, do_nothing: 70, buy_more: 100 };
  const prefMap = { low_risk: 10, balanced: 50, high_return: 100 };
  const drop = dropMap[s7.drop_reaction]         || 30;
  const pref = prefMap[s7.volatility_preference] || 30;
  return Math.round((drop + pref) / 2);
}

function scoreIncomeNeed(s8) {
  // Normaliza: aceita boolean ou string
  const needsNow   = s8.needs_income_now   === true || s8.needs_income_now   === 'true';
  const reinvest   = s8.reinvest_dividends === true || s8.reinvest_dividends === 'true';
  if (needsNow)  return 30;
  if (reinvest)  return 100;
  return 60;
}

function scoreFIIKnowledge(s6) {
  const products = s6.invested_products || [];
  if (products.includes('fiis'))                            return 100;
  if (products.includes('acoes') || products.includes('etfs')) return 60;
  if (products.includes('fundos'))                          return 30;
  return 10;
}

// Regras de negócio para restrições automáticas
function applyBusinessRules(wizardData, recommendation) {
  const s3 = wizardData.step3 || {};
  const s5 = wizardData.step5 || {};
  const s8 = wizardData.step8 || {};

  const warnings = [];

  if (parseInt(s3.reserve_months || 0) < 6) {
    warnings.push('Sua reserva de emergência está abaixo de 6 meses. Considere priorizá-la antes de ampliar exposição em FIIs.');
    recommendation.max_fii_exposure = 0.3;
  }

  if (s5.horizon === 'less_1y' || s5.horizon === '1_3y') {
    warnings.push('Com horizonte de investimento curto, recomendamos menor exposição em FIIs de tijolo.');
    recommendation.prefer_paper_fiis = true;
  }

  if (s8.needs_income_now) {
    warnings.push('Priorizando FIIs com histórico estável de distribuição de proventos.');
    recommendation.priority = 'income';
  }

  return { ...recommendation, warnings };
}

module.exports = { calculateInvestorScore, classifyProfile, applyBusinessRules };
