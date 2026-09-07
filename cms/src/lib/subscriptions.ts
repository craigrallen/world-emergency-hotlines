import type { Payload, PayloadRequest } from 'payload';
import { commitTransaction, createLocalReq, initTransaction, killTransaction, ValidationError } from 'payload';
import { sql } from '@payloadcms/db-postgres';
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

export type EventFamily = 'checkout' | 'subscription' | 'invoice';
export const EVENT_FAMILIES: readonly EventFamily[] = Object.freeze(['checkout', 'subscription', 'invoice'] as const);
export const FAMILY_WATERMARK: Record<EventFamily, 'lastCheckoutEventCreated' | 'lastSubscriptionEventCreated' | 'lastInvoiceEventCreated'> = {
  checkout: 'lastCheckoutEventCreated', subscription: 'lastSubscriptionEventCreated', invoice: 'lastInvoiceEventCreated',
};

export interface ApplyOptions {
  /** Which Stripe event family produced the patch; ordering is enforced per family so a delayed status event is never discarded because a later checkout or invoice event arrived first. */
  family: EventFamily;
  eventCreated: number; // unix seconds of the Stripe event (or store record)
  eventId: string | null;
  source: 'cms' | 'payments';
  /**
   * Same-second tie resolver. Whole-second `created` values cannot order two events
   * from the same second, so when the family's watermark equals `eventCreated` the
   * payload is not trusted: this returns the patch to apply instead (Stripe's current
   * object for webhooks; the already-merged store record for the payments mirror).
   * Without it, or when it returns null, the tied event is treated as stale.
   */
  reconcile?: () => Promise<SubscriptionPatch | null>;
}

interface DrizzleSession { db: { execute(query: unknown): Promise<unknown> } }
interface DrizzleAdapterLike { name?: string; sessions?: Record<string, DrizzleSession>; tableNameMap?: Map<string, string> }

const relationId = (value: unknown): Id | null => {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'id' in value) return (value as { id: Id }).id;
  return null;
};

const enumStatus = (value: unknown): string => (typeof value === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value) ? value : 'unknown');

/**
 * Run `work` inside a database transaction. A caller that already holds one (a
 * collection hook, for example) shares it; otherwise a local transaction is
 * opened and committed, or rolled back when `work` throws.
 */
export async function inTransaction<T>(payload: Payload, req: PayloadRequest | undefined, work: (tx: PayloadRequest) => Promise<T>): Promise<T> {
  if (req?.transactionID) return work(req);
  const local = await createLocalReq({}, payload);
  const started = await initTransaction(local);
  try {
    const result = await work(local);
    if (started) await commitTransaction(local);
    return result;
  } catch (error) {
    if (started) await killTransaction(local);
    throw error;
  }
}

/**
 * Serialise concurrent writers on one row. On Postgres this is `SELECT … FOR
 * UPDATE` inside the current transaction, so a second webhook for the same
 * subscription (or a second key request for the same user) waits for the first
 * to commit and then re-reads committed state. SQLite (development and tests)
 * serialises write transactions itself, so this is a no-op there.
 */
export async function lockRow(payload: Payload, tx: PayloadRequest, collection: string, column: string, value: Id): Promise<void> {
  const adapter = payload.db as unknown as DrizzleAdapterLike;
  if (adapter.name !== 'postgres' || !tx.transactionID) return;
  const session = adapter.sessions?.[String(tx.transactionID)]?.db;
  if (!session) return;
  const table = adapter.tableNameMap?.get(collection) ?? collection.replace(/-/g, '_');
  await session.execute(sql`SELECT id FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${value} FOR UPDATE`);
}

async function findUserByCustomer(payload: Payload, tx: PayloadRequest, customer: string | null | undefined): Promise<Id | null> {
  if (!customer) return null;
  const result = await payload.find({ collection: 'users', where: { stripeCustomerId: { equals: customer } }, limit: 1, depth: 0, overrideAccess: true, req: tx });
  return result.docs[0]?.id ?? null;
}

