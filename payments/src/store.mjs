// Store contract for webhook idempotency and entitlement state.
//
// createMemoryStore is single-process and bounded; it is enough for local
// testing and a single Railway replica. Production with more than one replica,
// or any requirement to survive restarts, needs a durable implementation with
// the same five methods:
//
// - claimEvent(id, lease) is an atomic first-writer-wins insert that answers
//   'claimed', 'duplicate' (a claim that was completed), or 'in_progress' (a claim
//   that was never completed and is younger than CLAIM_GRACE_SECONDS). An
//   incomplete claim older than the grace period belongs to a worker that died
//   mid-way and is taken over ('claimed' again, now carrying the taker's lease), so
//   a failed delivery whose cleanup also failed stays retryable instead of being
//   acknowledged forever as a duplicate. `lease` is a token the worker made up for
//   this delivery (CLAIM_LEASE); the claim records it.
// - completeEvent(id, lease) marks a claim done after the event was applied, and
//   releaseEvent(id, lease) drops a claim after a failed apply (best effort). Both
//   apply only while the claim still carries that lease and answer whether they did:
//   a worker that outlived the grace period and was taken over can neither complete
//   nor remove its successor's claim, so the event cannot be applied a third time.
// - putEntitlement must refuse, with a conflict error (`code` STORE_CONFLICT), a
//   record that would move any event family's `<family>_event_epoch` backwards
//   relative to what is stored, or whose `based_on_revision` is not the stored
//   record's `revision` (compare-and-swap against the record the writer read),
//   atomically with the write; every stored record carries a `revision` that the
//   store increments on each write. events.mjs re-reads and re-applies on
//   conflict, so two replicas can never resurrect older state, even at equal epochs.

import { plain } from './validation.mjs';

export const STORE_METHODS = Object.freeze(['claimEvent', 'completeEvent', 'releaseEvent', 'getEntitlement', 'putEntitlement']);
export const CLAIM_RESULTS = Object.freeze(['claimed', 'duplicate', 'in_progress']);
/** A worker's lease on one delivery: URL-safe, 8 to 128 characters (a UUID fits). */
export const CLAIM_LEASE = /^[A-Za-z0-9_-]{8,128}$/;
export const validLease = (lease) => typeof lease === 'string' && CLAIM_LEASE.test(lease);
/** How long an incomplete claim is trusted to be in progress before another delivery may take it over. */
export const CLAIM_GRACE_SECONDS = 120;
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

/** The stored record's revision (0 for none). */
export const revisionOf = (record) => (plain(record) && Number.isInteger(record.revision) && record.revision >= 0 ? record.revision : 0);

/**
 * True when `incoming` was built from a different version of the record than the
 * one stored: it names the revision it read (`based_on_revision`) and that is not
 * the stored revision. Writes without `based_on_revision` are unconditional.
 */
export function revisionMismatch(stored, incoming) {
  if (!plain(incoming) || !Number.isInteger(incoming.based_on_revision)) return false;
  return incoming.based_on_revision !== revisionOf(stored);
}

export function validateStore(store) {
  return store !== null && typeof store === 'object' && STORE_METHODS.every((name) => typeof store[name] === 'function');
}

export function createMemoryStore({ maxEvents = 10000, maxEntitlements = 10000, now = () => Date.now(), claimGraceSeconds = CLAIM_GRACE_SECONDS } = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000000 || !Number.isInteger(maxEntitlements) || maxEntitlements < 1 || maxEntitlements > 1000000) throw new Error('invalid store configuration');
  if (typeof now !== 'function' || !Number.isInteger(claimGraceSeconds) || claimGraceSeconds < 1 || claimGraceSeconds > 86400) throw new Error('invalid store configuration');
  const events = new Map(); // id -> { claimedAt, completed, lease }
  const entitlements = new Map();
  const evict = (collection, max) => { while (collection.size > max) collection.delete(collection.keys().next().value); };
  const checkClaimArgs = (id, lease) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new TypeError('event id required');
    if (!validLease(lease)) throw new TypeError('claim lease required');
  };
  return Object.freeze({
    kind: 'memory',
    async claimEvent(id, lease) {
      checkClaimArgs(id, lease);
      const at = now();
      const existing = events.get(id);
      if (existing) {
        if (existing.completed) return 'duplicate';
        if (at - existing.claimedAt < claimGraceSeconds * 1000) return 'in_progress';
        events.delete(id); // abandoned by a worker that never completed: take it over under this worker's lease
      }
      events.set(id, { claimedAt: at, completed: false, lease });
      evict(events, maxEvents);
      return 'claimed';
    },
    // Completion and release are bound to the lease the claim carries: a worker that was taken over finds nothing to do.
    async completeEvent(id, lease) { checkClaimArgs(id, lease); const existing = events.get(id); if (!existing || existing.lease !== lease || existing.completed) return false; existing.completed = true; return true; },
    async releaseEvent(id, lease) { checkClaimArgs(id, lease); const existing = events.get(id); if (!existing || existing.lease !== lease) return false; events.delete(id); return true; },
    async getEntitlement(key) { return entitlements.get(key) ?? null; },
    async putEntitlement(record) {
      if (!plain(record) || typeof record.key !== 'string' || record.key.length === 0 || record.key.length > 160) throw new TypeError('entitlement record requires a key');
      // Synchronous from here on, so the checks and the write cannot interleave with another request.
      const current = entitlements.get(record.key);
      const family = regressedFamily(current, record);
      if (family) throw new StoreConflictError(record.key, family);
      if (revisionMismatch(current, record)) throw new StoreConflictError(record.key, 'revision');
      const { based_on_revision: _read, ...rest } = record;
      const frozen = Object.freeze({ ...rest, revision: revisionOf(current) + 1 });
      entitlements.delete(frozen.key);
      entitlements.set(frozen.key, frozen);
      evict(entitlements, maxEntitlements);
      return frozen;
    },
    listEntitlements() { return [...entitlements.values()]; },
    get size() { return { events: events.size, entitlements: entitlements.size }; },
  });
}
