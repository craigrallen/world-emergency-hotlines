import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, describeConfig, redact, ConfigError } from '../src/config.mjs';
import { CmsStoreError, claimKeyFor, createCmsStore, toEntitlementDocument, validCmsUrl } from '../src/cms-store.mjs';
import { CLAIM_GRACE_SECONDS, STORE_CONFLICT, isStoreConflict, regressedFamily, revisionMismatch, revisionOf, validateStore } from '../src/store.mjs';
import { dispatchEvent } from '../src/events.mjs';
import { createPaymentsServer, ROUTES } from '../src/server.mjs';

const URL_ = 'http://cms.railway.internal:3000/cms/api';
const API_KEY = 'service-api-key-synthetic-0001';

/** In-memory fake of the two Payload collections the store touches. */
function fakeCms({ failWith = null, unauthorized = false, clock = { now: Date.now() } } = {}) {
  const events = new Map(), entitlements = new Map();
  const calls = [];
  let nextId = 1;
  const stamp = () => new Date(clock.now).toISOString();
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ method: init.method, path: url.pathname + url.search, authorization: init.headers.authorization });
    if (unauthorized) return json(401, { errors: [{ message: 'Unauthorized' }] });
    if (failWith) return json(failWith, { errors: [{ message: 'boom' }] });
    if (init.headers.authorization !== `users API-Key ${API_KEY}`) return json(401, { errors: [{ message: 'Unauthorized' }] });
    const [, collection, id] = url.pathname.replace('/cms/api', '').split('/');
    const eq = /^where\[(\w+)\]\[equals\]$/;
    const filter = [...url.searchParams.entries()].map(([k, v]) => [eq.exec(k)?.[1], v]).find(([k]) => k);
    const table = collection === 'stripe-events' ? events : collection === 'entitlements' ? entitlements : null;
    if (!table) return json(404, { errors: [{ message: 'Not Found' }] });
    if (init.method === 'GET') {
      const docs = [...table.values()].filter((doc) => !filter || doc[filter[0]] === filter[1]);
      return json(200, { docs, totalDocs: docs.length });
    }
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      // Like the CMS hook, the claim key is derived from consumer + event, never taken from the client.
      const incoming = collection === 'stripe-events' ? { ...body, claimKey: `${body.source ?? 'payments'}:${body.eventId}` } : body;
      const unique = collection === 'stripe-events' ? 'claimKey' : 'key';
      if ([...table.values()].some((doc) => doc[unique] === incoming[unique])) return json(400, { errors: [{ message: `The following field is invalid: ${unique}`, data: { errors: [{ field: unique, message: 'Value must be unique' }] } }] });
      const doc = { id: nextId++, ...incoming, updatedAt: stamp(), createdAt: stamp() };
      if (collection === 'entitlements' && doc.record) { const { based_on_revision: _read, ...rest } = doc.record; doc.record = { ...rest, revision: 1 }; }
      table.set(doc.id, doc);
      return json(201, { doc, message: 'created' });
    }
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      let targets;
      if (id) {
        const doc = table.get(Number(id));
        if (!doc) return json(404, { errors: [{ message: 'Not Found' }] });
        targets = [doc];
      } else {
        // Bulk update by `where`, as Payload's REST API does: equals / exists / less_than.
        const conditions = [...url.searchParams.entries()].map(([k, v]) => [/^where\[(\w+)\]\[(\w+)\]$/.exec(k), v]).filter(([m]) => m).map(([m, v]) => [m[1], m[2], v]);
        targets = [...table.values()].filter((doc) => conditions.every(([field, op, value]) => (op === 'equals' ? doc[field] === value : op === 'exists' ? (doc[field] !== undefined && doc[field] !== null) === (value === 'true') : op === 'less_than' ? typeof doc[field] === 'string' && doc[field] < value : false)));
      }
      for (const doc of targets) {
        // The CMS refuses, under its row lock, a record that moves any family epoch backwards or was built from a stale revision, and stamps the next revision.
        if (collection === 'entitlements' && body.record !== undefined) {
          const family = regressedFamily(doc.record, body.record);
          if (family) return json(409, { errors: [{ message: `entitlement already carries a newer ${family} event` }] });
          if (revisionMismatch(doc.record, body.record)) return json(409, { errors: [{ message: 'entitlement changed since it was read' }] });
          const { based_on_revision: _read, ...rest } = body.record;
          body.record = { ...rest, revision: revisionOf(doc.record) + 1 };
        }
        Object.assign(doc, body, { updatedAt: stamp() });
      }
      return id ? json(200, { doc: targets[0], message: 'updated' }) : json(200, { docs: targets, errors: [] });
    }
    if (init.method === 'DELETE') {
      // Bulk delete by `where`, as Payload's REST API does: every condition must hold (equals here).
      const conditions = [...url.searchParams.entries()].map(([k, v]) => [/^where\[(\w+)\]\[(\w+)\]$/.exec(k), v]).filter(([m]) => m).map(([m, v]) => [m[1], m[2], v]);
      const removed = conditions.length === 0 ? [] : [...table.values()].filter((doc) => conditions.every(([field, op, value]) => op === 'equals' && doc[field] === value));
      for (const doc of removed) table.delete(doc.id);
      return json(200, { docs: removed, errors: [] });
    }
    return json(405, { errors: [{ message: 'Method not allowed' }] });
  };
  return { fetchImpl, events, entitlements, calls };
}

