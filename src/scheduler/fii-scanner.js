const pool = require('../db/connection');
const { buscarLoteFIIs } = require('../collectors/fiis');
const { calcularScore, getAction } = require('../engine/fii-scorer');
const { gerarSintese } = require('../engine/fii-ai');

// Tickers extintos, incorporados ou com problemas — nunca recomendar
const BLACKLIST = new Set(['XPIN11', 'FIGS11', 'RBVO11', 'NVHO11', 'CVBI11']);

// Universo base sempre monitorado
const FIIS_BASE = [
  'HGLG11', 'RZTR11', 'SNCI11', 'SNAG11', 'RZAK11', 'KNCR11',
  'XPML11', 'VISC11', 'BRCO11', 'RBRR11', 'HSML11', 'BTLG11',
  'TRXF11', 'GGRC11', 'VRTA11', 'KNRI11', 'MCCI11',
];

async function rodarFIIScanner() {
  console.log('[fii-scanner] Iniciando varredura...');

  // Remove tickers extintos/blacklistados do banco (caso estejam presentes)
  try {
    const blackArr = [...BLACKLIST];
    await pool.query('DELETE FROM fiis_market WHERE ticker = ANY($1)', [blackArr]);
  } catch (e) {
    console.warn('[fii-scanner] Erro ao purgar blacklist:', e.message);
  }

  // Inclui todos os tickers ativos nas carteiras dos usuários
  let tickersUsuarios = [];
  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT ticker FROM portfolio_fiis WHERE sold_at IS NULL'
    );
    tickersUsuarios = rows.map(r => r.ticker);
  } catch (e) {
    console.warn('[fii-scanner] Erro ao buscar tickers de usuários:', e.message);
  }

  const universo = [...new Set([...FIIS_BASE, ...tickersUsuarios])];
  console.log(`[fii-scanner] Universo: ${universo.length} FIIs`);

  const dados = await buscarLoteFIIs(universo);

  for (const fii of dados) {
    if (BLACKLIST.has(fii.ticker)) continue;
    const score  = calcularScore(fii);
    const action = getAction(score);
    await pool.query(
      `INSERT INTO fiis_market
         (ticker, name, price, dy_12m, pvp, liquidity, net_worth, score, action, segment, vacancy, properties, scanned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (ticker) DO UPDATE SET
         name=EXCLUDED.name, price=EXCLUDED.price, dy_12m=EXCLUDED.dy_12m,
         pvp=EXCLUDED.pvp, liquidity=EXCLUDED.liquidity, net_worth=EXCLUDED.net_worth,
         score=EXCLUDED.score, action=EXCLUDED.action, segment=EXCLUDED.segment,
         vacancy=EXCLUDED.vacancy, properties=EXCLUDED.properties, scanned_at=NOW()`,
      [
        fii.ticker, fii.name, fii.price, fii.dy_12m, fii.pvp,
        fii.liquidity, fii.net_worth, score, action,
        fii.segment ?? null, fii.vacancy ?? null, fii.properties ?? null,
      ]
    );
  }

  // Síntese IA do Top 10
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
  return dados.length;
}

module.exports = { rodarFIIScanner };
