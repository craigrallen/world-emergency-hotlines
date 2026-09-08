import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getPayload, type Payload } from 'payload';
import config from '@payload-config';
import { createUser, paymentsStore, startMockStripe, stripeEvent } from './helpers';
import { claimEvent, mutateClaim } from '../src/lib/stripe';
import { inTransaction, lockRow } from '../src/lib/subscriptions';
import { withEntitlement } from '../src/endpoints/gateway';

// Run only against a disposable, migrated Postgres database. No schema push.
// The dedicated script must never report a vacuous pass, while the ordinary suite
// intentionally skips this file because its CMS job uses SQLite.
if (process.env.npm_lifecycle_event === 'test:postgres' && !process.env.TEST_POSTGRES_URL) {
  throw new Error('TEST_POSTGRES_URL is required for test:postgres');
}
describe.skipIf(!process.env.TEST_POSTGRES_URL)('Postgres lease ownership and projection', () => {
  let payload: Payload;
  let mock: Awaited<ReturnType<typeof startMockStripe>>;
  const apiKey = 'postgres-payments-test-key-0001';
  beforeAll(async () => {
    mock = await startMockStripe();
    payload = await getPayload({ config });
    expect(payload.db.name).toBe('postgres');
    await createUser(payload, { email: `pg-service-${Date.now()}@example.test`, password: 'postgres-synthetic-password-0001', role: 'service', serviceScope: 'payments_store', enableAPIKey: true, apiKey });
  });
  afterAll(async () => { await mock?.close(); await payload?.db.destroy?.(); });

  const store = () => paymentsStore(apiKey);

  async function waitForBlockedLease() {
    const pool = (payload.db as unknown as { pool: { query(sql: string): Promise<{ rows: unknown[] }> } }).pool;
    for (let i = 0; i < 500; i += 1) {
      const result = await pool.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%stripe_events%' AND query LIKE '%FOR UPDATE%'");
      if (result.rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Competing lease mutation never waited on the Postgres row lock');
  }

  test.each(['cms', 'payments'] as const)('%s stale completion and release wait, re-read, and cannot mutate the successor', async (source) => {
    for (const action of ['complete', 'release'] as const) {
      const event = stripeEvent('customer.subscription.updated', { id: 'sub_postgres000001' });
      expect(await claimEvent(payload, event as never, source, Date.now(), 'lease-old-worker-0001')).toBe('claimed');
      let finish!: () => void;
      let locked!: () => void;
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      const ready = new Promise<void>((resolve) => { locked = resolve; });
      const successor = inTransaction(payload, undefined, async (tx) => {
        await lockRow(payload, tx, 'stripe-events', 'claim_key', `${source}:${event.id}`);
        const doc = (await payload.find({ collection: 'stripe-events', where: { claimKey: { equals: `${source}:${event.id}` } }, req: tx, overrideAccess: true })).docs[0];
        await payload.update({ collection: 'stripe-events', id: doc.id, data: { lease: 'lease-new-worker-0002', outcome: null }, req: tx, overrideAccess: true });
        locked();
        await gate;
      });
      await ready;
      const stale = source === 'cms'
        ? mutateClaim(payload, event.id, source, 'lease-old-worker-0001', action === 'complete' ? 'processed' : null)
        : action === 'complete' ? store().completeEvent(event.id, 'lease-old-worker-0001') : store().releaseEvent(event.id, 'lease-old-worker-0001');
      try { await waitForBlockedLease(); } finally { finish(); await successor; }
      expect(await stale).toBe(false);
      const doc = (await payload.find({ collection: 'stripe-events', where: { claimKey: { equals: `${source}:${event.id}` } }, overrideAccess: true })).docs[0];
      expect(doc.lease).toBe('lease-new-worker-0002');
      expect(doc.outcome ?? null).toBeNull();
      expect(await mutateClaim(payload, event.id, source, 'lease-new-worker-0002', 'processed')).toBe(true);
    }
  });

  test.each(['cms', 'payments'] as const)('%s concurrent expired-lease takers have exactly one winner', async (source) => {
    const event = stripeEvent('customer.subscription.updated', { id: 'sub_postgres000002' });
    await claimEvent(payload, event as never, source, Date.now(), 'lease-old-worker-0001');
    const doc = (await payload.find({ collection: 'stripe-events', where: { eventId: { equals: event.id } }, overrideAccess: true })).docs[0];
    await payload.db.updateOne({ collection: 'stripe-events', id: doc.id, data: { updatedAt: new Date(Date.now() - 600000).toISOString() } });
    const results = await Promise.all(['lease-new-worker-0002', 'lease-new-worker-0003'].map((lease) => source === 'cms' ? claimEvent(payload, event as never, source, Date.now(), lease) : store().claimEvent(event.id, lease)));
    expect(results.sort()).toEqual(['claimed', 'in_progress']);
  });

  test('persisted subscription reassignment and unlink revoke the former owner’s bound key', async () => {
    const owner = await createUser(payload, { email: `pg-owner-${Date.now()}@example.test`, password: 'postgres-synthetic-password-0001' });
    const other = await createUser(payload, { email: `pg-other-${Date.now()}@example.test`, password: 'postgres-synthetic-password-0001' });
    const plan = await payload.create({ collection: 'plans', data: { offerId: 'pg_projection', label: 'PG projection', mode: 'subscription', stripePriceId: 'price_postgres0001', quantity: 1, active: true, gateway: { permissions: ['records'], quotaRate: 1, quotaBurst: 10 } }, overrideAccess: true });
    const sub = await payload.create({ collection: 'subscriptions', data: { stripeSubscriptionId: 'sub_postgres000099', user: owner.id, plan: plan.id, status: 'active', livemode: false, source: 'cms' }, overrideAccess: true });
    const key = { user: owner.id, subscription: sub.id, issuedBy: 'account', state: 'active', livemode: false };
    for (const user of [owner.id, other.id, null]) {
      await payload.update({ collection: 'subscriptions', id: sub.id, data: { user }, overrideAccess: true });
      const stored = await payload.findByID({ collection: 'subscriptions', id: sub.id, depth: 0, overrideAccess: true });
      const projected = withEntitlement([key], { entitled: new Set(), subscriptions: new Map([[String(sub.id), stored as unknown as Record<string, unknown>]]), plans: new Map([[String(plan.id), plan as unknown as Record<string, unknown>]]) });
      expect(projected[0].state).toBe(user === owner.id ? 'active' : 'revoked');
    }
  });
});
