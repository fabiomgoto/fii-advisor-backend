'use strict';
const Sentry = require('@sentry/node');

function initSentry(app) {
  if (!process.env.SENTRY_DSN) {
    console.warn('[sentry] SENTRY_DSN não definido — monitoramento desativado');
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 1.0 : 0.1,
    ignoreErrors: ['rate_limit_exceeded', 'Not Found', 'ValidationError'],
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers['x-api-key'];
        delete event.request.headers['authorization'];
      }
      return event;
    },
  });

  app.use(Sentry.Handlers.requestHandler());
  console.log('[sentry] Monitoramento ativo —', process.env.NODE_ENV);
}

function sentryErrorHandler() {
  return Sentry.Handlers.errorHandler({
    shouldHandleError(error) {
      return !error.status || error.status >= 500;
    },
  });
}

function captureError(err, context = {}) {
  Sentry.withScope((scope) => {
    Object.entries(context).forEach(([key, value]) => scope.setExtra(key, value));
    Sentry.captureException(err);
  });
}

module.exports = { initSentry, sentryErrorHandler, captureError };
