import type { Payload } from 'payload';
import { INTERNAL_CONTEXT } from '../access';
import { ACTIVE_STATUSES, SUBSCRIPTION_STATUSES } from '../collections/Subscriptions';

type Id = string | number;
type Doc = Record<string, unknown> & { id: Id };

export interface SubscriptionPatch {
  stripeSubscriptionId: string;
  stripeCustomerId?: string | null;
  user?: Id | null;
  plan?: Id | null;
  offer?: string | null;
  stripePriceId?: string | null;
  status?: string | null;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: number | null; // unix seconds
  livemode?: boolean;
  checkoutSessionId?: string | null;
  lastInvoiceId?: string | null;
  lastInvoiceStatus?: 'paid' | 'payment_failed' | null;
}

export interface ApplyOptions {
  eventCreated: number; // unix seconds of the Stripe event (or store record)
  eventId: string | null;
  source: 'cms' | 'payments';
}

const relationId = (value: unknown): Id | null => {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'id' in value) return (value as { id: Id }).id;
  return null;
};

const enumStatus = (value: unknown): string => (typeof value === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value) ? value : 'unknown');

async function findUserByCustomer(payload: Payload, customer: string | null | undefined): Promise<Id | null> {
  if (!customer) return null;
  const result = await payload.find({ collection: 'users', where: { stripeCustomerId: { equals: customer } }, limit: 1, depth: 0, overrideAccess: true });
  return result.docs[0]?.id ?? null;
}

async function findPlan(payload: Payload, offer: string | null | undefined, priceId: string | null | undefined): Promise<{ id: Id; offerId: string } | null> {
  if (priceId) {
    const byPrice = await payload.find({ collection: 'plans', where: { stripePriceId: { equals: priceId } }, limit: 1, depth: 0, overrideAccess: true });
    if (byPrice.docs[0]) return { id: byPrice.docs[0].id, offerId: byPrice.docs[0].offerId as string };
  }
  if (offer) {
    const byOffer = await payload.find({ collection: 'plans', where: { offerId: { equals: offer } }, limit: 1, depth: 0, overrideAccess: true });
    if (byOffer.docs[0]) return { id: byOffer.docs[0].id, offerId: byOffer.docs[0].offerId as string };
  }
  return null;
}

/**
 * Upsert one subscription mirror. Out-of-order deliveries are tolerated: an event
 * older than the newest one already applied never overwrites state. Returns the
 * stored document, or null when the event was stale.
 */
export async function applySubscriptionPatch(payload: Payload, patch: SubscriptionPatch, options: ApplyOptions): Promise<Doc | null> {
  const existingResult = await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: patch.stripeSubscriptionId } }, limit: 1, depth: 0, overrideAccess: true });
  const existing = (existingResult.docs[0] as unknown as Doc | undefined) ?? null;
  if (existing && typeof existing.lastEventCreated === 'number' && existing.lastEventCreated > options.eventCreated) return null;

  const customer = patch.stripeCustomerId ?? (existing?.stripeCustomerId as string | undefined) ?? null;
  const plan = (await findPlan(payload, patch.offer ?? (existing?.offer as string | undefined), patch.stripePriceId)) ?? null;
  const user = patch.user ?? relationId(existing?.user) ?? (await findUserByCustomer(payload, customer));

  const data: Record<string, unknown> = {
    stripeSubscriptionId: patch.stripeSubscriptionId,
    stripeCustomerId: customer,
    user,
    plan: plan?.id ?? relationId(existing?.plan) ?? null,
    offer: patch.offer ?? plan?.offerId ?? (existing?.offer as string | undefined) ?? null,
    status: patch.status !== undefined && patch.status !== null ? enumStatus(patch.status) : ((existing?.status as string | undefined) ?? 'pending_subscription_event'),
    cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? (existing?.cancelAtPeriodEnd as boolean | undefined) ?? false,
    currentPeriodEnd: patch.currentPeriodEnd !== undefined && patch.currentPeriodEnd !== null ? new Date(patch.currentPeriodEnd * 1000).toISOString() : ((existing?.currentPeriodEnd as string | undefined) ?? null),
    livemode: patch.livemode ?? (existing?.livemode as boolean | undefined) ?? false,
    checkoutSessionId: patch.checkoutSessionId ?? (existing?.checkoutSessionId as string | undefined) ?? null,
    lastInvoiceId: patch.lastInvoiceId ?? (existing?.lastInvoiceId as string | undefined) ?? null,
    lastInvoiceStatus: patch.lastInvoiceStatus ?? (existing?.lastInvoiceStatus as string | undefined) ?? null,
    lastEventCreated: options.eventCreated,
    lastEventId: options.eventId,
    source: options.source,
  };

  if (existing) {
    return (await payload.update({ collection: 'subscriptions', id: existing.id, data, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT } })) as unknown as Doc;
  }
  try {
    return (await payload.create({ collection: 'subscriptions', data: data as never, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT } })) as unknown as Doc;
  } catch (error) {
    // Lost a create race with a concurrent webhook: update the winner instead.
    const raced = await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: patch.stripeSubscriptionId } }, limit: 1, depth: 0, overrideAccess: true });
    const winner = raced.docs[0] as unknown as Doc | undefined;
    if (!winner) throw error;
    if (typeof winner.lastEventCreated === 'number' && winner.lastEventCreated > options.eventCreated) return null;
    return (await payload.update({ collection: 'subscriptions', id: winner.id, data, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT } })) as unknown as Doc;
  }
}