async function findPlan(payload: Payload, tx: PayloadRequest, offer: string | null | undefined, priceId: string | null | undefined): Promise<{ id: Id; offerId: string } | null> {
  if (priceId) {
    const byPrice = await payload.find({ collection: 'plans', where: { stripePriceId: { equals: priceId } }, limit: 1, depth: 0, overrideAccess: true, req: tx });
    if (byPrice.docs[0]) return { id: byPrice.docs[0].id, offerId: byPrice.docs[0].offerId as string };
  }
  if (offer) {
    const byOffer = await payload.find({ collection: 'plans', where: { offerId: { equals: offer } }, limit: 1, depth: 0, overrideAccess: true, req: tx });
    if (byOffer.docs[0]) return { id: byOffer.docs[0].id, offerId: byOffer.docs[0].offerId as string };
  }
  return null;
}

async function subscriptionExists(payload: Payload, id: string): Promise<boolean> {
  const result = await payload.count({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: id } }, overrideAccess: true });
  return result.totalDocs > 0;
}

/**
 * Upsert one subscription mirror. The stale-event check and the write happen
 * under the same transaction and row lock, so an older event can never overwrite
 * a newer one even when two webhook deliveries race. Returns the stored
 * document, or null when the event was stale.
 */
export async function applySubscriptionPatch(payload: Payload, incoming: SubscriptionPatch, options: ApplyOptions, req?: PayloadRequest, attempt = 0): Promise<Doc | null> {
  try {
    return await inTransaction(payload, req, async (tx) => {
      await lockRow(payload, tx, 'subscriptions', 'stripe_subscription_id', incoming.stripeSubscriptionId);
      const existingResult = await payload.find({ collection: 'subscriptions', where: { stripeSubscriptionId: { equals: incoming.stripeSubscriptionId } }, limit: 1, depth: 0, overrideAccess: true, req: tx });
      const existing = (existingResult.docs[0] as unknown as Doc | undefined) ?? null;
      const watermark = FAMILY_WATERMARK[options.family];
      const mark = existing?.[watermark];
      let applied = incoming;
      if (typeof mark === 'number') {
        if (mark > options.eventCreated) return null;
        if (mark === options.eventCreated) {
          const current = options.reconcile ? await options.reconcile() : null;
          if (!current) return null;
          applied = current;
        }
      }
      const patch = applied;

      const customer = patch.stripeCustomerId ?? (existing?.stripeCustomerId as string | undefined) ?? null;
      const plan = (await findPlan(payload, tx, patch.offer ?? (existing?.offer as string | undefined), patch.stripePriceId)) ?? null;
      const user = patch.user ?? relationId(existing?.user) ?? (await findUserByCustomer(payload, tx, customer));

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
        lastEventCreated: Math.max(options.eventCreated, typeof existing?.lastEventCreated === 'number' ? (existing.lastEventCreated as number) : 0),
        lastEventId: options.eventId,
        [watermark]: options.eventCreated,
        source: options.source,
      };

      if (existing) {
        return (await payload.update({ collection: 'subscriptions', id: existing.id, data, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT }, req: tx })) as unknown as Doc;
      }
      return (await payload.create({ collection: 'subscriptions', data: data as never, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT }, req: tx })) as unknown as Doc;
    });
  } catch (error) {
    // Two first events for the same subscription can race to create it; the unique
    // index rejects the loser (a ValidationError) and aborts its transaction. With the
    // row now present, a fresh transaction takes the row lock and applies the patch as
    // an update. Any other failure (a reconciliation fetch, for example) and a
    // caller-owned transaction are not retried here: the error propagates and the
    // caller's retry (Stripe, or the payments service) replays the event.
    if (attempt === 0 && !req?.transactionID && error instanceof ValidationError && (await subscriptionExists(payload, incoming.stripeSubscriptionId))) {
      return applySubscriptionPatch(payload, incoming, options, req, attempt + 1);
    }
    throw error;
  }
}

