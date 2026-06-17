'use strict';

// Formato B3: 4 letras + 1-2 dígitos + F opcional (ex: HGLG11, MXRF11, KNCA11F)
const TICKER_RE = /^[A-Z]{4}\d{1,2}F?$/;

function validateTicker(req, res, next) {
  const ticker = (req.params.ticker || req.body?.ticker || '').toUpperCase().trim();
  if (!ticker) {
    return res.status(400).json({ error: 'Ticker é obrigatório' });
  }
  if (!TICKER_RE.test(ticker)) {
    return res.status(400).json({
      error: 'Ticker inválido. Formato esperado: 4 letras + 2 números (ex: HGLG11)',
      received: ticker,
    });
  }
  req.params.ticker = ticker;
  next();
}

function validateTickerList(req, res, next) {
  const raw = req.query.tickers || '';
  if (!raw) return next();
  const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  const invalidos = tickers.filter(t => !TICKER_RE.test(t));
  if (invalidos.length) {
    return res.status(400).json({ error: 'Tickers inválidos na lista', invalidos });
  }
  if (tickers.length > 20) {
    return res.status(400).json({ error: 'Máximo de 20 tickers por requisição' });
  }
  req.validatedTickers = tickers;
  next();
}

module.exports = { validateTicker, validateTickerList };
