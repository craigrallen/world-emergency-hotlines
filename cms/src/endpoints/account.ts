import { randomUUID } from 'node:crypto';
import type { Endpoint, Payload, PayloadRequest } from 'payload';
import { INTERNAL_CONTEXT, accountUser, type RequestUser } from '../access';
import { OFFER_ID } from '../collections/Plans';
import { describeEnv, getEnv, type StripeMode } from '../env';
import { createGatewayKey } from '../lib/gateway-keys';
import { EndpointError, fail, guarded, json, readJsonBody } from '../lib/responses';
import { CHECKOUT_ORIGIN, PORTAL_ORIGIN, getStripe } from '../lib/stripe';
import { customerField, customerOf } from '../lib/customers';
import { entitlementContext, policyOf, withEntitlement, type GatewayPolicy } from './gateway';
import { forEachActiveSubscription, inTransaction, lockRow, newerSubscription } from '../lib/subscriptions';
import { ACTIVE_STATUSES } from '../collections/Subscriptions';

type Doc = Record<string, unknown> & { id: string | number };
/** Revoked and expired keys shown on the account page (newest first); active keys are never truncated. */
export const INACTIVE_KEY_HISTORY = 50;

/**
 * The billing mode keys are granted in. A key reaches the gateway only in the mode the export
 * carries (`exportableKeys`): live keys always, test keys only while the CMS itself holds a test
 * key. With Stripe disabled the export carries live keys alone, so grants come from live-mode
 * subscriptions alone as well; a test key minted then could never authenticate.
 */
export const grantLivemode = (stripeMode: StripeMode): boolean => stripeMode !== 'test';

const relationId = (value: unknown): string | number | null => (typeof value === 'string' || typeof value === 'number' ? value : value && typeof value === 'object' && 'id' in value ? (value as { id: string | number }).id : null);

/** Bound on how many candidates a key mint tries before giving up (matches other CAS-retry loops in this codebase). */
const MAX_GRANT_ATTEMPTS = 5;

/**
 * Re-reads a candidate granting subscription under a row lock keyed the same way the webhook
 * path locks it (`stripe_subscription_id`), so the two paths serialize against each other: a
 * webhook that cancels the subscription or clears its plan either committed before this lock is
 * taken (and is then visible here) or blocks until this transaction commits. Also re-checks that
 * the subscription still belongs to the requesting user: an admin reassigning it away between the
 * unlocked read and this lock must not let the requester mint a key bound to someone else's
 * subscription, nor can its billing mode have drifted from the one being granted in. Returns the
 * current subscription, plan, and policy, or null when the candidate no longer qualifies to grant
 * a key.
 */
async function lockAndRevalidateGrant(payload: Payload, tx: PayloadRequest, userId: string | number, livemode: boolean, candidate: { subscription: Doc }): Promise<{ subscription: Doc; plan: Doc; policy: GatewayPolicy } | null> {
  await lockRow(payload, tx, 'subscriptions', 'stripe_subscription_id', String(candidate.subscription.stripeSubscriptionId));
  const subscription = (await payload.findByID({ collection: 'subscriptions', id: candidate.subscription.id, depth: 0, overrideAccess: true, disableErrors: true, req: tx })) as unknown as Doc | null;
  if (!subscription || !(ACTIVE_STATUSES as readonly string[]).includes(String(subscription.status))) return null;
  if (String(relationId(subscription.user)) !== String(userId)) return null;
  if (subscription.livemode !== livemode) return null;
  const planId = relationId(subscription.plan);
  if (planId === null) return null;
  const plan = (await payload.findByID({ collection: 'plans', id: planId, depth: 0, overrideAccess: true, disableErrors: true, req: tx })) as unknown as Doc | null;
  const policy = policyOf(plan ?? undefined);
  if (!plan || !policy) return null;
  return { subscription, plan, policy };
}

/**
 * The user's newest active subscription in this billing mode (null when there is none) and
 * the one that grants API keys: the newest whose plan resolves to a gateway policy. Every
 * active subscription is visited once, in pages keyed on the immutable id, so a webhook
 * moving `lastEventCreated` mid-walk cannot hide one; among those with a usable policy the
 * newest event wins. An active subscription on an unconfigured price, or one that lost its
 * plan, therefore never blocks an account that is entitled through another subscription,
 * however many there are; with no usable policy anywhere `granting` is null. Only the
 * granting subscription's plan decides a key's permissions and quota.
 */
