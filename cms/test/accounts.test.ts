import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getPayload, type Payload } from 'payload';
import configPromise from '@payload-config';
import { call, createUser, login, startMockStripe } from './helpers';
import { sellablePlans } from '../src/endpoints/account';
import { resetPasswordEmailHTML, verifyEmailHTML } from '../src/lib/emails';

let payload: Payload;
let stripe: Awaited<ReturnType<typeof startMockStripe>>;
const PASSWORD = 'correct-horse-battery-staple-01';

beforeAll(async () => {
  stripe = await startMockStripe();
  payload = await getPayload({ config: configPromise });
  await createUser(payload, { email: 'admin@example.test', password: PASSWORD, role: 'admin', name: 'Admin' });
  await createUser(payload, { email: 'staff@example.test', password: PASSWORD, role: 'staff' });
  await payload.create({ collection: 'plans', data: { offerId: 'growth_monthly', label: 'Growth — monthly', description: 'Synthetic plan', mode: 'subscription', stripePriceId: 'price_synthetic0001', quantity: 1, active: true, gateway: { permissions: ['manifest', 'records'], quotaRate: 2, quotaBurst: 20 } }, overrideAccess: true });
  await payload.create({ collection: 'plans', data: { offerId: 'one_time_pack', label: 'One-time pack', mode: 'payment', stripePriceId: 'price_synthetic0003', quantity: 1, active: true, gateway: { quotaRate: 1, quotaBurst: 10 } }, overrideAccess: true });
  await payload.create({ collection: 'plans', data: { offerId: 'hidden_plan', label: 'Hidden', mode: 'subscription', stripePriceId: 'price_synthetic0002', quantity: 1, active: false, gateway: { quotaRate: 1, quotaBurst: 10 } }, overrideAccess: true });
});
afterAll(async () => { await stripe.close(); await payload.db.destroy?.(); });

describe('public status', () => {
  test('describes enablement without prices or secrets', async () => {
    const result = await call('/cms/api/account/status');
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.data).toMatchObject({ component: 'cms', status: 'enabled', accounts: { registration: 'open', email_verification: false }, stripe: { mode: 'test', checkout: true, hosted_checkout_only: true }, gateway: { key_issuance: true }, price_publication: 'not_published', free_static_surfaces_unchanged: true });
    expect(result.data.offers).toEqual([{ id: 'growth_monthly', label: 'Growth — monthly', description: 'Synthetic plan', mode: 'subscription' }]); // the active one-time plan is not sellable here
    expect(JSON.stringify(result.data)).not.toMatch(/price_synthetic|sk_test|whsec/);
  });
});

describe('account emails', () => {
  test('verification and password-reset links carry the token in a URL fragment, never the query string', () => {
    // A query-string token on the initial page load reaches Caddy's access log and rides along as the
    // Referer on any same-origin request that follows; a fragment reaches neither.
    const verifyHref = /href="([^"]+)"/.exec(verifyEmailHTML({ req: {} as never, token: 'verify-token-000000000', user: {} }))?.[1];
    expect(verifyHref).toMatch(/^https?:\/\/[^?]+#token=verify-token-000000000$/);
    const resetHref = /href="([^"]+)"/.exec(resetPasswordEmailHTML({ token: 'reset-token-0000000000' }))?.[1];
    expect(resetHref).toMatch(/^https?:\/\/[^?]+#token=reset-token-0000000000$/);
  });

  test('the verify-email endpoint takes the token in the request body, never the URL, so it never reaches an access log', async () => {
    const unverified = await createUser(payload, { email: 'unverified@example.test', password: PASSWORD, _verified: false });
    // `_verificationToken` denies field-level write access unconditionally (even with overrideAccess), by
    // design: only Payload's own auth machinery may set it. The raw db layer bypasses that field access,
    // exactly like the verifyEmail operation's own token-clearing update does, purely to arrange this test.
    await payload.db.updateOne({ collection: 'users', id: unverified.id, data: { _verificationToken: 'a'.repeat(40) }, returning: false });
    const wrong = await call('/cms/api/account/verify-email', { method: 'POST', body: { token: 'b'.repeat(40) } });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error.code).toBe('verification_failed');
    expect((await payload.findByID({ collection: 'users', id: unverified.id, overrideAccess: true }))._verified).not.toBe(true); // wrong token never verifies
    const ok = await call('/cms/api/account/verify-email', { method: 'POST', body: { token: 'a'.repeat(40) } });
    expect(ok.status).toBe(200);
    expect(ok.data).toEqual({ verified: true });
    expect((await payload.findByID({ collection: 'users', id: unverified.id, overrideAccess: true }))._verified).toBe(true);
  });

  test('a transient verifyEmail failure is a retryable error, never the same result as an invalid token', async () => {
    // Anything other than the operation's own "no user has this token" 403 (a database or adapter fault, say)
    // must not be reported as verification_failed: the client scrubs the token and calls that terminal, so a
    // transient fault would otherwise strand a member whose link was never actually invalid.
    const original = payload.verifyEmail.bind(payload);
    payload.verifyEmail = (async () => { throw new Error('simulated database fault'); }) as typeof payload.verifyEmail;
    try {
      const result = await call('/cms/api/account/verify-email', { method: 'POST', body: { token: 'd'.repeat(40) } });
      expect(result.status).toBe(503);
      expect(result.data.error.code).toBe('unavailable');
    } finally {
      payload.verifyEmail = original;
    }
  });
});

