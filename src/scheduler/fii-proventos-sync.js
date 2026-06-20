/**
 * fii-proventos-sync.js
 *
 * Sincroniza proventos calculados para tabela fii_proventos.
 * Fonte: tabela `dividends` (entradas manuais do usuário) × `contributions` (cotas na data)
 *
 * Nota: brapi free plan não suporta dividendsData/cashDividends para FIIs.
 * A sincronização usa dados locais que o usuário já cadastrou.
 */

const pool = require('../db/connection');

// ─── Helper: cotas acumuladas até uma data ───────────────────────────────────

function cotasNaData(aportes, dataRef) {
  if (!dataRef || !aportes?.length) return 0;
  return aportes
    .filter(a => (a.date || '').substring(0, 10) <= dataRef)
    .reduce((s, a) => s + parseFloat(a.quantity || 0), 0);
}

// ─── Sincronizar proventos de um ticker ──────────────────────────────────────

async function sincronizarProventos(userId, ticker, aportes) {
  // Busca dividendos cadastrados manualmente
  const { rows: dividends } = await pool.query(
    `SELECT ex_date::text, payment_date::text, value_per_share
     FROM dividends WHERE ticker = $1 AND user_id = $2
     ORDER BY ex_date`,
    [ticker.toUpperCase(), userId]
  );

  if (!dividends.length) return 0;

  let sincronizados = 0;

  for (const div of dividends) {
    const dataCom  = (div.ex_date || '').substring(0, 10);
    const dataPgto = div.payment_date ? (div.payment_date + '').substring(0, 10) : null;
    const rate     = parseFloat(div.value_per_share || 0);

    if (!dataCom || rate <= 0) continue;

    const cotas = cotasNaData(aportes, dataCom);
    if (cotas <= 0) continue;

    const totalRecebido = parseFloat((cotas * rate).toFixed(2));

    // Competência = mês do pagamento (quando o dinheiro entra na conta)
    // Fallback para data COM se payment_date não disponível
    const competencia = dataPgto || dataCom;

    try {
      await pool.query(
        `INSERT INTO fii_proventos
           (user_id, ticker, competencia, data_com, valor_por_cota, cotas_na_data, total_recebido, fonte)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual')
         ON CONFLICT (user_id, ticker, competencia)
         DO UPDATE SET
           valor_por_cota = EXCLUDED.valor_por_cota,
           cotas_na_data  = EXCLUDED.cotas_na_data,
           total_recebido = EXCLUDED.total_recebido,
           data_com       = EXCLUDED.data_com,
           updated_at     = NOW()`,
        [userId, ticker.toUpperCase(), competencia, dataCom, rate, cotas, totalRecebido]
      );
      sincronizados++;
    } catch (e) {
      console.warn(`[PROVENTOS] erro upsert ${ticker}/${dataCom}:`, e.message);
    }
  }

  console.log(`[PROVENTOS] ${ticker}: ${sincronizados} proventos sincronizados`);
  return sincronizados;
}

// ─── Sincronizar carteira de um usuário ──────────────────────────────────────

async function sincronizarProventosUsuario(userId) {
  const { rows: fiis } = await pool.query(
    'SELECT ticker FROM portfolio_fiis WHERE user_id = $1',
    [userId]
  );

  if (!fiis.length) return { sincronizados: 0, tickers: 0 };

  let totalMeses = 0;
  let totalTickers = 0;

  for (const { ticker } of fiis) {
    const { rows: aportes } = await pool.query(
      'SELECT date::text, quantity FROM contributions WHERE ticker = $1 AND user_id = $2 ORDER BY date',
      [ticker, userId]
    );
    if (!aportes.length) continue;
    const meses = await sincronizarProventos(userId, ticker, aportes);
    totalMeses   += meses;
    totalTickers += 1;
  }

  return { sincronizados: totalMeses, tickers: totalTickers };
}

// ─── Sincronizar todos os usuários ativos ────────────────────────────────────

async function sincronizarTodosProventos() {
  console.log('[PROVENTOS] Iniciando sync para todos os usuários...');

  // Busca todos os user_ids distintos que têm carteira
  const { rows: usuarios } = await pool.query(
    'SELECT DISTINCT user_id FROM portfolio_fiis'
  );

  if (!usuarios.length) {
    console.log('[PROVENTOS] Nenhum usuário com carteira');
    return;
  }

  let totalGeral = 0;
  for (const { user_id } of usuarios) {
    console.log(`[PROVENTOS] Processando user_id=${user_id}...`);
    const resultado = await sincronizarProventosUsuario(user_id);
    totalGeral += resultado.sincronizados;
  }

  console.log(`[PROVENTOS] Sync global concluído: ${totalGeral} registros em ${usuarios.length} usuários`);
}

module.exports = { sincronizarProventos, sincronizarProventosUsuario, sincronizarTodosProventos };
