import { randomUUID } from 'node:crypto';
import type { Endpoint, Payload, PayloadRequest } from 'payload';
import { INTERNAL_CONTEXT, accountUser, type RequestUser } from '../access';
import { OFFER_ID } from '../collections/Plans';
import { describeEnv, getEnv } from '../env';
import { createGatewayKey } from '../lib/gateway-keys';
import { EndpointError, fail, guarded, json, readJsonBody } from '../lib/responses';
import { CHECKOUT_ORIGIN, PORTAL_ORIGIN, getStripe } from '../lib/stripe';
import { policyOf, type GatewayPolicy } from './gateway';
import { activeSubscriptionsFor, inTransaction, lockRow } from '../lib/subscriptions';

type Doc = Record<string, unknown> & { id: string | number };
/** Revoked and expired keys shown on the account page (newest first); active keys are never truncated. */
export const INACTIVE_KEY_HISTORY = 50;

const relationId = (value: unknown): string | number | null => (typeof value === 'string' || typeof value === 'number' ? value : value && typeof value === 'object' && 'id' in value ? (value as { id: string | number }).id : null);

/**
 * The user's active subscriptions in this billing mode (newest first) and, among them, the
 * one that grants API keys: the newest whose plan resolves to a gateway policy. An active
 * subscription on an unconfigured price, or one that lost its plan, therefore never blocks
 * an account that is entitled through another subscription; with no usable policy anywhere
 * `granting` is null. Only the granting subscription's plan decides a key's permissions and quota.
 */
async function entitlingSubscriptions(payload: Payload, userId: string | number, livemode: boolean | null, req?: PayloadRequest): Promise<{ active: Doc[]; granting: { subscription: Doc; plan: Doc; policy: GatewayPolicy } | null }> {
  const active = await activeSubscriptionsFor(payload, userId, livemode, req);
  const planIds = [...new Map(active.map((sub) => relationId(sub.plan)).filter((id): id is string | number => id !== null).map((id) => [String(id), id])).values()];
  const plans = new Map<string, Doc>();
  if (planIds.length) {
    const found = await payload.find({ collection: 'plans', where: { id: { in: planIds } }, limit: planIds.length, depth: 0, overrideAccess: true, req });
    for (const plan of found.docs as unknown as Doc[]) plans.set(String(plan.id), plan);
  }
  for (const subscription of active) {
    const plan = plans.get(String(relationId(subscription.plan)));
    const policy = policyOf(plan);
    if (plan && policy) return { active, granting: { subscription, plan, policy } };
  }
  return { active, granting: null };
}

const publicPlan = (plan: Doc) => ({ id: plan.offerId, label: plan.label, description: plan.description ?? '', mode: plan.mode });
const publicSubscription = (sub: Doc) => ({
  id: sub.stripeSubscriptionId, offer: sub.offer ?? null, status: sub.status, cancel_at_period_end: sub.cancelAtPeriodEnd === true,
  current_period_end: sub.currentPeriodEnd ?? null, livemode: sub.livemode === true, last_invoice_status: sub.lastInvoiceStatus ?? null, updated_at: sub.updatedAt,
});
const publicKey = (key: Doc) => ({
  id: key.keyId, label: key.label ?? null, state: key.state, livemode: key.livemode === true, not_before: key.notBefore ?? null, expires_at: key.expiresAt ?? null,
  permissions: key.permissions, quota: { rate: key.quotaRate, burst: key.quotaBurst }, created_at: key.createdAt, revoked_at: key.revokedAt ?? null,
});

/** Plans the account page may sell: active and subscription-mode. One-time payment plans grant no entitlement here, so they are never offered. */
async function sellablePlans(payload: Payload): Promise<Doc[]> {
  const result = await payload.find({ collection: 'plans', where: { and: [{ active: { equals: true } }, { mode: { equals: 'subscription' } }] }, sort: 'offerId', limit: 50, depth: 0, overrideAccess: true });
  return result.docs as unknown as Doc[];
}

function requireAccount(req: PayloadRequest): RequestUser {
  const user = accountUser(req);
  if (!user) throw new EndpointError('unauthenticated');
  if (getEnv().requireEmailVerification && user._verified === false) throw new EndpointError('email_unverified');
  return user;
}

async function ensureCustomer(payload: Payload, user: RequestUser): Promise<string> {
  if (typeof user.stripeCustomerId === 'string' && user.stripeCustomerId) return user.stripeCustomerId;
  const stripe = getStripe();
  if (!stripe) throw new EndpointError('stripe_disabled');
  let customer;
  try {
    customer = await stripe.customers.create({ email: user.email, ...(user.name ? { name: user.name } : {}), metadata: { cms_user: String(user.id) } }, { idempotencyKey: `cms-customer-${user.id}` });
  } catch { throw new EndpointError('upstream_error'); }
  if (!/^cus_[A-Za-z0-9]{8,}$/.test(customer.id)) throw new EndpointError('upstream_error');
  await payload.update({ collection: 'users', id: user.id, data: { stripeCustomerId: customer.id }, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT } });
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
        entitlingSubscriptions(req.payload, user.id, env.stripeMode === 'disabled' ? null : env.stripeMode === 'live'),
      ]);
      const keys = { docs: [...activeKeys.docs, ...inactiveKeys.docs] };
      // Entitlement is shown through the subscription that can grant keys; failing that, the newest active one.
      const active = entitling.granting?.subscription ?? entitling.active[0] ?? null;
      return json(req, 200, {
        user: { id: user.id, email: user.email, name: user.name ?? null, role: user.role, verified: user._verified !== false, created_at: user.createdAt ?? null, billing_customer_linked: typeof user.stripeCustomerId === 'string' && user.stripeCustomerId.length > 0 },
        entitlement: { active: active !== null, offer: (active?.offer as string | undefined) ?? null },
        subscriptions: (subscriptions.docs as unknown as Doc[]).map(publicSubscription),
        api_keys: (keys.docs as unknown as Doc[]).map(publicKey),
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
      const customer = await ensureCustomer(req.payload, user);
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
      if (typeof user.stripeCustomerId !== 'string' || !user.stripeCustomerId) throw new EndpointError('no_customer');
      let portal;
      try {
        portal = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${env.siteUrl}/account` }, { idempotencyKey: randomUUID() });
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
        const { active, granting } = await entitlingSubscriptions(req.payload, user.id, env.stripeMode === 'disabled' ? null : env.stripeMode === 'live', tx);
        if (active.length === 0) throw new EndpointError('no_entitlement');
        const existing = await req.payload.count({ collection: 'api-keys', where: { and: [{ user: { equals: user.id } }, { state: { equals: 'active' } }] }, overrideAccess: true, req: tx });
        if (existing.totalDocs >= env.maxApiKeysPerUser) throw new EndpointError('key_limit');
        // The key's policy comes only from the plan attached to the granting subscription (the newest
        // active one with a resolvable policy). Active subscriptions without one (deleted plan, unknown
        // price) grant nothing, and when none has a policy there is no default to fall back to.
        if (!granting) throw new EndpointError('plan_unconfigured');
        const { subscription: grantor, policy } = granting;
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
