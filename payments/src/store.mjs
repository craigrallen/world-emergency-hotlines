// Store contract for webhook idempotency and entitlement state.
//
// createMemoryStore is single-process and bounded; it is enough for local
// testing and a single Railway replica. Production with more than one replica,
// or any requirement to survive restarts, needs a durable implementation with
// the same four methods (claimEvent must be an atomic first-writer-wins insert).

import { plain } from './validation.mjs';

export const STORE_METHODS = Object.freeze(['claimEvent', 'releaseEvent', 'getEntitlement', 'putEntitlement']);

export function validateStore(store) {
  return store !== null && typeof store === 'object' && STORE_METHODS.every((name) => typeof store[name] === 'function');
}

export function createMemoryStore({ maxEvents = 10000, maxEntitlements = 10000 } = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000000 || !Number.isInteger(maxEntitlements) || maxEntitlements < 1 || maxEntitlements > 1000000) throw new Error('invalid store configuration');
  const events = new Set();
  const entitlements = new Map();
  const evict = (collection, max) => { while (collection.size > max) collection.delete(collection.keys().next().value); };
  return Object.freeze({
    kind: 'memory',
    async claimEvent(id) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new TypeError('event id required');
      if (events.has(id)) return false;
      events.add(id);
      evict(events, maxEvents);
      return true;
    },
    async releaseEvent(id) { events.delete(id); },
    async getEntitlement(key) { return entitlements.get(key) ?? null; },
    async putEntitlement(record) {
      if (!plain(record) || typeof record.key !== 'string' || record.key.length === 0 || record.key.length > 160) throw new TypeError('entitlement record requires a key');
      const frozen = Object.freeze({ ...record });
      entitlements.delete(frozen.key);
      entitlements.set(frozen.key, frozen);
      evict(entitlements, maxEntitlements);
      return frozen;
    },
    listEntitlements() { return [...entitlements.values()]; },
    get size() { return { events: events.size, entitlements: entitlements.size }; },
  });
}
