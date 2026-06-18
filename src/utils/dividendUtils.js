'use strict';

/**
 * Calcula o DY acumulado nos últimos 12 meses a partir do array de cashDividends do Brapi.
 */
function calcularDY12m(cashDividends = []) {
  const umAnoAtras = new Date();
  umAnoAtras.setFullYear(umAnoAtras.getFullYear() - 1);
  return cashDividends
    .filter(d => d.paymentDate && new Date(d.paymentDate) >= umAnoAtras)
    .reduce((soma, d) => soma + (parseFloat(d.rate) || 0), 0);
}

/**
 * Retorna o próximo ou último rendimento relevante do array cashDividends do Brapi.
 * - Prioridade 1: pagamento futuro mais próximo (recente: false)
 * - Prioridade 2: pagamento mais recente dentro dos últimos 35 dias (recente: true)
 */
function extrairProximoRendimento(cashDividends = []) {
  const hoje   = new Date().toISOString().substring(0, 10);
  const limite = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);

  const list = cashDividends
    .map(d => ({
      valor:     parseFloat(d.rate) || 0,
      data_com:  d.lastDatePrior?.substring(0, 10) || null,
      data_pgto: d.paymentDate?.substring(0, 10)   || null,
    }))
    .filter(p => p.data_pgto && p.valor > 0);

  const futuros = list
    .filter(p => p.data_pgto >= hoje)
    .sort((a, b) => a.data_pgto.localeCompare(b.data_pgto));
  if (futuros.length) return { ...futuros[0], recente: false };

  const recentes = list
    .filter(p => p.data_pgto < hoje && p.data_pgto >= limite)
    .sort((a, b) => b.data_pgto.localeCompare(a.data_pgto));
  if (recentes.length) return { ...recentes[0], recente: true };

  return null;
}

/**
 * Converte cashDividends do Brapi para o formato da tabela `dividends`.
 */
function brapiDividsToDB(cashDividends = []) {
  return cashDividends
    .map(d => ({
      exDate:      d.lastDatePrior?.substring(0, 10) || null,
      paymentDate: d.paymentDate?.substring(0, 10)   || null,
      rate:        parseFloat(d.rate) || 0,
    }))
    .filter(d => d.exDate && d.rate > 0);
}

module.exports = { calcularDY12m, extrairProximoRendimento, brapiDividsToDB };
