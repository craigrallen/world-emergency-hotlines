import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_GRACE_SECONDS, CLAIM_RESULTS, STORE_METHODS, createMemoryStore, isStoreConflict, revisionMismatch, revisionOf, validateStore } from '../src/store.mjs';

test('memory store claims events once, distinguishes in-progress from completed claims, takes over abandoned ones, and stays bounded', async () => {
  let clock = 1_700_000_000_000;
  const store = createMemoryStore({ maxEvents: 2, now: () => clock });
  const L1 = 'lease-worker-0001', L2 = 'lease-worker-0002';
  assert.equal(await store.claimEvent('evt_a', L1), 'claimed');
  assert.equal(await store.claimEvent('evt_a', L2), 'in_progress', 'a fresh incomplete claim belongs to a worker that is still applying it');
  assert.equal(await store.completeEvent('evt_a', L2), false, 'only the lease holder completes a claim');
  assert.equal(await store.completeEvent('evt_a', L1), true);
  assert.equal(await store.claimEvent('evt_a', L2), 'duplicate');
  clock += CLAIM_GRACE_SECONDS * 1000 + 1;
  assert.equal(await store.claimEvent('evt_a', L2), 'duplicate', 'completed claims never expire');
  assert.equal(await store.releaseEvent('evt_a', L2), false, 'only the lease holder releases a claim');
  assert.equal(await store.releaseEvent('evt_a', L1), true);
  assert.equal(await store.claimEvent('evt_a', L1), 'claimed');
  // A claim that was never completed or released (its worker died) is taken over once the grace period passed, under the
  // taker's lease: the original worker, should it resurface, can neither release nor complete the successor's claim.
  clock += CLAIM_GRACE_SECONDS * 1000 + 1;
  assert.equal(await store.claimEvent('evt_a', L2), 'claimed');
  assert.equal(await store.releaseEvent('evt_a', L1), false);
  assert.equal(await store.completeEvent('evt_a', L1), false);
  assert.equal(await store.claimEvent('evt_a', L1), 'in_progress', 'the successor still holds it');
  assert.equal(await store.completeEvent('evt_a', L2), true);
  assert.equal(await store.claimEvent('evt_a', L1), 'duplicate');
  assert.equal(await store.claimEvent('evt_b', L1), 'claimed');
  assert.equal(await store.claimEvent('evt_c', L1), 'claimed');
  assert.equal(await store.claimEvent('evt_a', L1), 'claimed', 'oldest entry evicted once the bound is exceeded');
  await assert.rejects(store.claimEvent('', L1), TypeError);
  await assert.rejects(store.claimEvent('evt_a'), TypeError, 'a lease is required');
  await assert.rejects(store.completeEvent('evt_a', 'short'), TypeError);
  await assert.rejects(store.releaseEvent('evt_a', 42), TypeError);
  assert.deepEqual(store.size, { events: 2, entitlements: 0 });
  assert.deepEqual(CLAIM_RESULTS, ['claimed', 'duplicate', 'in_progress']);
  assert.throws(() => createMemoryStore({ now: 'nope' }));
  assert.throws(() => createMemoryStore({ claimGraceSeconds: 0 }));
});

test('entitlements are frozen, keyed, replaced in place, and bounded', async () => {
  const store = createMemoryStore({ maxEntitlements: 2 });
  const first = await store.putEntitlement({ key: 'sub:1', status: 'active' });
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(await store.getEntitlement('sub:1'), { key: 'sub:1', status: 'active', revision: 1 }, 'every stored record carries the revision the store stamped');
  // Compare-and-swap: a write built from a stale read is refused; one built from the current revision applies and bumps it.
  await assert.rejects(store.putEntitlement({ key: 'sub:1', status: 'canceled', based_on_revision: 0 }), isStoreConflict);
  assert.equal((await store.getEntitlement('sub:1')).status, 'active');
  assert.deepEqual(await store.putEntitlement({ key: 'sub:1', status: 'canceled', based_on_revision: 1 }), { key: 'sub:1', status: 'canceled', revision: 2 });
  assert.equal(revisionMismatch({ revision: 2 }, { based_on_revision: 1 }), true);
  assert.equal(revisionMismatch({ revision: 2 }, { status: 'x' }), false, 'writes without based_on_revision are unconditional');
  assert.equal(revisionMismatch(null, { based_on_revision: 0 }), false);
  assert.equal(revisionOf(null), 0);
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
