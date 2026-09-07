// Fail-closed configuration for the payments foundation.
//
// The service reads only PAYMENTS_* and STRIPE_* variables plus PORT. Unknown
// variables in those namespaces are rejected so a misspelled secret name can
// never silently disable a check. Secret values never appear in error text.

import { exactObject, integer, plain, validOrigin, validSitePath } from './validation.mjs';

export const VERSION = '0.1.0-foundation';
export const MODES = Object.freeze(['disabled', 'test', 'live']);
export const OFFER_MODES = Object.freeze(['subscription', 'payment']);
export const DEFAULT_PUBLIC_ORIGIN = 'https://worldhotlines.org';
export const DEFAULT_SUCCESS_PATH = '/billing/success';
export const DEFAULT_CANCEL_PATH = '/billing/cancelled';
export const DEFAULT_RETURN_PATH = '/billing';
export const DEFAULT_PORT = 8081;

// Stripe identifier shapes. Lengths are lower bounds only; Stripe may lengthen them.
export const SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/;
export const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9]{16,}$/;
export const PRICE_ID = /^price_[A-Za-z0-9]{8,}$/;
export const OFFER_ID = /^[a-z][a-z0-9_]{1,31}$/;
export const API_VERSION = /^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/;
export const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,}$/;
export const STRIPE_OBJECT_ID = /^[a-z]{2,10}_(?:(?:test|live)_)?[A-Za-z0-9]{8,}$/;

export const KNOWN_VARIABLES = Object.freeze([
  'PAYMENTS_MODE', 'PAYMENTS_HOST', 'PAYMENTS_PUBLIC_ORIGIN', 'PAYMENTS_SUCCESS_PATH', 'PAYMENTS_CANCEL_PATH', 'PAYMENTS_RETURN_PATH',
  'PAYMENTS_TRUST_PROXY', 'PAYMENTS_OFFERS', 'PAYMENTS_AUTOMATIC_TAX', 'PAYMENTS_STRIPE_TIMEOUT_MS',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_VERSION',
]);

const SECRET_PATTERN = /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+|\bwhsec_[A-Za-z0-9]+/g;
const SECRET_KEY_NAME = /secret|authorization|signature|api[_-]?key|password|token/i;
export const REDACTED = '[REDACTED]';

export class ConfigError extends Error {
  constructor(variable, reason) {
    super(`invalid payments configuration: ${variable} ${reason}`);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}

/** Replace Stripe key material anywhere inside strings, arrays, or objects. */
export function redact(value) {
  if (typeof value === 'string') return value.replace(SECRET_PATTERN, REDACTED);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY_NAME.test(key) ? REDACTED : redact(item)]));
  }
  return value;
}

export function parseOffers(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new ConfigError('PAYMENTS_OFFERS', 'must be a JSON object'); }
  if (!plain(parsed)) throw new ConfigError('PAYMENTS_OFFERS', 'must be a JSON object');
  const ids = Object.keys(parsed);
  if (ids.length < 1 || ids.length > 50) throw new ConfigError('PAYMENTS_OFFERS', 'must define between 1 and 50 offers');
  const offers = {};
  for (const id of ids) {
    if (!OFFER_ID.test(id)) throw new ConfigError('PAYMENTS_OFFERS', `has an invalid offer id: ${JSON.stringify(id).slice(0, 48)}`);
    const offer = parsed[id];
    if (!exactObject(offer, ['price', 'mode', 'quantity'], ['price', 'mode'])) throw new ConfigError('PAYMENTS_OFFERS', `offer ${id} must have exactly price, mode, and optional quantity`);
    if (typeof offer.price !== 'string' || !PRICE_ID.test(offer.price)) throw new ConfigError('PAYMENTS_OFFERS', `offer ${id} has an invalid Stripe price id`);
    if (!OFFER_MODES.includes(offer.mode)) throw new ConfigError('PAYMENTS_OFFERS', `offer ${id} mode must be subscription or payment`);
    const quantity = offer.quantity ?? 1;
    if (!integer(quantity, 1, 100)) throw new ConfigError('PAYMENTS_OFFERS', `offer ${id} quantity must be an integer from 1 to 100`);
    offers[id] = Object.freeze({ id, price: offer.price, mode: offer.mode, quantity });
  }
  return Object.freeze(offers);
}

function readFlag(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return false;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new ConfigError(name, 'must be 0, 1, true, or false');
}

function readPath(env, name, fallback) {
  const value = env[name] ?? fallback;
  if (!validSitePath(value)) throw new ConfigError(name, 'must be an absolute site path without query or fragment');
  return value;
}

/**
 * Build a frozen configuration from an environment-like object.
 * Throws ConfigError; the message names the variable but never echoes a secret.
 */
