import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { EVENT_KEYS, LIMITS, ROUTES, createPaymentsServer, parseFields, sameOrigin } from '../src/server.mjs';
import { StripeApiError } from '../src/stripe.mjs';
import { signTestPayload } from '../src/webhook.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { MemoryTokenBuckets } from '../src/quota.mjs';

const KEY = `sk_test_${'a'.repeat(40)}`;
const WHSEC = `whsec_${'b'.repeat(32)}`;
const ORIGIN = 'https://synthetic.invalid';
const OFFERS = { growth_monthly: { price: 'price_synthetic0001', mode: 'subscription' }, once: { price: 'price_synthetic0002', mode: 'payment', quantity: 2 } };
const fixture = readFileSync(new URL('../fixtures/events/checkout.session.completed.synthetic.json', import.meta.url));
const NOW_MS = 2145916800 * 1000;

function env(extra = {}) {
  return { PAYMENTS_MODE: 'test', PAYMENTS_HOST: '127.0.0.1', PORT: '0', PAYMENTS_PUBLIC_ORIGIN: ORIGIN, STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WHSEC, PAYMENTS_OFFERS: JSON.stringify(OFFERS), ...extra };
}

function mockStripe(overrides = {}) {
  const calls = [];
  const session = { id: 'cs_test_synthetic00000001', url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic00000001', status: 'complete', mode: 'subscription', customer: 'cus_synthetic00000001' };
  return {
    calls,
    createCheckoutSession: async (params, idempotencyKey) => { calls.push({ method: 'createCheckoutSession', params, idempotencyKey }); return overrides.createCheckoutSession ? overrides.createCheckoutSession(params) : session; },
    retrieveCheckoutSession: async (id) => { calls.push({ method: 'retrieveCheckoutSession', id }); return overrides.retrieveCheckoutSession ? overrides.retrieveCheckoutSession(id) : session; },
    createBillingPortalSession: async (params, idempotencyKey) => { calls.push({ method: 'createBillingPortalSession', params, idempotencyKey }); return overrides.createBillingPortalSession ? overrides.createBillingPortalSession(params) : { url: 'https://billing.stripe.com/p/session/synthetic' }; },
  };
}

async function start({ envExtra = {}, stripe = mockStripe(), store, quota, now = () => NOW_MS, sink } = {}) {
  const events = [];
  const config = loadConfig(env(envExtra));
  const service = createPaymentsServer(config, { stripe, store, quota, now, sink: sink ?? ((event) => events.push(event)) });
  const address = await service.listen();
  return { service, stripe, events, config, base: `http://127.0.0.1:${address.port}` };
}

const form = (fields, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers }, body: new URLSearchParams(fields).toString(), redirect: 'manual' });
const webhook = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signTestPayload({ rawBody: body, secret: WHSEC, timestamp: 2145916800 }), ...headers }, body });

