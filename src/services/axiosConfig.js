'use strict';
const axios = require('axios');

axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.config?.url) {
      error.config.url = error.config.url
        .replace(/token=[^&\s]+/gi,   'token=***')
        .replace(/apikey=[^&\s]+/gi,  'apikey=***')
        .replace(/api_key=[^&\s]+/gi, 'api_key=***')
        .replace(/secret=[^&\s]+/gi,  'secret=***');
    }
    const url    = error.config?.url    || 'unknown';
    const status = error.response?.status || 'no_response';
    const msg    = error.message || 'unknown error';
    console.warn(`[axios] ${status} ${url.substring(0, 100)} — ${msg}`);
    return Promise.reject(error);
  }
);

module.exports = axios;
