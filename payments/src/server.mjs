// HTTP surface for the payments foundation. Four exact routes under
// /billing/api; everything else is 404. Hosted Stripe Checkout and the
// Customer Portal do the card handling, so this process never sees card data.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { CHECKOUT_SESSION_ID, MODES, OFFER_ID, VERSION } from './config.mjs';
import { StripeApiError, createStripeClient } from './stripe.mjs';
import { WebhookError, constructEvent } from './webhook.mjs';
import { createMemoryStore, validateStore } from './store.mjs';
import { dispatchEvent } from './events.mjs';
import { MemoryTokenBuckets } from './quota.mjs';
import { plain } from './validation.mjs';

export const ROUTES = Object.freeze({ health: '/billing/api/health', checkout: '/billing/api/checkout-session', portal: '/billing/api/portal-session', webhook: '/billing/api/webhook' });
export const CHECKOUT_ORIGIN = 'https://checkout.stripe.com';
export const PORTAL_ORIGIN = 'https://billing.stripe.com';
export const LIMITS = Object.freeze({ formBodyBytes: 4096, webhookBodyBytes: 262144, perClient: Object.freeze({ rate: 0.5, burst: 10 }), global: Object.freeze({ rate: 10, burst: 50 }) });
export const EVENT_KEYS = Object.freeze(['timestamp', 'request_id', 'route', 'method', 'status_code', 'outcome', 'latency_bucket', 'event_type', 'offer', 'payments_version']);
export const ERRORS = Object.freeze({
  invalid_request: [400, 'Request could not be processed'], unknown_offer: [400, 'Unknown offer'], signature_invalid: [400, 'Webhook signature could not be verified'],
  livemode_mismatch: [400, 'Event mode does not match this deployment'], origin_not_allowed: [403, 'Cross-origin requests are not accepted'],
  not_found: [404, 'Not found'], portal_unavailable: [404, 'No manageable subscription for this session'], method_not_allowed: [405, 'Method not allowed'],
  payload_too_large: [413, 'Request body too large'], unsupported_media_type: [415, 'Unsupported content type'], rate_limited: [429, 'Too many requests'],
  handler_failed: [500, 'Event could not be recorded'], upstream_error: [502, 'Payment provider request failed'], payments_disabled: [503, 'Payments are not enabled'],
  unavailable: [503, 'Service unavailable'],
});
const ROUTE_NAMES = new Map(Object.entries(ROUTES).map(([name, path]) => [path, name]));
const CONFIG_KEYS = ['version', 'mode', 'host', 'port', 'publicOrigin', 'successPath', 'cancelPath', 'returnPath', 'trustProxy', 'automaticTax', 'stripeTimeoutMs', 'stripe', 'offers'];
const STRIPE_METHODS = ['createCheckoutSession', 'retrieveCheckoutSession', 'createBillingPortalSession'];

class RequestError extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; this.extra = extra; }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d{1,10}$/.test(length) || Number(length) > maxBytes)) { req.resume(); finish(reject, new RequestError('payload_too_large')); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { finish(reject, new RequestError('payload_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', () => finish(reject, new RequestError('invalid_request')));
    req.on('aborted', () => finish(reject, new RequestError('invalid_request')));
  });
}

export function parseFields(body, contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') {
    const out = {};
    for (const [key, value] of new URLSearchParams(body.toString('utf8'))) { if (Object.hasOwn(out, key)) return null; out[key] = value; }
    return out;
  }
  if (type === 'application/json') {
    try { const parsed = JSON.parse(body.toString('utf8')); return plain(parsed) ? parsed : null; } catch { return null; }
  }
  return undefined;
}

