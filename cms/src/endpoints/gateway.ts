import type { Endpoint } from 'payload';
import type { Payload } from 'payload';
import { hasRole, isServiceRequest } from '../access';
import { ACTIVE_STATUSES } from '../collections/Subscriptions';
import { getEnv, type StripeMode } from '../env';
import { toGatewayRecord, type GatewayKeyRecord } from '../lib/gateway-keys';
import { EndpointError, fail, guarded, json } from '../lib/responses';

export const KEY_RECORDS_SCHEMA = 'gateway-key-records/v1';
/**
 * The gateway refuses a snapshot with more records than this (`gateway/src/cms-keys.mjs`).
 * Only keys that evaluate as active are exported and counted, so the bound is on usable
 * keys, never on revoked, lapsed, or expired history, and reaching it is a capacity limit
 * to raise on both sides.
 */
export const GATEWAY_MAX_KEYS = 10000;
/** Stored keys are evaluated in pages of this size; history is walked but never exported or counted. */
export const EXPORT_PAGE_SIZE = 1000;

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

/** `live:<user>` / `test:<user>` for each of `users` with an active or trialing subscription in that mode. */
export async function entitledAccounts(payload: Payload, users: (string | number)[]): Promise<Set<string>> {
  const entitled = new Set<string>();
  if (users.length === 0) return entitled;
  const result = await payload.find({ collection: 'subscriptions', where: { and: [{ status: { in: [...ACTIVE_STATUSES] } }, { user: { in: users } }] }, limit: GATEWAY_MAX_KEYS + 1, pagination: false, depth: 0, overrideAccess: true });
  for (const sub of result.docs as unknown as Doc[]) {
    const user = relationId(sub.user);
    if (user) entitled.add(entitlementKey(sub.livemode, user));
  }
  return entitled;
}

