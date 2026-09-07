import type { CollectionConfig } from 'payload';
import { isAdmin, isStaffOrService } from '../access';

export const OFFER_ID = /^[a-z][a-z0-9_]{1,31}$/;
export const PRICE_ID = /^price_[A-Za-z0-9]{8,}$/;
export const GATEWAY_PERMISSIONS = ['manifest', 'records', 'resolver'] as const;

export const Plans: CollectionConfig = {
  slug: 'plans',
  labels: { singular: 'Plan', plural: 'Plans' },
  admin: {
    useAsTitle: 'label',
    defaultColumns: ['offerId', 'label', 'mode', 'active', 'stripePriceId', 'updatedAt'],
    group: 'Billing',
    description: 'Offer ids the account page may sell, each mapped to a Stripe price that lives only here and in the Stripe Dashboard. Prices are never published on the site.',
  },
  access: { read: isStaffOrService, create: isAdmin, update: isAdmin, delete: isAdmin },
  fields: [
    { name: 'offerId', type: 'text', required: true, unique: true, index: true, admin: { description: 'Stable public id, e.g. growth_monthly. Must match payments/contracts/v1/offers.json when the same offer is sold through /billing.' }, validate: (value: unknown) => (typeof value === 'string' && OFFER_ID.test(value) ? true : 'must be 2 to 32 lowercase letters, digits, or underscores starting with a letter') },
    { name: 'label', type: 'text', required: true, maxLength: 80 },
    { name: 'description', type: 'textarea', maxLength: 600, admin: { description: 'Shown on the account page. Never include a price.' } },
    { name: 'mode', type: 'select', required: true, defaultValue: 'subscription', options: [{ label: 'Subscription', value: 'subscription' }, { label: 'One-time payment', value: 'payment' }] },
    { name: 'stripePriceId', type: 'text', required: true, admin: { description: 'Stripe price id (price_…). Must belong to the same test/live mode as STRIPE_SECRET_KEY.' }, validate: (value: unknown) => (typeof value === 'string' && PRICE_ID.test(value) ? true : 'must be a Stripe price id (price_…)') },
    { name: 'quantity', type: 'number', required: true, defaultValue: 1, min: 1, max: 100 },
    { name: 'active', type: 'checkbox', defaultValue: false, admin: { description: 'Only active plans are offered on the account page.' } },
    {
      name: 'gateway',
      type: 'group',
      admin: { description: 'Managed API key policy granted to subscribers of this plan (see gateway/contracts/v1/key-record.schema.json).' },
      fields: [
        { name: 'permissions', type: 'select', hasMany: true, defaultValue: [...GATEWAY_PERMISSIONS], options: GATEWAY_PERMISSIONS.map((value) => ({ label: value, value })) },
        { name: 'quotaRate', type: 'number', required: true, defaultValue: 1, min: 0.001, max: 1000, admin: { description: 'Tokens per second (0 < rate <= 1000).' } },
        { name: 'quotaBurst', type: 'number', required: true, defaultValue: 10, min: 1, max: 10000, admin: { description: 'Integer bucket capacity (1..10000, and at most rate × 86400).' } },
      ],
    },
  ],
  hooks: {
    beforeValidate: [
      ({ data }) => {
        const gateway = (data?.gateway ?? {}) as { quotaRate?: number; quotaBurst?: number; permissions?: string[] };
        if (gateway.quotaBurst !== undefined && !Number.isInteger(gateway.quotaBurst)) throw new Error('gateway.quotaBurst must be an integer');
        if (gateway.quotaRate !== undefined && gateway.quotaBurst !== undefined && gateway.quotaBurst > gateway.quotaRate * 86400) throw new Error('gateway.quotaBurst must not exceed quotaRate × 86400');
        if (gateway.permissions !== undefined && gateway.permissions.length === 0) throw new Error('gateway.permissions needs at least one permission');
        return data;
      },
    ],
  },
  timestamps: true,
};
