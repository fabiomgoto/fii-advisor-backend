'use strict';

/**
 * asaasService.js — wrapper HTTP da API do Asaas (cobrança recorrente).
 *
 * Docs: https://docs.asaas.com/
 * Autenticação: header `access_token: <ASAAS_API_KEY>`
 *
 * Ambiente é definido por ASAAS_ENV (sandbox|production) ou ASAAS_API_URL explícito.
 */

const axios = require('axios');

const ENV = (process.env.ASAAS_ENV || 'sandbox').toLowerCase();
const BASE_URL =
  process.env.ASAAS_API_URL ||
  (ENV === 'production'
    ? 'https://api.asaas.com/v3'
    : 'https://api-sandbox.asaas.com/v3');

const API_KEY = process.env.ASAAS_API_KEY || '';

function client() {
  if (!API_KEY) {
    throw new Error('ASAAS_API_KEY não configurada');
  }
  return axios.create({
    baseURL: BASE_URL,
    timeout: 20000,
    headers: {
      access_token: API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'fii-advisor',
    },
  });
}

/** Normaliza erros do Asaas em Error com mensagem legível. */
function toError(err, contexto) {
  const apiErrors = err.response?.data?.errors;
  const msg = Array.isArray(apiErrors) && apiErrors.length
    ? apiErrors.map((e) => e.description).join('; ')
    : err.message;
  const e = new Error(`[Asaas:${contexto}] ${msg}`);
  e.statusCode = err.response?.status || 502;
  return e;
}

/**
 * Cria um cliente no Asaas.
 * @param {{name:string, email:string, cpfCnpj:string, mobilePhone?:string, externalReference?:string}} dados
 * @returns {Promise<object>} customer
 */
async function createCustomer(dados) {
  try {
    const { data } = await client().post('/customers', {
      name:              dados.name,
      email:             dados.email,
      cpfCnpj:           String(dados.cpfCnpj || '').replace(/\D/g, ''),
      mobilePhone:       dados.mobilePhone,
      externalReference: dados.externalReference,
      notificationDisabled: false,
    });
    return data;
  } catch (err) {
    throw toError(err, 'createCustomer');
  }
}

/** Busca um cliente por id. */
async function getCustomer(customerId) {
  try {
    const { data } = await client().get(`/customers/${customerId}`);
    return data;
  } catch (err) {
    throw toError(err, 'getCustomer');
  }
}

/**
 * Cria uma assinatura recorrente.
 * @param {{
 *   customer:string, value:number, cycle:string, nextDueDate:string,
 *   description?:string, billingType?:string, externalReference?:string,
 *   creditCardToken?:string, creditCard?:object, creditCardHolderInfo?:object, remoteIp?:string
 * }} dados
 * @returns {Promise<object>} subscription
 */
async function createSubscription(dados) {
  try {
    const body = {
      customer:          dados.customer,
      billingType:       dados.billingType || 'UNDEFINED', // deixa o cliente escolher PIX/boleto/cartão
      value:             dados.value,
      cycle:             dados.cycle || 'MONTHLY',
      nextDueDate:       dados.nextDueDate,
      description:       dados.description,
      externalReference: dados.externalReference,
    };
    // Cartão: usa token (preferível) ou dados brutos + IP do pagador
    if (dados.creditCardToken) {
      body.creditCardToken = dados.creditCardToken;
    } else if (dados.creditCard) {
      body.creditCard           = dados.creditCard;
      body.creditCardHolderInfo = dados.creditCardHolderInfo;
    }
    if (dados.remoteIp) body.remoteIp = dados.remoteIp;

    const { data } = await client().post('/subscriptions', body);
    return data;
  } catch (err) {
    throw toError(err, 'createSubscription');
  }
}

/**
 * Tokeniza um cartão de crédito (não armazenamos dados de cartão).
 * @param {{ customer:string, creditCard:object, creditCardHolderInfo:object, remoteIp:string }} dados
 * @returns {Promise<{creditCardToken:string, creditCardNumber:string, creditCardBrand:string}>}
 */
async function tokenizeCreditCard(dados) {
  try {
    const { data } = await client().post('/creditCard/tokenizeCreditCard', {
      customer:             dados.customer,
      creditCard:           dados.creditCard,
      creditCardHolderInfo: dados.creditCardHolderInfo,
      remoteIp:             dados.remoteIp,
    });
    return data;
  } catch (err) {
    throw toError(err, 'tokenizeCreditCard');
  }
}

/**
 * Busca o QR Code PIX de uma cobrança.
 * @returns {Promise<{encodedImage:string, payload:string, expirationDate:string}>}
 */
async function getPixQrCode(paymentId) {
  try {
    const { data } = await client().get(`/payments/${paymentId}/pixQrCode`);
    return data;
  } catch (err) {
    throw toError(err, 'getPixQrCode');
  }
}

/** Busca uma assinatura por id. */
async function getSubscription(subscriptionId) {
  try {
    const { data } = await client().get(`/subscriptions/${subscriptionId}`);
    return data;
  } catch (err) {
    throw toError(err, 'getSubscription');
  }
}

/** Lista as cobranças (payments) de uma assinatura. */
async function listSubscriptionPayments(subscriptionId) {
  try {
    const { data } = await client().get(`/subscriptions/${subscriptionId}/payments`);
    return data?.data || [];
  } catch (err) {
    throw toError(err, 'listSubscriptionPayments');
  }
}

/** Cancela (remove) uma assinatura no Asaas. */
async function cancelSubscription(subscriptionId) {
  try {
    const { data } = await client().delete(`/subscriptions/${subscriptionId}`);
    return data;
  } catch (err) {
    throw toError(err, 'cancelSubscription');
  }
}

/** Busca uma cobrança (payment) por id. */
async function getPayment(paymentId) {
  try {
    const { data } = await client().get(`/payments/${paymentId}`);
    return data;
  } catch (err) {
    throw toError(err, 'getPayment');
  }
}

function isConfigured() {
  return Boolean(API_KEY);
}

module.exports = {
  BASE_URL,
  ENV,
  isConfigured,
  createCustomer,
  getCustomer,
  createSubscription,
  getSubscription,
  listSubscriptionPayments,
  cancelSubscription,
  getPayment,
  tokenizeCreditCard,
  getPixQrCode,
};
