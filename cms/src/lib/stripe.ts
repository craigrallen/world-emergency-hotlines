import Stripe from 'stripe';
import type { Payload } from 'payload';
import { ValidationError } from 'payload';
import { INTERNAL_CONTEXT } from '../access';
import { claimKeyFor, type EventSource } from '../collections/StripeEvents';
import { getEnv } from '../env';
import { applySubscriptionPatch, type SubscriptionPatch } from './subscriptions';

export const CHECKOUT_ORIGIN = 'https://checkout.stripe.com';
export const PORTAL_ORIGIN = 'https://billing.stripe.com';
export const HANDLED_EVENT_TYPES = Object.freeze([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed',
]);

let client: Stripe | null | undefined;

/** Stripe SDK client from the environment, or null while billing is disabled. */
export function getStripe(): Stripe | null {
  if (client !== undefined) return client;
  const env = getEnv();
  if (!env.stripeSecretKey) { client = null; return client; }
  const base = env.stripeApiBase ? new URL(env.stripeApiBase) : null;
  // The pinned version is the one this SDK's types describe; bump both together.
  const options: Stripe.StripeConfig = { apiVersion: '2026-08-26.dahlia', telemetry: false, maxNetworkRetries: 1, timeout: 15000, appInfo: { name: 'world-hotlines-cms', url: 'https://worldhotlines.org' } };
  if (base) { options.host = base.hostname; options.port = base.port; options.protocol = 'http'; }
  client = new Stripe(env.stripeSecretKey, options);
  return client;
}
export function resetStripeClient(): void { client = undefined; }

const stripeId = (value: unknown): string | null => {
  if (typeof value === 'string') return /^[a-z]{2,10}_(?:(?:test|live)_)?[A-Za-z0-9]{8,}$/.test(value) ? value : null;
  if (value && typeof value === 'object' && 'id' in value) return stripeId((value as { id: unknown }).id);
  return null;
};
const offerOf = (metadata: Stripe.Metadata | null | undefined): string | null => (metadata && typeof metadata.offer === 'string' && /^[a-z][a-z0-9_]{1,31}$/.test(metadata.offer) ? metadata.offer : null);
/** Account id carried in checkout/subscription metadata; numeric database ids come back as numbers. */
const userOf = (metadata: Stripe.Metadata | null | undefined, reference?: string | null): number | string | null => {
  const raw = (metadata && typeof metadata.cms_user === 'string' && metadata.cms_user) || (typeof reference === 'string' ? reference : '');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(raw)) return null;
  return /^\d{1,15}$/.test(raw) ? Number(raw) : raw;
};

/** How long an incomplete claim is trusted to be in progress before another delivery may take it over. */
export const CLAIM_GRACE_SECONDS = 120;
export type ClaimResult = 'claimed' | 'duplicate' | 'in_progress';

/**
 * First-writer-wins claim on the idempotency ledger. Claims are per consumer
 * (`claimKey` = source:eventId): the payments service keeps its own, so neither
 * consumer can mark an event done for the other. A claim is only a duplicate once
 * it carries an outcome; an incomplete claim younger than the grace period is
 * reported as in progress (the endpoint answers non-2xx so Stripe retries), and an
 * older one belongs to a worker that died before cleaning up and is taken over. A
 * failed delivery whose claim release also failed therefore stays retryable.
 */
export async function claimEvent(payload: Payload, event: Stripe.Event, source: EventSource = 'cms', now = Date.now()): Promise<ClaimResult> {
  const claimKey = claimKeyFor(source, event.id);
  try {
    await payload.create({ collection: 'stripe-events', data: { eventId: event.id, type: event.type, livemode: event.livemode, source, claimKey }, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT } });
    return 'claimed';
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
  const existing = (await payload.find({ collection: 'stripe-events', where: { claimKey: { equals: claimKey } }, limit: 1, depth: 0, overrideAccess: true })).docs[0];
  if (!existing) throw new Error('event claim was refused but is not recorded');
  if (typeof existing.outcome === 'string' && existing.outcome.length > 0) return 'duplicate';
  const updatedAt = Date.parse(String(existing.updatedAt));
  if (Number.isFinite(updatedAt) && now - updatedAt < CLAIM_GRACE_SECONDS * 1000) return 'in_progress';
  // Take the abandoned claim over; the update refreshes updatedAt so a second taker sees it as in progress.
  await payload.update({ collection: 'stripe-events', id: existing.id, data: { outcome: null, type: event.type, livemode: event.livemode }, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT } });
  return 'claimed';
}