async function entitlingSubscriptions(payload: Payload, userId: string | number, livemode: boolean | null, req?: PayloadRequest): Promise<{ newest: Doc | null; granting: { subscription: Doc; plan: Doc; policy: GatewayPolicy } | null }> {
  let newest: Doc | null = null;
  let granting: { subscription: Doc; plan: Doc; policy: GatewayPolicy } | null = null;
  await forEachActiveSubscription(payload, userId, livemode, req, async (page) => {
    const planIds = [...new Map(page.map((sub) => relationId(sub.plan)).filter((id): id is string | number => id !== null).map((id) => [String(id), id])).values()];
    const plans = new Map<string, Doc>();
    if (planIds.length) {
      const found = await payload.find({ collection: 'plans', where: { id: { in: planIds } }, limit: planIds.length, depth: 0, overrideAccess: true, req });
      for (const plan of found.docs as unknown as Doc[]) plans.set(String(plan.id), plan);
    }
    for (const subscription of page) {
      newest = newerSubscription(newest, subscription);
      const plan = plans.get(String(relationId(subscription.plan)));
      const policy = policyOf(plan);
      if (plan && policy && (granting === null || newerSubscription(granting.subscription, subscription) === subscription)) granting = { subscription, plan, policy };
    }
  });
  return { newest, granting };
}

const publicPlan = (plan: Doc) => ({ id: plan.offerId, label: plan.label, description: plan.description ?? '', mode: plan.mode });
const publicSubscription = (sub: Doc) => ({
  id: sub.stripeSubscriptionId, offer: sub.offer ?? null, status: sub.status, cancel_at_period_end: sub.cancelAtPeriodEnd === true,
  current_period_end: sub.currentPeriodEnd ?? null, livemode: sub.livemode === true, last_invoice_status: sub.lastInvoiceStatus ?? null, updated_at: sub.updatedAt,
});
// `storedState` defaults to the record's own (unprojected) state, right for a just-minted or
// just-revoked key. The account list passes the pre-projection state explicitly: entitlement
// projection can turn a stored-active key's shown `state` into "revoked" while its subscription is
// merely suspended (and may recover), but the member must still be able to permanently revoke that
// key, so `revocable` always reflects whether the record itself is still active, never the display.
const publicKey = (key: Doc, storedState: unknown = key.state) => ({
  id: key.keyId, label: key.label ?? null, state: key.state, revocable: storedState === 'active', livemode: key.livemode === true, not_before: key.notBefore ?? null, expires_at: key.expiresAt ?? null,
  permissions: key.permissions, quota: { rate: key.quotaRate, burst: key.quotaBurst }, created_at: key.createdAt, revoked_at: key.revokedAt ?? null,
});

/** Plans are read in pages of this size when the status response is assembled; every sellable plan is returned. */
export const PLAN_PAGE_SIZE = 50;

/**
 * Plans the account page may sell: active and subscription-mode. One-time payment plans
 * grant no entitlement here, so they are never offered. The account page renders plans from
 * this list alone and the response carries no pagination, so every matching plan is returned,
 * walked in pages keyed on the immutable id and sorted by offer id.
 */
export async function sellablePlans(payload: Payload, pageSize = PLAN_PAGE_SIZE): Promise<Doc[]> {
  const docs: Doc[] = [];
  let after: string | number | null = null;
  for (;;) {
    const and: Record<string, unknown>[] = [{ active: { equals: true } }, { mode: { equals: 'subscription' } }];
    if (after !== null) and.push({ id: { greater_than: after } });
    const page = (await payload.find({ collection: 'plans', where: { and } as never, sort: 'id', limit: pageSize, depth: 0, overrideAccess: true })).docs as unknown as Doc[];
    if (page.length === 0) break;
    docs.push(...page);
    after = page[page.length - 1].id;
    if (page.length < pageSize) break;
  }
  return docs.sort((a, b) => String(a.offerId).localeCompare(String(b.offerId)));
}

function requireAccount(req: PayloadRequest): RequestUser {
  const user = accountUser(req);
  if (!user) throw new EndpointError('unauthenticated');
  if (getEnv().requireEmailVerification && user._verified === false) throw new EndpointError('email_unverified');
  return user;
}

