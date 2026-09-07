import Stripe from 'stripe';
import type { Payload } from 'payload';
import { ValidationError } from 'payload';
import type { StripeWebhookHandler, StripeWebhookHandlers } from '@payloadcms/plugin-stripe/types';
import { INTERNAL_CONTEXT } from '../access';
import { getEnv } from '../env';
import { applySubscriptionPatch } from './subscriptions';

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

/** First-writer-wins claim on the shared idempotency ledger; false means already seen. */
export async function claimEvent(payload: Payload, event: Stripe.Event, source: 'cms' | 'payments' = 'cms'): Promise<boolean> {
  try {
    await payload.create({ collection: 'stripe-events', data: { eventId: event.id, type: event.type, livemode: event.livemode, source }, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT } });
    return true;
  } catch (error) {
    if (error instanceof ValidationError) return false;
    throw error;
  }
}

export async function releaseEvent(payload: Payload, eventId: string): Promise<void> {
  await payload.delete({ collection: 'stripe-events', where: { eventId: { equals: eventId } }, depth: 0, overrideAccess: true });
}

async function recordOutcome(payload: Payload, eventId: string, outcome: string): Promise<void> {
  await payload.update({ collection: 'stripe-events', where: { eventId: { equals: eventId } }, data: { outcome }, depth: 0, overrideAccess: true });
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

async function onCheckoutSession(payload: Payload, event: Stripe.Event): Promise<string> {
  const session = event.data.object as Stripe.Checkout.Session;
  const customer = stripeId(session.customer);
  const userId = userOf(session.metadata, session.client_reference_id);
  await linkCustomerToUser(payload, userId, customer);
  const subscription = stripeId(session.subscription);
  if (!subscription) return 'no_subscription';
  const result = await applySubscriptionPatch(payload, {
    stripeSubscriptionId: subscription, stripeCustomerId: customer, user: userId, offer: offerOf(session.metadata),
    checkoutSessionId: stripeId(session) ?? undefined, livemode: event.livemode,
  }, { eventCreated: event.created, eventId: event.id, source: 'cms' });
  return result ? 'processed' : 'stale';
}

async function onSubscription(payload: Payload, event: Stripe.Event): Promise<string> {
  const subscription = event.data.object as Stripe.Subscription;
  const id = stripeId(subscription);
  if (!id) return 'missing_id';
  const customer = stripeId(subscription.customer);
  const userId = userOf(subscription.metadata);
  await linkCustomerToUser(payload, userId, customer);
  const price = subscription.items?.data?.[0]?.price;
  const result = await applySubscriptionPatch(payload, {
    stripeSubscriptionId: id, stripeCustomerId: customer, user: userId, offer: offerOf(subscription.metadata), stripePriceId: stripeId(price),
    status: event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true, currentPeriodEnd: periodEndOf(subscription), livemode: event.livemode,
  }, { eventCreated: event.created, eventId: event.id, source: 'cms' });
  return result ? 'processed' : 'stale';
}

async function onInvoice(payload: Payload, event: Stripe.Event): Promise<string> {
  const invoice = event.data.object as Stripe.Invoice & { subscription?: unknown; parent?: { subscription_details?: { subscription?: unknown } } };
  const subscription = stripeId(invoice.subscription) ?? stripeId(invoice.parent?.subscription_details?.subscription);
  if (!subscription) return 'no_subscription';
  const result = await applySubscriptionPatch(payload, {
    stripeSubscriptionId: subscription, stripeCustomerId: stripeId(invoice.customer), livemode: event.livemode,
    lastInvoiceId: stripeId(invoice), lastInvoiceStatus: event.type === 'invoice.paid' ? 'paid' : 'payment_failed',
  }, { eventCreated: event.created, eventId: event.id, source: 'cms' });
  return result ? 'processed' : 'stale';
}

/**
 * Apply one verified event. Exported for tests; the plugin calls it through
 * `stripeWebhookHandlers` after verifying the Stripe-Signature header.
 */
export async function handleStripeEvent(payload: Payload, event: Stripe.Event): Promise<string> {
  const env = getEnv();
  if (event.livemode !== (env.stripeMode === 'live')) {
    payload.logger.warn({ event_type: event.type }, 'stripe event livemode does not match this deployment; ignored');
    return 'livemode_mismatch';
  }
  if (!HANDLED_EVENT_TYPES.includes(event.type)) return 'unhandled_type';
  if (!(await claimEvent(payload, event))) return 'duplicate';
  let outcome: string;
  try {
    if (event.type.startsWith('checkout.session.')) outcome = await onCheckoutSession(payload, event);
    else if (event.type.startsWith('customer.subscription.')) outcome = await onSubscription(payload, event);
    else outcome = await onInvoice(payload, event);
  } catch (error) {
    // The plugin has already answered 200, so release the claim: a Dashboard resend can reprocess it.
    try { await releaseEvent(payload, event.id); } catch { /* ledger cleanup is best effort */ }
    payload.logger.error({ err: error instanceof Error ? error.message : 'unknown', event_type: event.type }, 'stripe event handler failed');
    return 'handler_failed';
  }
  try { await recordOutcome(payload, event.id, outcome); } catch { /* outcome is informational */ }
  payload.logger.info({ event_type: event.type, outcome }, 'stripe event applied');
  return outcome;
}

const handler: StripeWebhookHandler<Stripe.Event> = async ({ event, payload }) => { await handleStripeEvent(payload, event); };

export const stripeWebhookHandlers: StripeWebhookHandlers = Object.fromEntries(HANDLED_EVENT_TYPES.map((type) => [type, handler]));
