import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDLED_EVENT_TYPES, MAX_UPSERT_ATTEMPTS, PENDING_SUBSCRIPTION, dispatchEvent, stripeId } from '../src/events.mjs';
import { StoreConflictError, createMemoryStore, isStoreConflict, regressedFamily } from '../src/store.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/events/${name}.synthetic.json`, import.meta.url), 'utf8'));
const offers = { growth_monthly: { id: 'growth_monthly', price: 'price_synthetic0001', mode: 'subscription', quantity: 1 } };

test('stripeId accepts ids and expanded objects only', () => {
  assert.equal(stripeId('cus_synthetic00000001'), 'cus_synthetic00000001');
  assert.equal(stripeId({ id: 'sub_synthetic00000001', object: 'subscription' }), 'sub_synthetic00000001');
  for (const value of [null, undefined, 42, 'nope', 'cus_short', { id: 'x' }, ['cus_synthetic00000001']]) assert.equal(stripeId(value), null);
});

test('checkout completion records the session and seeds the subscription entitlement', async () => {
  const store = createMemoryStore();
  const summary = await dispatchEvent(load('checkout.session.completed'), { store, offers });
  assert.deepEqual(summary, { outcome: 'processed', keys: ['cs:cs_test_synthetic00000001', 'sub:sub_synthetic00000001'], offer: 'growth_monthly', offer_known: true });
  const session = await store.getEntitlement('cs:cs_test_synthetic00000001');
  assert.equal(session.kind, 'checkout_session');
  assert.equal(session.status, 'complete');
  assert.equal(session.payment_status, 'paid');
  assert.equal(session.customer, 'cus_synthetic00000001');
  assert.equal(session.livemode, false);
  assert.equal(session.source_event, 'evt_synthetic00000001');
  const subscription = await store.getEntitlement('sub:sub_synthetic00000001');
  assert.equal(subscription.status, PENDING_SUBSCRIPTION);
  assert.equal(subscription.offer, 'growth_monthly');
  assert.equal(subscription.checkout_session, 'cs_test_synthetic00000001');
  const serialized = JSON.stringify(store.listEntitlements());
  for (const forbidden of ['email', 'name', 'address', 'amount', 'card']) assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
});

test('unknown offers are flagged, not trusted', async () => {
  const store = createMemoryStore();
  const summary = await dispatchEvent(load('checkout.session.completed'), { store, offers: {} });
  assert.equal(summary.offer, 'growth_monthly');
  assert.equal(summary.offer_known, false);
  const event = load('checkout.session.completed');
  event.data.object.metadata = { offer: 'DROP TABLE' };
  event.id = 'evt_synthetic00000009';
  assert.equal((await dispatchEvent(event, { store, offers })).offer, null);
});

test('subscription lifecycle applies newest-wins ordering and invoice status', async () => {
  const store = createMemoryStore();
  await dispatchEvent(load('checkout.session.completed'), { store, offers });
  const updated = await dispatchEvent(load('customer.subscription.updated'), { store, offers });
  assert.equal(updated.outcome, 'processed');
  let record = await store.getEntitlement('sub:sub_synthetic00000001');
  assert.equal(record.status, 'active');
  assert.equal(record.current_period_end, 2148595200);
  const stale = load('customer.subscription.updated');
  stale.id = 'evt_synthetic00000010'; stale.created = 2145916700; stale.data.object.status = 'incomplete';
  assert.equal((await dispatchEvent(stale, { store, offers })).outcome, 'stale');
  // Ordering is per event family: a checkout event created later than a delayed
  // subscription event must not swallow the status that subscription event carries.
  const family = createMemoryStore();
  const lateCheckout = load('checkout.session.completed');
  lateCheckout.id = 'evt_synthetic00000020'; lateCheckout.created = 2145916900;
  assert.equal((await dispatchEvent(lateCheckout, { store: family, offers })).outcome, 'processed');
  const delayedActivation = load('customer.subscription.updated');
  delayedActivation.id = 'evt_synthetic00000021'; delayedActivation.created = 2145916850; delayedActivation.data.object.status = 'active';
  assert.equal((await dispatchEvent(delayedActivation, { store: family, offers })).outcome, 'processed');
  const seeded = await family.getEntitlement(`sub:${delayedActivation.data.object.id}`);
  assert.equal(seeded.status, 'active');
  assert.equal(seeded.subscription_event_epoch, 2145916850);
  assert.equal(seeded.checkout_event_epoch, 2145916900);
  assert.equal(seeded.updated_at_epoch, 2145916900, 'updated_at_epoch stays the newest event of any family');
  assert.equal((await store.getEntitlement('sub:sub_synthetic00000001')).status, 'active');
  const failed = await dispatchEvent(load('invoice.payment_failed'), { store, offers });
  assert.equal(failed.outcome, 'processed');
  record = await store.getEntitlement('sub:sub_synthetic00000001');
  assert.equal(record.last_invoice_status, 'payment_failed');
  assert.equal(record.last_invoice, 'in_synthetic00000001');
  assert.equal(record.status, 'active', 'invoice events do not invent a subscription status');
  const deleted = load('customer.subscription.updated');
  deleted.id = 'evt_synthetic00000011'; deleted.type = 'customer.subscription.deleted'; deleted.created = 2148595300; deleted.data.object.status = 'active';
  await dispatchEvent(deleted, { store, offers });
  assert.equal((await store.getEntitlement('sub:sub_synthetic00000001')).status, 'canceled');
  const legacy = load('invoice.payment_failed');
  legacy.id = 'evt_synthetic00000012'; legacy.type = 'invoice.paid'; legacy.created = 2148595400; delete legacy.data.object.parent; legacy.data.object.subscription = 'sub_synthetic00000001';
  assert.equal((await dispatchEvent(legacy, { store, offers })).outcome, 'processed');
  assert.equal((await store.getEntitlement('sub:sub_synthetic00000001')).last_invoice_status, 'paid');
});

