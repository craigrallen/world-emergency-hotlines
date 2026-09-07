// Store contract for webhook idempotency and entitlement state.
//
// createMemoryStore is single-process and bounded; it is enough for local
// testing and a single Railway replica. Production with more than one replica,
// or any requirement to survive restarts, needs a durable implementation with
// the same four methods: claimEvent must be an atomic first-writer-wins insert,
// and putEntitlement must refuse, with a conflict error (`code` STORE_CONFLICT),
// a record that would move any event family's `<family>_event_epoch` backwards
// relative to what is stored, atomically with the write. events.mjs re-reads and
// re-applies on conflict, so two replicas can never resurrect older state.

import { plain } from './validation.mjs';

export const STORE_METHODS = Object.freeze(['claimEvent', 'releaseEvent', 'getEntitlement', 'putEntitlement']);
export const EVENT_FAMILIES = Object.freeze(['checkout', 'subscription', 'invoice']);
export const STORE_CONFLICT = 'store_conflict';

/** putEntitlement lost a race: the stored record already carries a newer event of `family`. */
export class StoreConflictError extends Error {
  constructor(key, family) {
    super(`entitlement ${key} changed concurrently (${family})`);
    this.name = 'StoreConflictError';
    this.code = STORE_CONFLICT;
    this.family = family;
  }
}

export const isStoreConflict = (error) => error instanceof Error && error.code === STORE_CONFLICT;

/**
 * The first event family whose epoch `incoming` would move backwards, or drop,
 * relative to `stored`; null when the write is safe. Mirrors the guard the CMS
 * enforces server-side (cms/src/collections/Entitlements.ts).
 */
export function regressedFamily(stored, incoming) {
  if (!plain(stored) || !plain(incoming)) return null;
  for (const family of EVENT_FAMILIES) {
    const stamp = `${family}_event_epoch`;
    if (!Number.isInteger(stored[stamp])) continue;
    if (!Number.isInteger(incoming[stamp]) || incoming[stamp] < stored[stamp]) return family;
  }
  return null;
}

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
      // Synchronous from here on, so the check and the write cannot interleave with another request.
      const family = regressedFamily(entitlements.get(frozen.key), frozen);
      if (family) throw new StoreConflictError(frozen.key, family);
      entitlements.delete(frozen.key);
      entitlements.set(frozen.key, frozen);
      evict(entitlements, maxEntitlements);
      return frozen;
    },
    listEntitlements() { return [...entitlements.values()]; },
    get size() { return { events: events.size, entitlements: entitlements.size }; },
  });
}
