import type { Payload, PayloadRequest } from 'payload';
import { commitTransaction, createLocalReq, initTransaction, killTransaction, ValidationError } from 'payload';
import { sql } from '@payloadcms/db-postgres';
import { INTERNAL_CONTEXT } from '../access';
import { ACTIVE_STATUSES, SUBSCRIPTION_STATUSES } from '../collections/Subscriptions';
import { CUSTOMER_FIELDS, customerField } from './customers';

type Id = string | number;
export type SubscriptionDoc = Record<string, unknown> & { id: Id };
type Doc = SubscriptionDoc;

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
   * Current-state resolver. Whole-second `created` values cannot order two events
   * from the same second or version a fetched snapshot. Once a family has a watermark, the
   * payload is not trusted: this returns the patch to apply instead (Stripe's current
   * object for webhooks; see `syncSubscriptionFromEntitlement` for the payments mirror).
   * It receives the stored document as read under the row lock. Without it, or when
   * it returns null, the tied event is treated as stale.
   */
  reconcile?: (existing: Doc | null, ordering: 'tie' | 'newer') => Promise<SubscriptionPatch | null>;
}

/**
 * Current-state resolver for the payments mirror (ties and newer events): Stripe's current object for the
 * family, as the webhook handlers use (`lib/stripe.ts` builds one from the CMS's
 * Stripe client). Ordering allows an incoming invoice fallback only for newer
 * events when Stripe has no latest invoice; ties must not resurrect old invoices.
 */
export type MirrorTieBreaker = (family: EventFamily, patch: SubscriptionPatch, ordering: 'tie' | 'newer') => Promise<SubscriptionPatch | null>;

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
  if (adapter.name !== 'postgres') return;
  if (!tx.transactionID) throw new Error('Postgres row lock requires a transaction');
  const session = adapter.sessions?.[String(tx.transactionID)]?.db;
  if (!session) throw new Error('Postgres transaction session is unavailable');
  const table = adapter.tableNameMap?.get(collection) ?? collection.replace(/-/g, '_');
  await session.execute(sql`SELECT id FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${value} FOR UPDATE`);
}

/**
 * `id` when that user still exists, else null. Stripe keeps `cms_user` in metadata after
 * an account is deleted (Postgres nulls the relation, SQLite may not), so neither the
 * metadata id nor a stored relation is written back without this check: a deleted id
 * would violate the relationship and turn every later event for the subscription into
 * a failed, endlessly retried delivery.
 */
async function liveUser(payload: Payload, tx: PayloadRequest, id: Id | null | undefined): Promise<Id | null> {
  if (id === null || id === undefined) return null;
  // Collections use integer ids; anything else cannot name a user and must not reach the database inside this transaction.
  if (typeof id !== 'number' && !/^\d{1,15}$/.test(String(id))) return null;
  const result = await payload.count({ collection: 'users', where: { id: { equals: id } }, overrideAccess: true, req: tx });
  return result.totalDocs > 0 ? id : null;
}

/** The account holding `customer` in the given billing mode (either mode when unknown); test and live customers are stored apart. */
async function findUserByCustomer(payload: Payload, tx: PayloadRequest, customer: string | null | undefined, livemode: boolean | null | undefined): Promise<Id | null> {
  if (!customer) return null;
  const where = typeof livemode === 'boolean' ? { [customerField(livemode)]: { equals: customer } } : { or: CUSTOMER_FIELDS.map((field) => ({ [field]: { equals: customer } })) };
  const result = await payload.find({ collection: 'users', where: where as never, limit: 1, depth: 0, overrideAccess: true, req: tx });
  return result.docs[0]?.id ?? null;
}

type PlanRef = { id: Id; offerId: string | null };

async function planWhere(payload: Payload, tx: PayloadRequest, where: Record<string, unknown>): Promise<PlanRef | null> {
  const result = await payload.find({ collection: 'plans', where: where as never, limit: 1, depth: 0, overrideAccess: true, req: tx });
  return result.docs[0] ? { id: result.docs[0].id, offerId: (result.docs[0].offerId as string) ?? null } : null;
}

