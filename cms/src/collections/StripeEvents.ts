import type { CollectionConfig } from 'payload';
import { isAdminOrPaymentsStore, isStaffOrPaymentsStore } from '../access';

export const EVENT_SOURCES = ['payments', 'cms'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** One claim per consumer and event: the payments service and the CMS webhook do different work with the same event. */
export const claimKeyFor = (source: string, eventId: string): string => `${source}:${eventId}`;

export const StripeEvents: CollectionConfig = {
  slug: 'stripe-events',
  labels: { singular: 'Stripe event', plural: 'Stripe events' },
  admin: {
    useAsTitle: 'claimKey',
    defaultColumns: ['eventId', 'source', 'type', 'outcome', 'livemode', 'createdAt'],
    group: 'Billing',
    description: 'Webhook idempotency ledger shared by the CMS webhook and the payments service. Claims are unique per consumer and event (claimKey = source:eventId), so each consumer processes every event exactly once across replicas and neither can mark an event done for the other; the ledger stores ids and types only.',
  },
  access: { read: isStaffOrPaymentsStore, create: isAdminOrPaymentsStore, update: isAdminOrPaymentsStore, delete: isAdminOrPaymentsStore },
  fields: [
    { name: 'eventId', type: 'text', required: true, index: true, validate: (value: unknown) => (typeof value === 'string' && /^evt_[A-Za-z0-9]{8,}$/.test(value) ? true : 'must be a Stripe event id (evt_…)') },
    { name: 'source', type: 'select', required: true, defaultValue: 'payments', options: [{ label: 'Payments service', value: 'payments' }, { label: 'CMS webhook', value: 'cms' }] },
    {
      name: 'claimKey',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: { readOnly: true, description: 'Derived as source:eventId; the unique index makes the first writer per consumer win.' },
      validate: (value: unknown) => (typeof value === 'string' && /^(payments|cms):evt_[A-Za-z0-9]{8,}$/.test(value) ? true : 'must be <source>:<event id>'),
    },
    { name: 'type', type: 'text', maxLength: 128 },
    { name: 'livemode', type: 'checkbox', defaultValue: false },
    { name: 'outcome', type: 'text', maxLength: 64 },
  ],
  hooks: {
    beforeValidate: [
      ({ data, originalDoc }) => {
        if (!data) return data;
        // The claim key is never client-supplied: it is derived from the consumer and the event.
        const source = (data.source as string | undefined) ?? (originalDoc?.source as string | undefined) ?? 'payments';
        const eventId = (data.eventId as string | undefined) ?? (originalDoc?.eventId as string | undefined);
        if (typeof eventId === 'string') (data as Record<string, unknown>).claimKey = claimKeyFor(source, eventId);
        return data;
      },
    ],
  },
  timestamps: true,
};
