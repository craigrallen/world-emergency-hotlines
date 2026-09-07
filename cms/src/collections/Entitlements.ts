import type { CollectionConfig } from 'payload';
import { APIError } from 'payload';
import { isAdmin, isAdminOrPaymentsStore, isStaffOrPaymentsStore } from '../access';
import { EVENT_FAMILIES, lockRow, syncSubscriptionFromEntitlement, type EventFamily } from '../lib/subscriptions';

export const STALE_RECORD = 'stale_record';

/**
 * The first event family whose epoch the incoming record would move backwards, or
 * drop, relative to the stored record; null when the write is safe. Records carry
 * one `<family>_event_epoch` per family (payments/src/events.mjs), so a writer that
 * read the record before another replica advanced it is detected here.
 */
export function regressedFamily(stored: unknown, incoming: unknown): EventFamily | null {
  if (!stored || typeof stored !== 'object' || !incoming || typeof incoming !== 'object') return null;
  for (const family of EVENT_FAMILIES) {
    const stamp = `${family}_event_epoch`;
    const before = (stored as Record<string, unknown>)[stamp];
    if (!Number.isInteger(before)) continue;
    const after = (incoming as Record<string, unknown>)[stamp];
    if (!Number.isInteger(after) || (after as number) < (before as number)) return family;
  }
  return null;
}

/**
 * Durable store for the payments service (`payments/src/cms-store.mjs`). One document
 * per store key (`cs:<checkout session>` or `sub:<subscription>`). Structured columns
 * make the admin useful; `record` keeps the exact payments-service record so the
 * store contract round-trips byte-for-byte.
 */
export const Entitlements: CollectionConfig = {
  slug: 'entitlements',
  labels: { singular: 'Entitlement', plural: 'Entitlements' },
  admin: {
    useAsTitle: 'key',
    defaultColumns: ['key', 'kind', 'offer', 'status', 'customer', 'livemode', 'updatedAt'],
    group: 'Billing',
    description: 'Payments-service store records (Stripe ids and enum statuses only). Subscription-kind records are mirrored into Subscriptions automatically.',
  },
  access: { read: isStaffOrPaymentsStore, create: isAdminOrPaymentsStore, update: isAdminOrPaymentsStore, delete: isAdmin },
  fields: [
    { name: 'key', type: 'text', required: true, unique: true, index: true, validate: (value: unknown) => (typeof value === 'string' && /^(cs|sub):[a-z]{2,10}_(?:(?:test|live)_)?[A-Za-z0-9]{8,}$/.test(value) ? true : 'must be cs:<checkout session id> or sub:<subscription id>') },
    { name: 'kind', type: 'select', required: true, defaultValue: 'unknown', options: [{ label: 'checkout_session', value: 'checkout_session' }, { label: 'subscription', value: 'subscription' }, { label: 'unknown', value: 'unknown' }] },
    { name: 'offer', type: 'text', maxLength: 64, index: true },
    { name: 'offerKnown', type: 'checkbox', defaultValue: false },
    { name: 'status', type: 'text', required: true, defaultValue: 'unknown', maxLength: 64 },
    { name: 'customer', type: 'text', maxLength: 200, index: true },
    { name: 'subscription', type: 'text', maxLength: 200, index: true },
    { name: 'checkoutSession', type: 'text', maxLength: 200 },
    { name: 'paymentIntent', type: 'text', maxLength: 200 },
    { name: 'livemode', type: 'checkbox', defaultValue: false },
    { name: 'updatedAtEpoch', type: 'number' },
    { name: 'sourceEvent', type: 'text', maxLength: 200 },
    { name: 'source', type: 'text', required: true, defaultValue: 'payments', maxLength: 32 },
    { name: 'record', type: 'json', required: true, admin: { description: 'Exact record as written by the payments service store contract.' } },
  ],
  hooks: {
    beforeChange: [
      // Ordering guard, atomic with the write. Two payments replicas can read the
      // same record and both pass their own client-side staleness check; whichever
      // writes second must not move any family's epoch backwards. The stored record
      // is re-read under the row lock (Postgres `SELECT … FOR UPDATE`; SQLite
      // serialises writers itself) because `originalDoc` predates the lock. A
      // regression is refused with 409 and the payments service re-reads and retries.
      async ({ data, operation, originalDoc, req }) => {
        if (operation !== 'update' || !data || data.record === undefined) return data;
        const key = (data.key as string | undefined) ?? (originalDoc?.key as string | undefined);
        if (typeof key !== 'string') return data;
        await lockRow(req.payload, req, 'entitlements', 'key', key);
        const current = await req.payload.find({ collection: 'entitlements', where: { key: { equals: key } }, limit: 1, depth: 0, overrideAccess: true, req });
        const family = regressedFamily(current.docs[0]?.record, data.record);
        if (family) throw new APIError(`entitlement ${key} already carries a newer ${family} event; re-read and retry`, 409, { code: STALE_RECORD, family }, true);
        return data;
      },
    ],
    afterChange: [
      async ({ doc, req }) => {
        if (doc.kind === 'subscription') {
          // Runs inside the request transaction and propagates failures on purpose:
          // the payments service then sees a failed store write, releases its event
          // claim, and Stripe retries, instead of a stale mirror behind a 2xx.
          try { await syncSubscriptionFromEntitlement(req.payload, doc, req); } catch (error) {
            req.payload.logger.error({ err: error instanceof Error ? error.message : 'unknown', key: doc.key }, 'entitlement → subscription sync failed');
            throw error;
          }
        }
        return doc;
      },
    ],
  },
  timestamps: true,
};
