// Webhook event dispatch. Only pseudonymous Stripe identifiers and closed enum
// statuses are stored: no names, emails, addresses, card data, or amounts.
// Out-of-order deliveries are tolerated by never letting an older event
// overwrite state written by a newer one.

import { OFFER_ID, STRIPE_OBJECT_ID } from './config.mjs';
import { plain } from './validation.mjs';

export const HANDLED_EVENT_TYPES = Object.freeze([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed',
]);
export const SUBSCRIPTION_STATUSES = Object.freeze(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']);
export const CHECKOUT_STATUSES = Object.freeze(['open', 'complete', 'expired']);
export const PAYMENT_STATUSES = Object.freeze(['paid', 'unpaid', 'no_payment_required']);
export const PENDING_SUBSCRIPTION = 'pending_subscription_event';

/** Accept a bare id or an expanded object carrying one; anything else is null. */
export function stripeId(value) {
  if (typeof value === 'string') return STRIPE_OBJECT_ID.test(value) ? value : null;
  if (plain(value) && typeof value.id === 'string' && STRIPE_OBJECT_ID.test(value.id)) return value.id;
  return null;
}

function offerOf(object, offers) {
  const raw = plain(object.metadata) ? object.metadata.offer : undefined;
  if (typeof raw !== 'string' || !OFFER_ID.test(raw)) return { offer: null, known: false, present: false };
  return { offer: raw, known: Object.hasOwn(offers, raw), present: true };
}

const enumOr = (value, allowed, fallback = 'unknown') => (allowed.includes(value) ? value : fallback);

async function upsert(store, key, patch, event) {
  const existing = await store.getEntitlement(key);
  if (existing && Number.isInteger(existing.updated_at_epoch) && existing.updated_at_epoch > event.created) return { record: existing, stale: true };
  const record = await store.putEntitlement({
    ...(existing ?? {}), ...patch, key,
    livemode: event.livemode, updated_at_epoch: event.created, updated_at: new Date(event.created * 1000).toISOString(), source_event: event.id,
  });
  return { record, stale: false };
}

/**
 * Apply one verified event to the store. Returns a small, log-safe summary.
 * `offers` is the configured offer map so unknown offer ids can be flagged.
 */
export async function dispatchEvent(event, { store, offers = {} }) {
  if (!plain(event) || !plain(event.data) || !plain(event.data.object)) throw new TypeError('event shape invalid');
  const object = event.data.object;
  const ignored = (reason) => ({ outcome: 'ignored', reason, keys: [], offer: null, offer_known: false });

  if (event.type.startsWith('checkout.session.')) {
    if (!HANDLED_EVENT_TYPES.includes(event.type)) return ignored('unhandled_type');
    const sessionId = stripeId(object);
    if (!sessionId) return ignored('missing_id');
    const { offer, known } = offerOf(object, offers);
    const patch = {
      kind: 'checkout_session', offer, offer_known: known, mode: enumOr(object.mode, ['subscription', 'payment', 'setup']),
      status: enumOr(object.status, CHECKOUT_STATUSES), payment_status: enumOr(object.payment_status, PAYMENT_STATUSES),
      customer: stripeId(object.customer), subscription: stripeId(object.subscription), payment_intent: stripeId(object.payment_intent),
    };
    const session = await upsert(store, `cs:${sessionId}`, patch, event);
    const keys = [session.record.key];
    if (patch.subscription && event.type === 'checkout.session.completed') {
      const existing = await store.getEntitlement(`sub:${patch.subscription}`);
      const seeded = await upsert(store, `sub:${patch.subscription}`, {
        kind: 'subscription', offer: existing?.offer ?? offer, offer_known: existing?.offer_known ?? known, customer: patch.customer ?? existing?.customer ?? null,
        status: existing?.status ?? PENDING_SUBSCRIPTION, checkout_session: sessionId,
      }, event);
      keys.push(seeded.record.key);
    }
    return { outcome: session.stale ? 'stale' : 'processed', keys, offer, offer_known: known };
  }

  if (event.type.startsWith('customer.subscription.')) {
    if (!HANDLED_EVENT_TYPES.includes(event.type)) return ignored('unhandled_type');
    const subscriptionId = stripeId(object);
    if (!subscriptionId) return ignored('missing_id');
    const existing = await store.getEntitlement(`sub:${subscriptionId}`);
    const meta = offerOf(object, offers);
    const offer = meta.present ? meta.offer : (existing?.offer ?? null);
    const known = meta.present ? meta.known : (existing?.offer_known ?? false);
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : enumOr(object.status, SUBSCRIPTION_STATUSES);
    const result = await upsert(store, `sub:${subscriptionId}`, {
      kind: 'subscription', offer, offer_known: known, customer: stripeId(object.customer) ?? existing?.customer ?? null, status,
      cancel_at_period_end: object.cancel_at_period_end === true,
      current_period_end: Number.isInteger(object.current_period_end) ? object.current_period_end : (existing?.current_period_end ?? null),
    }, event);
    return { outcome: result.stale ? 'stale' : 'processed', keys: [result.record.key], offer, offer_known: known };
  }

  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    // Newer Stripe API versions moved the subscription reference under `parent`.
    const subscriptionId = stripeId(object.subscription) ?? stripeId(object.parent?.subscription_details?.subscription);
    if (!subscriptionId) return ignored('no_subscription');
    const existing = await store.getEntitlement(`sub:${subscriptionId}`);
    const result = await upsert(store, `sub:${subscriptionId}`, {
      kind: 'subscription', offer: existing?.offer ?? null, offer_known: existing?.offer_known ?? false,
      customer: stripeId(object.customer) ?? existing?.customer ?? null, status: existing?.status ?? PENDING_SUBSCRIPTION,
      last_invoice: stripeId(object), last_invoice_status: event.type === 'invoice.paid' ? 'paid' : 'payment_failed',
    }, event);
    return { outcome: result.stale ? 'stale' : 'processed', keys: [result.record.key], offer: result.record.offer, offer_known: result.record.offer_known };
  }

  return ignored('unhandled_type');
}
