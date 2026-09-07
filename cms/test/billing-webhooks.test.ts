import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getPayload, type Payload } from 'payload';
import configPromise from '@payload-config';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { call, createUser, login, signEvent, startMockStripe, stripeEvent } from './helpers';
import { handleStripeEvent, periodEndOf } from '../src/lib/stripe';
import { toGatewayRecord } from '../src/lib/gateway-keys';
import { exportableKeys, withEntitlement } from '../src/endpoints/gateway';

let payload: Payload;
let stripe: Awaited<ReturnType<typeof startMockStripe>>;
const PASSWORD = 'correct-horse-battery-staple-01';
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const subscription = (id: string, extra: Record<string, unknown> = {}) => ({ id, object: 'subscription', status: 'active', customer: 'cus_synthetic00000001', cancel_at_period_end: false, metadata: {}, items: { object: 'list', data: [{ id: 'si_synthetic0001', object: 'subscription_item', current_period_end: 2148595200, price: { id: 'price_synthetic0001', object: 'price' } }] }, ...extra });

beforeAll(async () => {
  // The Stripe client reads CMS_STRIPE_API_BASE when the config module loads (test/setup.ts), so the double must listen there.
  stripe = await startMockStripe();
  payload = await getPayload({ config: configPromise });
  await createUser(payload, { email: 'admin@example.test', password: PASSWORD, role: 'admin' });
  await createUser(payload, { email: 'buyer@example.test', password: PASSWORD, name: 'Buyer' });
  // Each automation gets its own service account with exactly one scope.
  const service = await createUser(payload, { email: 'service@example.test', password: PASSWORD, role: 'service', serviceScope: 'payments_store', enableAPIKey: true, apiKey: 'service-api-key-synthetic-0001' });
  expect(service).toMatchObject({ role: 'service', serviceScope: 'payments_store' });
  const gatewaySync = await createUser(payload, { email: 'gateway-sync@example.test', password: PASSWORD, role: 'service', serviceScope: 'gateway_sync', enableAPIKey: true, apiKey: 'service-api-key-synthetic-0002' });
  expect(gatewaySync.serviceScope).toBe('gateway_sync');
  await expect(createUser(payload, { email: 'unscoped@example.test', password: PASSWORD, role: 'service', enableAPIKey: true, apiKey: 'service-api-key-synthetic-0003' })).rejects.toThrow(/serviceScope/);
  const member = await createUser(payload, { email: 'scoped-member@example.test', password: PASSWORD, serviceScope: 'gateway_sync' });
  expect(member.serviceScope ?? null).toBeNull(); // a scope means nothing on a person
  await payload.create({ collection: 'plans', data: { offerId: 'growth_monthly', label: 'Growth — monthly', mode: 'subscription', stripePriceId: 'price_synthetic0001', quantity: 1, active: true, gateway: { permissions: ['manifest', 'records'], quotaRate: 2, quotaBurst: 20 } }, overrideAccess: true });
});
afterAll(async () => { await stripe.close(); await payload.db.destroy?.(); });

const buyerId = async () => (await payload.find({ collection: 'users', where: { email: { equals: 'buyer@example.test' } }, overrideAccess: true })).docs[0].id;

