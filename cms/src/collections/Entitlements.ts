import type { CollectionConfig } from 'payload';
import { isAdmin, isAdminOrService, isStaffOrService } from '../access';
import { syncSubscriptionFromEntitlement } from '../lib/subscriptions';

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
  access: { read: isStaffOrService, create: isAdminOrService, update: isAdminOrService, delete: isAdmin },
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
    afterChange: [
      async ({ doc, req }) => {
        if (doc.kind === 'subscription') {
          try { await syncSubscriptionFromEntitlement(req.payload, doc); } catch (error) {
            req.payload.logger.error({ err: error instanceof Error ? error.message : 'unknown', key: doc.key }, 'entitlement → subscription sync failed');
          }
        }
        return doc;
      },
    ],
  },
  timestamps: true,
};