export function sameOrigin(headers, publicOrigin) {
  if (headers.origin !== undefined && headers.origin !== publicOrigin) return false;
  if (headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin') return false;
  return true;
}

function wantsJson(headers) {
  const accept = String(headers.accept ?? '').toLowerCase();
  return accept.includes('application/json') && !accept.includes('text/html');
}

function clientKey(req, trustProxy) {
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
  return `ip:${forwarded || req.socket.remoteAddress || 'unknown'}`.slice(0, 256);
}

function bucketLatency(ms) { return ms < 50 ? '<50ms' : ms < 500 ? '<500ms' : ms < 5000 ? '<5s' : '>=5s'; }

function validateConfig(config) {
  if (!plain(config) || !Object.isFrozen(config) || Object.keys(config).some((key) => !CONFIG_KEYS.includes(key)) || CONFIG_KEYS.some((key) => !Object.hasOwn(config, key))) throw new Error('invalid payments configuration object');
  if (!MODES.includes(config.mode) || config.version !== VERSION) throw new Error('invalid payments configuration object');
  if (config.mode !== 'disabled' && (!plain(config.stripe) || typeof config.stripe.secretKey !== 'string' || typeof config.stripe.webhookSecret !== 'string')) throw new Error('invalid payments configuration object');
}

export function createPaymentsServer(config, { stripe, store, sink, sinkError, now, fetchImpl, quota, maxConcurrent = 64, shutdownTimeoutMs = 5000 } = {}) {
  validateConfig(config);
  const enabled = config.mode !== 'disabled';
  const stripeClient = enabled
    ? (stripe ?? createStripeClient({ secretKey: config.stripe.secretKey, apiVersion: config.stripe.apiVersion, fetchImpl, timeoutMs: config.stripeTimeoutMs }))
    : null;
  if (enabled && (!stripeClient || STRIPE_METHODS.some((name) => typeof stripeClient[name] !== 'function'))) throw new Error('invalid stripe client');
  const eventStore = store ?? createMemoryStore();
  if (!validateStore(eventStore)) throw new Error('invalid store');
  const buckets = quota ?? new MemoryTokenBuckets();
  if (typeof buckets.take !== 'function') throw new Error('invalid payments server options');
  const emit = sink ?? (() => {});
  const emitError = sinkError ?? (() => {});
  const clock = now ?? (() => Date.now());
  if (typeof emit !== 'function' || typeof emitError !== 'function' || typeof clock !== 'function') throw new Error('invalid payments server options');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 10000 || !Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 100 || shutdownTimeoutMs > 60000) throw new Error('invalid payments server options');

  let active = 0, stopping = false, sinkErrors = 0;
  const sockets = new Set();

  const send = (res, status, body, id, extra = {}) => {
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': id, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'referrer-policy': 'no-referrer', ...extra, 'content-length': bytes.length });
    res.end(res.req?.method === 'HEAD' ? undefined : bytes);
  };
  const fail = (res, code, id, extra = {}) => { const [status, message] = ERRORS[code]; send(res, status, { error: { code, message, request_id: id } }, id, extra); return status; };
  const redirectOrJson = (req, res, id, target, extra) => {
    if (wantsJson(req.headers)) { send(res, 200, { url: target, ...extra }, id); return 200; }
    send(res, 303, { url: target, ...extra }, id, { location: target }); return 303;
  };

  const limitOrThrow = (req) => {
    const global = buckets.take('global', LIMITS.global);
    if (!global.ok) throw new RequestError(global.overflow ? 'unavailable' : 'rate_limited', { 'retry-after': String(global.retryAfter) });
    const client = buckets.take(clientKey(req, config.trustProxy), LIMITS.perClient);
    if (!client.ok) throw new RequestError(client.overflow ? 'unavailable' : 'rate_limited', { 'retry-after': String(client.retryAfter) });
  };

  const readFields = async (req) => {
    const body = await readBody(req, LIMITS.formBodyBytes);
    const fields = parseFields(body, req.headers['content-type']);
    if (fields === undefined) throw new RequestError('unsupported_media_type');
    if (fields === null) throw new RequestError('invalid_request');
    return fields;
  };

  const upstream = async (call) => {
    try { return await call(); } catch (error) {
      if (error instanceof StripeApiError) throw new RequestError(error.status === 429 ? 'unavailable' : 'upstream_error', error.status === 429 ? { 'retry-after': '5' } : {}, error.code);
      throw new RequestError('upstream_error');
    }
  };

  async function handleCheckout(req, res, id, telemetry) {
    if (!sameOrigin(req.headers, config.publicOrigin)) throw new RequestError('origin_not_allowed');
    limitOrThrow(req);
    const fields = await readFields(req);
    if (typeof fields.offer !== 'string' || !OFFER_ID.test(fields.offer)) throw new RequestError('invalid_request');
    const offer = config.offers[fields.offer];
    if (!offer) throw new RequestError('unknown_offer');
    telemetry.offer = offer.id;
    const params = {
      mode: offer.mode,
      line_items: [{ price: offer.price, quantity: offer.quantity }],
      success_url: `${config.publicOrigin}${config.successPath}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.publicOrigin}${config.cancelPath}`,
      metadata: { offer: offer.id },
      ...(offer.mode === 'subscription' ? { subscription_data: { metadata: { offer: offer.id } } } : { payment_intent_data: { metadata: { offer: offer.id } } }),
      ...(config.automaticTax ? { automatic_tax: { enabled: true } } : {}),
    };
    const session = await upstream(() => stripeClient.createCheckoutSession(params, randomUUID()));
    if (!plain(session) || typeof session.url !== 'string' || !session.url.startsWith(`${CHECKOUT_ORIGIN}/`) || typeof session.id !== 'string' || !CHECKOUT_SESSION_ID.test(session.id)) throw new RequestError('upstream_error');
    return redirectOrJson(req, res, id, session.url, { id: session.id });
  }

  async function handlePortal(req, res, id) {
    if (!sameOrigin(req.headers, config.publicOrigin)) throw new RequestError('origin_not_allowed');
    limitOrThrow(req);
    const fields = await readFields(req);
    const match = typeof fields.session_id === 'string' && CHECKOUT_SESSION_ID.exec(fields.session_id);
    if (!match || match[1] !== config.mode) throw new RequestError('invalid_request');
    const session = await upstream(() => stripeClient.retrieveCheckoutSession(fields.session_id));
    const customer = plain(session) && session.status === 'complete' && session.mode === 'subscription' ? (typeof session.customer === 'string' ? session.customer : session.customer?.id) : null;
    if (typeof customer !== 'string' || !/^cus_[A-Za-z0-9]{8,}$/.test(customer)) throw new RequestError('portal_unavailable');
    const portal = await upstream(() => stripeClient.createBillingPortalSession({ customer, return_url: `${config.publicOrigin}${config.returnPath}` }, randomUUID()));
    if (!plain(portal) || typeof portal.url !== 'string' || !portal.url.startsWith(`${PORTAL_ORIGIN}/`)) throw new RequestError('upstream_error');
    return redirectOrJson(req, res, id, portal.url, {});
  }

  async function handleWebhook(req, res, id, telemetry) {
    const rawBody = await readBody(req, LIMITS.webhookBodyBytes);
    let nowSeconds;
    try { const value = clock(); if (!Number.isFinite(value)) throw new Error(); nowSeconds = Math.floor(value / 1000); } catch { throw new RequestError('unavailable'); }
    let event;
    try { event = constructEvent({ rawBody, header: req.headers['stripe-signature'], secret: config.stripe.webhookSecret, now: nowSeconds }); } catch (error) {
      if (error instanceof WebhookError) throw new RequestError('signature_invalid', {}, error.reason);
      throw error;
    }
    telemetry.event_type = event.type;
    if (event.livemode !== (config.mode === 'live')) throw new RequestError('livemode_mismatch');
    let claimed;
    try { claimed = await eventStore.claimEvent(event.id); } catch { throw new RequestError('unavailable'); }
    if (!claimed) { telemetry.outcome = 'duplicate'; send(res, 200, { received: true, duplicate: true }, id); return 200; }
    let summary;
    try { summary = await dispatchEvent(event, { store: eventStore, offers: config.offers }); } catch {
      try { await eventStore.releaseEvent(event.id); } catch {}
      throw new RequestError('handler_failed');
    }
    telemetry.outcome = summary.outcome;
    telemetry.offer = summary.offer ?? null;
    send(res, 200, { received: true, outcome: summary.outcome }, id);
    return 200;
  }

  const server = http.createServer({ requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 5000, maxHeaderSize: 16384 }, (req, res) => {
    const started = performance.now(), id = randomUUID(), raw = req.url ?? '', query = raw.indexOf('?'), path = query < 0 ? raw : raw.slice(0, query);
    const route = query < 0 ? (ROUTE_NAMES.get(path) ?? 'unknown') : 'unknown';
    const telemetry = { outcome: 'ok', event_type: null, offer: null };
    let status = 500;
    res.once('finish', () => {
      let stamp; try { const value = clock(); stamp = Number.isFinite(value) ? new Date(value).toISOString() : new Date(0).toISOString(); } catch { stamp = new Date(0).toISOString(); }
      const event = { timestamp: stamp, request_id: id, route, method: req.method, status_code: status, outcome: telemetry.outcome, latency_bucket: bucketLatency(performance.now() - started), event_type: telemetry.event_type, offer: telemetry.offer, payments_version: VERSION };
      try { emit(event); } catch { sinkErrors = Math.min(Number.MAX_SAFE_INTEGER, sinkErrors + 1); try { emitError(sinkErrors); } catch {} }
    });
    const finishWith = (code, extra = {}) => { telemetry.outcome = code; status = fail(res, code, id, extra); };

    if (stopping || active >= maxConcurrent) { res.setHeader('connection', 'close'); finishWith('unavailable'); res.once('finish', () => req.socket.destroy()); req.resume(); return; }
    active += 1;
    let accounted = false;
    const done = () => { if (!accounted) { accounted = true; active = Math.max(0, active - 1); } };
    res.once('finish', done); res.once('close', done);

    if (route === 'unknown') { req.resume(); finishWith('not_found'); return; }
    if (route === 'health') {
      if (!['GET', 'HEAD'].includes(req.method)) { req.resume(); finishWith('method_not_allowed', { allow: 'GET, HEAD' }); return; }
      req.resume();
      status = 200;
      send(res, 200, { component: 'payments', payments_version: VERSION, status: enabled ? 'enabled' : 'disabled', mode: config.mode, offers: Object.keys(config.offers), store: eventStore.kind ?? 'custom', foundation: true }, id);
      return;
    }
    if (req.method !== 'POST') { req.resume(); finishWith('method_not_allowed', { allow: 'POST' }); return; }
    if (!enabled) { req.resume(); finishWith('payments_disabled'); return; }

    const handler = route === 'checkout' ? handleCheckout : route === 'portal' ? handlePortal : handleWebhook;
    handler(req, res, id, telemetry).then((code) => { status = code; }).catch((error) => {
      req.resume();
      if (res.headersSent) { status = res.statusCode; return; }
      if (error instanceof RequestError) { finishWith(error.code, error.extra); return; }
      finishWith('unavailable');
    });
  });
  server.maxRequestsPerSocket = 100;
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });

  return Object.freeze({
    server, config, store: eventStore,
    get activeRequests() { return active; },
    get sinkErrors() { return sinkErrors; },
    listen: () => new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(server.address()); };
      server.once('error', onError).once('listening', onListening).listen(config.port, config.host);
    }),
    close: () => new Promise((resolve, reject) => {
      stopping = true;
      const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, shutdownTimeoutMs);
      timer.unref();
      server.close((error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
      server.closeIdleConnections();
    }),
  });
}
