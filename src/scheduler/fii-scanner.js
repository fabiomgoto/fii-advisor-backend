const pool = require('../db/connection');
const { buscarLoteFIIs } = require('../collectors/fiis');
const { calcularScore, getAction } = require('../engine/fii-scorer');
const { gerarSintese } = require('../engine/fii-ai');

// FIIs monitorados (carteira + universo básico)
const FIIS_UNIVERSO = [
  'HGLG11', 'RZTR11', 'SNCI11', 'SNAG11', 'RZAK11', 'KNCR11',
  'XPML11', 'VISC11', 'BRCO11', 'RBRR11', 'HSML11', 'BTLG11',
  'TRXF11', 'GGRC11', 'VRTA11', 'KNRI11', 'MCCI11', 'CVBI11',
];

async function rodarFIIScanner() {
  console.log('[fii-scanner] Iniciando varredura...');
  const dados = await buscarLoteFIIs(FIIS_UNIVERSO);

  for (const fii of dados) {
    const score = calcularScore(fii);
    const action = getAction(score);
    await pool.query(
      `INSERT INTO fiis_market (ticker, name, price, dy_12m, pvp, liquidity, net_worth, score, action, scanned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (ticker) DO UPDATE SET
         name=EXCLUDED.name, price=EXCLUDED.price, dy_12m=EXCLUDED.dy_12m,
         pvp=EXCLUDED.pvp, liquidity=EXCLUDED.liquidity, net_worth=EXCLUDED.net_worth,
         score=EXCLUDED.score, action=EXCLUDED.action, scanned_at=NOW()`,
      [fii.ticker, fii.name, fii.price, fii.dy_12m, fii.pvp, fii.liquidity, fii.net_worth, score, action]
    );
  }

  // Gera síntese IA para o Top 10
  const top10 = dados
    .map(f => ({ ...f, score: calcularScore(f), action: getAction(calcularScore(f)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  try {
    const synthesis = await gerarSintese(top10);
    await pool.query(
      `INSERT INTO top10_synthesis (synthesis, top_tickers) VALUES ($1, $2)`,
      [synthesis, JSON.stringify(top10.map(f => f.ticker))]
    );
    console.log('[fii-scanner] Síntese IA gerada.');
  } catch (err) {
    console.warn('[fii-scanner] Falha na síntese IA:', err.message);
  }

  console.log(`[fii-scanner] Concluído: ${dados.length} FIIs processados.`);
}

module.exports = { rodarFIIScanner };
