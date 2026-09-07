import type { Endpoint } from 'payload';
import { hasRole, isServiceRequest } from '../access';
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
      const keys = exportableKeys(result.docs as unknown as Record<string, unknown>[], stripeMode).map(toGatewayRecord);
      return json(req, 200, { schema: KEY_RECORDS_SCHEMA, mode: 'production', generated_at: new Date().toISOString(), includes_test_mode_keys: stripeMode === 'test', keys });
    }),
  },
];
