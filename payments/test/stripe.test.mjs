import test from 'node:test';
import assert from 'node:assert/strict';
import { StripeApiError, USER_AGENT, createStripeClient, encodeForm } from '../src/stripe.mjs';

const key = `sk_test_${'a'.repeat(40)}`;

test('encodeForm produces Stripe bracket notation', () => {
  const encoded = encodeForm({
    mode: 'subscription',
    line_items: [{ price: 'price_synthetic0001', quantity: 1 }],
    metadata: { offer: 'growth_monthly' },
    success_url: 'https://synthetic.invalid/billing/success?session_id={CHECKOUT_SESSION_ID}',
    automatic_tax: { enabled: true },
    skipped: null,
  });
  assert.equal(encoded, [
    'mode=subscription', 'line_items%5B0%5D%5Bprice%5D=price_synthetic0001', 'line_items%5B0%5D%5Bquantity%5D=1', 'metadata%5Boffer%5D=growth_monthly',
    'success_url=https%3A%2F%2Fsynthetic.invalid%2Fbilling%2Fsuccess%3Fsession_id%3D%7BCHECKOUT_SESSION_ID%7D', 'automatic_tax%5Benabled%5D=true',
  ].join('&'));
  assert.equal(new URLSearchParams(encoded).get('success_url'), 'https://synthetic.invalid/billing/success?session_id={CHECKOUT_SESSION_ID}');
  assert.throws(() => encodeForm({ bad: () => {} }), TypeError);
  assert.throws(() => encodeForm({ bad: Infinity }), TypeError);
});

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  return { calls, fetchImpl };
}
const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('client sends bearer auth, version, idempotency, and form body', async () => {
  const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, { id: 'cs_test_synthetic00000001', url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic00000001' }));
  const client = createStripeClient({ secretKey: key, apiVersion: '2025-08-27.basil', fetchImpl });
  const session = await client.createCheckoutSession({ mode: 'payment', line_items: [{ price: 'price_synthetic0001', quantity: 2 }] }, 'idem-1');
  assert.equal(session.id, 'cs_test_synthetic00000001');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  const { headers, body, method, redirect } = calls[0].init;
  assert.equal(method, 'POST');
  assert.equal(redirect, 'error');
  assert.equal(headers.authorization, `Bearer ${key}`);
  assert.equal(headers['stripe-version'], '2025-08-27.basil');
  assert.equal(headers['idempotency-key'], 'idem-1');
  assert.equal(headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(headers['user-agent'], USER_AGENT);
  assert.equal(body, 'mode=payment&line_items%5B0%5D%5Bprice%5D=price_synthetic0001&line_items%5B0%5D%5Bquantity%5D=2');
  await client.retrieveCheckoutSession('cs_test_synthetic00000001');
  assert.equal(calls[1].url, 'https://api.stripe.com/v1/checkout/sessions/cs_test_synthetic00000001');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.body, undefined);
  assert.equal(calls[1].init.headers['idempotency-key'], undefined);
  const auto = await (async () => { await client.createBillingPortalSession({ customer: 'cus_synthetic00000001', return_url: 'https://synthetic.invalid/billing' }); return calls[2].init.headers['idempotency-key']; })();
  assert.match(auto, /^[0-9a-f-]{36}$/);
});

test('client rejects unsafe construction and request shapes', async () => {
  assert.throws(() => createStripeClient({ secretKey: 'short' }));
  assert.throws(() => createStripeClient({ secretKey: key, fetchImpl: null }));
  assert.throws(() => createStripeClient({ secretKey: key, timeoutMs: 10 }));
  assert.throws(() => createStripeClient({ secretKey: key, baseUrl: 'https://api.stripe.com/v1' }));
  const client = createStripeClient({ secretKey: key, fetchImpl: async () => jsonResponse(200, {}) });
  await assert.rejects(client.request('DELETE', '/v1/customers'), /invalid stripe request/);
  await assert.rejects(client.request('GET', '/v2/anything'), /invalid stripe request/);
  await assert.rejects(client.request('GET', '/v1/checkout/sessions/../secret'), /invalid stripe request/);
  await assert.rejects(client.request('GET', '/v1/checkout/sessions?expand[]=x'), /invalid stripe request/);
  await assert.rejects(client.request('GET', '/v1/customers', { params: { a: 1 } }), /GET requests take no params/);
});

test('Stripe errors surface status, code, and redacted messages; timeouts and non-JSON fail closed', async () => {
  const leaked = `sk_test_${'z'.repeat(40)}`;
  const failing = createStripeClient({ secretKey: key, fetchImpl: async () => jsonResponse(400, { error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such price; key ${leaked}` } }, { 'request-id': 'req_synthetic1' }) });
  await assert.rejects(failing.createCheckoutSession({}), (error) => error instanceof StripeApiError && error.status === 400 && error.code === 'resource_missing' && error.requestId === 'req_synthetic1' && !error.message.includes('z'.repeat(10)) && error.message.includes('[REDACTED]'));
  const rateLimited = createStripeClient({ secretKey: key, fetchImpl: async () => new Response('slow down', { status: 429 }) });
  await assert.rejects(rateLimited.createCheckoutSession({}), (error) => error.status === 429 && error.code === null);
  const slow = createStripeClient({ secretKey: key, timeoutMs: 100, fetchImpl: (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); }) });
  await assert.rejects(slow.createCheckoutSession({}), (error) => error instanceof StripeApiError && error.type === 'timeout' && error.status === 0);
  const network = createStripeClient({ secretKey: key, fetchImpl: async () => { throw new Error(`ECONNRESET ${leaked}`); } });
  await assert.rejects(network.createCheckoutSession({}), (error) => error.type === 'network_error' && !error.message.includes('z'.repeat(10)));
  const weird = createStripeClient({ secretKey: key, fetchImpl: async () => new Response('"a string"', { status: 200 }) });
  await assert.rejects(weird.createCheckoutSession({}), (error) => error.type === 'invalid_response');
});