test('CMS URL validation admits https and private/loopback http only', () => {
  for (const ok of ['https://cms.example.org/cms/api', 'http://localhost:3000/cms/api', 'http://127.0.0.1:3000/cms/api', 'http://cms.railway.internal:3000/cms/api', 'http://cms.local/cms/api', 'http://cms:3000/cms/api', 'https://worldhotlines.org']) assert.equal(validCmsUrl(ok), true, ok);
  for (const bad of ['http://cms.example.org/cms/api', 'http://10.0.0.5:3000/cms/api', 'http://[fe80::1]:3000/cms/api', 'https://cms.example.org/cms/api/', 'https://user:pw@cms.example.org/cms/api', 'https://cms.example.org/cms/api?x=1', 'https://cms.example.org/#a', 'ftp://cms.internal', 'https://cms.example.org/../x', '', 42, 'https://cms example.org']) assert.equal(validCmsUrl(bad), false, String(bad));
});

test('store construction is closed and the API key never leaks into errors', () => {
  assert.throws(() => createCmsStore({ url: 'http://public.example.org/cms/api', apiKey: API_KEY }), /valid CMS API URL/);
  assert.throws(() => createCmsStore({ url: URL_, apiKey: 'short' }), /API key/);
  assert.throws(() => createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: 'nope' }), /fetch/);
  assert.throws(() => createCmsStore({ url: URL_, apiKey: API_KEY, timeoutMs: 1 }), /timeout/);
  assert.throws(() => createCmsStore({ url: URL_, apiKey: API_KEY, usersCollection: 'Users!' }), /slug/);
  const store = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: async () => new Response('x', { status: 500 }) });
  assert.equal(validateStore(store), true);
  assert.equal(store.kind, 'cms');
  assert.equal(JSON.stringify(Object.getOwnPropertyDescriptors(store)).includes(API_KEY), false);
});

const L1 = 'lease-worker-0001', L2 = 'lease-worker-0002';