describe('Stripe webhooks through the CMS endpoint', () => {
  test('rejects unsigned and mis-signed events', async () => {
    const event = stripeEvent('customer.subscription.created', subscription('sub_synthetic00000009'));
    const unsigned = await call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: JSON.stringify(event), origin: null });
    expect(unsigned.status).toBe(400);
    expect(unsigned.data.error.code).toBe('signature_invalid');
    const forged = signEvent(event, `whsec_${'z'.repeat(32)}`);
    const bad = await call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: forged.body, headers: { 'stripe-signature': forged.signature }, origin: null });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe('signature_invalid');
    const empty = await call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: '', headers: { 'stripe-signature': forged.signature }, origin: null });
    expect(empty.status).toBe(400);
    expect((await payload.count({ collection: 'stripe-events', overrideAccess: true })).totalDocs).toBe(0);
    expect((await payload.count({ collection: 'subscriptions', overrideAccess: true })).totalDocs).toBe(0);
  });

  test('checkout completion links the customer and subscription to the account by client_reference_id', async () => {
    const user = await buyerId();
    const event = stripeEvent('checkout.session.completed', { id: 'cs_test_synthetic00000001', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_synthetic00000001', subscription: 'sub_synthetic00000001', client_reference_id: String(user), metadata: { offer: 'growth_monthly', cms_user: String(user) } });
    const signed = signEvent(event);
    const result = await call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: signed.body, headers: { 'stripe-signature': signed.signature }, origin: null });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ received: true, outcome: 'processed' }); // handled before the response, not after
    const sub = (await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000001' } }, overrideAccess: true, depth: 0 })).docs[0];
    expect(sub).toMatchObject({ user, stripeCustomerId: 'cus_synthetic00000001', offer: 'growth_monthly', status: 'pending_subscription_event', checkoutSessionId: 'cs_test_synthetic00000001', source: 'cms', livemode: false });
    const buyer = await payload.findByID({ collection: 'users', id: user, overrideAccess: true });
    expect(buyer.stripeCustomerId).toBe('cus_synthetic00000001');
    const ledger = await payload.find({ collection: 'stripe-events', where: { eventId: { equals: event.id } }, overrideAccess: true });
    expect(ledger.docs[0]).toMatchObject({ type: 'checkout.session.completed', source: 'cms', claimKey: `cms:${event.id}`, outcome: 'processed' });
    const replay = await call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: signed.body, headers: { 'stripe-signature': signed.signature }, origin: null });
    expect(replay.data).toEqual({ received: true, outcome: 'duplicate' });
  });

  test('a handler failure answers 500 with the claim released, so Stripe retries and the retry is processed', async () => {
    const event = stripeEvent('customer.subscription.created', subscription('sub_synthetic00000007', { customer: 'cus_synthetic00000007' }));
    const signed = signEvent(event);
    const originalCreate = payload.create;
    let outages = 0;
    payload.create = (async (args: { collection: string }) => {
      if (args.collection === 'subscriptions') { outages += 1; throw new Error('synthetic database outage'); }
      return (originalCreate as unknown as (options: unknown) => Promise<unknown>)(args);
    }) as never;
    let failed;
    try {
      failed = await call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: signed.body, headers: { 'stripe-signature': signed.signature }, origin: null });
    } finally {
      payload.create = originalCreate;
    }
    expect(outages).toBe(1);
    expect(failed.status).toBe(500);
    expect(failed.data.error.code).toBe('handler_failed');
    expect((await payload.count({ collection: 'stripe-events', where: { eventId: { equals: event.id } }, overrideAccess: true })).totalDocs).toBe(0); // claim released
    expect((await payload.count({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000007' } }, overrideAccess: true })).totalDocs).toBe(0);
    const retried = await call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: signed.body, headers: { 'stripe-signature': signed.signature }, origin: null });
    expect(retried.status).toBe(200);
    expect(retried.data).toEqual({ received: true, outcome: 'processed' });
    expect((await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000007' } }, overrideAccess: true, depth: 0 })).docs[0]).toMatchObject({ status: 'active', user: null });
  });

  test('an incomplete claim is retried, never acknowledged: 409 while in progress, taken over once abandoned', async () => {
    const deliver = async (signed: { body: string; signature: string }) => call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: signed.body, headers: { 'stripe-signature': signed.signature }, origin: null });
    const backdate = (id: number | string) => payload.db.updateOne({ collection: 'stripe-events', id, data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() } });
    const event = stripeEvent('customer.subscription.created', subscription('sub_synthetic00000006', { customer: 'cus_synthetic00000006' }));
    const signed = signEvent(event);
    // A worker that died mid-way leaves a claim without an outcome and without releasing it.
    const abandoned = await payload.create({ collection: 'stripe-events', data: { eventId: event.id, type: event.type, livemode: false, source: 'cms', claimKey: `cms:${event.id}` }, overrideAccess: true, depth: 0 });
    const inProgress = await deliver(signed);
    expect(inProgress.status).toBe(409);
    expect(inProgress.data.error.code).toBe('event_in_progress');
    expect((await payload.count({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000006' } }, overrideAccess: true })).totalDocs).toBe(0);
    await backdate(abandoned.id);
    const takenOver = await deliver(signed);
    expect(takenOver.data).toEqual({ received: true, outcome: 'processed' });
    const ledger = await payload.find({ collection: 'stripe-events', where: { eventId: { equals: event.id } }, overrideAccess: true, depth: 0 });
    expect(ledger.totalDocs).toBe(1);
    expect(ledger.docs[0].outcome).toBe('processed');
    expect((await deliver(signed)).data).toEqual({ received: true, outcome: 'duplicate' });
    // The same protection covers a failure whose cleanup also fails: the claim stays behind, but stays retryable.
    const second = stripeEvent('customer.subscription.created', subscription('sub_synthetic00000012', { customer: 'cus_synthetic00000012' }));
    const signed2 = signEvent(second);
    const originalCreate = payload.create, originalDelete = payload.delete;
    payload.create = (async (args: { collection: string }) => { if (args.collection === 'subscriptions') throw new Error('synthetic database outage'); return (originalCreate as unknown as (options: unknown) => Promise<unknown>)(args); }) as never;
    payload.delete = (async (args: { collection: string }) => { if (args.collection === 'stripe-events') throw new Error('synthetic database outage'); return (originalDelete as unknown as (options: unknown) => Promise<unknown>)(args); }) as never;
    let failed;
    try { failed = await deliver(signed2); } finally { payload.create = originalCreate; payload.delete = originalDelete; }
    expect(failed.status).toBe(500);
    const stuck = (await payload.find({ collection: 'stripe-events', where: { eventId: { equals: second.id } }, overrideAccess: true, depth: 0 })).docs[0];
    expect(stuck.outcome ?? null).toBeNull(); // the release failed too, so the claim is still there
    expect((await deliver(signed2)).status).toBe(409); // within the grace period: retry later, never a 200
    await backdate(stuck.id);
    expect((await deliver(signed2)).data).toEqual({ received: true, outcome: 'processed' });
    expect((await payload.count({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000012' } }, overrideAccess: true })).totalDocs).toBe(1);
    expect((await payload.count({ collection: 'stripe-events', where: { eventId: { equals: second.id } }, overrideAccess: true })).totalDocs).toBe(1);
  });

  test('same-second events are reconciled against Stripe instead of trusting delivery order', async () => {
    const id = 'sub_synthetic00000005';
    const at = 2145917500;
    const find = async () => (await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: id } }, overrideAccess: true, depth: 0 })).docs[0];
    const retrievals = () => stripe.requests.filter((r) => r.method === 'GET' && r.path === `/v1/subscriptions/${id}`).length;
    stripe.objects.set(`/v1/subscriptions/${id}`, subscription(id, { customer: 'cus_synthetic00000005', status: 'canceled' }));
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.created', subscription(id, { customer: 'cus_synthetic00000005' }), { created: at }) as never)).toBe('processed');
    expect((await find()).status).toBe('active');
    expect(retrievals()).toBe(0);
    // Same second, cancellation delivered second: the payload is not trusted for order; Stripe's current object (canceled) is applied.
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.updated', subscription(id, { customer: 'cus_synthetic00000005', status: 'canceled' }), { created: at }) as never)).toBe('processed');
    expect((await find()).status).toBe('canceled');
    // Same second, the pre-cancellation "active" update delivered last: reconciled to canceled, so it can never restore access.
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.updated', subscription(id, { customer: 'cus_synthetic00000005', status: 'active' }), { created: at }) as never)).toBe('processed');
    expect((await find()).status).toBe('canceled');
    expect(retrievals()).toBe(2);
    // If Stripe cannot be asked, the tied event fails (500, claim released, Stripe retries) rather than being applied in an unknown order.
    stripe.objects.delete(`/v1/subscriptions/${id}`);
    const tied = stripeEvent('customer.subscription.updated', subscription(id, { customer: 'cus_synthetic00000005', status: 'active' }), { created: at });
    expect(await handleStripeEvent(payload, tied as never)).toBe('handler_failed');
    expect((await payload.count({ collection: 'stripe-events', where: { eventId: { equals: tied.id } }, overrideAccess: true })).totalDocs).toBe(0);
    expect((await find()).status).toBe('canceled');
    // A strictly newer event still applies without a fetch.
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.updated', subscription(id, { customer: 'cus_synthetic00000005', status: 'active' }), { created: at + 1 }) as never)).toBe('processed');
    expect((await find()).status).toBe('active');
    expect(retrievals()).toBe(3);
    // Two invoice events in one second for different invoices: the subscription's latest invoice decides, not the delivered one.
    const invoiceEvent = (invoiceId: string, type: string, created: number) => stripeEvent(type, { id: invoiceId, object: 'invoice', customer: 'cus_synthetic00000005', status: type === 'invoice.paid' ? 'paid' : 'open', parent: { subscription_details: { subscription: id } } }, { created });
    expect(await handleStripeEvent(payload, invoiceEvent('in_synthetic00000052', 'invoice.paid', at + 2) as never)).toBe('processed');
    expect(await find()).toMatchObject({ lastInvoiceId: 'in_synthetic00000052', lastInvoiceStatus: 'paid' });
    stripe.objects.set(`/v1/subscriptions/${id}`, subscription(id, { customer: 'cus_synthetic00000005', latest_invoice: 'in_synthetic00000052' }));
    stripe.objects.set('/v1/invoices/in_synthetic00000052', { id: 'in_synthetic00000052', object: 'invoice', status: 'paid', customer: 'cus_synthetic00000005' });
    expect(await handleStripeEvent(payload, invoiceEvent('in_synthetic00000051', 'invoice.payment_failed', at + 2) as never)).toBe('processed'); // older invoice, same second, delivered last
    expect(await find()).toMatchObject({ lastInvoiceId: 'in_synthetic00000052', lastInvoiceStatus: 'paid', status: 'active' });
    expect(stripe.requests.filter((r) => r.method === 'GET' && r.path === '/v1/invoices/in_synthetic00000052').length).toBe(1);
    expect(stripe.requests.filter((r) => r.method === 'GET' && r.path === '/v1/invoices/in_synthetic00000051').length).toBe(0);
  });

  test('subscription events activate the account, are idempotent, and never let an older event overwrite newer state', async () => {
    const created = stripeEvent('customer.subscription.created', subscription('sub_synthetic00000001'), { created: 2145916801 });
    expect(await handleStripeEvent(payload, created as never)).toBe('processed');
    expect(await handleStripeEvent(payload, created as never)).toBe('duplicate');
    const stale = stripeEvent('customer.subscription.updated', subscription('sub_synthetic00000001', { status: 'canceled' }), { created: 2145916700 });
    expect(await handleStripeEvent(payload, stale as never)).toBe('stale');
    const sub = (await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000001' } }, overrideAccess: true, depth: 0 })).docs[0];
    expect(sub.status).toBe('active');
    expect(sub.currentPeriodEnd).toBe(new Date(2148595200 * 1000).toISOString());
    expect(sub.plan).toBeTruthy();
    const me = await call('/cms/api/account/me', { token: await login('buyer@example.test', PASSWORD) });
    expect(me.data.entitlement).toEqual({ active: true, offer: 'growth_monthly' });
    expect(me.data.subscriptions[0]).toMatchObject({ id: 'sub_synthetic00000001', status: 'active', offer: 'growth_monthly' });
    // Ordering is per event family: a checkout event created after a delayed
    // subscription event must not discard the status that subscription event carries.
    const lateCheckout = stripeEvent('checkout.session.completed', { id: 'cs_test_synthetic00000002', object: 'checkout.session', mode: 'subscription', status: 'complete', customer: 'cus_synthetic00000001', subscription: 'sub_synthetic00000003', client_reference_id: String(await buyerId()), metadata: { offer: 'growth_monthly' } }, { created: 2145916950 });
    expect(await handleStripeEvent(payload, lateCheckout as never)).toBe('processed');
    const delayedActivation = stripeEvent('customer.subscription.created', subscription('sub_synthetic00000003'), { created: 2145916940 });
    expect(await handleStripeEvent(payload, delayedActivation as never)).toBe('processed');
    const third = (await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000003' } }, overrideAccess: true, depth: 0 })).docs[0];
    expect(third).toMatchObject({ status: 'active', checkoutSessionId: 'cs_test_synthetic00000002', lastCheckoutEventCreated: 2145916950, lastSubscriptionEventCreated: 2145916940, lastEventCreated: 2145916950 });
    const olderStatus = stripeEvent('customer.subscription.updated', subscription('sub_synthetic00000003', { status: 'canceled' }), { created: 2145916930 });
    expect(await handleStripeEvent(payload, olderStatus as never)).toBe('stale');
    const livemodeMismatch = stripeEvent('customer.subscription.updated', subscription('sub_synthetic00000001', { status: 'past_due' }), { created: 2145916900, livemode: true });
    expect(await handleStripeEvent(payload, livemodeMismatch as never)).toBe('livemode_mismatch');
    const invoice = stripeEvent('invoice.payment_failed', { id: 'in_synthetic00000001', object: 'invoice', customer: 'cus_synthetic00000001', parent: { subscription_details: { subscription: 'sub_synthetic00000001' } } }, { created: 2145916902 });
    expect(await handleStripeEvent(payload, invoice as never)).toBe('processed');
    const after = (await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000001' } }, overrideAccess: true, depth: 0 })).docs[0];
    expect(after).toMatchObject({ lastInvoiceId: 'in_synthetic00000001', lastInvoiceStatus: 'payment_failed', status: 'active' });
    expect(periodEndOf({ current_period_end: 5 } as never)).toBe(5);
    expect(periodEndOf({ items: { data: [{ current_period_end: 7 }, { current_period_end: 9 }] } } as never)).toBe(9);
    expect(periodEndOf({ items: { data: [] } } as never)).toBeNull();
  });
});

describe('payments-service store contract (service API key)', () => {
  const service = { apiKey: 'service-api-key-synthetic-0001' };
  test('claims events first-writer-wins per consumer through the unique claim key and releases them', async () => {
    const first = await call('/cms/api/stripe-events', { method: 'POST', apiKey: service.apiKey, origin: null, body: { eventId: 'evt_payments00000001', source: 'payments' } });
    expect(first.status).toBe(201);
    expect(first.data.doc.claimKey).toBe('payments:evt_payments00000001');
    const duplicate = await call('/cms/api/stripe-events', { method: 'POST', apiKey: service.apiKey, origin: null, body: { eventId: 'evt_payments00000001', source: 'payments' } });
    expect(duplicate.status).toBe(400);
    // The CMS webhook's claim on the same event is a different consumer's and never blocks the payments service (or vice versa).
    const otherConsumer = await payload.create({ collection: 'stripe-events', data: { eventId: 'evt_payments00000001', source: 'cms', claimKey: 'cms:evt_payments00000001' }, overrideAccess: true, depth: 0 });
    expect(otherConsumer.claimKey).toBe('cms:evt_payments00000001');
    // A service credential is pinned to its own namespace: `source` and the claim key it sends are ignored.
    const forgedKey = await call('/cms/api/stripe-events', { method: 'POST', apiKey: service.apiKey, origin: null, body: { eventId: 'evt_payments00000004', source: 'cms', claimKey: 'cms:evt_payments00000004' } });
    expect(forgedKey.status).toBe(201);
    expect(forgedKey.data.doc).toMatchObject({ source: 'payments', claimKey: 'payments:evt_payments00000004' });
    const lookup = await call('/cms/api/stripe-events?where[claimKey][equals]=payments:evt_payments00000001&limit=1&depth=0', { apiKey: service.apiKey, origin: null });
    expect(lookup.data.totalDocs).toBe(1);
    const released = await call('/cms/api/stripe-events?where[claimKey][equals]=payments:evt_payments00000001', { method: 'DELETE', apiKey: service.apiKey, origin: null });
    expect(released.status).toBe(200);
    expect((await call('/cms/api/stripe-events?where[claimKey][equals]=payments:evt_payments00000001', { apiKey: service.apiKey, origin: null })).data.totalDocs).toBe(0);
    expect((await payload.count({ collection: 'stripe-events', where: { eventId: { equals: 'evt_payments00000001' } }, overrideAccess: true })).totalDocs).toBe(1); // the CMS claim survives the payments release
    expect((await call('/cms/api/stripe-events?where[eventId][equals]=evt_payments00000001', { apiKey: service.apiKey, origin: null })).data.totalDocs).toBe(0); // and is invisible to the store credential
    const anonymous = await call('/cms/api/stripe-events', { method: 'POST', body: { eventId: 'evt_payments00000002', source: 'payments' } });
    expect(anonymous.status).toBe(403);
    // The store credential writes only in its own namespace: it cannot forge or complete a CMS claim, nor see or change one.
    const forgedCms = await call('/cms/api/stripe-events', { method: 'POST', apiKey: service.apiKey, origin: null, body: { eventId: 'evt_payments00000006', source: 'cms', outcome: 'processed' } });
    expect(forgedCms.status).toBe(201);
    expect(forgedCms.data.doc).toMatchObject({ source: 'payments', claimKey: 'payments:evt_payments00000006' });
    const cmsClaim = await payload.create({ collection: 'stripe-events', data: { eventId: 'evt_payments00000007', source: 'cms', claimKey: 'cms:evt_payments00000007' }, overrideAccess: true, depth: 0 });
    const completeCms = await call('/cms/api/stripe-events?where[claimKey][equals]=cms:evt_payments00000007&depth=0', { method: 'PATCH', apiKey: service.apiKey, origin: null, body: { outcome: 'processed' } });
    expect(completeCms.data.docs ?? []).toHaveLength(0);
    expect((await call(`/cms/api/stripe-events/${cmsClaim.id}?depth=0`, { method: 'PATCH', apiKey: service.apiKey, origin: null, body: { outcome: 'processed' } })).status).toBeGreaterThanOrEqual(400);
    expect((await call('/cms/api/stripe-events?where[claimKey][equals]=cms:evt_payments00000007', { method: 'DELETE', apiKey: service.apiKey, origin: null })).data.docs ?? []).toHaveLength(0);
    expect((await payload.findByID({ collection: 'stripe-events', id: cmsClaim.id, overrideAccess: true, depth: 0 })).outcome ?? null).toBeNull();
    expect((await call('/cms/api/stripe-events?where[eventId][equals]=evt_payments00000007', { apiKey: service.apiKey, origin: null })).data.totalDocs).toBe(0); // invisible to the store credential
    // A take-over is re-checked under the row lock: a fresh incomplete claim cannot be taken over (even by id), an abandoned one can, once.
    const fresh = await call('/cms/api/stripe-events', { method: 'POST', apiKey: service.apiKey, origin: null, body: { eventId: 'evt_payments00000008', source: 'payments' } });
    expect(fresh.status).toBe(201);
    expect((await call(`/cms/api/stripe-events/${fresh.data.doc.id}?depth=0`, { method: 'PATCH', apiKey: service.apiKey, origin: null, body: { outcome: null } })).status).toBe(409);
    await payload.db.updateOne({ collection: 'stripe-events', id: fresh.data.doc.id, data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() } });
    const taken = await call('/cms/api/stripe-events?where[claimKey][equals]=payments:evt_payments00000008&where[outcome][exists]=false&depth=0', { method: 'PATCH', apiKey: service.apiKey, origin: null, body: { outcome: null } });
    expect(taken.status).toBe(200);
    expect(taken.data.docs).toHaveLength(1);
    expect((await call(`/cms/api/stripe-events/${fresh.data.doc.id}?depth=0`, { method: 'PATCH', apiKey: service.apiKey, origin: null, body: { outcome: null } })).status).toBe(409); // refreshed by the take-over: a second taker backs off
    expect((await call('/cms/api/stripe-events?where[claimKey][equals]=payments:evt_payments00000008&depth=0', { method: 'PATCH', apiKey: service.apiKey, origin: null, body: { outcome: 'processed' } })).data.docs).toHaveLength(1);
    expect((await call(`/cms/api/stripe-events/${fresh.data.doc.id}?depth=0`, { method: 'PATCH', apiKey: service.apiKey, origin: null, body: { outcome: null } })).status).toBe(409); // completed claims are never taken over
    // Scopes: the gateway-sync credential cannot touch the ledger or entitlements, and neither service credential reads anything else.
    const gateway = { apiKey: 'service-api-key-synthetic-0002' };
    expect((await call('/cms/api/stripe-events', { method: 'POST', apiKey: gateway.apiKey, origin: null, body: { eventId: 'evt_payments00000005', source: 'payments' } })).status).toBe(403);
    expect((await call('/cms/api/stripe-events?limit=1', { apiKey: gateway.apiKey, origin: null })).status).toBe(403);
    expect((await call('/cms/api/entitlements?depth=0', { method: 'POST', apiKey: gateway.apiKey, origin: null, body: { key: 'sub:sub_synthetic00000099', kind: 'subscription', status: 'active', record: { key: 'sub:sub_synthetic00000099' } } })).status).toBe(403);
    for (const apiKey of [service.apiKey, gateway.apiKey]) {
      expect((await call('/cms/api/subscriptions?limit=1', { apiKey, origin: null })).status).toBe(403);
      expect((await call('/cms/api/plans?limit=1', { apiKey, origin: null })).status).toBe(403);
      expect((await call('/cms/api/api-keys?limit=1', { apiKey, origin: null })).status).toBe(403);
      expect((await call('/cms/api/users?limit=1', { apiKey, origin: null })).status).toBe(403);
    }
  });

  test('entitlement records mirror into subscriptions and link the account by customer id', async () => {
    const record = { key: 'sub:sub_synthetic00000002', kind: 'subscription', offer: 'growth_monthly', offer_known: true, customer: 'cus_synthetic00000001', status: 'active', livemode: false, updated_at_epoch: 2145917000, updated_at: '2038-01-01T00:03:20.000Z', source_event: 'evt_payments00000003', cancel_at_period_end: true, current_period_end: 2148595200 };
    const document = { key: record.key, kind: 'subscription', offer: 'growth_monthly', offerKnown: true, status: 'active', customer: record.customer, subscription: 'sub_synthetic00000002', livemode: false, updatedAtEpoch: record.updated_at_epoch, sourceEvent: record.source_event, source: 'payments', record };
    const created = await call('/cms/api/entitlements?depth=0', { method: 'POST', apiKey: service.apiKey, origin: null, body: document });
    expect(created.status).toBe(201);
    const readBack = await call('/cms/api/entitlements?where[key][equals]=sub:sub_synthetic00000002&limit=1&depth=0', { apiKey: service.apiKey, origin: null });
    expect(readBack.data.docs[0].record).toEqual(record);
    for (let i = 0; i < 50 && (await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000002' } }, overrideAccess: true })).totalDocs === 0; i += 1) await wait(50);
    const mirrored = (await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000002' } }, overrideAccess: true, depth: 0 })).docs[0];
    expect(mirrored).toMatchObject({ user: await buyerId(), offer: 'growth_monthly', status: 'active', cancelAtPeriodEnd: true, source: 'payments', lastEventId: 'evt_payments00000003', lastEventCreated: 2145917000 });
    const patched = await call(`/cms/api/entitlements/${created.data.doc.id}?depth=0`, { method: 'PATCH', apiKey: service.apiKey, origin: null, body: { ...document, status: 'canceled', updatedAtEpoch: 2145917100, record: { ...record, status: 'canceled', updated_at_epoch: 2145917100 } } });
    expect(patched.status).toBe(200);
    for (let i = 0; i < 50 && (await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000002' } }, overrideAccess: true })).docs[0].status !== 'canceled'; i += 1) await wait(50);
    expect((await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000002' } }, overrideAccess: true })).docs[0].status).toBe('canceled');
    const member = await call('/cms/api/entitlements', { token: await login('buyer@example.test', PASSWORD) });
    expect(member.status).toBe(403);
  });

  test('an entitlement write that would move a family epoch backwards is refused with 409, atomically with the write', async () => {
    const record = { key: 'sub:sub_synthetic00000004', kind: 'subscription', offer: 'growth_monthly', offer_known: true, customer: 'cus_synthetic00000001', status: 'active', livemode: false, updated_at_epoch: 2145918000, subscription_event_epoch: 2145918000, checkout_event_epoch: 2145917990, source_event: 'evt_payments00000010' };
    const document = (r: typeof record) => ({ key: r.key, kind: 'subscription', offer: r.offer, offerKnown: true, status: r.status, customer: r.customer, subscription: 'sub_synthetic00000004', livemode: false, updatedAtEpoch: r.updated_at_epoch, sourceEvent: r.source_event, source: 'payments', record: r });
    const created = await call('/cms/api/entitlements?depth=0', { method: 'POST', apiKey: service.apiKey, origin: null, body: document(record) });
    expect(created.status).toBe(201);
    const mirrored = () => payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000004' } }, overrideAccess: true, depth: 0 }).then((result) => result.docs[0]);
    expect(await mirrored()).toMatchObject({ status: 'active', lastSubscriptionEventCreated: 2145918000, lastCheckoutEventCreated: 2145917990 });
    // A replica that read the record before the epoch above was written must not win.
    const older = { ...record, status: 'canceled', subscription_event_epoch: 2145917900, updated_at_epoch: 2145917900, source_event: 'evt_payments00000011' };
    const rejected = await call(`/cms/api/entitlements/${created.data.doc.id}?depth=0`, { method: 'PATCH', apiKey: service.apiKey, origin: null, body: document(older) });
    expect(rejected.status).toBe(409);
    const { subscription_event_epoch: _dropped, ...withoutFamily } = record;
    const dropped = await call(`/cms/api/entitlements/${created.data.doc.id}?depth=0`, { method: 'PATCH', apiKey: service.apiKey, origin: null, body: document({ ...withoutFamily, status: 'canceled' } as typeof record) });
    expect(dropped.status).toBe(409);
    const stored = await call('/cms/api/entitlements?where[key][equals]=sub:sub_synthetic00000004&limit=1&depth=0', { apiKey: service.apiKey, origin: null });
    expect(stored.data.docs[0].record).toEqual(record);
    expect((await mirrored()).status).toBe('active');
    // Equal or newer epochs are accepted (and mirrored).
    const newer = { ...record, status: 'canceled', subscription_event_epoch: 2145918100, updated_at_epoch: 2145918100, source_event: 'evt_payments00000012' };
    const accepted = await call(`/cms/api/entitlements/${created.data.doc.id}?depth=0`, { method: 'PATCH', apiKey: service.apiKey, origin: null, body: document(newer) });
    expect(accepted.status).toBe(200);
    expect(await mirrored()).toMatchObject({ status: 'canceled', lastSubscriptionEventCreated: 2145918100 });
    const same = await call(`/cms/api/entitlements/${created.data.doc.id}?depth=0`, { method: 'PATCH', apiKey: service.apiKey, origin: null, body: document(newer) });
    expect(same.status).toBe(200);
    // The store record is the payments service's already-ordered view, so a same-epoch change to it is mirrored rather than refused.
    const sameEpochChange = await call(`/cms/api/entitlements/${created.data.doc.id}?depth=0`, { method: 'PATCH', apiKey: service.apiKey, origin: null, body: document({ ...newer, status: 'past_due', source_event: 'evt_payments00000013' }) });
    expect(sameEpochChange.status).toBe(200);
    expect(await mirrored()).toMatchObject({ status: 'past_due', lastSubscriptionEventCreated: 2145918100 });
  });
});

describe('managed API keys', () => {
  test('members with an active entitlement mint keys that the gateway export validates against its schema', async () => {
    const token = await login('buyer@example.test', PASSWORD);
    const created = await call('/cms/api/account/api-keys', { method: 'POST', token, body: { label: 'CI robot' } });
    expect(created.status).toBe(201);
    const raw = created.data.key as string;
    expect(raw).toMatch(/^weh_live_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(created.data.record).toMatchObject({ label: 'CI robot', state: 'active', livemode: false, permissions: ['manifest', 'records'], quota: { rate: 2, burst: 20 } });
    expect(JSON.stringify(created.data.record)).not.toContain('verifier');
    const second = await call('/cms/api/account/api-keys', { method: 'POST', token, body: {} });
    expect(second.status).toBe(201);
    const third = await call('/cms/api/account/api-keys', { method: 'POST', token, body: {} });
    expect(third.status).toBe(409);
    expect(third.data.error.code).toBe('key_limit');
    const me = await call('/cms/api/account/me', { token });
    expect(me.data.api_keys).toHaveLength(2);
    expect(JSON.stringify(me.data)).not.toContain('verifier');
    const revoked = await call(`/cms/api/account/api-keys/${created.data.record.id}`, { method: 'DELETE', token });
    expect(revoked.status).toBe(200);
    expect(revoked.data.record.state).toBe('revoked');
    expect(revoked.data.record.revoked_at).toBeTruthy();
    const memberRead = await call('/cms/api/api-keys', { token });
    expect(memberRead.status).toBe(200);
    expect(memberRead.data.docs.every((doc: Record<string, unknown>) => !('verifier' in doc))).toBe(true);

    const exported = await call('/cms/api/gateway/keys', { apiKey: 'service-api-key-synthetic-0002', origin: null });
    expect(exported.status).toBe(200);
    expect((await call('/cms/api/gateway/keys', { apiKey: 'service-api-key-synthetic-0001', origin: null })).status).toBe(403); // the payments-store credential never exports verifiers
    expect(exported.data.schema).toBe('gateway-key-records/v1');
    expect(exported.data.mode).toBe('production');
    expect(exported.data.includes_test_mode_keys).toBe(true); // this CMS runs with a Stripe test key
    const testKey = { livemode: false }, liveKey = { livemode: true };
    expect(exportableKeys([testKey, liveKey], 'test')).toEqual([testKey, liveKey]);
    expect(exportableKeys([testKey, liveKey], 'live')).toEqual([liveKey]);
    expect(exportableKeys([testKey, liveKey], 'disabled')).toEqual([liveKey]);
    const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../gateway/contracts/v1/key-record.schema.json'), 'utf8'));
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    for (const record of exported.data.keys) expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    const mine = exported.data.keys.find((record: { id: string }) => record.id === created.data.record.id);
    expect(mine.state).toBe('revoked');
    expect(mine.verifier).toBe(createHmac('sha256', process.env.GATEWAY_KEY_PEPPER as string).update(raw).digest('base64url'));
    expect(toGatewayRecord({ keyId: 'abcdefabcdef', verifier: mine.verifier, state: 'active', expiresAt: '2000-01-01T00:00:00.000Z', permissions: ['manifest'], quotaRate: 1, quotaBurst: 1 }).state).toBe('expired');
    const stillActive = second.data.record.id as string;
    expect(exported.data.keys.find((record: { id: string }) => record.id === stillActive).state).toBe('active');
    // Losing every entitlement suspends the export; recovering one restores the key.
    // (The buyer also holds sub_synthetic00000003 from the ordering test above.)
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.deleted', subscription('sub_synthetic00000001', { status: 'canceled' }), { created: 2145917200 }) as never)).toBe('processed');
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.deleted', subscription('sub_synthetic00000003', { status: 'canceled' }), { created: 2145917200 }) as never)).toBe('processed');
    const suspended = await call('/cms/api/gateway/keys', { apiKey: 'service-api-key-synthetic-0002', origin: null });
    expect(suspended.data.keys.find((record: { id: string }) => record.id === stillActive).state).toBe('revoked');
    expect((await payload.find({ collection: 'api-keys', where: { keyId: { equals: stillActive } }, overrideAccess: true })).docs[0].state).toBe('active'); // stored record untouched
    // The keys were granted by sub_synthetic00000003 (the newest active subscription at mint time), so recovering a
    // different subscription on the same account does not restore them; recovering the granting one does.
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.updated', subscription('sub_synthetic00000001', { status: 'active' }), { created: 2145917300 }) as never)).toBe('processed');
    const otherSubscription = await call('/cms/api/gateway/keys', { apiKey: 'service-api-key-synthetic-0002', origin: null });
    expect(otherSubscription.data.keys.find((record: { id: string }) => record.id === stillActive).state).toBe('revoked');
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.updated', subscription('sub_synthetic00000003', { status: 'active' }), { created: 2145917300 }) as never)).toBe('processed');
    const restored = await call('/cms/api/gateway/keys', { apiKey: 'service-api-key-synthetic-0002', origin: null });
    expect(restored.data.keys.find((record: { id: string }) => record.id === stillActive).state).toBe('active');
    // Keys without a granting subscription (admin-created) fall back to the account's entitlement in their billing mode.
    const accountOnly = { entitled: new Set(['live:7']), subscriptions: new Map(), plans: new Map() };
    expect(withEntitlement([{ state: 'active', livemode: false, user: 7 }, { state: 'revoked', livemode: false, user: 7 }, { state: 'active', livemode: true, user: 7 }], accountOnly).map((k) => k.state)).toEqual(['revoked', 'revoked', 'active']);
    // An account-minted key whose granting subscription is gone never falls back to the account.
    expect(withEntitlement([{ state: 'active', livemode: true, user: 7, issuedBy: 'account', subscription: null }, { state: 'active', livemode: true, user: 7, issuedBy: 'admin', subscription: null }], accountOnly).map((k) => k.state)).toEqual(['revoked', 'active']);
    // Keys bound to a subscription follow that subscription and the plan currently attached to it, never the account.
    const bound = {
      entitled: new Set(['test:7']),
      subscriptions: new Map<string, Record<string, unknown>>([['9', { id: 9, status: 'active', livemode: false, plan: 3 }], ['10', { id: 10, status: 'canceled', livemode: false, plan: 3 }], ['12', { id: 12, status: 'trialing', livemode: false, plan: 99 }]]),
      plans: new Map<string, Record<string, unknown>>([['3', { id: 3, gateway: { permissions: ['manifest'], quotaRate: 5, quotaBurst: 50 } }]]),
    };
    expect(withEntitlement([
      { state: 'active', livemode: false, user: 7, subscription: 9, permissions: ['manifest', 'records'], quotaRate: 1, quotaBurst: 10 },
      { state: 'active', livemode: false, user: 7, subscription: 10 }, // granting subscription canceled: revoked although the account still has test:7
      { state: 'active', livemode: true, user: 7, subscription: 9 }, // billing mode of the key and its subscription must agree
      { state: 'active', livemode: false, user: 7, subscription: 11 }, // granting subscription deleted
      { state: 'active', livemode: false, user: 7, subscription: 12, permissions: ['records'], quotaRate: 2, quotaBurst: 20 }, // plan without a gateway policy keeps the stored one
      { state: 'revoked', livemode: false, user: 7, subscription: 9 },
    ], bound)).toMatchObject([
      { state: 'active', permissions: ['manifest'], quotaRate: 5, quotaBurst: 50 }, { state: 'revoked' }, { state: 'revoked' }, { state: 'revoked' }, { state: 'active', permissions: ['records'], quotaRate: 2, quotaBurst: 20 }, { state: 'revoked' },
    ]);
    const memberExport = await call('/cms/api/gateway/keys', { token });
    expect(memberExport.status).toBe(403);
    const anonymousExport = await call('/cms/api/gateway/keys');
    expect(anonymousExport.status).toBe(401);
    const synthetic = await call('/cms/api/gateway/keys?mode=synthetic', { apiKey: 'service-api-key-synthetic-0002', origin: null });
    expect(synthetic.status).toBe(400);
  });

  test('a key follows the subscription that granted it, not the account: cancelling that tier revokes the key while a cheaper plan stays active', async () => {
    await payload.create({ collection: 'plans', data: { offerId: 'pro_monthly', label: 'Pro — monthly', mode: 'subscription', stripePriceId: 'price_synthetic0002', quantity: 1, active: true, gateway: { permissions: ['manifest', 'records', 'resolver'], quotaRate: 10, quotaBurst: 100 } }, overrideAccess: true });
    const tiered = await createUser(payload, { email: 'tiered@example.test', password: PASSWORD });
    const priced = (id: string, price: string, extra: Record<string, unknown> = {}) => subscription(id, { customer: 'cus_synthetic00000010', metadata: { cms_user: String(tiered.id) }, items: { object: 'list', data: [{ id: 'si_synthetic0010', object: 'subscription_item', current_period_end: 2148595200, price: { id: price, object: 'price' } }] }, ...extra });
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.created', priced('sub_synthetic00000010', 'price_synthetic0001'), { created: 2145916800 }) as never)).toBe('processed'); // growth
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.created', priced('sub_synthetic00000011', 'price_synthetic0002'), { created: 2145916900 }) as never)).toBe('processed'); // pro, newest
    const token = await login('tiered@example.test', PASSWORD);
    const minted = await call('/cms/api/account/api-keys', { method: 'POST', token, body: { label: 'pro key' } });
    expect(minted.status).toBe(201);
    expect(minted.data.record).toMatchObject({ permissions: ['manifest', 'records', 'resolver'], quota: { rate: 10, burst: 100 } });
    const pro = (await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000011' } }, overrideAccess: true, depth: 0 })).docs[0];
    expect((await payload.find({ collection: 'api-keys', where: { keyId: { equals: minted.data.record.id } }, overrideAccess: true, depth: 0 })).docs[0].subscription).toBe(pro.id);
    const exportedKey = async () => (await call('/cms/api/gateway/keys', { apiKey: 'service-api-key-synthetic-0002', origin: null })).data.keys.find((record: { id: string }) => record.id === minted.data.record.id);
    expect(await exportedKey()).toMatchObject({ state: 'active', permissions: ['manifest', 'records', 'resolver'], quota: { rate: 10, burst: 100 } });
    // Cancelling the granting (pro) subscription revokes the key in the export even though the cheaper subscription keeps the account entitled.
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.deleted', priced('sub_synthetic00000011', 'price_synthetic0002', { status: 'canceled' }), { created: 2145917000 }) as never)).toBe('processed');
    expect((await call('/cms/api/account/me', { token })).data.entitlement).toEqual({ active: true, offer: 'growth_monthly' });
    expect((await exportedKey()).state).toBe('revoked');
    // Reactivating it restores the key; moving it to the cheaper plan moves the key's policy with it.
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.updated', priced('sub_synthetic00000011', 'price_synthetic0001'), { created: 2145917100 }) as never)).toBe('processed');
    expect(await exportedKey()).toMatchObject({ state: 'active', permissions: ['manifest', 'records'], quota: { rate: 2, burst: 20 } });
    expect((await payload.find({ collection: 'api-keys', where: { keyId: { equals: minted.data.record.id } }, overrideAccess: true, depth: 0 })).docs[0]).toMatchObject({ state: 'active', issuedBy: 'account', quotaRate: 10, quotaBurst: 100 }); // stored record untouched
    // Deleting the granting subscription itself revokes the keys it granted, in the same operation.
    const deleted = await call(`/cms/api/subscriptions/${pro.id}`, { method: 'DELETE', token: await login('admin@example.test', PASSWORD) });
    expect(deleted.status).toBe(200);
    expect((await payload.find({ collection: 'api-keys', where: { keyId: { equals: minted.data.record.id } }, overrideAccess: true, depth: 0 })).docs[0]).toMatchObject({ state: 'revoked', subscription: null });
    expect((await exportedKey()).state).toBe('revoked');
    expect((await call('/cms/api/account/me', { token })).data.entitlement).toEqual({ active: true, offer: 'growth_monthly' }); // the account itself stays entitled through the cheaper plan
  });

  test('deleting an account deletes its managed keys in the same operation', async () => {
    const leaver = await createUser(payload, { email: 'leaver@example.test', password: PASSWORD });
    const entitled = stripeEvent('customer.subscription.created', subscription('sub_synthetic00000008', { customer: 'cus_synthetic00000008', metadata: { cms_user: String(leaver.id), offer: 'growth_monthly' } }), { created: 2145916800 });
    expect(await handleStripeEvent(payload, entitled as never)).toBe('processed');
    const minted = await call('/cms/api/account/api-keys', { method: 'POST', token: await login('leaver@example.test', PASSWORD), body: { label: 'leaving soon' } });
    expect(minted.status).toBe(201);
    expect((await payload.count({ collection: 'api-keys', where: { user: { equals: leaver.id } }, overrideAccess: true })).totalDocs).toBe(1);
    const deleted = await call(`/cms/api/users/${leaver.id}`, { method: 'DELETE', token: await login('admin@example.test', PASSWORD) });
    expect(deleted.status).toBe(200);
    expect((await payload.count({ collection: 'users', where: { email: { equals: 'leaver@example.test' } }, overrideAccess: true })).totalDocs).toBe(0);
    expect((await payload.count({ collection: 'api-keys', where: { user: { equals: leaver.id } }, overrideAccess: true })).totalDocs).toBe(0);
    expect((await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000008' } }, overrideAccess: true, depth: 0 })).docs[0].user).toBeNull();
    const exported = await call('/cms/api/gateway/keys', { apiKey: 'service-api-key-synthetic-0002', origin: null });
    expect(exported.data.keys.some((record: { id: string }) => record.id === minted.data.record.id)).toBe(false);
  });

  test('the account page lists every active key, however many revoked ones came after them', async () => {
    const hoarder = await createUser(payload, { email: 'hoarder@example.test', password: PASSWORD });
    const keyDoc = (n: number, state: 'active' | 'revoked') => ({ keyId: `hoard${String(n).padStart(7, '0')}`, verifier: 'A'.repeat(43), user: hoarder.id, state, livemode: false, issuedBy: 'admin', permissions: ['manifest'], quotaRate: 1, quotaBurst: 10 });
    for (let n = 0; n < 3; n += 1) await payload.create({ collection: 'api-keys', data: keyDoc(n, 'active') as never, overrideAccess: true, depth: 0 });
    for (let n = 3; n < 60; n += 1) await payload.create({ collection: 'api-keys', data: keyDoc(n, 'revoked') as never, overrideAccess: true, depth: 0 });
    const me = await call('/cms/api/account/me', { token: await login('hoarder@example.test', PASSWORD) });
    const listed = me.data.api_keys as { id: string; state: string }[];
    expect(listed.filter((key) => key.state === 'active').map((key) => key.id).sort()).toEqual(['hoard0000000', 'hoard0000001', 'hoard0000002']);
    expect(listed.filter((key) => key.state === 'revoked')).toHaveLength(50);
    expect(listed).toHaveLength(53);
  });

  test('no entitlement, no key', async () => {
    await createUser(payload, { email: 'free@example.test', password: PASSWORD });
    const denied = await call('/cms/api/account/api-keys', { method: 'POST', token: await login('free@example.test', PASSWORD), body: {} });
    expect(denied.status).toBe(403);
    expect(denied.data.error.code).toBe('no_entitlement');
  });
});
