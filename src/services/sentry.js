'use strict';
const Sentry = require('@sentry/node');

// init movido para index.js (deve rodar antes de require('express'))

function sentryErrorHandler() {
  return (err, req, res, next) => {
    if (!err.status || err.status >= 500) {
      Sentry.captureException(err);
    }
    next(err);
  };
}

function captureError(err, context = {}) {
  Sentry.withScope((scope) => {
    Object.entries(context).forEach(([key, value]) => scope.setExtra(key, value));
    Sentry.captureException(err);
  });
}

module.exports = { initSentry, sentryErrorHandler, captureError };