test('claimEvent is first-writer-wins per consumer, completion makes a claim a duplicate, and releaseEvent frees the id', async () => {
  const cms = fakeCms();
  const store = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: cms.fetchImpl });
  assert.equal(await store.claimEvent('evt_synthetic0001', L1), 'claimed');
  assert.equal(await store.claimEvent('evt_synthetic0001', L2), 'in_progress', 'an incomplete claim is still being applied by its owner');
  assert.equal(await store.completeEvent('evt_synthetic0001', L2), false, 'only the lease holder completes a claim');
  assert.equal(await store.completeEvent('evt_synthetic0001', L1), true);
  assert.equal(await store.claimEvent('evt_synthetic0001', L2), 'duplicate');
  assert.equal(cms.events.size, 1);
  assert.equal([...cms.events.values()][0].source, 'payments');
  assert.equal([...cms.events.values()][0].claimKey, claimKeyFor('evt_synthetic0001'));
  assert.equal([...cms.events.values()][0].lease, L1);
  assert.equal([...cms.events.values()][0].outcome, 'processed');
  // The CMS webhook's own claim on the same event never counts as this consumer's.
  cms.events.set(99, { id: 99, eventId: 'evt_synthetic0002', source: 'cms', claimKey: 'cms:evt_synthetic0002', outcome: 'processed' });
  assert.equal(await store.claimEvent('evt_synthetic0002', L1), 'claimed');
  assert.equal(cms.events.size, 3);
  assert.equal(await store.releaseEvent('evt_synthetic0001', L2), false, 'only the lease holder releases a claim');
  assert.equal(cms.events.size, 3);
  assert.equal(await store.releaseEvent('evt_synthetic0001', L1), true);
  assert.equal(cms.events.size, 2, 'release removes only this consumer\'s claim');
  assert.equal(await store.claimEvent('evt_synthetic0001', L1), 'claimed');
  await assert.rejects(store.claimEvent('not-an-event', L1), TypeError);
  await assert.rejects(store.claimEvent('evt_synthetic0001'), TypeError, 'a lease is required');
  await assert.rejects(store.releaseEvent('', L1), TypeError);
  await assert.rejects(store.completeEvent('', L1), TypeError);
  await assert.rejects(store.completeEvent('evt_synthetic0001', 'short'), TypeError);
  assert.equal(await store.completeEvent('evt_synthetic0009', L1), false, 'a claim this worker does not hold is not completed');
  assert.ok(cms.calls.every((call) => call.authorization === `users API-Key ${API_KEY}`));
});

test('an incomplete claim abandoned by a dead worker is taken over after the grace period, so it never becomes a permanent duplicate', async () => {
  const clock = { now: 1_700_000_000_000 };
  const cms = fakeCms({ clock });
  const store = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: cms.fetchImpl, now: () => clock.now });
  assert.equal(await store.claimEvent('evt_synthetic0005', L1), 'claimed');
  clock.now += 1000;
  assert.equal(await store.claimEvent('evt_synthetic0005', L2), 'in_progress');
  clock.now += CLAIM_GRACE_SECONDS * 1000;
  assert.equal(await store.claimEvent('evt_synthetic0005', L2), 'claimed', 'taken over: the worker never completed or released it');
  assert.equal([...cms.events.values()][0].lease, L2, 'the claim now carries the taker\'s lease');
  assert.equal(await store.claimEvent('evt_synthetic0005', L1), 'in_progress', 'the take-over refreshed the claim, so a second taker backs off');
  // The original worker resurfaces after its take-over: it can neither release nor complete the successor's claim.
  assert.equal(await store.releaseEvent('evt_synthetic0005', L1), false);
  assert.equal(await store.completeEvent('evt_synthetic0005', L1), false);
  assert.equal(cms.events.size, 1);
  assert.equal([...cms.events.values()][0].outcome ?? null, null);
  assert.equal(await store.completeEvent('evt_synthetic0005', L2), true);
  clock.now += CLAIM_GRACE_SECONDS * 1000 + 1;
  assert.equal(await store.claimEvent('evt_synthetic0005', L1), 'duplicate', 'completed claims never expire');
  assert.equal(cms.events.size, 1);
  assert.throws(() => createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: cms.fetchImpl, now: 'nope' }), /clock/);
  assert.throws(() => createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: cms.fetchImpl, claimGraceSeconds: 0 }), /grace/);
});

