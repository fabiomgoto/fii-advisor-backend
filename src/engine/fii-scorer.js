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

module.exports = { calcularScore, getAction };