describe('registration and sessions', () => {
  test('anyone can register while registration is open, but only as a member without privileges', async () => {
    const created = await call('/cms/api/users', { method: 'POST', body: { email: 'member@example.test', password: PASSWORD, name: 'Member', role: 'admin', enableAPIKey: true, stripeLiveCustomerId: 'cus_injected0001', stripeTestCustomerId: 'cus_injected0002', notes: 'sneaky' } });
    expect(created.status).toBe(201);
    const stored = await payload.findByID({ collection: 'users', id: created.data.doc.id, overrideAccess: true, showHiddenFields: true });
    expect(stored.role).toBe('member');
    expect(stored.enableAPIKey).toBeFalsy();
    expect(stored.stripeLiveCustomerId ?? null).toBeNull();
    expect(stored.stripeTestCustomerId ?? null).toBeNull();
    expect(stored.notes ?? null).toBeNull();
  });

  test('password policy is enforced server-side for registration, self-update, and reset', async () => {
    const short = await call('/cms/api/users', { method: 'POST', body: { email: 'weak@example.test', password: 'short' } });
    expect(short.status).toBe(400);
    expect(JSON.stringify(short.data)).toMatch(/12 to 256 characters/);
    const token = await login('member@example.test', PASSWORD);
    const me = await call('/cms/api/account/me', { token });
    const change = await call(`/cms/api/users/${me.data.user.id}`, { method: 'PATCH', token, body: { password: 'tooshort' } });
    expect(change.status).toBe(400);
    const okChange = await call(`/cms/api/users/${me.data.user.id}`, { method: 'PATCH', token, body: { password: PASSWORD } });
    expect(okChange.status).toBe(200);
    const forgot = await payload.forgotPassword({ collection: 'users', data: { email: 'member@example.test' }, disableEmail: true });
    const reset = await call('/cms/api/users/reset-password', { method: 'POST', body: { token: forgot, password: 'tiny' } });
    expect(reset.status).toBe(400);
    const goodReset = await call('/cms/api/users/reset-password', { method: 'POST', body: { token: forgot, password: PASSWORD } });
    expect(goodReset.status).toBe(200);
    expect(await login('member@example.test', PASSWORD)).toBeTruthy();
  });

  test('reset-password distinguishes an invalid token (403) from a rejected password on a valid one (400)', async () => {
    // The account page tells these apart by status alone (a rejected password must never be reported as a
    // dead link): pin the exact codes Payload's own operation returns so a version bump cannot silently swap them.
    const bogus = await call('/cms/api/users/reset-password', { method: 'POST', body: { token: 'x'.repeat(40), password: PASSWORD } });
    expect(bogus.status).toBe(403);
    expect(JSON.stringify(bogus.data)).toMatch(/invalid or has expired/i);
    const forgot = await payload.forgotPassword({ collection: 'users', data: { email: 'member@example.test' }, disableEmail: true });
    const tooLong = await call('/cms/api/users/reset-password', { method: 'POST', body: { token: forgot, password: 'a'.repeat(300) } });
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(tooLong.data)).toMatch(/12 to 256 characters/);
  });

  test('accounts are created verified while verification is not required, so verification columns exist in every mode', async () => {
    const stored = (await payload.find({ collection: 'users', where: { email: { equals: 'member@example.test' } }, overrideAccess: true, showHiddenFields: true })).docs[0] as unknown as Record<string, unknown>;
    expect(stored._verified).toBe(true);
    // ...and no verification email is attempted for an account that is already verified
    // (the spy on the email adapter is proven live by the reset flow, which does send).
    const adapter = payload.email as unknown as { sendEmail: unknown };
    const originalSendEmail = adapter.sendEmail;
    let attempted = 0;
    adapter.sendEmail = async () => { attempted += 1; };
    try {
      const registered = await call('/cms/api/users', { method: 'POST', body: { email: 'quiet@example.test', password: PASSWORD } });
      expect(registered.status).toBe(201);
      expect(attempted).toBe(0);
      const reset = await call('/cms/api/users/forgot-password', { method: 'POST', body: { email: 'quiet@example.test' } });
      expect(reset.status).toBe(200);
      expect(attempted).toBe(1);
    } finally {
      adapter.sendEmail = originalSendEmail;
    }
  });

  test('members read only themselves; staff read everyone; members cannot escalate', async () => {
    const memberToken = await login('member@example.test', PASSWORD);
    const staffToken = await login('staff@example.test', PASSWORD);
    const mine = await call('/cms/api/users', { token: memberToken });
    expect(mine.status).toBe(200);
    expect(mine.data.docs.map((doc: { email: string }) => doc.email)).toEqual(['member@example.test']);
    const all = await call('/cms/api/users', { token: staffToken });
    expect(all.data.totalDocs).toBeGreaterThanOrEqual(3);
    const me = await call('/cms/api/account/me', { token: memberToken });
    expect(me.status).toBe(200);
    expect(me.data.user).toMatchObject({ email: 'member@example.test', role: 'member', billing_customer_linked: false });
    expect(me.data.entitlement).toEqual({ active: false, can_grant_keys: false, offer: null });
    const escalate = await call(`/cms/api/users/${me.data.user.id}`, { method: 'PATCH', token: memberToken, body: { role: 'admin', name: 'Renamed' } });
    expect(escalate.status).toBe(200);
    const after = await payload.findByID({ collection: 'users', id: me.data.user.id, overrideAccess: true });
    expect(after.role).toBe('member');
    expect(after.name).toBe('Renamed');
    const other = await call(`/cms/api/users/${(await payload.find({ collection: 'users', where: { email: { equals: 'staff@example.test' } }, overrideAccess: true })).docs[0].id}`, { method: 'PATCH', token: memberToken, body: { name: 'hijack' } });
    expect([403, 404]).toContain(other.status);
    const anonymous = await call('/cms/api/account/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.data.error.code).toBe('unauthenticated');
  });

  test('cookie sessions from a foreign origin are refused (CSRF allowlist)', async () => {
    const token = await login('member@example.test', PASSWORD);
    const cookie = await call('/cms/api/account/me', { headers: { cookie: `payload-token=${token}` }, origin: 'https://evil.invalid' });
    expect(cookie.status).toBe(401);
    const sameOrigin = await call('/cms/api/account/me', { headers: { cookie: `payload-token=${token}` } });
    expect(sameOrigin.status).toBe(200);
  });

  test('admin panel access is limited to admin and staff roles', async () => {
    const admin = payload.collections.users.config.access.admin as (args: { req: unknown }) => boolean | Promise<boolean>;
    const req = (role: string | null, strategy = 'local-jwt') => ({ user: role ? { id: 1, role, collection: 'users', _strategy: strategy } : null, payload });
    expect(await admin({ req: req('member') })).toBe(false);
    expect(await admin({ req: req('service', 'api-key') })).toBe(false);
    expect(await admin({ req: req(null) })).toBe(false);
    expect(await admin({ req: req('staff') })).toBe(true);
    expect(await admin({ req: req('admin') })).toBe(true);
  });
});

