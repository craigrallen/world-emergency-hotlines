// Minimal Stripe REST client. No SDK: the two calls this foundation needs are
// form-encoded POSTs and one GET, so the official library is optional. Swap in
// the `stripe` npm package later if richer surface area is needed; the server
// only depends on the three methods returned by createStripeClient.

import { randomUUID } from 'node:crypto';
import { VERSION, redact } from './config.mjs';

export const DEFAULT_BASE_URL = 'https://api.stripe.com';
export const USER_AGENT = `world-hotlines-payments/${VERSION}`;
const PATH = /^\/v1\/[a-z_]+(?:\/[A-Za-z0-9_]+)*(?:\/[a-z_]+)?$/;

export class StripeApiError extends Error {
  constructor({ status, type = null, code = null, message = 'Stripe request failed', requestId = null }) {
    super(redact(String(message)).slice(0, 512));
    this.name = 'StripeApiError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Encode nested params the way Stripe expects: a[b][0][c]=value. */
export function encodeForm(params, prefix = '') {
  const pairs = [];
  const visit = (value, key) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${key}[${index}]`)); return; }
    if (typeof value === 'object') { for (const [child, item] of Object.entries(value)) visit(item, key ? `${key}[${child}]` : child); return; }
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError(`unsupported form value at ${key}`);
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  visit(params, prefix);
  return pairs.join('&');
}

export function createStripeClient({ secretKey, apiVersion = null, fetchImpl = globalThis.fetch, timeoutMs = 15000, baseUrl = DEFAULT_BASE_URL } = {}) {
  if (typeof secretKey !== 'string' || secretKey.length < 24) throw new Error('stripe client requires a secret key');
  if (typeof fetchImpl !== 'function') throw new Error('stripe client requires fetch');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('stripe client timeout out of range');
  if (typeof baseUrl !== 'string' || !/^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(baseUrl)) throw new Error('stripe client base URL must be a bare origin');

  async function request(method, path, { params = null, idempotencyKey = null } = {}) {
    if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !PATH.test(path)) throw new Error('invalid stripe request');
    const headers = { authorization: `Bearer ${secretKey}`, accept: 'application/json', 'user-agent': USER_AGENT };
    if (apiVersion) headers['stripe-version'] = apiVersion;
    let body;
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['idempotency-key'] = idempotencyKey ?? randomUUID();
      body = encodeForm(params ?? {});
    } else if (params) {
      throw new Error('GET requests take no params');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { method, headers, body, signal: controller.signal, redirect: 'error' });
    } catch (error) {
      throw new StripeApiError({ status: 0, type: controller.signal.aborted ? 'timeout' : 'network_error', message: controller.signal.aborted ? 'Stripe request timed out' : 'Stripe request failed' });
    } finally {
      clearTimeout(timer);
    }
    const requestId = response.headers?.get?.('request-id') ?? null;
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object' ? payload.error : {};
      throw new StripeApiError({ status: response.status, type: typeof detail.type === 'string' ? detail.type : null, code: typeof detail.code === 'string' ? detail.code : null, message: typeof detail.message === 'string' ? detail.message : 'Stripe request failed', requestId });
    }
    if (!payload || typeof payload !== 'object') throw new StripeApiError({ status: response.status, type: 'invalid_response', message: 'Stripe returned a non-object body', requestId });
    return payload;
  }

  return Object.freeze({
    request,
    createCheckoutSession: (params, idempotencyKey) => request('POST', '/v1/checkout/sessions', { params, idempotencyKey }),
    retrieveCheckoutSession: (id) => request('GET', `/v1/checkout/sessions/${id}`),
    createBillingPortalSession: (params, idempotencyKey) => request('POST', '/v1/billing_portal/sessions', { params, idempotencyKey }),
  });
}