test('entitlements round-trip through structured columns and the raw record', async () => {
  const cms = fakeCms();
  const store = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: cms.fetchImpl });
  assert.equal(await store.getEntitlement('sub:sub_synthetic0001'), null);
  const record = { key: 'sub:sub_synthetic0001', kind: 'subscription', offer: 'growth_monthly', offer_known: true, customer: 'cus_synthetic0001', status: 'active', livemode: false, updated_at_epoch: 2145916800, updated_at: '2038-01-01T00:00:00.000Z', source_event: 'evt_synthetic0001', cancel_at_period_end: false, current_period_end: 2148595200 };
  const stored = await store.putEntitlement(record);
  assert.ok(Object.isFrozen(stored));
  assert.deepEqual(await store.getEntitlement('sub:sub_synthetic0001'), { ...record, revision: 1 });
  await assert.rejects(store.putEntitlement({ ...record, status: 'canceled', based_on_revision: 0 }), (error) => isStoreConflict(error) && error.reason === 'conflict', 'a write built from a stale read is refused');
  assert.equal((await store.getEntitlement('sub:sub_synthetic0001')).status, 'active');
  const doc = [...cms.entitlements.values()][0];
  assert.equal(doc.kind, 'subscription');
  assert.equal(doc.subscription, 'sub_synthetic0001');
  assert.equal(doc.customer, 'cus_synthetic0001');
  assert.equal(doc.status, 'active');
  assert.equal(doc.offerKnown, true);
  assert.equal(doc.updatedAtEpoch, 2145916800);
  assert.equal(doc.source, 'payments');
  await store.putEntitlement({ ...record, status: 'canceled', updated_at_epoch: 2145916900, based_on_revision: 1 });
  assert.equal(cms.entitlements.size, 1, 'updates patch the existing document');
  assert.deepEqual([(await store.getEntitlement('sub:sub_synthetic0001')).status, (await store.getEntitlement('sub:sub_synthetic0001')).revision], ['canceled', 2]);
  await assert.rejects(store.putEntitlement({ key: 'bogus' }), TypeError);
  await assert.rejects(store.getEntitlement('sub:'), TypeError);
  const session = toEntitlementDocument({ key: 'cs:cs_test_synthetic00000001', kind: 'checkout_session', status: 'complete', offer: null, customer: null, subscription: 'sub_synthetic0001', payment_intent: null });
  assert.equal(session.checkoutSession, 'cs_test_synthetic00000001');
  assert.equal(session.subscription, 'sub_synthetic0001');
  assert.equal(session.offer, null);
  assert.equal(session.kind, 'checkout_session');
});

test('a lost create race falls back to updating the winner', async () => {
  const cms = fakeCms();
  let lookups = 0;
  const racing = async (input, init) => {
    const url = new URL(input);
    if (init.method === 'GET' && url.pathname.endsWith('/entitlements') && lookups++ === 0) {
      return new Response(JSON.stringify({ docs: [], totalDocs: 0 }), { status: 200 });
    }
    return cms.fetchImpl(input, init);
  };
  const store = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: racing });
  await store.putEntitlement({ key: 'sub:sub_synthetic0002', kind: 'subscription', status: 'active' });
  // Simulate another replica having inserted first: the fake now has the row, and
  // our next put sees an empty first lookup (stale read) followed by the 400.
  lookups = 0;
  await store.putEntitlement({ key: 'sub:sub_synthetic0002', kind: 'subscription', status: 'past_due' });
  assert.equal(cms.entitlements.size, 1);
  assert.equal([...cms.entitlements.values()][0].status, 'past_due');
});

