import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_GRACE_SECONDS, CLAIM_RESULTS, STORE_METHODS, createMemoryStore, validateStore } from '../src/store.mjs';

test('memory store claims events once, distinguishes in-progress from completed claims, takes over abandoned ones, and stays bounded', async () => {
  let clock = 1_700_000_000_000;
  const store = createMemoryStore({ maxEvents: 2, now: () => clock });
  assert.equal(await store.claimEvent('evt_a'), 'claimed');
  assert.equal(await store.claimEvent('evt_a'), 'in_progress', 'a fresh incomplete claim belongs to a worker that is still applying it');
  await store.completeEvent('evt_a');
  assert.equal(await store.claimEvent('evt_a'), 'duplicate');
  clock += CLAIM_GRACE_SECONDS * 1000 + 1;
  assert.equal(await store.claimEvent('evt_a'), 'duplicate', 'completed claims never expire');
  await store.releaseEvent('evt_a');
  assert.equal(await store.claimEvent('evt_a'), 'claimed');
  // A claim that was never completed or released (its worker died) is taken over once the grace period passed.
  clock += CLAIM_GRACE_SECONDS * 1000 + 1;
  assert.equal(await store.claimEvent('evt_a'), 'claimed');
  assert.equal(await store.claimEvent('evt_b'), 'claimed');
  assert.equal(await store.claimEvent('evt_c'), 'claimed');
  assert.equal(await store.claimEvent('evt_a'), 'claimed', 'oldest entry evicted once the bound is exceeded');
  await assert.rejects(store.claimEvent(''), TypeError);
  assert.deepEqual(store.size, { events: 2, entitlements: 0 });
  assert.deepEqual(CLAIM_RESULTS, ['claimed', 'duplicate', 'in_progress']);
  assert.throws(() => createMemoryStore({ now: 'nope' }));
  assert.throws(() => createMemoryStore({ claimGraceSeconds: 0 }));
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
  assert.deepEqual(STORE_METHODS, ['claimEvent', 'completeEvent', 'releaseEvent', 'getEntitlement', 'putEntitlement']);
  assert.equal(validateStore({ claimEvent() {}, releaseEvent() {}, getEntitlement() {}, putEntitlement() {} }), false, 'completeEvent is part of the contract');
  assert.throws(() => createMemoryStore({ maxEvents: 0 }));
});