/**
 * Which plan a subscription is on. An explicit billed price (unique per plan) is the
 * only source of truth: an unknown price resolves to no plan, clearing any prior one,
 * so a subscription moved to an unconfigured product grants nothing (no key policy,
 * keys exported revoked) instead of keeping the old plan through stale offer
 * metadata. A patch without a price keeps the plan the record already has. Offer
 * metadata seeds a plan only while no billed price is known at all (a checkout seed,
 * a payments record that predates prices); once a price was recorded and resolved to
 * no plan, the payments mirror replaying the old offer cannot bring that plan back.
 * `byPrice` says the billed price decided, so the stored offer follows the plan.
 */
async function resolvePlan(payload: Payload, tx: PayloadRequest, patch: SubscriptionPatch, existing: Doc | null): Promise<{ plan: PlanRef | null; byPrice: boolean }> {
  if (typeof patch.stripePriceId === 'string' && patch.stripePriceId.length > 0) {
    return { plan: await planWhere(payload, tx, { stripePriceId: { equals: patch.stripePriceId } }), byPrice: true };
  }
  const kept = relationId(existing?.plan);
  if (kept !== null) return { plan: { id: kept, offerId: (existing?.offer as string | undefined) ?? null }, byPrice: false };
  if (typeof existing?.stripePriceId === 'string' && existing.stripePriceId.length > 0) return { plan: null, byPrice: true };
  const hint = patch.offer ?? (existing?.offer as string | undefined);
  return { plan: hint ? await planWhere(payload, tx, { offerId: { equals: hint } }) : null, byPrice: false };
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
        // A fetched snapshot has no historical event version. Every later accepted
        // delivery must fetch again, including events from a later second.
        if (mark === options.eventCreated || options.reconcile) {
          const current = options.reconcile ? await options.reconcile(existing, mark === options.eventCreated ? 'tie' : 'newer') : null;
          if (!current) return null;
          applied = current;
        }
      }
      const patch = applied;

      const customer = patch.stripeCustomerId ?? (existing?.stripeCustomerId as string | undefined) ?? null;
      const { plan, byPrice } = await resolvePlan(payload, tx, patch, existing);
      const user = (await liveUser(payload, tx, patch.user)) ?? (await liveUser(payload, tx, relationId(existing?.user))) ?? (await findUserByCustomer(payload, tx, customer, patch.livemode ?? (existing?.livemode as boolean | undefined)));

      const data: Record<string, unknown> = {
        stripeSubscriptionId: patch.stripeSubscriptionId,
        stripeCustomerId: customer,
        user,
        plan: plan?.id ?? null,
        stripePriceId: typeof patch.stripePriceId === 'string' && patch.stripePriceId.length > 0 ? patch.stripePriceId : ((existing?.stripePriceId as string | undefined) ?? null),
        // When the billed price decided, the resolved plan decides the offer (none when the price is unknown here);
        // otherwise the offer metadata, then the kept or seeded plan's offer, then the stored offer.
        offer: byPrice ? (plan?.offerId ?? null) : (patch.offer ?? plan?.offerId ?? (existing?.offer as string | undefined) ?? null),
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

const sameValue = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

/**
 * True when applying `patch` would leave the fields its family owns unchanged on
 * `existing`: the payments mirror replaying its own merged record (after an update
 * to another family) ties with state it wrote itself and changes nothing.
 */
export function familyUnchanged(family: EventFamily, patch: SubscriptionPatch, existing: Doc): boolean {
  if (patch.stripeCustomerId && !sameValue(patch.stripeCustomerId, existing.stripeCustomerId)) return false;
  if (family === 'checkout') return patch.checkoutSessionId === undefined || sameValue(patch.checkoutSessionId, existing.checkoutSessionId);
  if (family === 'invoice') {
    return (patch.lastInvoiceId === undefined || sameValue(patch.lastInvoiceId, existing.lastInvoiceId))
      && (patch.lastInvoiceStatus === undefined || sameValue(patch.lastInvoiceStatus, existing.lastInvoiceStatus));
  }
  const periodEnd = patch.currentPeriodEnd === undefined || patch.currentPeriodEnd === null ? undefined : new Date(patch.currentPeriodEnd * 1000).toISOString();
  return (patch.status === undefined || patch.status === null || sameValue(enumStatus(patch.status), existing.status))
    && (patch.cancelAtPeriodEnd === undefined || patch.cancelAtPeriodEnd === (existing.cancelAtPeriodEnd === true))
    && (periodEnd === undefined || sameValue(periodEnd, existing.currentPeriodEnd))
    && (!patch.stripePriceId || sameValue(patch.stripePriceId, existing.stripePriceId));
}

/**
 * Mirror a payments-service `sub:` entitlement record into the subscriptions
 * collection. The record is a merged view carrying one watermark per event family
 * (`<family>_event_epoch`, see payments/src/events.mjs), so each family's fields
 * are applied under their own watermark; a record that predates the per-family
 * epochs falls back to `updated_at_epoch`.
 *
 * A same-epoch tie is the mirror replaying its own record when the family's fields
 * are unchanged, and applies. Different fields at an equal epoch mean the two Stripe
 * consumers (this CMS's webhook and the payments service) applied different events
 * from the same second; neither payload can be trusted for order, so `tieBreaker`
 * (Stripe's current object) decides, and its failure fails this write so the
 * payments service fails its delivery and Stripe retries. With no tie breaker this
 * CMS has no webhook consumer and the payments record, the only writer, applies.
 */
export async function syncSubscriptionFromEntitlement(payload: Payload, doc: Record<string, unknown>, req?: PayloadRequest, tieBreaker: MirrorTieBreaker | null = null): Promise<Doc | null> {
  const record = (doc.record && typeof doc.record === 'object' ? doc.record : {}) as Record<string, unknown>;
  const subscriptionId = typeof doc.subscription === 'string' && doc.subscription ? doc.subscription : String(doc.key ?? '').replace(/^sub:/, '');
  if (!/^sub_[A-Za-z0-9]{8,}$/.test(subscriptionId)) return null;
  const fallbackEpoch = Number.isInteger(doc.updatedAtEpoch) ? (doc.updatedAtEpoch as number) : Math.floor(Date.now() / 1000);
  const epochOf = (family: EventFamily): number => (Number.isInteger(record[`${family}_event_epoch`]) ? (record[`${family}_event_epoch`] as number) : fallbackEpoch);
  const base = { stripeSubscriptionId: subscriptionId, stripeCustomerId: typeof doc.customer === 'string' ? doc.customer : null, livemode: doc.livemode === true };
  const meta = { eventId: typeof doc.sourceEvent === 'string' ? doc.sourceEvent : null, source: 'payments' as const };
  const invoiceStatus = record.last_invoice_status === 'paid' || record.last_invoice_status === 'payment_failed' ? record.last_invoice_status : undefined;

  const settle = (family: EventFamily, patch: SubscriptionPatch) => async (existing: Doc | null, ordering: 'tie' | 'newer'): Promise<SubscriptionPatch | null> => {
    if (existing && familyUnchanged(family, patch, existing)) return patch;
    return tieBreaker ? tieBreaker(family, patch, ordering) : patch;
  };
  const apply = (patch: SubscriptionPatch, family: EventFamily) => applySubscriptionPatch(payload, patch, { ...meta, family, eventCreated: epochOf(family), reconcile: settle(family, patch) }, req);
  let result: Doc | null = null;
  // Applied only when this delivery actually carries checkout-family data (a session, an offer, or the
  // family's own watermark): otherwise there is nothing to write, and stamping the watermark anyway
  // (borrowing updated_at_epoch as epochOf's fallback) would reject a genuinely older checkout delivery
  // that later supplies the family's first real data as stale.
  if (typeof record.checkout_session === 'string' || typeof doc.offer === 'string' || Number.isInteger(record.checkout_event_epoch)) {
    const applied = await apply({
      ...base, offer: typeof doc.offer === 'string' ? doc.offer : null,
      checkoutSessionId: typeof record.checkout_session === 'string' ? record.checkout_session : undefined,
    }, 'checkout');
    result = applied ?? result;
  }
  if (typeof doc.status === 'string' && doc.status !== 'pending_subscription_event') {
    const applied2 = await apply({
      ...base, status: doc.status, cancelAtPeriodEnd: record.cancel_at_period_end === true,
      currentPeriodEnd: Number.isInteger(record.current_period_end) ? (record.current_period_end as number) : undefined,
      // The billed price the payments service saw on the subscription (payments/src/events.mjs); the plan follows it.
      stripePriceId: typeof record.price === 'string' && /^price_[A-Za-z0-9]{8,}$/.test(record.price) ? record.price : undefined,
    }, 'subscription');
    result = applied2 ?? result;
  }
  if (typeof record.last_invoice === 'string') {
    const applied3 = await apply({ ...base, lastInvoiceId: record.last_invoice, lastInvoiceStatus: invoiceStatus }, 'invoice');
    result = applied3 ?? result;
  }
  return result;
}

/**
 * One page of a user's active (or trialing) subscriptions in the given billing mode,
 * keyed on the immutable `id` (ascending; `after` is the last id of the previous page).
 * A walk over these pages visits every subscription that existed when it started exactly
 * once, however webhooks move `lastEventCreated` meanwhile; ordering by that mutable
 * field would let an updated row slip into a page already consumed and be missed.
 */
export async function activeSubscriptionsFor(payload: Payload, userId: Id, livemode: boolean | null = null, req?: PayloadRequest, { limit = 25, after = null }: { limit?: number; after?: Id | null } = {}): Promise<Doc[]> {
  const and: Record<string, unknown>[] = [{ user: { equals: userId } }, { status: { in: [...ACTIVE_STATUSES] } }];
  if (livemode !== null) and.push({ livemode: { equals: livemode } });
  if (after !== null) and.push({ id: { greater_than: after } });
  const result = await payload.find({ collection: 'subscriptions', where: { and } as never, sort: 'id', limit, depth: 0, overrideAccess: true, req });
  return result.docs as unknown as Doc[];
}

/** Visit every active (or trialing) subscription of a user once, in stable id pages. */
export async function forEachActiveSubscription(payload: Payload, userId: Id, livemode: boolean | null, req: PayloadRequest | undefined, visit: (page: Doc[]) => void | Promise<void>, pageSize = 25): Promise<void> {
  let after: Id | null = null;
  for (;;) {
    const page = await activeSubscriptionsFor(payload, userId, livemode, req, { limit: pageSize, after });
    if (page.length === 0) return;
    await visit(page);
    after = page[page.length - 1].id;
    if (page.length < pageSize) return;
  }
}

const eventStamp = (doc: Doc | null): number => (doc && typeof doc.lastEventCreated === 'number' ? (doc.lastEventCreated as number) : -1);
/** The later of two subscriptions by newest applied event (the first wins a tie). */
export const newerSubscription = (a: Doc | null, b: Doc): Doc => (eventStamp(b) > eventStamp(a) ? b : (a ?? b));

/** The active (or trialing) subscription with the newest applied event for a user, or null. */
export async function activeSubscriptionFor(payload: Payload, userId: Id, livemode: boolean | null = null, req?: PayloadRequest): Promise<Doc | null> {
  let newest: Doc | null = null;
  await forEachActiveSubscription(payload, userId, livemode, req, (page) => { for (const doc of page) newest = newerSubscription(newest, doc); });
  return newest;
}