test('a writer that read before a newer event was stored yields to it instead of overwriting', async () => {
  const base = createMemoryStore();
  let gate = null;
  const gated = { ...base, async getEntitlement(key) { const record = await base.getEntitlement(key); if (gate) { const wait = gate; gate = null; await wait; } return record; } };
  const older = load('customer.subscription.updated'); older.id = 'evt_synthetic00000030'; older.created = 2145916800; older.data.object.status = 'active';
  const newer = load('customer.subscription.updated'); newer.id = 'evt_synthetic00000031'; newer.created = 2145916900; newer.data.object.status = 'canceled';
  let release;
  gate = new Promise((ok) => { release = ok; });
  const slow = dispatchEvent(older, { store: gated, offers }); // reads "no record", then parks
  await new Promise((ok) => setTimeout(ok, 0));
  assert.equal((await dispatchEvent(newer, { store: base, offers })).outcome, 'processed');
  release();
  assert.equal((await slow).outcome, 'stale', 'the store refused the stale write and the re-read saw the newer event');
  const record = await base.getEntitlement(`sub:${older.data.object.id}`);
  assert.equal(record.status, 'canceled');
  assert.equal(record.subscription_event_epoch, 2145916900);
  assert.equal(record.source_event, 'evt_synthetic00000031');
  // The guard lives in the store, so no caller can bypass it.
  await assert.rejects(base.putEntitlement({ ...record, subscription_event_epoch: 2145916850 }), isStoreConflict);
  await assert.rejects(base.putEntitlement({ key: record.key, kind: 'subscription', status: 'active' }), (error) => isStoreConflict(error) && error.family === 'subscription', 'dropping a family epoch is a regression too');
  assert.equal(regressedFamily(record, record), null);
  assert.equal(regressedFamily(null, record), null);
  assert.equal(regressedFamily({ checkout_event_epoch: 5 }, { checkout_event_epoch: 5, subscription_event_epoch: 1 }), null, 'families the stored record never saw are free to appear');
  // A store that keeps conflicting is given up on after a bounded number of re-reads; the webhook then fails and Stripe retries.
  let attempts = 0;
  const hostile = { ...base, async putEntitlement(entry) { attempts += 1; throw new StoreConflictError(entry.key, 'subscription'); } };
  const another = load('customer.subscription.updated'); another.id = 'evt_synthetic00000032'; another.created = 2148595500;
  await assert.rejects(dispatchEvent(another, { store: hostile, offers }), isStoreConflict);
  assert.equal(attempts, MAX_UPSERT_ATTEMPTS);
});