test('pure helpers: field parsing and same-origin policy', () => {
  assert.deepEqual(parseFields(Buffer.from('offer=a&x=1'), 'application/x-www-form-urlencoded; charset=utf-8'), { offer: 'a', x: '1' });
  assert.equal(parseFields(Buffer.from('offer=a&offer=b'), 'application/x-www-form-urlencoded'), null);
  assert.deepEqual(parseFields(Buffer.from('{"offer":"a"}'), 'application/json'), { offer: 'a' });
  assert.equal(parseFields(Buffer.from('[1]'), 'application/json'), null);
  assert.equal(parseFields(Buffer.from('{'), 'application/json'), null);
  assert.equal(parseFields(Buffer.from('x'), 'text/plain'), undefined);
  assert.equal(sameOrigin({}, ORIGIN), true);
  assert.equal(sameOrigin({ origin: ORIGIN }, ORIGIN), true);
  assert.equal(sameOrigin({ origin: 'https://evil.invalid' }, ORIGIN), false);
  assert.equal(sameOrigin({ origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, ORIGIN), false);
  assert.equal(sameOrigin({ 'sec-fetch-site': 'same-origin' }, ORIGIN), true);
});

test('startup validation rejects tampered configuration, stores, and clients', () => {
  const config = loadConfig(env());
  assert.throws(() => createPaymentsServer({ ...config }), /invalid payments configuration/);
  assert.throws(() => createPaymentsServer(Object.freeze({ ...config, extra: 1 })), /invalid payments configuration/);
  assert.throws(() => createPaymentsServer(config, { stripe: {} }), /invalid stripe client/);
  assert.throws(() => createPaymentsServer(config, { stripe: mockStripe(), store: {} }), /invalid store/);
  assert.throws(() => createPaymentsServer(config, { stripe: mockStripe(), sink: 'nope' }), /invalid payments server options/);
  assert.throws(() => createPaymentsServer(config, { stripe: mockStripe(), maxConcurrent: 0 }), /invalid payments server options/);
  assert.throws(() => createPaymentsServer(config, { stripe: mockStripe(), quota: {} }), /invalid payments server options/);
  assert.ok(createPaymentsServer(loadConfig({ PAYMENTS_HOST: '127.0.0.1', PORT: '0' })).server, 'disabled mode needs no Stripe client');
});

test('health, routing, and method rules', async () => {
  const s = await start();
  try {
    let r = await fetch(`${s.base}${ROUTES.health}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    assert.deepEqual(await r.json(), { component: 'payments', payments_version: '0.1.0-foundation', status: 'enabled', mode: 'test', offers: ['growth_monthly', 'once'], store: 'memory', foundation: true });
    r = await fetch(`${s.base}${ROUTES.health}`, { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '');
    r = await fetch(`${s.base}${ROUTES.health}`, { method: 'POST' });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'GET, HEAD');
    assert.equal((await r.json()).error.code, 'method_not_allowed');
    for (const path of ['/billing/api/health?x=1', '/billing/api/unknown', '/managed/v1/health', '/', '/billing/api/checkout-session/']) {
      r = await fetch(`${s.base}${path}`);
      assert.equal(r.status, 404, path);
    }
    r = await fetch(`${s.base}${ROUTES.checkout}`);
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'POST');
    r = await fetch(`${s.base}${ROUTES.webhook}`, { method: 'PUT' });
    assert.equal(r.status, 405);
  } finally { await s.service.close(); }
  await assert.rejects(fetch(`${s.base}${ROUTES.health}`));
});

test('disabled mode serves health and refuses every payment route with 503', async () => {
  const events = [];
  const config = loadConfig({ PAYMENTS_HOST: '127.0.0.1', PORT: '0' });
  const service = createPaymentsServer(config, { sink: (event) => events.push(event) });
  const address = await service.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}${ROUTES.health}`);
    assert.equal((await health.json()).status, 'disabled');
    for (const route of [ROUTES.checkout, ROUTES.portal, ROUTES.webhook]) {
      const r = await fetch(`${base}${route}`, form({ offer: 'growth_monthly' }));
      assert.equal(r.status, 503, route);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const body = await r.json();
      assert.equal(body.error.code, 'payments_disabled');
      assert.equal(body.error.message, 'Payments are not enabled');
    }
  } finally { await service.close(); }
  assert.ok(events.every((event) => event.outcome === 'ok' || event.outcome === 'payments_disabled'));
});

test('checkout creates a hosted session and redirects browsers or returns JSON', async () => {
  const s = await start();
  try {
    let r = await fetch(`${s.base}${ROUTES.checkout}`, form({ offer: 'growth_monthly' }, { 'sec-fetch-site': 'same-origin', accept: 'text/html,application/xhtml+xml' }));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_synthetic00000001');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const call = s.stripe.calls[0];
    assert.equal(call.method, 'createCheckoutSession');
    assert.match(call.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.deepEqual(call.params, {
      mode: 'subscription', line_items: [{ price: 'price_synthetic0001', quantity: 1 }],
      success_url: `${ORIGIN}/billing/success?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${ORIGIN}/billing/cancelled`,
      metadata: { offer: 'growth_monthly' }, subscription_data: { metadata: { offer: 'growth_monthly' } },
    });
    r = await fetch(`${s.base}${ROUTES.checkout}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, accept: 'application/json' }, body: JSON.stringify({ offer: 'once' }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic00000001', id: 'cs_test_synthetic00000001' });
    const oneTime = s.stripe.calls[1].params;
    assert.equal(oneTime.mode, 'payment');
    assert.deepEqual(oneTime.line_items, [{ price: 'price_synthetic0002', quantity: 2 }]);
    assert.deepEqual(oneTime.payment_intent_data, { metadata: { offer: 'once' } });
    assert.equal(oneTime.subscription_data, undefined);
    assert.equal(oneTime.automatic_tax, undefined);
  } finally { await s.service.close(); }
  const taxed = await start({ envExtra: { PAYMENTS_AUTOMATIC_TAX: '1', PAYMENTS_SUCCESS_PATH: '/thanks' } });
  try {
    await fetch(`${taxed.base}${ROUTES.checkout}`, form({ offer: 'growth_monthly' }));
    assert.deepEqual(taxed.stripe.calls[0].params.automatic_tax, { enabled: true });
    assert.equal(taxed.stripe.calls[0].params.success_url, `${ORIGIN}/thanks?session_id={CHECKOUT_SESSION_ID}`);
  } finally { await taxed.service.close(); }
});

test('checkout input, origin, size, and media-type failures are closed and never reach Stripe', async () => {
  const s = await start({ quota: { take: () => ({ ok: true, remaining: 1 }) } });
  try {
    const expect = async (init, status, code) => { const r = await fetch(`${s.base}${ROUTES.checkout}`, init); assert.equal(r.status, status, code); assert.equal((await r.json()).error.code, code); };
    await expect(form({ offer: 'nope' }), 400, 'unknown_offer');
    await expect(form({ offer: 'Growth' }), 400, 'invalid_request');
    await expect(form({ other: 'x' }), 400, 'invalid_request');
    const smuggled = await fetch(`${s.base}${ROUTES.checkout}`, form({ offer: 'growth_monthly', price: 'price_attacker', quantity: '999' }));
    assert.equal(smuggled.status, 303, 'extra fields are ignored, not trusted');
    assert.equal(s.stripe.calls.at(-1).params.line_items[0].price, 'price_synthetic0001');
    assert.equal(s.stripe.calls.at(-1).params.line_items[0].quantity, 1);
    await expect(form({ offer: 'growth_monthly' }, { origin: 'https://evil.invalid' }), 403, 'origin_not_allowed');
    await expect(form({ offer: 'growth_monthly' }, { 'sec-fetch-site': 'cross-site' }), 403, 'origin_not_allowed');
    await expect({ method: 'POST', headers: { 'content-type': 'text/plain', origin: ORIGIN }, body: 'offer=growth_monthly' }, 415, 'unsupported_media_type');
    await expect({ method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '[1,2]' }, 400, 'invalid_request');
    await expect({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: `offer=growth_monthly&pad=${'x'.repeat(LIMITS.formBodyBytes)}` }, 413, 'payload_too_large');
  } finally { await s.service.close(); }
  assert.ok(s.stripe.calls.every((call) => call.params?.line_items?.[0]?.price !== 'price_attacker'), 'client-supplied price ids are never forwarded');
});

test('upstream failures map to closed 502/503 responses', async () => {
  const cases = [
    [{ createCheckoutSession: () => { throw new StripeApiError({ status: 400, code: 'resource_missing', message: 'No such price' }); } }, 502, 'upstream_error'],
    [{ createCheckoutSession: () => { throw new StripeApiError({ status: 429, message: 'rate' }); } }, 503, 'unavailable'],
    [{ createCheckoutSession: () => ({ id: 'cs_test_synthetic00000001', url: 'https://evil.invalid/pay' }) }, 502, 'upstream_error'],
    [{ createCheckoutSession: () => ({ id: 'bogus', url: 'https://checkout.stripe.com/c/pay/x' }) }, 502, 'upstream_error'],
    [{ createCheckoutSession: () => { throw new Error('boom'); } }, 502, 'upstream_error'],
  ];
  for (const [overrides, status, code] of cases) {
    const s = await start({ stripe: mockStripe(overrides) });
    try {
      const r = await fetch(`${s.base}${ROUTES.checkout}`, form({ offer: 'growth_monthly' }));
      assert.equal(r.status, status, code);
      assert.equal((await r.json()).error.code, code);
      if (status === 503) assert.equal(r.headers.get('retry-after'), '5');
    } finally { await s.service.close(); }
  }
});

test('per-client rate limiting returns 429 with Retry-After and honours trusted proxy headers', async () => {
  let t = 0;
  const s = await start({ quota: new MemoryTokenBuckets({ now: () => t }), envExtra: { PAYMENTS_TRUST_PROXY: '1' } });
  try {
    for (let i = 0; i < LIMITS.perClient.burst; i++) assert.equal((await fetch(`${s.base}${ROUTES.checkout}`, form({ offer: 'growth_monthly' }, { 'x-forwarded-for': '203.0.113.7' }))).status, 303);
    const limited = await fetch(`${s.base}${ROUTES.checkout}`, form({ offer: 'growth_monthly' }, { 'x-forwarded-for': '203.0.113.7' }));
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after'), /^\d+$/);
    assert.equal((await limited.json()).error.code, 'rate_limited');
    assert.equal((await fetch(`${s.base}${ROUTES.checkout}`, form({ offer: 'growth_monthly' }, { 'x-forwarded-for': '203.0.113.8' }))).status, 303, 'a different client keeps its own bucket');
    t = 60000;
    assert.equal((await fetch(`${s.base}${ROUTES.checkout}`, form({ offer: 'growth_monthly' }, { 'x-forwarded-for': '203.0.113.7' }))).status, 303, 'bucket refills');
  } finally { await s.service.close(); }
});

test('portal exchange requires a completed subscription session in the deployment mode', async () => {
  const s = await start();
  try {
    let r = await fetch(`${s.base}${ROUTES.portal}`, form({ session_id: 'cs_test_synthetic00000001' }));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), 'https://billing.stripe.com/p/session/synthetic');
    assert.deepEqual(s.stripe.calls.map((call) => call.method), ['retrieveCheckoutSession', 'createBillingPortalSession']);
    assert.deepEqual(s.stripe.calls[1].params, { customer: 'cus_synthetic00000001', return_url: `${ORIGIN}/billing` });
    r = await fetch(`${s.base}${ROUTES.portal}`, form({ session_id: 'cs_live_synthetic00000001' }));
    assert.equal(r.status, 400);
    r = await fetch(`${s.base}${ROUTES.portal}`, form({ session_id: 'cus_synthetic00000001' }));
    assert.equal(r.status, 400);
    r = await fetch(`${s.base}${ROUTES.portal}`, form({ session_id: 'cs_test_synthetic00000001' }, { origin: 'https://evil.invalid' }));
    assert.equal(r.status, 403);
  } finally { await s.service.close(); }
  for (const session of [{ status: 'open', mode: 'subscription', customer: 'cus_synthetic00000001' }, { status: 'complete', mode: 'payment', customer: 'cus_synthetic00000001' }, { status: 'complete', mode: 'subscription', customer: null }]) {
    const x = await start({ stripe: mockStripe({ retrieveCheckoutSession: () => ({ id: 'cs_test_synthetic00000001', ...session }) }) });
    try {
      const r = await fetch(`${x.base}${ROUTES.portal}`, form({ session_id: 'cs_test_synthetic00000001' }));
      assert.equal(r.status, 404);
      assert.equal((await r.json()).error.code, 'portal_unavailable');
      assert.equal(x.stripe.calls.length, 1, 'no portal session is created');
    } finally { await x.service.close(); }
  }
  const expanded = await start({ stripe: mockStripe({ retrieveCheckoutSession: () => ({ id: 'cs_test_synthetic00000001', status: 'complete', mode: 'subscription', customer: { id: 'cus_synthetic00000001', email: 'private@synthetic.invalid' } }) }) });
  try { assert.equal((await fetch(`${expanded.base}${ROUTES.portal}`, form({ session_id: 'cs_test_synthetic00000001' }))).status, 303); } finally { await expanded.service.close(); }
});

test('webhook verifies, deduplicates, records, and rejects mismatched or oversized events', async () => {
  const store = createMemoryStore();
  const s = await start({ store });
  try {
    let r = await fetch(`${s.base}${ROUTES.webhook}`, webhook(fixture));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { received: true, outcome: 'processed' });
    assert.equal((await store.getEntitlement('sub:sub_synthetic00000001')).offer, 'growth_monthly');
    r = await fetch(`${s.base}${ROUTES.webhook}`, webhook(fixture));
    assert.deepEqual(await r.json(), { received: true, duplicate: true });
    r = await fetch(`${s.base}${ROUTES.webhook}`, webhook(fixture, { 'stripe-signature': `t=2145916800,v1=${'0'.repeat(64)}` }));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'signature_invalid');
    r = await fetch(`${s.base}${ROUTES.webhook}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: fixture });
    assert.equal(r.status, 400);
    const tampered = Buffer.from(fixture.toString().replace('"livemode": false', '"livemode": true'));
    r = await fetch(`${s.base}${ROUTES.webhook}`, webhook(tampered));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'livemode_mismatch');
    const other = JSON.parse(fixture); other.id = 'evt_synthetic00000077'; other.type = 'charge.succeeded';
    r = await fetch(`${s.base}${ROUTES.webhook}`, webhook(Buffer.from(JSON.stringify(other))));
    assert.deepEqual(await r.json(), { received: true, outcome: 'ignored' });
    r = await fetch(`${s.base}${ROUTES.webhook}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(LIMITS.webhookBodyBytes + 1), 'stripe-signature': 't=1,v1=' + '0'.repeat(64) }, body: Buffer.alloc(LIMITS.webhookBodyBytes + 1, 0x20) });
    assert.equal(r.status, 413);
    r = await fetch(`${s.base}${ROUTES.webhook}`, webhook(fixture, { origin: 'https://dashboard.stripe.invalid' }));
    assert.equal(r.status, 200, 'webhooks are server-to-server and skip the browser origin policy');
  } finally { await s.service.close(); }
  const drift = await start({ store: createMemoryStore(), now: () => NOW_MS + 600000 });
  try { assert.equal((await fetch(`${drift.base}${ROUTES.webhook}`, webhook(fixture))).status, 400); } finally { await drift.service.close(); }
});

test('webhook handler failures release the event so Stripe retries succeed', async () => {
  const inner = createMemoryStore();
  let failures = 1;
  const flaky = { kind: 'flaky', claimEvent: (id) => inner.claimEvent(id), releaseEvent: (id) => inner.releaseEvent(id), getEntitlement: (key) => inner.getEntitlement(key), putEntitlement: (record) => { if (failures-- > 0) throw new Error('db down'); return inner.putEntitlement(record); } };
  const s = await start({ store: flaky });
  try {
    let r = await fetch(`${s.base}${ROUTES.webhook}`, webhook(fixture));
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error.code, 'handler_failed');
    r = await fetch(`${s.base}${ROUTES.webhook}`, webhook(fixture));
    assert.deepEqual(await r.json(), { received: true, outcome: 'processed' });
  } finally { await s.service.close(); }
  const broken = { kind: 'broken', claimEvent: () => { throw new Error('unreachable'); }, releaseEvent: async () => {}, getEntitlement: async () => null, putEntitlement: async (record) => record };
  const b = await start({ store: broken });
  try { assert.equal((await fetch(`${b.base}${ROUTES.webhook}`, webhook(fixture))).status, 503); } finally { await b.service.close(); }
});

test('sink events have exact safe fields and never carry secrets; throwing sinks are isolated', async () => {
  let failures = 0;
  const events = [];
  const s = await start({ sink: (event) => { events.push(event); throw new Error('sink'); } });
  const service = createPaymentsServer(s.config, { stripe: mockStripe(), now: () => NOW_MS, sink: (event) => { events.push(event); throw new Error('sink'); }, sinkError: (count) => { failures = count; } });
  await s.service.close();
  const address = await service.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${base}${ROUTES.health}`);
    await fetch(`${base}${ROUTES.checkout}`, form({ offer: 'growth_monthly' }));
    await fetch(`${base}${ROUTES.webhook}`, webhook(fixture));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(failures, 3);
    assert.equal(service.sinkErrors, 3);
    const mine = events.slice(-3);
    for (const event of mine) assert.deepEqual(Object.keys(event), [...EVENT_KEYS]);
    assert.deepEqual(mine.map((event) => [event.route, event.status_code, event.outcome]), [['health', 200, 'ok'], ['checkout', 303, 'ok'], ['webhook', 200, 'processed']]);
    assert.equal(mine[1].offer, 'growth_monthly');
    assert.equal(mine[2].event_type, 'checkout.session.completed');
    const encoded = JSON.stringify(events);
    assert.equal(encoded.includes(KEY), false);
    assert.equal(encoded.includes(WHSEC), false);
    assert.equal(encoded.includes('cus_synthetic'), false);
    assert.equal(encoded.includes('203.0.113'), false);
  } finally { await service.close(); }
});

test('overload answers 503 with connection close', async () => {
  const gate = { resolve: null };
  const stripe = mockStripe({ createCheckoutSession: () => new Promise((resolve) => { gate.resolve = () => resolve({ id: 'cs_test_synthetic00000001', url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic00000001' }); }) });
  const config = loadConfig(env());
  const service = createPaymentsServer(config, { stripe, maxConcurrent: 1 });
  const address = await service.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const pending = fetch(`${base}${ROUTES.checkout}`, form({ offer: 'growth_monthly' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rejected = await fetch(`${base}${ROUTES.health}`);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('connection'), 'close');
    gate.resolve();
    assert.equal((await pending).status, 303);
  } finally { await service.close(); }
});