/**
 * Mirror a payments-service `sub:` entitlement record into the subscriptions
 * collection. The record is a merged view carrying one watermark per event family
 * (`<family>_event_epoch`, see payments/src/events.mjs), so each family's fields
 * are applied under their own watermark; a record that predates the per-family
 * epochs falls back to `updated_at_epoch`.
 */
export async function syncSubscriptionFromEntitlement(payload: Payload, doc: Record<string, unknown>, req?: PayloadRequest): Promise<Doc | null> {
  const record = (doc.record && typeof doc.record === 'object' ? doc.record : {}) as Record<string, unknown>;
  const subscriptionId = typeof doc.subscription === 'string' && doc.subscription ? doc.subscription : String(doc.key ?? '').replace(/^sub:/, '');
  if (!/^sub_[A-Za-z0-9]{8,}$/.test(subscriptionId)) return null;
  const fallbackEpoch = Number.isInteger(doc.updatedAtEpoch) ? (doc.updatedAtEpoch as number) : Math.floor(Date.now() / 1000);
  const epochOf = (family: EventFamily): number => (Number.isInteger(record[`${family}_event_epoch`]) ? (record[`${family}_event_epoch`] as number) : fallbackEpoch);
  const base = { stripeSubscriptionId: subscriptionId, stripeCustomerId: typeof doc.customer === 'string' ? doc.customer : null, livemode: doc.livemode === true };
  const meta = { eventId: typeof doc.sourceEvent === 'string' ? doc.sourceEvent : null, source: 'payments' as const };
  const invoiceStatus = record.last_invoice_status === 'paid' || record.last_invoice_status === 'payment_failed' ? record.last_invoice_status : undefined;

  // The store record is already a merged, ordered view (the payments service reconciles
  // its own ties against Stripe), so a same-epoch tie applies it rather than refusing it.
  const apply = (patch: SubscriptionPatch, family: EventFamily) => applySubscriptionPatch(payload, patch, { ...meta, family, eventCreated: epochOf(family), reconcile: async () => patch }, req);
  let result: Doc | null = null;
  const applied = await apply({
    ...base, offer: typeof doc.offer === 'string' ? doc.offer : null,
    checkoutSessionId: typeof record.checkout_session === 'string' ? record.checkout_session : undefined,
  }, 'checkout');
  result = applied ?? result;
  if (typeof doc.status === 'string' && doc.status !== 'pending_subscription_event') {
    const applied2 = await apply({
      ...base, status: doc.status, cancelAtPeriodEnd: record.cancel_at_period_end === true,
      currentPeriodEnd: Number.isInteger(record.current_period_end) ? (record.current_period_end as number) : undefined,
    }, 'subscription');
    result = applied2 ?? result;
  }
  if (typeof record.last_invoice === 'string') {
    const applied3 = await apply({ ...base, lastInvoiceId: record.last_invoice, lastInvoiceStatus: invoiceStatus }, 'invoice');
    result = applied3 ?? result;
  }
  return result;
}

/** The newest active (or trialing) subscription for a user, or null. */
export async function activeSubscriptionFor(payload: Payload, userId: Id, livemode: boolean | null = null, req?: PayloadRequest): Promise<Doc | null> {
  const where: Record<string, unknown> = { and: [{ user: { equals: userId } }, { status: { in: [...ACTIVE_STATUSES] } }] };
  if (livemode !== null) (where.and as unknown[]).push({ livemode: { equals: livemode } });
  const result = await payload.find({ collection: 'subscriptions', where: where as never, sort: '-lastEventCreated', limit: 1, depth: 0, overrideAccess: true, req });
  return (result.docs[0] as unknown as Doc | undefined) ?? null;
}