export async function releaseEvent(payload: Payload, eventId: string, source: EventSource = 'cms'): Promise<void> {
  await payload.delete({ collection: 'stripe-events', where: { claimKey: { equals: claimKeyFor(source, eventId) } }, depth: 0, overrideAccess: true });
}

async function recordOutcome(payload: Payload, eventId: string, outcome: string, source: EventSource = 'cms'): Promise<void> {
  await payload.update({ collection: 'stripe-events', where: { claimKey: { equals: claimKeyFor(source, eventId) } }, data: { outcome }, depth: 0, overrideAccess: true });
}

async function linkCustomerToUser(payload: Payload, userId: number | string | null, customer: string | null): Promise<void> {
  if (!userId || !customer) return;
  const user = await payload.findByID({ collection: 'users', id: userId, depth: 0, overrideAccess: true, disableErrors: true });
  if (!user || user.stripeCustomerId === customer) return;
  if (user.stripeCustomerId) return; // never re-point an account at a different customer from a webhook
  await payload.update({ collection: 'users', id: user.id, data: { stripeCustomerId: customer }, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT } });
}

/** Subscription period end moved from the subscription to its items in newer Stripe API versions. */
export function periodEndOf(subscription: Stripe.Subscription): number | null {
  const legacy = (subscription as unknown as { current_period_end?: unknown }).current_period_end;
  if (Number.isInteger(legacy)) return legacy as number;
  const items = subscription.items?.data ?? [];
  const ends = items.map((item) => (item as unknown as { current_period_end?: unknown }).current_period_end).filter((value): value is number => Number.isInteger(value));
  return ends.length ? Math.max(...ends) : null;
}

/** Stripe client for a same-second reconciliation fetch; the webhook only runs with one configured. */
const stripeForReconcile = (): Stripe => {
  const stripe = getStripe();
  if (!stripe) throw new Error('stripe client is not configured; cannot reconcile a same-second event');
  return stripe;
};

function checkoutPatch(session: Stripe.Checkout.Session, livemode: boolean): SubscriptionPatch | null {
  const subscription = stripeId(session.subscription);
  if (!subscription) return null;
  return {
    stripeSubscriptionId: subscription, stripeCustomerId: stripeId(session.customer), user: userOf(session.metadata, session.client_reference_id), offer: offerOf(session.metadata),
    checkoutSessionId: stripeId(session) ?? undefined, livemode,
  };
}

function subscriptionPatch(subscription: Stripe.Subscription, livemode: boolean, deleted = false): SubscriptionPatch {
  const price = subscription.items?.data?.[0]?.price;
  return {
    stripeSubscriptionId: String(subscription.id), stripeCustomerId: stripeId(subscription.customer), user: userOf(subscription.metadata), offer: offerOf(subscription.metadata), stripePriceId: stripeId(price),
    status: deleted ? 'canceled' : subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true, currentPeriodEnd: periodEndOf(subscription), livemode,
  };
}

type InvoiceLike = Stripe.Invoice & { subscription?: unknown; parent?: { subscription_details?: { subscription?: unknown } } };
const invoiceSubscription = (invoice: InvoiceLike): string | null => stripeId(invoice.subscription) ?? stripeId(invoice.parent?.subscription_details?.subscription);
function invoicePatch(invoice: InvoiceLike, livemode: boolean, status: 'paid' | 'payment_failed' | null): SubscriptionPatch | null {
  const subscription = invoiceSubscription(invoice);
  if (!subscription) return null;
  return { stripeSubscriptionId: subscription, stripeCustomerId: stripeId(invoice.customer), livemode, lastInvoiceId: stripeId(invoice), lastInvoiceStatus: status ?? undefined };
}
/** From a fetched invoice its status is authoritative; anything not paid/open/uncollectible leaves the last status alone. */
const fetchedInvoiceStatus = (invoice: Stripe.Invoice): 'paid' | 'payment_failed' | null => (invoice.status === 'paid' ? 'paid' : invoice.status === 'open' || invoice.status === 'uncollectible' ? 'payment_failed' : null);