test('same-second events are reconciled from Stripe\'s current object instead of delivery order', async () => {
  const store = createMemoryStore();
  const fetched = { calls: [], object: null };
  const fetchObject = async (kind, id) => { fetched.calls.push([kind, id]); return fetched.object; };
  const at = 2145917000;
  const lifecycle = (id, status) => { const event = load('customer.subscription.updated'); event.id = id; event.created = at; event.data.object.status = status; return event; };
  assert.equal((await dispatchEvent(lifecycle('evt_synthetic00000040', 'active'), { store, offers, fetchObject })).outcome, 'processed');
  assert.deepEqual(fetched.calls, [], 'the first write of a family needs no reconciliation');
  // Cancellation created in the same second, delivered second: the payload is not trusted for order; Stripe's current state is applied.
  fetched.object = { ...lifecycle('evt_x', 'canceled').data.object };
  assert.equal((await dispatchEvent(lifecycle('evt_synthetic00000041', 'canceled'), { store, offers, fetchObject })).outcome, 'processed');
  assert.equal((await store.getEntitlement('sub:sub_synthetic00000001')).status, 'canceled');
  assert.deepEqual(fetched.calls, [['subscription', 'sub_synthetic00000001']]);
  // A pre-cancellation "active" update from that same second delivered last cannot restore access.
  assert.equal((await dispatchEvent(lifecycle('evt_synthetic00000042', 'active'), { store, offers, fetchObject })).outcome, 'processed');
  assert.equal((await store.getEntitlement('sub:sub_synthetic00000001')).status, 'canceled');
  // Without a fetcher a tie is refused, and a fetched object for another id is ignored (both fail closed).
  assert.equal((await dispatchEvent(lifecycle('evt_synthetic00000043', 'active'), { store, offers })).outcome, 'stale');
  fetched.object = { ...fetched.object, id: 'sub_synthetic00000099' };
  assert.equal((await dispatchEvent(lifecycle('evt_synthetic00000044', 'active'), { store, offers, fetchObject })).outcome, 'stale');
  assert.equal((await store.getEntitlement('sub:sub_synthetic00000001')).status, 'canceled');
  // A fetch failure propagates so the webhook fails and Stripe retries.
  await assert.rejects(dispatchEvent(lifecycle('evt_synthetic00000045', 'active'), { store, offers, fetchObject: async () => { throw new Error('stripe unreachable'); } }), /stripe unreachable/);
  // Invoice ties take the fetched invoice's status; checkout ties take the fetched session.
  const invoice = load('invoice.payment_failed'); invoice.id = 'evt_synthetic00000046'; invoice.created = at + 1;
  assert.equal((await dispatchEvent(invoice, { store, offers, fetchObject })).outcome, 'processed');
  const paidLater = load('invoice.payment_failed'); paidLater.id = 'evt_synthetic00000047'; paidLater.created = at + 1; paidLater.type = 'invoice.paid';
  fetched.object = { ...paidLater.data.object, status: 'paid' };
  assert.equal((await dispatchEvent(paidLater, { store, offers, fetchObject })).outcome, 'processed');
  assert.equal((await store.getEntitlement('sub:sub_synthetic00000001')).last_invoice_status, 'paid');
  const checkout = load('checkout.session.completed'); checkout.id = 'evt_synthetic00000048'; checkout.created = at + 2;
  assert.equal((await dispatchEvent(checkout, { store, offers, fetchObject })).outcome, 'processed');
  const expired = load('checkout.session.completed'); expired.id = 'evt_synthetic00000049'; expired.created = at + 2; expired.type = 'checkout.session.expired'; expired.data.object.status = 'expired';
  fetched.object = { ...expired.data.object, status: 'complete' };
  assert.equal((await dispatchEvent(expired, { store, offers, fetchObject })).outcome, 'processed');
  assert.equal((await store.getEntitlement('cs:cs_test_synthetic00000001')).status, 'complete', 'the fetched session, not the tied payload, is stored');
});

test('unhandled, malformed, and unlinked events are ignored explicitly', async () => {
  const store = createMemoryStore();
  const other = load('checkout.session.completed'); other.type = 'charge.succeeded';
  assert.equal((await dispatchEvent(other, { store, offers })).reason, 'unhandled_type');
  const noId = load('checkout.session.completed'); delete noId.data.object.id;
  assert.equal((await dispatchEvent(noId, { store, offers })).reason, 'missing_id');
  const orphanInvoice = load('invoice.payment_failed'); delete orphanInvoice.data.object.parent;
  assert.equal((await dispatchEvent(orphanInvoice, { store, offers })).reason, 'no_subscription');
  const unknownCheckout = load('checkout.session.completed'); unknownCheckout.type = 'checkout.session.something_new';
  assert.equal((await dispatchEvent(unknownCheckout, { store, offers })).reason, 'unhandled_type');
  await assert.rejects(dispatchEvent({ type: 'x' }, { store, offers }), TypeError);
  assert.equal(store.listEntitlements().length, 0);
  assert.equal(HANDLED_EVENT_TYPES.length, 9);
});
