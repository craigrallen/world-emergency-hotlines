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
  stripe = await startMockStripe(12112);
  process.env.CMS_STRIPE_API_BASE = 'http://127.0.0.1:12112';
  payload = await getPayload({ config: configPromise });
  await createUser(payload, { email: 'admin@example.test', password: PASSWORD, role: 'admin' });
  await createUser(payload, { email: 'buyer@example.test', password: PASSWORD, name: 'Buyer' });
  const service = await createUser(payload, { email: 'service@example.test', password: PASSWORD, role: 'service', enableAPIKey: true, apiKey: 'service-api-key-synthetic-0001' });
  expect(service.role).toBe('service');
  await payload.create({ collection: 'plans', data: { offerId: 'growth_monthly', label: 'Growth — monthly', mode: 'subscription', stripePriceId: 'price_synthetic0001', quantity: 1, active: true, gateway: { permissions: ['manifest', 'records'], quotaRate: 2, quotaBurst: 20 } }, overrideAccess: true });
});
afterAll(async () => { await stripe.close(); await payload.db.destroy?.(); });

const buyerId = async () => (await payload.find({ collection: 'users', where: { email: { equals: 'buyer@example.test' } }, overrideAccess: true })).docs[0].id;

describe('Stripe webhooks through the plugin route', () => {
  test('rejects unsigned and mis-signed events', async () => {
    const event = stripeEvent('customer.subscription.created', subscription('sub_synthetic00000009'));
    const unsigned = await call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: JSON.stringify(event), origin: null });
    expect(unsigned.status).toBe(200); // plugin acknowledges but ignores events without a signature header
    expect((await payload.count({ collection: 'stripe-events', overrideAccess: true })).totalDocs).toBe(0);
    const forged = signEvent(event, `whsec_${'z'.repeat(32)}`);
    const bad = await call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: forged.body, headers: { 'stripe-signature': forged.signature }, origin: null });
    expect(bad.status).toBe(400);
    await wait(50);
    expect((await payload.count({ collection: 'stripe-events', overrideAccess: true })).totalDocs).toBe(0);
  });

  test('checkout completion links the customer and subscription to the account by client_reference_id', async () => {
    const user = await buyerId();
    const event = stripeEvent('checkout.session.completed', { id: 'cs_test_synthetic00000001', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_synthetic00000001', subscription: 'sub_synthetic00000001', client_reference_id: String(user), metadata: { offer: 'growth_monthly', cms_user: String(user) } });
    const signed = signEvent(event);
    const result = await call('/cms/api/stripe/webhooks', { method: 'POST', rawBody: signed.body, headers: { 'stripe-signature': signed.signature }, origin: null });
    expect(result.status).toBe(200);
    for (let i = 0; i < 50 && (await payload.count({ collection: 'subscriptions', overrideAccess: true })).totalDocs === 0; i += 1) await wait(50);
    const sub = (await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: 'sub_synthetic00000001' } }, overrideAccess: true, depth: 0 })).docs[0];
    expect(sub).toMatchObject({ user, stripeCustomerId: 'cus_synthetic00000001', offer: 'growth_monthly', status: 'pending_subscription_event', checkoutSessionId: 'cs_test_synthetic00000001', source: 'cms', livemode: false });
    const buyer = await payload.findByID({ collection: 'users', id: user, overrideAccess: true });
    expect(buyer.stripeCustomerId).toBe('cus_synthetic00000001');
    const ledger = await payload.find({ collection: 'stripe-events', where: { eventId: { equals: event.id } }, overrideAccess: true });
    expect(ledger.docs[0]).toMatchObject({ type: 'checkout.session.completed', source: 'cms', outcome: 'processed' });
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
  test('claims events first-writer-wins through the unique index and releases them', async () => {
    const first = await call('/cms/api/stripe-events', { method: 'POST', apiKey: service.apiKey, origin: null, body: { eventId: 'evt_payments00000001', source: 'payments' } });
    expect(first.status).toBe(201);
    const duplicate = await call('/cms/api/stripe-events', { method: 'POST', apiKey: service.apiKey, origin: null, body: { eventId: 'evt_payments00000001', source: 'payments' } });
    expect(duplicate.status).toBe(400);
    const lookup = await call('/cms/api/stripe-events?where[eventId][equals]=evt_payments00000001&limit=1&depth=0', { apiKey: service.apiKey, origin: null });
    expect(lookup.data.totalDocs).toBe(1);
    const released = await call('/cms/api/stripe-events?where[eventId][equals]=evt_payments00000001', { method: 'DELETE', apiKey: service.apiKey, origin: null });
    expect(released.status).toBe(200);
    expect((await call('/cms/api/stripe-events?where[eventId][equals]=evt_payments00000001', { apiKey: service.apiKey, origin: null })).data.totalDocs).toBe(0);
    const anonymous = await call('/cms/api/stripe-events', { method: 'POST', body: { eventId: 'evt_payments00000002', source: 'payments' } });
    expect(anonymous.status).toBe(403);
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

    const exported = await call('/cms/api/gateway/keys', { apiKey: 'service-api-key-synthetic-0001', origin: null });
    expect(exported.status).toBe(200);
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
    const suspended = await call('/cms/api/gateway/keys', { apiKey: 'service-api-key-synthetic-0001', origin: null });
    expect(suspended.data.keys.find((record: { id: string }) => record.id === stillActive).state).toBe('revoked');
    expect((await payload.find({ collection: 'api-keys', where: { keyId: { equals: stillActive } }, overrideAccess: true })).docs[0].state).toBe('active'); // stored record untouched
    expect(await handleStripeEvent(payload, stripeEvent('customer.subscription.updated', subscription('sub_synthetic00000001', { status: 'active' }), { created: 2145917300 }) as never)).toBe('processed');
    const restored = await call('/cms/api/gateway/keys', { apiKey: 'service-api-key-synthetic-0001', origin: null });
    expect(restored.data.keys.find((record: { id: string }) => record.id === stillActive).state).toBe('active');
    expect(withEntitlement([{ state: 'active', livemode: false, user: 7 }, { state: 'revoked', livemode: false, user: 7 }, { state: 'active', livemode: true, user: 7 }], new Set(['live:7'])).map((k) => k.state)).toEqual(['revoked', 'revoked', 'active']);
    const memberExport = await call('/cms/api/gateway/keys', { token });
    expect(memberExport.status).toBe(403);
    const anonymousExport = await call('/cms/api/gateway/keys');
    expect(anonymousExport.status).toBe(401);
    const synthetic = await call('/cms/api/gateway/keys?mode=synthetic', { apiKey: 'service-api-key-synthetic-0001', origin: null });
    expect(synthetic.status).toBe(400);
  });

  test('no entitlement, no key', async () => {
    await createUser(payload, { email: 'free@example.test', password: PASSWORD });
    const denied = await call('/cms/api/account/api-keys', { method: 'POST', token: await login('free@example.test', PASSWORD), body: {} });
    expect(denied.status).toBe(403);
    expect(denied.data.error.code).toBe('no_entitlement');
  });
});