/** Mirror a payments-service `sub:` entitlement record into the subscriptions collection. */
export async function syncSubscriptionFromEntitlement(payload: Payload, doc: Record<string, unknown>): Promise<Doc | null> {
  const record = (doc.record && typeof doc.record === 'object' ? doc.record : {}) as Record<string, unknown>;
  const subscriptionId = typeof doc.subscription === 'string' && doc.subscription ? doc.subscription : String(doc.key ?? '').replace(/^sub:/, '');
  if (!/^sub_[A-Za-z0-9]{8,}$/.test(subscriptionId)) return null;
  const invoiceStatus = record.last_invoice_status === 'paid' || record.last_invoice_status === 'payment_failed' ? record.last_invoice_status : undefined;
  return applySubscriptionPatch(payload, {
    stripeSubscriptionId: subscriptionId,
    stripeCustomerId: typeof doc.customer === 'string' ? doc.customer : null,
    offer: typeof doc.offer === 'string' ? doc.offer : null,
    status: typeof doc.status === 'string' ? doc.status : null,
    cancelAtPeriodEnd: record.cancel_at_period_end === true,
    currentPeriodEnd: Number.isInteger(record.current_period_end) ? (record.current_period_end as number) : undefined,
    livemode: doc.livemode === true,
    checkoutSessionId: typeof record.checkout_session === 'string' ? record.checkout_session : undefined,
    lastInvoiceId: typeof record.last_invoice === 'string' ? record.last_invoice : undefined,
    lastInvoiceStatus: invoiceStatus,
  }, {
    eventCreated: Number.isInteger(doc.updatedAtEpoch) ? (doc.updatedAtEpoch as number) : Math.floor(Date.now() / 1000),
    eventId: typeof doc.sourceEvent === 'string' ? doc.sourceEvent : null,
    source: 'payments',
  });
}

/** The newest active (or trialing) subscription for a user, or null. */
export async function activeSubscriptionFor(payload: Payload, userId: Id, livemode: boolean | null = null): Promise<Doc | null> {
  const where: Record<string, unknown> = { and: [{ user: { equals: userId } }, { status: { in: [...ACTIVE_STATUSES] } }] };
  if (livemode !== null) (where.and as unknown[]).push({ livemode: { equals: livemode } });
  const result = await payload.find({ collection: 'subscriptions', where: where as never, sort: '-lastEventCreated', limit: 1, depth: 0, overrideAccess: true });
  return (result.docs[0] as unknown as Doc | undefined) ?? null;
}