/** The account's Stripe customer for the billing mode this CMS runs in, created on first use; a customer from the other mode is never reused. */
async function ensureCustomer(payload: Payload, user: RequestUser, livemode: boolean): Promise<string> {
  const existing = customerOf(user, livemode);
  if (existing) return existing;
  const stripe = getStripe();
  if (!stripe) throw new EndpointError('stripe_disabled');
  let customer;
  try {
    customer = await stripe.customers.create({ email: user.email, ...(user.name ? { name: user.name } : {}), metadata: { cms_user: String(user.id) } }, { idempotencyKey: `cms-customer-${livemode ? 'live' : 'test'}-${user.id}` });
  } catch { throw new EndpointError('upstream_error'); }
  if (!/^cus_[A-Za-z0-9]{8,}$/.test(customer.id)) throw new EndpointError('upstream_error');
  await payload.update({ collection: 'users', id: user.id, data: { [customerField(livemode)]: customer.id }, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT } });
  return customer.id;
}

export const accountEndpoints: Endpoint[] = [
  {
    // Public: lets the static /account page discover whether accounts, billing, and key issuance are on.
    path: '/account/status', method: 'get',
    handler: (req) => guarded(req, async () => {
      const env = getEnv();
      const plans = env.stripeMode === 'disabled' ? [] : await sellablePlans(req.payload);
      const summary = describeEnv(env);
      return json(req, 200, {
        component: 'cms', status: 'enabled',
        accounts: { registration: summary.registration, email_verification: summary.email_verification },
        stripe: { mode: summary.stripe_mode, checkout: env.stripeMode !== 'disabled' && plans.length > 0, hosted_checkout_only: true },
        gateway: { key_issuance: summary.gateway_key_issuance },
        offers: plans.map(publicPlan),
        price_publication: 'not_published',
        free_static_surfaces_unchanged: true,
      });
    }),
  },
  {
    // Public: verifies an emailed token via the local API, in the request body rather than the URL
    // path Payload's own REST verify route uses, so the live token never appears in Caddy's access log.
    path: '/account/verify-email', method: 'post',
    handler: (req) => guarded(req, async () => {
      const body = await readJsonBody(req);
      if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(body.token)) throw new EndpointError('invalid_request');
      try { await req.payload.verifyEmail({ collection: 'users', token: body.token }); } catch { throw new EndpointError('verification_failed'); }
      return json(req, 200, { verified: true });
    }),
  },
  {
    path: '/account/me', method: 'get',
    handler: (req) => guarded(req, async () => {
      const user = requireAccount(req);
      const env = getEnv();
      // Every active key is returned (a member must be able to revoke each one that counts
      // toward the limit); revoked and expired keys are history, capped to the most recent.
      const [subscriptions, activeKeys, inactiveKeys, entitling] = await Promise.all([
        req.payload.find({ collection: 'subscriptions', where: { user: { equals: user.id } }, sort: '-lastEventCreated', limit: 20, depth: 0, overrideAccess: true }),
        req.payload.find({ collection: 'api-keys', where: { and: [{ user: { equals: user.id } }, { state: { equals: 'active' } }] }, sort: '-createdAt', limit: 10000, pagination: false, depth: 0, overrideAccess: true }),
        req.payload.find({ collection: 'api-keys', where: { and: [{ user: { equals: user.id } }, { state: { not_equals: 'active' } }] }, sort: '-createdAt', limit: INACTIVE_KEY_HISTORY, depth: 0, overrideAccess: true }),
        entitlingSubscriptions(req.payload, user.id, grantLivemode(env.stripeMode)),
      ]);
      // A key whose expiry has passed is expired whatever its stored state says (an admin-set expiry is not written back on
      // its own): it reads as expired here and never as active, and the mint path persists the transition before counting.
      const now = Date.now();
      const lapsed = (key: Doc) => typeof key.expiresAt === 'string' && Date.parse(key.expiresAt) <= now;
      const active = (activeKeys.docs as unknown as Doc[]).filter((key) => !lapsed(key));
      const expired = (activeKeys.docs as unknown as Doc[]).filter(lapsed).map((key): Doc => ({ ...key, state: 'expired' }));
      const stored = [...active, ...expired, ...(inactiveKeys.docs as unknown as Doc[])];
      const storedStates = new Map(stored.map((key) => [String(key.keyId), key.state]));
      // Shown state, permissions, and quota follow the same entitlement projection the gateway export
      // applies, not the values copied when the key was minted: a cancelled or downgraded granting
      // subscription must read here exactly as it will be enforced, never as a stale "active" record.
      const keys = withEntitlement(stored, await entitlementContext(req.payload, stored));
      // Entitlement is shown through the subscription that can grant keys; failing that, the newest active one.
      const entitled = entitling.granting?.subscription ?? entitling.newest;
      return json(req, 200, {
        user: { id: user.id, email: user.email, name: user.name ?? null, role: user.role, verified: user._verified !== false, created_at: user.createdAt ?? null, billing_customer_linked: env.stripeMode !== 'disabled' && customerOf(user, env.stripeMode === 'live') !== null },
        entitlement: { active: entitled !== null, offer: (entitled?.offer as string | undefined) ?? null },
        subscriptions: (subscriptions.docs as unknown as Doc[]).map(publicSubscription),
        api_keys: keys.map((key) => publicKey(key, storedStates.get(String(key.keyId)))),
        stripe: { mode: env.stripeMode },
        gateway: { key_issuance: env.gatewayKeyPepper !== null, max_keys: env.maxApiKeysPerUser },
      });
    }),
  },
  {
    // Account-bound hosted Checkout: the session carries the user id so the webhook links the subscription.
    path: '/account/checkout', method: 'post',
    handler: (req) => guarded(req, async () => {
      const user = requireAccount(req);
      const env = getEnv();
      const stripe = getStripe();
      if (!stripe) throw new EndpointError('stripe_disabled');
      const body = await readJsonBody(req);
      if (typeof body.offer !== 'string' || !OFFER_ID.test(body.offer)) throw new EndpointError('invalid_request');
      const plans = await req.payload.find({ collection: 'plans', where: { and: [{ offerId: { equals: body.offer } }, { active: { equals: true } }] }, limit: 1, depth: 0, overrideAccess: true });
      const plan = plans.docs[0] as unknown as Doc | undefined;
      if (!plan) throw new EndpointError('unknown_offer');
      // Entitlements are subscription facts; a one-time payment would charge without granting anything.
      if (plan.mode !== 'subscription') throw new EndpointError('unsupported_offer');
      const customer = await ensureCustomer(req.payload, user, env.stripeMode === 'live');
      const metadata = { offer: String(plan.offerId), cms_user: String(user.id) };
      let session;
      try {
        session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer,
          client_reference_id: String(user.id),
          line_items: [{ price: String(plan.stripePriceId), quantity: Number(plan.quantity) || 1 }],
          success_url: `${env.siteUrl}/account?checkout=success`,
          cancel_url: `${env.siteUrl}/account?checkout=cancelled`,
          metadata,
          subscription_data: { metadata },
        }, { idempotencyKey: randomUUID() });
      } catch { throw new EndpointError('upstream_error'); }
      if (typeof session.url !== 'string' || !session.url.startsWith(`${CHECKOUT_ORIGIN}/`)) throw new EndpointError('upstream_error');
      return json(req, 200, { url: session.url, id: session.id });
    }),
  },
  {
    path: '/account/portal', method: 'post',
    handler: (req) => guarded(req, async () => {
      const user = requireAccount(req);
      const env = getEnv();
      const stripe = getStripe();
      if (!stripe) throw new EndpointError('stripe_disabled');
      const customer = customerOf(user, env.stripeMode === 'live');
      if (!customer) throw new EndpointError('no_customer');
      let portal;
      try {
        portal = await stripe.billingPortal.sessions.create({ customer, return_url: `${env.siteUrl}/account` }, { idempotencyKey: randomUUID() });
      } catch { throw new EndpointError('upstream_error'); }
      if (typeof portal.url !== 'string' || !portal.url.startsWith(`${PORTAL_ORIGIN}/`)) throw new EndpointError('upstream_error');
      return json(req, 200, { url: portal.url });
    }),
  },
  {
    // Issue a managed API key. The raw key appears in this response only.
    path: '/account/api-keys', method: 'post',
    handler: (req) => guarded(req, async () => {
      const user = requireAccount(req);
      const env = getEnv();
      if (!env.gatewayKeyPepper) throw new EndpointError('keys_unavailable');
      const body = await readJsonBody(req);
      const label = body.label === undefined ? null : body.label;
      if (label !== null && (typeof label !== 'string' || label.length > 60)) throw new EndpointError('invalid_request');
      const key = createGatewayKey(env.gatewayKeyPepper);
      // Entitlement check, key count, and insert run under one transaction with the
      // user's row locked, so concurrent requests cannot exceed the per-user limit.
      const record = await inTransaction(req.payload, undefined, async (tx) => {
        await lockRow(req.payload, tx, 'users', 'id', user.id);
        const livemode = grantLivemode(env.stripeMode);
        const { newest, granting } = await entitlingSubscriptions(req.payload, user.id, livemode, tx);
        if (!newest) throw new EndpointError('no_entitlement');
        // Keys whose expiry has passed are expired, not active: the transition is persisted here, under the user's lock,
        // so an admin-set expiry that lapsed never counts against the limit or blocks a usable replacement.
        await req.payload.update({ collection: 'api-keys', where: { and: [{ user: { equals: user.id } }, { state: { equals: 'active' } }, { expiresAt: { less_than_equal: new Date().toISOString() } }] }, data: { state: 'expired' }, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT }, req: tx });
        const existing = await req.payload.count({ collection: 'api-keys', where: { and: [{ user: { equals: user.id } }, { state: { equals: 'active' } }] }, overrideAccess: true, req: tx });
        if (existing.totalDocs >= env.maxApiKeysPerUser) throw new EndpointError('key_limit');
        // The key's policy comes only from the plan attached to the granting subscription (the newest
        // active one with a resolvable policy). Active subscriptions without one (deleted plan, unknown
        // price) grant nothing, and when none has a policy there is no default to fall back to.
        //
        // Locking the user's row above serializes concurrent mint requests against each other, but a webhook that
        // cancels this subscription or clears its plan locks only the subscription row, not the user's, and can
        // commit in the gap between the read above and the key insert below. The candidate is re-read and locked by
        // its own row immediately before use, so such a webhook is either already visible here or blocks until this
        // transaction is done; a candidate that no longer qualifies is replaced by searching again, bounded so a
        // subscription that keeps changing cannot spin this forever.
        let confirmed = granting ? await lockAndRevalidateGrant(req.payload, tx, user.id, livemode, granting) : null;
        for (let attempt = 1; !confirmed && attempt < MAX_GRANT_ATTEMPTS; attempt += 1) {
          const retry = (await entitlingSubscriptions(req.payload, user.id, livemode, tx)).granting;
          if (!retry) break;
          confirmed = await lockAndRevalidateGrant(req.payload, tx, user.id, livemode, retry);
        }
        if (!confirmed) throw new EndpointError('plan_unconfigured');
        const { subscription: grantor, policy } = confirmed;
        return (await req.payload.create({
          collection: 'api-keys',
          data: {
            keyId: key.id, verifier: key.verifier, user: user.id as number, subscription: grantor.id as number, issuedBy: 'account', label, state: 'active', livemode: grantor.livemode === true,
            permissions: policy.permissions as ('manifest' | 'records' | 'resolver')[],
            quotaRate: policy.quotaRate, quotaBurst: policy.quotaBurst,
          },
          depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT }, req: tx,
        })) as unknown as Doc;
      });
      req.payload.logger.info({ user: user.id }, 'managed api key issued');
      return json(req, 201, { key: key.raw, record: publicKey(record), notice: 'Store this key now; it is not shown again and the CMS keeps only a verifier.' });
    }),
  },
  {
    path: '/account/api-keys/:keyId', method: 'delete',
    handler: (req) => guarded(req, async () => {
      const user = requireAccount(req);
      const keyId = req.routeParams?.keyId;
      if (typeof keyId !== 'string' || !/^[a-z0-9]{12}$/.test(keyId)) throw new EndpointError('invalid_request');
      const found = await req.payload.find({ collection: 'api-keys', where: { and: [{ keyId: { equals: keyId } }, { user: { equals: user.id } }] }, limit: 1, depth: 0, overrideAccess: true });
      const key = found.docs[0] as unknown as Doc | undefined;
      if (!key) return fail(req, 'not_found');
      const updated = key.state === 'revoked' ? key : ((await req.payload.update({ collection: 'api-keys', id: key.id, data: { state: 'revoked' }, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT } })) as unknown as Doc);
      return json(req, 200, { record: publicKey(updated) });
    }),
  },
];