/** Everything the export needs to evaluate each key against the subscription that granted it. */
export async function entitlementContext(payload: Payload, keys: Doc[]): Promise<EntitlementContext> {
  // Only admin-created keys without a granting subscription fall back to the account, so only their users are looked up.
  const fallbackUsers = [...new Map(keys.filter((key) => rawId(key.subscription) === null && key.issuedBy !== 'account').map((key) => rawId(key.user)).filter((id): id is string | number => id !== null).map((id) => [String(id), id])).values()];
  const entitled = await entitledAccounts(payload, fallbackUsers);
  const subscriptions = new Map<string, Doc>();
  const subscriptionIds = [...new Map(keys.map((key) => rawId(key.subscription)).filter((id): id is string | number => id !== null).map((id) => [String(id), id])).values()];
  if (subscriptionIds.length) {
    const result = await payload.find({ collection: 'subscriptions', where: { id: { in: subscriptionIds } }, limit: GATEWAY_MAX_KEYS + 1, pagination: false, depth: 0, overrideAccess: true });
    for (const sub of result.docs as unknown as Doc[]) subscriptions.set(String(sub.id), sub);
  }
  const plans = new Map<string, Doc>();
  const planIds = [...new Map([...subscriptions.values()].map((sub) => rawId(sub.plan)).filter((id): id is string | number => id !== null).map((id) => [String(id), id])).values()];
  if (planIds.length) {
    const result = await payload.find({ collection: 'plans', where: { id: { in: planIds } }, limit: GATEWAY_MAX_KEYS + 1, pagination: false, depth: 0, overrideAccess: true });
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
 * deleted, or in the other billing mode) an otherwise active key evaluates as
 * `revoked` (and so leaves the export), and it returns to `active` at the next sync
 * if the subscription recovers. Its permissions and quota follow the plan currently attached to that
 * subscription, so a downgrade or upgrade moves the key's policy with it and a
 * key minted on a higher tier cannot outlive that tier on a cheaper subscription;
 * a subscription whose plan no longer resolves to a policy grants nothing.
 * Keys created by an admin without a granting subscription fall back to the
 * account's entitlement in the key's billing mode; a key minted from the account
 * page whose granting subscription no longer exists (deleted, relation cleared) is
 * revoked rather than falling back. Stored records are not changed.
 */
export function withEntitlement<T extends Doc>(keys: T[], context: EntitlementContext): T[] {
  return keys.map((key) => {
    const granted = rawId(key.subscription);
    if (granted === null && key.issuedBy === 'account') return key.state === 'active' ? { ...key, state: 'revoked' } : key;
    if (granted !== null) {
      const subscription = context.subscriptions.get(String(granted));
      const active = subscription !== undefined && (ACTIVE_STATUSES as readonly string[]).includes(String(subscription.status)) && (subscription.livemode === true) === (key.livemode === true);
      // No resolvable plan policy (plan deleted, price unknown) means no grant: the key is revoked rather than exported with its copied policy.
      const policy = subscription ? policyOf(context.plans.get(String(rawId(subscription.plan)))) : null;
      return { ...key, ...(policy ?? {}), state: key.state === 'active' && (!active || !policy) ? 'revoked' : key.state };
    }
    const user = relationId(key.user);
    if (key.state !== 'active' || (user && context.entitled.has(entitlementKey(key.livemode, user)))) return key;
    return { ...key, state: 'revoked' };
  });
}

/**
 * Every record the gateway snapshot needs: keys stored as active, evaluated page by page
 * against the subscription that granted them, keeping those that still evaluate as active.
 * Stored state alone says nothing about a key's standing (a lapsed subscription leaves its
 * keys stored active and exported revoked), so the capacity check counts the evaluated set.
 * More than `maxKeys` usable keys throws `snapshot_too_large`: a capacity limit to raise on
 * both sides, never a snapshot to truncate (a failed sync keeps the gateway's previous keys;
 * a truncated one would silently drop live ones).
 *
 * Pages are keyed on the unique `keyId` (every page asks for ids greater than the last one
 * seen), not on an offset: a key revoked or deleted while the export runs must not shift the
 * following rows and drop a still-active key from a snapshot that replaces the whole set.
 */
export async function collectActiveKeys(payload: Payload, stripeMode: StripeMode, { pageSize = EXPORT_PAGE_SIZE, maxKeys = GATEWAY_MAX_KEYS }: { pageSize?: number; maxKeys?: number } = {}): Promise<GatewayKeyRecord[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxKeys) || maxKeys < 0) throw new TypeError('invalid export bounds');
  const keys = new Map<string, GatewayKeyRecord>();
  let after: string | null = null;
  for (;;) {
    const where = after === null ? { state: { equals: 'active' } } : { and: [{ state: { equals: 'active' } }, { keyId: { greater_than: after } }] };
    const result = await payload.find({ collection: 'api-keys', where: where as never, sort: 'keyId', limit: pageSize, pagination: false, depth: 0, overrideAccess: true });
    const page = result.docs as unknown as Doc[];
    if (page.length === 0) break;
    const docs = exportableKeys(page, stripeMode);
    for (const record of withEntitlement(docs, await entitlementContext(payload, docs)).map(toGatewayRecord)) if (record.state === 'active') keys.set(record.id, record);
    if (keys.size > maxKeys) throw new EndpointError('snapshot_too_large');
    after = String(page[page.length - 1].keyId);
    if (page.length < pageSize) break;
  }
  return [...keys.values()];
}

/**
 * Key records for the managed API gateway (`gateway/src/cli.mjs sync-keys`).
 * Only a service account scoped `gateway_sync` (API key) or an admin may read it;
 * the payments-store credential cannot. The snapshot replaces the gateway's whole
 * key set and the gateway refuses a key it does not know exactly as it refuses a
 * revoked one (`gateway/src/security.mjs`), so only keys that evaluate as active are
 * exported: revoked and expired history never counts against the gateway's record
 * limit, and a revocation takes effect by the key's absence at the next sync.
 * Verifiers are never raw keys.
 */
export const gatewayEndpoints: Endpoint[] = [
  {
    path: '/gateway/keys', method: 'get',
    handler: (req) => guarded(req, async () => {
      if (!isServiceRequest(req, 'gateway_sync') && !hasRole(req, 'admin')) return fail(req, req.user ? 'forbidden' : 'unauthenticated');
      const mode = req.searchParams.get('mode') ?? 'production';
      if (mode !== 'production') return fail(req, 'invalid_request');
      const stripeMode = getEnv().stripeMode;
      const keys = await collectActiveKeys(req.payload, stripeMode);
      return json(req, 200, { schema: KEY_RECORDS_SCHEMA, mode: 'production', generated_at: new Date().toISOString(), includes_test_mode_keys: stripeMode === 'test', keys });
    }),
  },
];
