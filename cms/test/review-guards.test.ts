import { describe, expect, test, vi } from 'vitest';
import { bootstrapAdmin, localFirstUserEnabled } from '../src/lib/bootstrap';
import { getEnv } from '../src/env';
import { readWebhookBody, MAX_WEBHOOK_BODY_BYTES, stripeWebhookEndpoint } from '../src/endpoints/stripe-webhook';
import { withEntitlement } from '../src/endpoints/gateway';

function bootstrapFixture(admins: number, users: number) {
  return { count: vi.fn().mockResolvedValueOnce({ totalDocs: admins }).mockResolvedValueOnce({ totalDocs: users }), find: vi.fn().mockResolvedValue({ docs: [] }), create: vi.fn(), update: vi.fn(), logger: { info: vi.fn() } };
}

describe('bootstrap startup policy', () => {
  const env = () => ({ ...getEnv(), nodeEnv: 'production', bootstrapAdmin: null });
  test('web bootstrap is limited to non-production SQLite without configured credentials', () => {
    const local = { ...getEnv(), nodeEnv: 'development', databaseKind: 'sqlite' as const, bootstrapAdmin: null };
    expect(localFirstUserEnabled(local)).toBe(true);
    for (const overrides of [{ nodeEnv: 'production' }, { databaseKind: 'postgres' as const }, { building: true }, { bootstrapAdmin: { email: 'admin@example.test', password: 'synthetic-password-0001' } }]) {
      expect(localFirstUserEnabled({ ...local, ...overrides })).toBe(false);
    }
  });
  test('empty production fails clearly without explicit bootstrap, existing admin starts normally', async () => {
    await expect(bootstrapAdmin(bootstrapFixture(0, 0) as never, env())).rejects.toThrow(/CMS_ADMIN_EMAIL and CMS_ADMIN_PASSWORD/);
    await expect(bootstrapAdmin(bootstrapFixture(1, 1) as never, env())).resolves.toBeUndefined();
  });
  test('explicit credentials recover a member-only database by creating an admin', async () => {
    const fixture = bootstrapFixture(0, 1);
    await bootstrapAdmin(fixture as never, { ...env(), bootstrapAdmin: { email: 'admin@example.test', password: 'synthetic-password-0001' } });
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: 'admin@example.test', role: 'admin', _verified: true }) }));
  });
  test('explicit credentials recover their existing account and reset its password', async () => {
    const fixture = bootstrapFixture(0, 1);
    fixture.find.mockResolvedValue({ docs: [{ id: 42, email: 'admin@example.test', role: 'member' }] });
    await bootstrapAdmin(fixture as never, { ...env(), bootstrapAdmin: { email: 'admin@example.test', password: 'synthetic-password-0001' } });
    expect(fixture.update).toHaveBeenCalledWith(expect.objectContaining({ id: 42, data: { password: 'synthetic-password-0001', role: 'admin', _verified: true }, context: { cmsInternal: true } }));
    expect(fixture.create).not.toHaveBeenCalled();
  });
  test('explicit bootstrap creates a verified administrator', async () => {
    const fixture = bootstrapFixture(0, 0);
    await bootstrapAdmin(fixture as never, { ...env(), bootstrapAdmin: { email: 'admin@example.test', password: 'synthetic-password-0001' } });
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'admin', _verified: true }), context: { cmsInternal: true } }));
  });
});

describe('bounded webhook stream', () => {
  test('counts UTF-8 bytes and cancels a no-length stream before reading the remainder', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(new TextEncoder().encode('é'.repeat(MAX_WEBHOOK_BODY_BYTES / 4))); }, cancel }, { highWaterMark: 0 });
    await expect(readWebhookBody({ body, headers: new Headers() })).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(pulls).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
  });
  test('accepts exact byte boundary and refuses declared oversize without reading', async () => {
    expect((await readWebhookBody(new Request('http://localhost', { method: 'POST', body: 'a'.repeat(MAX_WEBHOOK_BODY_BYTES) }))).length).toBe(MAX_WEBHOOK_BODY_BYTES);
    const pull = vi.fn();
    await expect(readWebhookBody({ headers: new Headers({ 'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1) }), body: new ReadableStream({ pull }, { highWaterMark: 0 }) })).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(pull).not.toHaveBeenCalled();
  });
  test('endpoint returns 413 for an oversized stream', async () => {
    const req = new Request('http://localhost', { method: 'POST', body: 'a'.repeat(MAX_WEBHOOK_BODY_BYTES + 1), headers: { 'stripe-signature': 'synthetic' } });
    const response = await stripeWebhookEndpoint.handler(Object.assign(req, { payload: { config: { cors: [] } } }) as never);
    expect(response.status).toBe(413);
  });
});

test('bound key projection revokes reassigned and unlinked subscriptions', () => {
  const key = { id: 1, user: 10, subscription: 20, issuedBy: 'account', state: 'active', livemode: false };
  const plan = { id: 30, active: true, mode: 'subscription', gateway: { permissions: ['records'], quotaRate: 1, quotaBurst: 10 } };
  for (const user of [11, null, undefined]) {
    const context = { subscriptions: new Map([['20', { id: 20, user, status: 'active', plan: 30, livemode: false }]]), plans: new Map([['30', plan]]), entitled: new Set<string>() };
    expect(withEntitlement([key], context as never)[0].state).toBe('revoked');
  }
});