test('a stale entitlement write is refused as a conflict and the dispatcher re-reads instead of overwriting', async () => {
  const cms = fakeCms();
  const store = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: cms.fetchImpl });
  await store.putEntitlement({ key: 'sub:sub_synthetic0003', kind: 'subscription', status: 'canceled', subscription_event_epoch: 2145916900, updated_at_epoch: 2145916900 });
  await assert.rejects(
    store.putEntitlement({ key: 'sub:sub_synthetic0003', kind: 'subscription', status: 'active', subscription_event_epoch: 2145916800, updated_at_epoch: 2145916800 }),
    (error) => error instanceof CmsStoreError && error.reason === 'conflict' && error.status === 409 && error.code === STORE_CONFLICT && isStoreConflict(error),
  );
  assert.equal((await store.getEntitlement('sub:sub_synthetic0003')).status, 'canceled');
  // Two replicas: the older event reads before the newer one writes, then loses the
  // write (409) and, on re-read, recognises the newer state as authoritative.
  let gate = null;
  const gated = async (input, init) => {
    const response = await cms.fetchImpl(input, init);
    if (init.method === 'GET' && gate) { const wait = gate; gate = null; await wait; }
    return response;
  };
  const racing = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: gated });
  const object = { id: 'sub_synthetic0004', object: 'subscription', status: 'active', customer: 'cus_synthetic0004', metadata: { offer: 'growth_monthly' }, cancel_at_period_end: false, current_period_end: 2148595200 };
  const older = { id: 'evt_synthetic0030', object: 'event', type: 'customer.subscription.updated', livemode: false, created: 2145916800, data: { object } };
  const newer = { ...older, id: 'evt_synthetic0031', created: 2145916900, data: { object: { ...object, status: 'canceled' } } };
  let release;
  gate = new Promise((ok) => { release = ok; });
  const slow = dispatchEvent(older, { store: racing, offers: {} });
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal((await dispatchEvent(newer, { store, offers: {} })).outcome, 'processed');
  release();
  assert.equal((await slow).outcome, 'stale');
  const final = await store.getEntitlement('sub:sub_synthetic0004');
  assert.equal(final.status, 'canceled');
  assert.equal(final.subscription_event_epoch, 2145916900);
  assert.equal(final.source_event, 'evt_synthetic0031');
  assert.equal(cms.entitlements.size, 2);
});

