import type { CollectionConfig } from 'payload';
import { isAdminOrService, isStaffOrService } from '../access';

export const StripeEvents: CollectionConfig = {
  slug: 'stripe-events',
  labels: { singular: 'Stripe event', plural: 'Stripe events' },
  admin: {
    useAsTitle: 'eventId',
    defaultColumns: ['eventId', 'type', 'source', 'outcome', 'livemode', 'createdAt'],
    group: 'Billing',
    description: 'Webhook idempotency ledger shared by the CMS webhook and the payments service. The unique event id makes the first writer win across replicas; the ledger stores ids and types only.',
  },
  access: { read: isStaffOrService, create: isAdminOrService, update: isAdminOrService, delete: isAdminOrService },
  fields: [
    { name: 'eventId', type: 'text', required: true, unique: true, index: true, validate: (value: unknown) => (typeof value === 'string' && /^evt_[A-Za-z0-9]{8,}$/.test(value) ? true : 'must be a Stripe event id (evt_…)') },
    { name: 'type', type: 'text', maxLength: 128 },
    { name: 'livemode', type: 'checkbox', defaultValue: false },
    { name: 'source', type: 'select', required: true, defaultValue: 'payments', options: [{ label: 'Payments service', value: 'payments' }, { label: 'CMS webhook', value: 'cms' }] },
    { name: 'outcome', type: 'text', maxLength: 64 },
  ],
  timestamps: true,
};