async function onCheckoutSession(payload: Payload, event: Stripe.Event): Promise<string> {
  const session = event.data.object as Stripe.Checkout.Session;
  const customer = stripeId(session.customer);
  const userId = userOf(session.metadata, session.client_reference_id);
  await linkCustomerToUser(payload, userId, customer);
  const patch = checkoutPatch(session, event.livemode);
  if (!patch) return 'no_subscription';
  const sessionId = stripeId(session);
  const result = await applySubscriptionPatch(payload, patch, {
    family: 'checkout', eventCreated: event.created, eventId: event.id, source: 'cms',
    reconcile: sessionId ? async () => checkoutPatch(await stripeForReconcile().checkout.sessions.retrieve(sessionId), event.livemode) : undefined,
  });
  return result ? 'processed' : 'stale';
}

async function onSubscription(payload: Payload, event: Stripe.Event): Promise<string> {
  const subscription = event.data.object as Stripe.Subscription;
  const id = stripeId(subscription);
  if (!id) return 'missing_id';
  await linkCustomerToUser(payload, userOf(subscription.metadata), stripeId(subscription.customer));
  const result = await applySubscriptionPatch(payload, subscriptionPatch(subscription, event.livemode, event.type === 'customer.subscription.deleted'), {
    family: 'subscription', eventCreated: event.created, eventId: event.id, source: 'cms',
    // Stripe's current object is authoritative for a tie (a deleted subscription reads as canceled).
    reconcile: async () => subscriptionPatch(await stripeForReconcile().subscriptions.retrieve(id), event.livemode),
  });
  return result ? 'processed' : 'stale';
}

async function onInvoice(payload: Payload, event: Stripe.Event): Promise<string> {
  const invoice = event.data.object as InvoiceLike;
  const patch = invoicePatch(invoice, event.livemode, event.type === 'invoice.paid' ? 'paid' : 'payment_failed');
  if (!patch) return 'no_subscription';
  const invoiceId = stripeId(invoice);
  const result = await applySubscriptionPatch(payload, patch, {
    family: 'invoice', eventCreated: event.created, eventId: event.id, source: 'cms',
    reconcile: invoiceId ? async () => { const current = await stripeForReconcile().invoices.retrieve(invoiceId); return invoicePatch(current as InvoiceLike, event.livemode, fetchedInvoiceStatus(current)); } : undefined,
  });
  return result ? 'processed' : 'stale';
}

/**
 * Apply one verified event. The webhook endpoint (`endpoints/stripe-webhook.ts`)
 * calls this after verifying the Stripe-Signature header and turns
 * `handler_failed` into a 500 so Stripe retries the delivery.
 */
export async function handleStripeEvent(payload: Payload, event: Stripe.Event): Promise<string> {
  const env = getEnv();
  if (event.livemode !== (env.stripeMode === 'live')) {
    payload.logger.warn({ event_type: event.type }, 'stripe event livemode does not match this deployment; ignored');
    return 'livemode_mismatch';
  }
  if (!HANDLED_EVENT_TYPES.includes(event.type)) return 'unhandled_type';
  const claim = await claimEvent(payload, event);
  if (claim !== 'claimed') return claim;
  let outcome: string;
  try {
    if (event.type.startsWith('checkout.session.')) outcome = await onCheckoutSession(payload, event);
    else if (event.type.startsWith('customer.subscription.')) outcome = await onSubscription(payload, event);
    else outcome = await onInvoice(payload, event);
  } catch (error) {
    // Release the claim before reporting failure: the endpoint answers 500 and
    // Stripe's automatic retry must not be turned away as a duplicate. If this
    // release fails too, the claim stays incomplete and claimEvent lets a later
    // retry take it over after the grace period.
    try { await releaseEvent(payload, event.id); } catch { /* see claimEvent: an incomplete claim is retryable */ }
    payload.logger.error({ err: error instanceof Error ? error.message : 'unknown', event_type: event.type }, 'stripe event handler failed');
    return 'handler_failed';
  }
  try { await recordOutcome(payload, event.id, outcome); } catch { /* outcome is informational */ }
  payload.logger.info({ event_type: event.type, outcome }, 'stripe event applied');
  return outcome;
}
