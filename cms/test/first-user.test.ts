import { afterAll, beforeAll, expect, test } from 'vitest';
import { getPayload, type Payload } from 'payload';

let payload: Payload;
let call: typeof import('./helpers').call;
const PASSWORD = 'synthetic-first-admin-password-0001';
beforeAll(async () => {
  // Match the documented local default, including closed member registration.
  process.env.CMS_ACCOUNTS_REGISTRATION = 'closed';
  const config = (await import('@payload-config')).default;
  payload = await getPayload({ config });
  call = (await import('./helpers')).call;
});
afterAll(async () => { await payload.db.destroy?.(); });

test('closed local setup creates exactly one verified admin through Payload first-register', async () => {
  expect((await call('/cms/api/users', { method: 'POST', body: { email: 'member@example.test', password: PASSWORD, role: 'admin' } })).status).toBe(403);
  const weak = await call('/cms/api/users/first-register', { method: 'POST', body: { email: 'admin@example.test', password: 'short' } });
  expect(weak.status).toBe(400);
  expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(0);
  const first = await call('/cms/api/users/first-register', { method: 'POST', body: { email: 'admin@example.test', password: PASSWORD, role: 'service', serviceScope: 'payments_store', enableAPIKey: true, apiKey: 'injected-synthetic-key' } });
  expect(first.status).toBe(200);
  expect(first.data.user).toMatchObject({ role: 'admin', _verified: true });
  expect(first.headers.get('set-cookie')).toContain('payload-token=');
  const stored = await payload.findByID({ collection: 'users', id: first.data.user.id, overrideAccess: true });
  expect(stored.serviceScope ?? null).toBeNull();
  expect(stored.enableAPIKey).not.toBe(true);
  expect((await call('/cms/api/users/me', { token: first.data.token })).data.user.role).toBe('admin');
  expect((await call('/cms/api/users/first-register', { method: 'POST', body: { email: 'second@example.test', password: PASSWORD } })).status).toBe(403);
  expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(1);
});