describe('checkout, portal, and plans', () => {
  test('checkout creates a Stripe customer once, binds the session to the account, and returns only the hosted URL', async () => {
    const token = await login('member@example.test', PASSWORD);
    const bogus = await call('/cms/api/account/checkout', { method: 'POST', token, body: { offer: 'hidden_plan' } });
    expect(bogus.status).toBe(400);
    expect(bogus.data.error.code).toBe('unknown_offer');
    const malformed = await call('/cms/api/account/checkout', { method: 'POST', token, body: { offer: 'Not Valid' } });
    expect(malformed.status).toBe(400);
    const oneTime = await call('/cms/api/account/checkout', { method: 'POST', token, body: { offer: 'one_time_pack' } });
    expect(oneTime.status).toBe(400);
    expect(oneTime.data.error.code).toBe('unsupported_offer');
    expect(stripe.requests.filter((request) => request.path === '/v1/checkout/sessions')).toHaveLength(0);
    const first = await call('/cms/api/account/checkout', { method: 'POST', token, body: { offer: 'growth_monthly' } });
    expect(first.status).toBe(200);
    expect(first.data.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const customerCall = stripe.requests.find((request) => request.path === '/v1/customers');
    expect(customerCall?.body.get('email')).toBe('member@example.test');
    expect(customerCall?.headers['idempotency-key']).toMatch(/^cms-customer-/);
    const sessionCall = stripe.requests.find((request) => request.path === '/v1/checkout/sessions');
    expect(sessionCall?.body.get('mode')).toBe('subscription');
    expect(sessionCall?.body.get('line_items[0][price]')).toBe('price_synthetic0001');
    expect(sessionCall?.body.get('customer')).toMatch(/^cus_synthetic/);
    expect(sessionCall?.body.get('client_reference_id')).toBe(String((await call('/cms/api/account/me', { token })).data.user.id));
    expect(sessionCall?.body.get('metadata[offer]')).toBe('growth_monthly');
    expect(sessionCall?.body.get('success_url')).toBe('http://localhost:8080/account?checkout=success');
    expect(sessionCall?.body.get('cancel_url')).toBe('http://localhost:8080/account?checkout=cancelled');
    const second = await call('/cms/api/account/checkout', { method: 'POST', token, body: { offer: 'growth_monthly' } });
    expect(second.status).toBe(200);
    expect(stripe.requests.filter((request) => request.path === '/v1/customers')).toHaveLength(1);
    const me = await call('/cms/api/account/me', { token });
    expect(me.data.user.billing_customer_linked).toBe(true);
    const anonymous = await call('/cms/api/account/checkout', { method: 'POST', body: { offer: 'growth_monthly' } });
    expect(anonymous.status).toBe(401);
  });

  test('portal requires a linked customer and returns only the hosted portal URL', async () => {
    await createUser(payload, { email: 'fresh@example.test', password: PASSWORD });
    const noCustomer = await call('/cms/api/account/portal', { method: 'POST', token: await login('fresh@example.test', PASSWORD) });
    expect(noCustomer.status).toBe(404);
    expect(noCustomer.data.error.code).toBe('no_customer');
    const portal = await call('/cms/api/account/portal', { method: 'POST', token: await login('member@example.test', PASSWORD) });
    expect(portal.status).toBe(200);
    expect(portal.data).toEqual({ url: 'https://billing.stripe.com/p/session/synthetic1' });
    expect(stripe.requests.find((request) => request.path === '/v1/billing_portal/sessions')?.body.get('return_url')).toBe('http://localhost:8080/account');
  });

  test('plans are admin-only through REST and never readable by members', async () => {
    const member = await call('/cms/api/plans', { token: await login('member@example.test', PASSWORD) });
    expect(member.status).toBe(403);
    const staff = await call('/cms/api/plans', { token: await login('staff@example.test', PASSWORD) });
    expect(staff.status).toBe(200);
    const staffWrite = await call('/cms/api/plans', { method: 'POST', token: await login('staff@example.test', PASSWORD), body: { offerId: 'x_plan', label: 'x', mode: 'subscription', stripePriceId: 'price_synthetic0009', quantity: 1 } });
    expect(staffWrite.status).toBe(403);
    const admin = await login('admin@example.test', PASSWORD);
    const badQuota = await call('/cms/api/plans', { method: 'POST', token: admin, body: { offerId: 'bad_quota', label: 'x', mode: 'subscription', stripePriceId: 'price_synthetic0009', quantity: 1, gateway: { quotaRate: 0.001, quotaBurst: 10000 } } });
    expect(badQuota.status).toBe(400);
    // Stripe line-item quantities are integers; a fractional plan quantity would make every checkout fail upstream.
    const fractional = await call('/cms/api/plans', { method: 'POST', token: admin, body: { offerId: 'half_pack', label: 'x', mode: 'subscription', stripePriceId: 'price_synthetic0009', quantity: 1.5, gateway: { quotaRate: 1, quotaBurst: 10 } } });
    expect(fractional.status).toBe(400);
    // A Stripe price maps to exactly one plan, so a subscription's billed price resolves unambiguously.
    const duplicatePrice = await call('/cms/api/plans', { method: 'POST', token: admin, body: { offerId: 'growth_copy', label: 'x', mode: 'subscription', stripePriceId: 'price_synthetic0001', quantity: 1, gateway: { quotaRate: 1, quotaBurst: 10 } } });
    expect(duplicatePrice.status).toBe(400);
    // The quota invariant holds for the effective policy: a partial update of one field is checked against the stored other.
    const created = await call('/cms/api/plans?depth=0', { method: 'POST', token: admin, body: { offerId: 'partial_plan', label: 'x', mode: 'subscription', stripePriceId: 'price_synthetic0010', quantity: 1, gateway: { quotaRate: 1, quotaBurst: 100 } } });
    expect(created.status).toBe(201);
    const rateOnly = await call(`/cms/api/plans/${created.data.doc.id}?depth=0`, { method: 'PATCH', token: admin, body: { gateway: { quotaRate: 0.001 } } });
    expect(rateOnly.status).toBe(400); // 0.001 × 86400 = 86.4 < the stored burst of 100
    expect((await payload.findByID({ collection: 'plans', id: created.data.doc.id, overrideAccess: true, depth: 0 })).gateway?.quotaRate).toBe(1);
    const burstOnly = await call(`/cms/api/plans/${created.data.doc.id}?depth=0`, { method: 'PATCH', token: admin, body: { gateway: { quotaBurst: 86 } } });
    expect(burstOnly.status).toBe(200);
    expect((await call(`/cms/api/plans/${created.data.doc.id}?depth=0`, { method: 'PATCH', token: admin, body: { gateway: { quotaRate: 0.001 } } })).status).toBe(200);
  });
});

test('the status response lists every sellable plan, however many there are, in offer order', async () => {
  for (let i = 1; i <= 3; i += 1) {
    await payload.create({ collection: 'plans', data: { offerId: `bulk_plan_${i}`, label: `Bulk ${i}`, mode: 'subscription', stripePriceId: `price_synthetic09${String(i).padStart(2, '0')}`, quantity: 1, active: true, gateway: { permissions: ['manifest'], quotaRate: 1, quotaBurst: 10 } }, overrideAccess: true });
  }
  const all = await sellablePlans(payload);
  const offers = all.map((plan) => plan.offerId);
  expect(offers).toEqual([...offers].sort()); // sorted by offer id
  expect(offers).toEqual(expect.arrayContaining(['growth_monthly', 'bulk_plan_1', 'bulk_plan_2', 'bulk_plan_3']));
  expect(offers).not.toContain('one_time_pack'); // payment-mode plans grant nothing here
  expect(offers).not.toContain('hidden_plan'); // inactive plans are never offered
  // Walking one plan per page yields the same list: the status response never truncates the catalogue.
  expect((await sellablePlans(payload, 1)).map((plan) => plan.offerId)).toEqual(offers);
  const status = await call('/cms/api/account/status');
  expect(status.data.offers.map((plan: { id: string }) => plan.id)).toEqual(offers);
});