test('CMS failures surface as CmsStoreError and never as silent duplicates', async () => {
  const down = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: fakeCms({ failWith: 503 }).fetchImpl });
  await assert.rejects(down.claimEvent('evt_synthetic0001', L1), (error) => error instanceof CmsStoreError && error.reason === 'claim_failed' && error.status === 503);
  await assert.rejects(down.getEntitlement('sub:sub_synthetic0001'), (error) => error instanceof CmsStoreError && error.reason === 'lookup_failed');
  await assert.rejects(down.releaseEvent('evt_synthetic0001', L1), (error) => error instanceof CmsStoreError && error.reason === 'release_failed');
  const denied = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: fakeCms({ unauthorized: true }).fetchImpl });
  await assert.rejects(denied.claimEvent('evt_synthetic0001', L1), (error) => error instanceof CmsStoreError && error.reason === 'unauthorized' && error.status === 401);
  const schemaError = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: async (input, init) => (init.method === 'POST' ? new Response('{"errors":[{"message":"bad field"}]}', { status: 400 }) : new Response('{"docs":[]}', { status: 200 })) });
  await assert.rejects(schemaError.claimEvent('evt_synthetic0001', L1), (error) => error instanceof CmsStoreError && error.reason === 'claim_rejected', 'a 400 without a stored duplicate is an error, not a duplicate');
  const network = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(network.claimEvent('evt_synthetic0001', L1), (error) => error instanceof CmsStoreError && error.reason === 'network_error');
  const slow = createCmsStore({ url: URL_, apiKey: API_KEY, timeoutMs: 100, fetchImpl: (_input, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(slow.claimEvent('evt_synthetic0001', L1), (error) => error instanceof CmsStoreError && error.reason === 'timeout');
});

test('the event dispatcher works unchanged on the CMS-backed store', async () => {
  const cms = fakeCms();
  const store = createCmsStore({ url: URL_, apiKey: API_KEY, fetchImpl: cms.fetchImpl });
  const event = { id: 'evt_synthetic0009', object: 'event', type: 'customer.subscription.updated', livemode: false, created: 2145916800, data: { object: { id: 'sub_synthetic0009', object: 'subscription', status: 'active', customer: 'cus_synthetic0009', metadata: { offer: 'growth_monthly' }, cancel_at_period_end: false, current_period_end: 2148595200 } } };
  const summary = await dispatchEvent(event, { store, offers: { growth_monthly: { id: 'growth_monthly' } } });
  assert.equal(summary.outcome, 'processed');
  const record = await store.getEntitlement('sub:sub_synthetic0009');
  assert.equal(record.status, 'active');
  assert.equal(record.offer_known, true);
  const stale = await dispatchEvent({ ...event, id: 'evt_synthetic0010', created: 2145916700, data: { object: { ...event.data.object, status: 'canceled' } } }, { store, offers: {} });
  assert.equal(stale.outcome, 'stale');
  assert.equal((await store.getEntitlement('sub:sub_synthetic0009')).status, 'active');
});

test('configuration selects the store and keeps the API key out of summaries', () => {
  const memory = loadConfig({});
  assert.deepEqual(memory.store, { kind: 'memory' });
  assert.deepEqual(describeConfig(memory).store, { kind: 'memory', cms_url: null, cms_api_key_configured: false });
  const cms = loadConfig({ PAYMENTS_STORE: 'cms', PAYMENTS_CMS_URL: URL_, PAYMENTS_CMS_API_KEY: API_KEY });
  assert.deepEqual(cms.store, { kind: 'cms', url: URL_, apiKey: API_KEY });
  assert.ok(Object.isFrozen(cms.store));
  const summary = describeConfig(cms);
  assert.deepEqual(summary.store, { kind: 'cms', cms_url: URL_, cms_api_key_configured: true });
  assert.equal(JSON.stringify(summary).includes(API_KEY), false);
  assert.equal(JSON.stringify(redact({ store: cms.store })).includes(API_KEY), false, 'redact() masks apiKey properties');
  assert.deepEqual(loadConfig({ PAYMENTS_STORE: '', PAYMENTS_CMS_URL: '', PAYMENTS_CMS_API_KEY: '' }).store, { kind: 'memory' }, 'empty strings from Compose/Railway mean not configured');
  for (const [env, variable] of [
    [{ PAYMENTS_STORE: 'redis' }, 'PAYMENTS_STORE'],
    [{ PAYMENTS_STORE: 'cms', PAYMENTS_CMS_URL: '', PAYMENTS_CMS_API_KEY: API_KEY }, 'PAYMENTS_CMS_URL'],
    [{ PAYMENTS_STORE: 'cms', PAYMENTS_CMS_URL: URL_, PAYMENTS_CMS_API_KEY: '' }, 'PAYMENTS_CMS_API_KEY'],
    [{ PAYMENTS_STORE: 'cms' }, 'PAYMENTS_CMS_URL'],
    [{ PAYMENTS_STORE: 'cms', PAYMENTS_CMS_URL: 'http://public.example.org/cms/api', PAYMENTS_CMS_API_KEY: API_KEY }, 'PAYMENTS_CMS_URL'],
    [{ PAYMENTS_STORE: 'cms', PAYMENTS_CMS_URL: URL_ }, 'PAYMENTS_CMS_API_KEY'],
    [{ PAYMENTS_STORE: 'cms', PAYMENTS_CMS_URL: URL_, PAYMENTS_CMS_API_KEY: 'short' }, 'PAYMENTS_CMS_API_KEY'],
    [{ PAYMENTS_CMS_URL: URL_ }, 'PAYMENTS_CMS_URL'],
    [{ PAYMENTS_CMS_API_KEY: API_KEY }, 'PAYMENTS_CMS_API_KEY'],
  ]) assert.throws(() => loadConfig(env), (error) => error instanceof ConfigError && error.variable === variable, `expected ${variable}`);
});

test('the server builds the CMS store from configuration and reports it in health', async () => {
  const cms = fakeCms();
  const config = loadConfig({ PAYMENTS_HOST: '127.0.0.1', PORT: '0', PAYMENTS_STORE: 'cms', PAYMENTS_CMS_URL: URL_, PAYMENTS_CMS_API_KEY: API_KEY });
  const service = createPaymentsServer(config, { fetchImpl: cms.fetchImpl });
  const address = await service.listen();
  try {
    const health = await (await fetch(`http://127.0.0.1:${address.port}${ROUTES.health}`)).json();
    assert.equal(health.store, 'cms');
    assert.equal(health.status, 'disabled');
    assert.equal(service.store.kind, 'cms');
    assert.equal(await service.store.claimEvent('evt_synthetic0001', L1), 'claimed');
  } finally { await service.close(); }
  assert.throws(() => createPaymentsServer(Object.freeze({ ...config, store: Object.freeze({ kind: 'redis' }) })), /invalid payments configuration/);
});
