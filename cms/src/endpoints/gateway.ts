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
export const entitlementKey = (livemode: unknown, userId: string) => `${livemode === true ? 'live' : 'test'}:${userId}`;

/** `live:<user>` / `test:<user>` for every account with an active or trialing subscription in that mode. */
export async function entitledAccounts(payload: Payload): Promise<Set<string>> {
  const result = await payload.find({ collection: 'subscriptions', where: { status: { in: [...ACTIVE_STATUSES] } }, limit: 10000, pagination: false, depth: 0, overrideAccess: true });
  const entitled = new Set<string>();
  for (const sub of result.docs as unknown as Record<string, unknown>[]) {
    const user = relationId(sub.user);
    if (user) entitled.add(entitlementKey(sub.livemode, user));
  }
  return entitled;
}

/**
 * A key's exported state also reflects the account's current entitlement: while
 * the entitling subscription is not active (past_due, unpaid, canceled, …) an
 * otherwise active key is exported as `revoked`, and it returns to `active` at
 * the next sync if the subscription recovers. Stored records are not changed.
 */
export function withEntitlement<T extends { livemode?: unknown; state?: unknown; user?: unknown }>(keys: T[], entitled: Set<string>): T[] {
  return keys.map((key) => {
    const user = relationId(key.user);
    if (key.state !== 'active' || (user && entitled.has(entitlementKey(key.livemode, user)))) return key;
    return { ...key, state: 'revoked' };
  });
}

/**
 * Key records for the managed API gateway (`gateway/src/cli.mjs sync-keys`).
 * Service accounts (API key) and admins only. Revoked and expired records are
 * included so the gateway learns about revocations; verifiers are never raw keys.
 */
export const gatewayEndpoints: Endpoint[] = [
  {
    path: '/gateway/keys', method: 'get',
    handler: (req) => guarded(req, async () => {
      if (!isServiceRequest(req) && !hasRole(req, 'admin')) return fail(req, req.user ? 'forbidden' : 'unauthenticated');
      const mode = req.searchParams.get('mode') ?? 'production';
      if (mode !== 'production') return fail(req, 'invalid_request');
      const result = await req.payload.find({ collection: 'api-keys', sort: 'keyId', limit: 10000, pagination: false, depth: 0, overrideAccess: true });
      const stripeMode = getEnv().stripeMode;
      const entitled = await entitledAccounts(req.payload);
      const keys = withEntitlement(exportableKeys(result.docs as unknown as Record<string, unknown>[], stripeMode), entitled).map(toGatewayRecord);
      return json(req, 200, { schema: KEY_RECORDS_SCHEMA, mode: 'production', generated_at: new Date().toISOString(), includes_test_mode_keys: stripeMode === 'test', keys });
    }),
  },
];
