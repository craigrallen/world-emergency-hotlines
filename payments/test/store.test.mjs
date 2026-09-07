import test from 'node:test';
import assert from 'node:assert/strict';
import { STORE_METHODS, createMemoryStore, validateStore } from '../src/store.mjs';

test('memory store claims events once, releases on failure, and stays bounded', async () => {
  const store = createMemoryStore({ maxEvents: 2 });
  assert.equal(await store.claimEvent('evt_a'), true);
  assert.equal(await store.claimEvent('evt_a'), false);
  await store.releaseEvent('evt_a');
  assert.equal(await store.claimEvent('evt_a'), true);
  assert.equal(await store.claimEvent('evt_b'), true);
  assert.equal(await store.claimEvent('evt_c'), true);
  assert.equal(await store.claimEvent('evt_a'), true, 'oldest entry evicted once the bound is exceeded');
  await assert.rejects(store.claimEvent(''), TypeError);
  assert.deepEqual(store.size, { events: 2, entitlements: 0 });
});

test('entitlements are frozen, keyed, replaced in place, and bounded', async () => {
  const store = createMemoryStore({ maxEntitlements: 2 });
  const first = await store.putEntitlement({ key: 'sub:1', status: 'active' });
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(await store.getEntitlement('sub:1'), { key: 'sub:1', status: 'active' });
  await store.putEntitlement({ key: 'sub:2', status: 'active' });
  await store.putEntitlement({ key: 'sub:1', status: 'canceled' });
  await store.putEntitlement({ key: 'sub:3', status: 'active' });
  assert.equal(await store.getEntitlement('sub:2'), null, 'least recently written record evicted');
  assert.equal((await store.getEntitlement('sub:1')).status, 'canceled');
  assert.equal(store.listEntitlements().length, 2);
  await assert.rejects(store.putEntitlement({ status: 'x' }), TypeError);
  await assert.rejects(store.putEntitlement(null), TypeError);
});

test('store contract validation', () => {
  assert.equal(validateStore(createMemoryStore()), true);
  assert.equal(validateStore({}), false);
  assert.equal(validateStore(null), false);
  assert.deepEqual(STORE_METHODS, ['claimEvent', 'releaseEvent', 'getEntitlement', 'putEntitlement']);
  assert.throws(() => createMemoryStore({ maxEvents: 0 }));
});
