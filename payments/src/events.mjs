// Webhook event dispatch. Only pseudonymous Stripe identifiers and closed enum
// statuses are stored: no names, emails, addresses, card data, or amounts.
// Out-of-order deliveries are tolerated by never letting an older event
// overwrite state written by a newer one; two events created in the same
// second are reconciled against Stripe's current object instead of being ordered.

import { OFFER_ID, STRIPE_OBJECT_ID } from './config.mjs';
import { EVENT_FAMILIES, isStoreConflict } from './store.mjs';
import { plain } from './validation.mjs';

export { EVENT_FAMILIES };

export const HANDLED_EVENT_TYPES = Object.freeze([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed',
]);
export const SUBSCRIPTION_STATUSES = Object.freeze(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']);
export const CHECKOUT_STATUSES = Object.freeze(['open', 'complete', 'expired']);
export const PAYMENT_STATUSES = Object.freeze(['paid', 'unpaid', 'no_payment_required']);
export const PENDING_SUBSCRIPTION = 'pending_subscription_event';
/** Re-reads after a store conflict before giving up (the webhook then fails and Stripe retries). */
export const MAX_UPSERT_ATTEMPTS = 5;
/** Stripe object kind fetched to reconcile a same-second tie, per event family. */
export const RECONCILE_KIND = Object.freeze({ checkout: 'checkout.session', subscription: 'subscription', invoice: 'invoice' });

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

/**
 * Ordering is tracked per event family (`<family>_event_epoch`), because each
 * family writes its own fields: a checkout event that arrives after a delayed
 * subscription event must not make that subscription event "stale", or the
 * status it carried would be lost. `updated_at_epoch` stays the newest of all.
 *
 * Whole-second `created` values cannot order two events from the same second, so
 * a tie never trusts the payload: `reconcile()` fetches Stripe's current object
 * and that is applied instead (without a fetcher the event is treated as stale,
 * which fails closed). `buildPatch(existing, current)` is called with the record
 * as read for this attempt and with the fetched object when reconciling, so
 * nothing is derived from a stale read. The store refuses (conflict) a write that
 * would move a family's epoch backwards relative to what another replica wrote in
 * between; on conflict the record is re-read and the decision made again.
 */
async function upsert(store, key, buildPatch, event, family, reconcile = null) {
  if (!EVENT_FAMILIES.includes(family)) throw new TypeError('event family invalid');
  const stamp = `${family}_event_epoch`;
  for (let attempt = 1; ; attempt += 1) {
    const existing = await store.getEntitlement(key);
    let current = null;
    const mark = existing?.[stamp];
    if (Number.isInteger(mark)) {
      if (mark > event.created) return { record: existing, stale: true };
      if (mark === event.created) {
        current = reconcile ? await reconcile() : null;
        if (!current) return { record: existing, stale: true };
      }
    }
    const newest = Math.max(event.created, Number.isInteger(existing?.updated_at_epoch) ? existing.updated_at_epoch : 0);
    try {
      const record = await store.putEntitlement({
        ...(existing ?? {}), ...buildPatch(existing, current), key,
        livemode: event.livemode, [stamp]: event.created, updated_at_epoch: newest, updated_at: new Date(newest * 1000).toISOString(), source_event: event.id,
      });
      return { record, stale: false, reconciled: current !== null };
    } catch (error) {
      if (!isStoreConflict(error) || attempt >= MAX_UPSERT_ATTEMPTS) throw error;
    }
  }
}

/** Fetch Stripe's current object for a tie; anything but the same object id is treated as unavailable. */
function reconciler(fetchObject, family, id) {
  if (typeof fetchObject !== 'function') return null;
  return async () => {
    const current = await fetchObject(RECONCILE_KIND[family], id);
    return plain(current) && stripeId(current) === id ? current : null;
  };
}

/**
 * Apply one verified event to the store. Returns a small, log-safe summary.
 * `offers` is the configured offer map so unknown offer ids can be flagged;
 * `fetchObject(kind, id)` retrieves a Stripe object to reconcile same-second ties.
 */
export async function dispatchEvent(event, { store, offers = {}, fetchObject = null }) {
  if (!plain(event) || !plain(event.data) || !plain(event.data.object)) throw new TypeError('event shape invalid');
  const object = event.data.object;
  const ignored = (reason) => ({ outcome: 'ignored', reason, keys: [], offer: null, offer_known: false });
  const outcome = (result) => (result.stale ? 'stale' : 'processed');

  if (event.type.startsWith('checkout.session.')) {
    if (!HANDLED_EVENT_TYPES.includes(event.type)) return ignored('unhandled_type');
    const sessionId = stripeId(object);
    if (!sessionId) return ignored('missing_id');
    const { offer, known } = offerOf(object, offers);
    const sessionPatch = (source) => ({
      kind: 'checkout_session', offer, offer_known: known, mode: enumOr(source.mode, ['subscription', 'payment', 'setup']),
      status: enumOr(source.status, CHECKOUT_STATUSES), payment_status: enumOr(source.payment_status, PAYMENT_STATUSES),
      customer: stripeId(source.customer), subscription: stripeId(source.subscription), payment_intent: stripeId(source.payment_intent),
    });
    const reconcile = reconciler(fetchObject, 'checkout', sessionId);
    const session = await upsert(store, `cs:${sessionId}`, (_existing, current) => sessionPatch(current ?? object), event, 'checkout', reconcile);
    const keys = [session.record.key];
    const subscriptionId = stripeId(object.subscription);
    if (subscriptionId && event.type === 'checkout.session.completed') {
      const seeded = await upsert(store, `sub:${subscriptionId}`, (existing, current) => {
        const source = current ?? object;
        return {
          kind: 'subscription', offer: existing?.offer ?? offer, offer_known: existing?.offer_known ?? known, customer: stripeId(source.customer) ?? existing?.customer ?? null,
          status: existing?.status ?? PENDING_SUBSCRIPTION, checkout_session: sessionId,
        };
      }, event, 'checkout', reconcile);
      keys.push(seeded.record.key);
    }
    return { outcome: outcome(session), keys, offer, offer_known: known };
  }

  if (event.type.startsWith('customer.subscription.')) {
    if (!HANDLED_EVENT_TYPES.includes(event.type)) return ignored('unhandled_type');
    const subscriptionId = stripeId(object);
    if (!subscriptionId) return ignored('missing_id');
    const result = await upsert(store, `sub:${subscriptionId}`, (existing, current) => {
      const source = current ?? object;
      const meta = offerOf(source, offers);
      // A deleted subscription is canceled; Stripe's current object already reads that way.
      const status = current === null && event.type === 'customer.subscription.deleted' ? 'canceled' : enumOr(source.status, SUBSCRIPTION_STATUSES);
      return {
        kind: 'subscription',
        offer: meta.present ? meta.offer : (existing?.offer ?? null), offer_known: meta.present ? meta.known : (existing?.offer_known ?? false),
        customer: stripeId(source.customer) ?? existing?.customer ?? null, status,
        cancel_at_period_end: source.cancel_at_period_end === true,
        current_period_end: Number.isInteger(source.current_period_end) ? source.current_period_end : (existing?.current_period_end ?? null),
      };
    }, event, 'subscription', reconciler(fetchObject, 'subscription', subscriptionId));
    return { outcome: outcome(result), keys: [result.record.key], offer: result.record.offer ?? null, offer_known: result.record.offer_known === true };
  }

  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    // Newer Stripe API versions moved the subscription reference under `parent`.
    const subscriptionId = stripeId(object.subscription) ?? stripeId(object.parent?.subscription_details?.subscription);
    if (!subscriptionId) return ignored('no_subscription');
    const invoiceId = stripeId(object);
    const result = await upsert(store, `sub:${subscriptionId}`, (existing, current) => {
      const source = current ?? object;
      // From the event the type is authoritative; from a fetched invoice its status is.
      const invoiceStatus = current === null
        ? (event.type === 'invoice.paid' ? 'paid' : 'payment_failed')
        : (source.status === 'paid' ? 'paid' : source.status === 'open' || source.status === 'uncollectible' ? 'payment_failed' : (existing?.last_invoice_status ?? null));
      return {
        kind: 'subscription', offer: existing?.offer ?? null, offer_known: existing?.offer_known ?? false,
        customer: stripeId(source.customer) ?? existing?.customer ?? null, status: existing?.status ?? PENDING_SUBSCRIPTION,
        last_invoice: stripeId(source) ?? invoiceId, last_invoice_status: invoiceStatus,
      };
    }, event, 'invoice', invoiceId ? reconciler(fetchObject, 'invoice', invoiceId) : null);
    return { outcome: outcome(result), keys: [result.record.key], offer: result.record.offer ?? null, offer_known: result.record.offer_known === true };
  }

  return ignored('unhandled_type');
}