export function loadConfig(env = process.env) {
  if (!env || typeof env !== 'object') throw new ConfigError('environment', 'must be an object');
  for (const name of Object.keys(env)) {
    if ((name.startsWith('PAYMENTS_') || name.startsWith('STRIPE_')) && !KNOWN_VARIABLES.includes(name)) throw new ConfigError(name, 'is not a recognised variable');
  }
  const mode = env.PAYMENTS_MODE ?? 'disabled';
  if (!MODES.includes(mode)) throw new ConfigError('PAYMENTS_MODE', 'must be disabled, test, or live');

  const host = env.PAYMENTS_HOST ?? '127.0.0.1';
  if (typeof host !== 'string' || host.length < 1 || host.length > 255 || /\s/.test(host)) throw new ConfigError('PAYMENTS_HOST', 'must be a bind address');
  const portRaw = env.PORT ?? String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(portRaw) || !integer(Number(portRaw), 0, 65535)) throw new ConfigError('PORT', 'must be an integer from 0 to 65535');
  const port = Number(portRaw);

  const publicOrigin = env.PAYMENTS_PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN;
  if (!validOrigin(publicOrigin, { allowHttp: mode !== 'live' })) throw new ConfigError('PAYMENTS_PUBLIC_ORIGIN', mode === 'live' ? 'must be an exact https origin' : 'must be an exact https origin or a loopback http origin');
  const successPath = readPath(env, 'PAYMENTS_SUCCESS_PATH', DEFAULT_SUCCESS_PATH);
  const cancelPath = readPath(env, 'PAYMENTS_CANCEL_PATH', DEFAULT_CANCEL_PATH);
  const returnPath = readPath(env, 'PAYMENTS_RETURN_PATH', DEFAULT_RETURN_PATH);
  const trustProxy = readFlag(env, 'PAYMENTS_TRUST_PROXY');
  const automaticTax = readFlag(env, 'PAYMENTS_AUTOMATIC_TAX');
  const timeoutRaw = env.PAYMENTS_STRIPE_TIMEOUT_MS ?? '15000';
  if (!/^\d{3,6}$/.test(timeoutRaw) || !integer(Number(timeoutRaw), 1000, 120000)) throw new ConfigError('PAYMENTS_STRIPE_TIMEOUT_MS', 'must be an integer from 1000 to 120000');

  const base = { version: VERSION, mode, host, port, publicOrigin, successPath, cancelPath, returnPath, trustProxy, automaticTax, stripeTimeoutMs: Number(timeoutRaw) };
  if (mode === 'disabled') return Object.freeze({ ...base, stripe: null, offers: Object.freeze({}) });

  const secretKey = env.STRIPE_SECRET_KEY;
  if (typeof secretKey !== 'string' || !SECRET_KEY.test(secretKey)) throw new ConfigError('STRIPE_SECRET_KEY', 'must be a Stripe secret or restricted key');
  const keyMode = SECRET_KEY.exec(secretKey)[2];
  if (keyMode !== mode) throw new ConfigError('STRIPE_SECRET_KEY', `must be a ${mode}-mode key when PAYMENTS_MODE=${mode}`);
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (typeof webhookSecret !== 'string' || !WEBHOOK_SECRET.test(webhookSecret)) throw new ConfigError('STRIPE_WEBHOOK_SECRET', 'must be a Stripe webhook signing secret');
  const apiVersion = env.STRIPE_API_VERSION ?? null;
  if (apiVersion !== null && !API_VERSION.test(apiVersion)) throw new ConfigError('STRIPE_API_VERSION', 'must look like YYYY-MM-DD or YYYY-MM-DD.name');
  if (env.PAYMENTS_OFFERS === undefined) throw new ConfigError('PAYMENTS_OFFERS', 'is required when payments are enabled');
  const offers = parseOffers(env.PAYMENTS_OFFERS);

  return Object.freeze({ ...base, stripe: Object.freeze({ secretKey, webhookSecret, apiVersion }), offers });
}

/** Secret-free summary suitable for logs and `check-config`. */
export function describeConfig(config) {
  return {
    version: config.version, mode: config.mode, host: config.host, port: config.port, public_origin: config.publicOrigin,
    success_path: config.successPath, cancel_path: config.cancelPath, return_path: config.returnPath, trust_proxy: config.trustProxy,
    automatic_tax: config.automaticTax, stripe_api_version: config.stripe?.apiVersion ?? null, stripe_key_configured: config.stripe !== null,
    webhook_secret_configured: config.stripe !== null, offers: Object.values(config.offers).map(({ id, mode, quantity }) => ({ id, mode, quantity })),
  };
}
