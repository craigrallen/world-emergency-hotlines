import type { CollectionConfig } from 'payload';
import { isAdmin, ownerOrStaff } from '../access';

export const SUBSCRIPTION_STATUSES = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'pending_subscription_event', 'unknown'] as const;
export const ACTIVE_STATUSES: readonly string[] = ['active', 'trialing'];

export const Subscriptions: CollectionConfig = {
  slug: 'subscriptions',
  labels: { singular: 'Subscription', plural: 'Subscriptions' },
  admin: {
    useAsTitle: 'stripeSubscriptionId',
    defaultColumns: ['stripeSubscriptionId', 'user', 'offer', 'status', 'currentPeriodEnd', 'livemode', 'source', 'updatedAt'],
    group: 'Billing',
    description: 'Mirror of Stripe subscriptions, written only by verified webhooks (CMS) or the payments service store. Holds pseudonymous ids and enum statuses; no amounts, names, addresses, or card data.',
  },
  access: { read: ownerOrStaff('user'), create: isAdmin, update: isAdmin, delete: isAdmin },
  fields: [
    { name: 'stripeSubscriptionId', type: 'text', required: true, unique: true, index: true, admin: { readOnly: true } },
    { name: 'stripeCustomerId', type: 'text', index: true, admin: { readOnly: true } },
    { name: 'user', type: 'relationship', relationTo: 'users', index: true, admin: { description: 'Linked from checkout client_reference_id, subscription metadata, or the customer id on the user.' } },
    { name: 'plan', type: 'relationship', relationTo: 'plans' },
    { name: 'offer', type: 'text', index: true, admin: { readOnly: true } },
    { name: 'status', type: 'select', required: true, defaultValue: 'unknown', options: SUBSCRIPTION_STATUSES.map((value) => ({ label: value, value })), admin: { readOnly: true } },
    { name: 'cancelAtPeriodEnd', type: 'checkbox', defaultValue: false, admin: { readOnly: true } },
    { name: 'currentPeriodEnd', type: 'date', admin: { readOnly: true } },
    { name: 'livemode', type: 'checkbox', defaultValue: false, admin: { readOnly: true } },
    { name: 'checkoutSessionId', type: 'text', admin: { readOnly: true } },
    { name: 'lastInvoiceId', type: 'text', admin: { readOnly: true } },
    { name: 'lastInvoiceStatus', type: 'select', options: [{ label: 'paid', value: 'paid' }, { label: 'payment_failed', value: 'payment_failed' }], admin: { readOnly: true } },
    { name: 'lastEventCreated', type: 'number', admin: { readOnly: true, description: 'Unix seconds of the newest Stripe event applied from any family.' } },
    { name: 'lastCheckoutEventCreated', type: 'number', admin: { readOnly: true, description: 'Watermark for checkout.session.* events; an older checkout event never overwrites a newer one.' } },
    { name: 'lastSubscriptionEventCreated', type: 'number', admin: { readOnly: true, description: 'Watermark for customer.subscription.* events (status, cancellation, period).' } },
    { name: 'lastInvoiceEventCreated', type: 'number', admin: { readOnly: true, description: 'Watermark for invoice.* events (last invoice status).' } },
    { name: 'lastEventId', type: 'text', admin: { readOnly: true } },
    { name: 'source', type: 'select', required: true, defaultValue: 'cms', options: [{ label: 'CMS webhook', value: 'cms' }, { label: 'Payments service store', value: 'payments' }], admin: { readOnly: true } },
  ],
  timestamps: true,
};
