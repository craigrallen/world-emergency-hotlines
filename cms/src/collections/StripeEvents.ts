import type { Access, CollectionConfig } from 'payload';
import { APIError } from 'payload';
import { hasRole, isAdmin, isAdminOrPaymentsStore, isServiceRequest } from '../access';
import { mutateClaim } from '../lib/stripe';
import { fail, guarded, json, readJsonBody } from '../lib/responses';
import { lockRow } from '../lib/subscriptions';

export const EVENT_SOURCES = ['payments', 'cms'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** How long an incomplete claim is trusted to be in progress before another delivery may take it over. */
export const CLAIM_GRACE_SECONDS = 120;

/** One claim per consumer and event: the payments service and the CMS webhook do different work with the same event. */
export const claimKeyFor = (source: string, eventId: string): string => `${source}:${eventId}`;

/** The payments-store credential sees and changes only its own (`payments:`) claims; it can never mark a CMS claim done. */
const paymentsRowsOrStaff: Access = ({ req }) => (hasRole(req, 'admin', 'staff') ? true : isServiceRequest(req, 'payments_store') ? { source: { equals: 'payments' } } : false);
const paymentsRowsOrAdmin: Access = ({ req }) => (hasRole(req, 'admin') ? true : isServiceRequest(req, 'payments_store') ? { source: { equals: 'payments' } } : false);

export const StripeEvents: CollectionConfig = {
  slug: 'stripe-events',
  labels: { singular: 'Stripe event', plural: 'Stripe events' },
  admin: {
    useAsTitle: 'claimKey',
    defaultColumns: ['eventId', 'source', 'type', 'outcome', 'livemode', 'createdAt'],
    group: 'Billing',
    description: 'Webhook idempotency ledger shared by the CMS webhook and the payments service. Claims are unique per consumer and event (claimKey = source:eventId), so each consumer processes every event exactly once across replicas and neither can mark an event done for the other; the ledger stores ids and types only.',
  },
  access: { read: paymentsRowsOrStaff, create: isAdminOrPaymentsStore, update: paymentsRowsOrAdmin, delete: isAdmin },
  endpoints: [{
    path: '/lease', method: 'post',
    handler: (req) => guarded(req, async () => {
      if (!isServiceRequest(req, 'payments_store')) return fail(req, 'forbidden');
      const data = await readJsonBody(req);
      if (typeof data.eventId !== 'string' || !/^evt_[A-Za-z0-9]{8,}$/.test(data.eventId) || typeof data.lease !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(data.lease) || !['complete', 'release'].includes(String(data.action))) return fail(req, 'invalid_request');
      const applied = await mutateClaim(req.payload, data.eventId, 'payments', data.lease, data.action === 'complete' ? 'processed' : null);
      return json(req, 200, { applied });
    }),
  }],
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
    {
      name: 'lease',
      type: 'text',
      index: true,
      admin: { readOnly: true, description: 'Lease token of the worker holding this claim. Completion and release apply only while it still matches, so a worker that outlived the grace period and was taken over cannot complete or remove its successor\'s claim.' },
      validate: (value: unknown) => (value === undefined || value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value)) ? true : 'must be 8 to 128 URL-safe characters'),
    },
    { name: 'type', type: 'text', maxLength: 128 },
    { name: 'livemode', type: 'checkbox', defaultValue: false },
    { name: 'outcome', type: 'text', maxLength: 64 },
  ],
  hooks: {
    beforeChange: [
      // A service take-over of an abandoned claim (`outcome: null` on an incomplete row) is
      // re-checked under the row lock: if another delivery completed or refreshed the claim
      // in the meantime, this one is refused with 409 and backs off, so two takers can never
      // both process the event. The CMS's own take-over path holds the same lock (lib/stripe.ts).
      async ({ data, operation, originalDoc, req }) => {
        if (operation !== 'update' || !data || !isServiceRequest(req)) return data;
        if (data.outcome !== null || typeof data.lease !== 'string') throw new APIError('Use the lease endpoint to complete or release a claim', 403);
        if ((data.eventId !== undefined && data.eventId !== originalDoc?.eventId) || data.source !== originalDoc?.source) throw new APIError('Claim identity is immutable', 403);
        const claimKey = (originalDoc?.claimKey as string | undefined) ?? (data.claimKey as string | undefined);
        if (typeof claimKey !== 'string') return data;
        await lockRow(req.payload, req, 'stripe-events', 'claim_key', claimKey);
        const current = (await req.payload.find({ collection: 'stripe-events', where: { claimKey: { equals: claimKey } }, limit: 1, depth: 0, overrideAccess: true, req })).docs[0];
        if (!current) return data;
        if (typeof current.outcome === 'string' && current.outcome.length > 0) throw new APIError('claim already completed', 409, { code: 'claim_completed' }, true);
        const updatedAt = Date.parse(String(current.updatedAt));
        if (Number.isFinite(updatedAt) && Date.now() - updatedAt < CLAIM_GRACE_SECONDS * 1000) throw new APIError('claim is in progress', 409, { code: 'claim_in_progress' }, true);
        return data;
      },
    ],
    beforeValidate: [
      ({ data, originalDoc, req }) => {
        if (!data) return data;
        // A service credential always writes in its own namespace, whatever `source` it sends.
        if (isServiceRequest(req)) (data as Record<string, unknown>).source = 'payments';
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
