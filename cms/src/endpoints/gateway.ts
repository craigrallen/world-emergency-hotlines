import type { Endpoint } from 'payload';
import type { Payload } from 'payload';
import { hasRole, isServiceRequest } from '../access';
import { ACTIVE_STATUSES } from '../collections/Subscriptions';
import { getEnv, type StripeMode } from '../env';
import { toGatewayRecord } from '../lib/gateway-keys';
import { fail, guarded, json } from '../lib/responses';

export const KEY_RECORDS_SCHEMA = 'gateway-key-records/v1';

/**
 * Live-mode keys are always exported. Keys minted from a test-mode subscription are
 * exported only while the CMS itself runs with a Stripe test key, so promoting a
 * deployment to live (or running without Stripe) drops them at the next sync.
 */
export function exportableKeys<T extends { livemode?: unknown }>(keys: T[], stripeMode: StripeMode): T[] {
  const includeTest = stripeMode === 'test';
  return keys.filter((key) => key.livemode === true || includeTest);
}

const relationId = (value: unknown): string | null => (typeof value === 'string' || typeof value === 'number' ? String(value) : value && typeof value === 'object' && 'id' in value ? String((value as { id: unknown }).id) : null);
const rawId = (value: unknown): string | number | null => (typeof value === 'string' || typeof value === 'number' ? value : value && typeof value === 'object' && 'id' in value ? ((value as { id: string | number }).id) : null);
export const entitlementKey = (livemode: unknown, userId: string) => `${livemode === true ? 'live' : 'test'}:${userId}`;

type Doc = Record<string, unknown>;
export interface EntitlementContext {
  /** `live:<user>` / `test:<user>` for accounts with any active subscription in that mode (fallback for keys without a granting subscription). */
  entitled: Set<string>;
  /** Granting subscriptions referenced by the exported keys, by id. */
  subscriptions: Map<string, Doc>;
  /** Plans currently attached to those subscriptions, by id. */
  plans: Map<string, Doc>;
}
export interface GatewayPolicy { permissions: string[]; quotaRate: number; quotaBurst: number }

/** `live:<user>` / `test:<user>` for every account with an active or trialing subscription in that mode. */
export async function entitledAccounts(payload: Payload): Promise<Set<string>> {
  const result = await payload.find({ collection: 'subscriptions', where: { status: { in: [...ACTIVE_STATUSES] } }, limit: 10000, pagination: false, depth: 0, overrideAccess: true });
  const entitled = new Set<string>();
  for (const sub of result.docs as unknown as Doc[]) {
    const user = relationId(sub.user);
    if (user) entitled.add(entitlementKey(sub.livemode, user));
  }
  return entitled;
}

/** Everything the export needs to evaluate each key against the subscription that granted it. */
export async function entitlementContext(payload: Payload, keys: Doc[]): Promise<EntitlementContext> {
  const entitled = await entitledAccounts(payload);
  const subscriptions = new Map<string, Doc>();
  const subscriptionIds = [...new Map(keys.map((key) => rawId(key.subscription)).filter((id): id is string | number => id !== null).map((id) => [String(id), id])).values()];
  if (subscriptionIds.length) {
    const result = await payload.find({ collection: 'subscriptions', where: { id: { in: subscriptionIds } }, limit: 10000, pagination: false, depth: 0, overrideAccess: true });
    for (const sub of result.docs as unknown as Doc[]) subscriptions.set(String(sub.id), sub);
  }
  const plans = new Map<string, Doc>();
  const planIds = [...new Map([...subscriptions.values()].map((sub) => rawId(sub.plan)).filter((id): id is string | number => id !== null).map((id) => [String(id), id])).values()];
  if (planIds.length) {
    const result = await payload.find({ collection: 'plans', where: { id: { in: planIds } }, limit: 10000, pagination: false, depth: 0, overrideAccess: true });
    for (const plan of result.docs as unknown as Doc[]) plans.set(String(plan.id), plan);
  }
  return { entitled, subscriptions, plans };
}

/** The gateway policy a plan grants, or null when the plan carries none. */
export function policyOf(plan: Doc | undefined): GatewayPolicy | null {
  const gateway = plan?.gateway as { permissions?: unknown; quotaRate?: unknown; quotaBurst?: unknown } | undefined;
  if (!gateway || !Array.isArray(gateway.permissions) || gateway.permissions.length === 0 || typeof gateway.quotaRate !== 'number' || typeof gateway.quotaBurst !== 'number') return null;
  return { permissions: gateway.permissions.map(String), quotaRate: gateway.quotaRate, quotaBurst: gateway.quotaBurst };
}

/**
 * A key's exported state follows the subscription that granted it, not the
 * account: while that subscription is not active (past_due, unpaid, canceled,
 * deleted, or in the other billing mode) an otherwise active key is exported as
 * `revoked`, and it returns to `active` at the next sync if the subscription
 * recovers. Its permissions and quota follow the plan currently attached to that
 * subscription, so a downgrade or upgrade moves the key's policy with it and a
 * key minted on a higher tier cannot outlive that tier on a cheaper subscription.
 * Keys without a granting subscription (created by an admin) fall back to the
 * account's entitlement in the key's billing mode. Stored records are not changed.
 */
export function withEntitlement<T extends Doc>(keys: T[], context: EntitlementContext): T[] {
  return keys.map((key) => {
    const granted = rawId(key.subscription);
    if (granted !== null) {
      const subscription = context.subscriptions.get(String(granted));
      const active = subscription !== undefined && (ACTIVE_STATUSES as readonly string[]).includes(String(subscription.status)) && (subscription.livemode === true) === (key.livemode === true);
      const policy = subscription ? policyOf(context.plans.get(String(rawId(subscription.plan)))) : null;
      return { ...key, ...(policy ?? {}), state: key.state === 'active' && !active ? 'revoked' : key.state };
    }
    const user = relationId(key.user);
    if (key.state !== 'active' || (user && context.entitled.has(entitlementKey(key.livemode, user)))) return key;
    return { ...key, state: 'revoked' };
  });
}

/**
 * Key records for the managed API gateway (`gateway/src/cli.mjs sync-keys`).
 * Only a service account scoped `gateway_sync` (API key) or an admin may read it;
 * the payments-store credential cannot. Revoked and expired records are included
 * so the gateway learns about revocations; verifiers are never raw keys.
 */
export const gatewayEndpoints: Endpoint[] = [
  {
    path: '/gateway/keys', method: 'get',
    handler: (req) => guarded(req, async () => {
      if (!isServiceRequest(req, 'gateway_sync') && !hasRole(req, 'admin')) return fail(req, req.user ? 'forbidden' : 'unauthenticated');
      const mode = req.searchParams.get('mode') ?? 'production';
      if (mode !== 'production') return fail(req, 'invalid_request');
      const result = await req.payload.find({ collection: 'api-keys', sort: 'keyId', limit: 10000, pagination: false, depth: 0, overrideAccess: true });
      const stripeMode = getEnv().stripeMode;
      const docs = result.docs as unknown as Doc[];
      const keys = withEntitlement(exportableKeys(docs, stripeMode), await entitlementContext(req.payload, docs)).map(toGatewayRecord);
      return json(req, 200, { schema: KEY_RECORDS_SCHEMA, mode: 'production', generated_at: new Date().toISOString(), includes_test_mode_keys: stripeMode === 'test', keys });
    }),
  },
];
