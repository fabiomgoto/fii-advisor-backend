function calcularScore(fii) {
  let pts = 0;

  // DY Sustentável (20pts)
  if (fii.dy_12m != null) {
    if (fii.dy_12m >= 10) pts += 20;
    else if (fii.dy_12m >= 8) pts += 15;
    else if (fii.dy_12m >= 6) pts += 10;
    else pts += 5;
  }
  // dy_12m null → 0pts (não pontua sem dado)

  // P/VP (15pts)
  if (fii.pvp != null) {
    if (fii.pvp < 0.90) pts += 15;
    else if (fii.pvp < 1.00) pts += 12;
    else if (fii.pvp < 1.10) pts += 8;
    else pts += 3;
  }
  // pvp null → 0pts

  // Vacância (15pts)
  if (fii.vacancy != null) {
    if (fii.vacancy < 3) pts += 15;
    else if (fii.vacancy < 8) pts += 10;
    else if (fii.vacancy < 15) pts += 5;
  }

  // Crescimento dividendos (15pts)
  if (fii.div_growth != null) {
    if (fii.div_growth > 0) pts += 15;
    else if (fii.div_growth === 0) pts += 8;
  }

  // WAULT qualidade contratos (10pts)
  if (fii.wault != null) {
    if (fii.wault > 5) pts += 10;
    else if (fii.wault > 3) pts += 7;
    else pts += 3;
  }

  // Alavancagem (10pts)
  if (fii.leverage != null) {
    if (fii.leverage < 20) pts += 10;
    else if (fii.leverage < 35) pts += 6;
    else pts += 2;
  }

  // Diversificação (10pts)
  if (fii.properties != null) {
    if (fii.properties > 10) pts += 10;
    else if (fii.properties > 5) pts += 6;
    else pts += 3;
  }

  // Liquidez (5pts)
  if (fii.liquidity != null) {
    if (fii.liquidity > 2000000) pts += 5;
    else if (fii.liquidity > 500000) pts += 3;
    else pts += 1;
  }

  return Math.min(pts, 100);
}

function getAction(score) {
  if (score >= 80) return 'buy';
  if (score >= 60) return 'hold';
  return 'review';
}

// ─── Score por perfil (pesos ajustados) ─────────────────────────────────────

const PESOS_PERFIL = {
  renda:       { dy: 35, pvp: 10, vacancy: 10, div_growth: 25, wault:  5, leverage:  5, properties:  5, liquidity:  5 },
  crescimento: { dy: 10, pvp: 30, vacancy: 15, div_growth: 10, wault: 15, leverage: 10, properties:  5, liquidity:  5 },
  equilibrio:  { dy: 20, pvp: 15, vacancy: 15, div_growth: 15, wault: 10, leverage: 10, properties: 10, liquidity:  5 },
  seguranca:   { dy: 15, pvp: 10, vacancy: 10, div_growth: 10, wault: 20, leverage: 20, properties: 10, liquidity:  5 },
};

function calcularScorePerfil(fii, perfil) {
  const pesos = PESOS_PERFIL[perfil] || PESOS_PERFIL.equilibrio;
  let pts = 0;
  let maxDisponivel = 0;

  function pontuarCriterio(valor, max, fn) {
    if (valor == null) return;
    maxDisponivel += max;
    pts += fn(valor, max);
  }

  pontuarCriterio(fii.dy_12m, pesos.dy, (v, m) => {
    if (v >= 10) return m;
    if (v >= 8)  return m * 0.75;
    if (v >= 6)  return m * 0.5;
    return m * 0.25;
  });

  pontuarCriterio(fii.pvp, pesos.pvp, (v, m) => {
    if (v < 0.90) return m;
    if (v < 1.00) return m * 0.8;
    if (v < 1.10) return m * 0.53;
    return m * 0.2;
  });

  pontuarCriterio(fii.vacancy, pesos.vacancy, (v, m) => {
    if (v < 3)  return m;
    if (v < 8)  return m * 0.67;
    if (v < 15) return m * 0.33;
    return 0;
  });

  pontuarCriterio(fii.div_growth, pesos.div_growth, (v, m) => {
    if (v > 0)  return m;
    if (v === 0) return m * 0.53;
    return 0;
  });

  pontuarCriterio(fii.wault, pesos.wault, (v, m) => {
    if (v > 5) return m;
    if (v > 3) return m * 0.7;
    return m * 0.3;
  });

  pontuarCriterio(fii.leverage, pesos.leverage, (v, m) => {
    if (v < 20) return m;
    if (v < 35) return m * 0.6;
    return m * 0.2;
  });

  pontuarCriterio(fii.properties, pesos.properties, (v, m) => {
    if (v > 10) return m;
    if (v > 5)  return m * 0.6;
    return m * 0.3;
  });

  pontuarCriterio(fii.liquidity, pesos.liquidity, (v, m) => {
    if (v > 2000000) return m;
    if (v > 500000)  return m * 0.6;
    return m * 0.2;
  });

  if (maxDisponivel === 0) return calcularScore(fii);
  return Math.min(Math.round((pts / maxDisponivel) * 100), 100);
}

module.exports = { calcularScore, calcularScorePerfil, getAction, PESOS_PERFIL };
