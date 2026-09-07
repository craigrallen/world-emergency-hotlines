import { describe, expect, test } from 'vitest';
import { BUILD_PLACEHOLDER_SECRET, EnvError, KNOWN_VARIABLES, describeEnv, readEnv, validOrigin } from '../src/env';

const base = { PAYLOAD_SECRET: 'x'.repeat(40), DATABASE_URL: 'file:./data/x.db', PUBLIC_SITE_URL: 'https://worldhotlines.org' };
const expectVariable = (source: Record<string, string | undefined>, variable: string) => {
  const clean = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as unknown as NodeJS.ProcessEnv;
  expect(() => readEnv(clean)).toThrowError(expect.objectContaining({ variable }) as unknown as EnvError);
};

describe('environment parsing fails closed', () => {
  test('defaults are closed, keyless, and secret-free', () => {
    const env = readEnv(base as unknown as NodeJS.ProcessEnv);
    expect(env).toMatchObject({ registration: 'closed', requireEmailVerification: false, stripeMode: 'disabled', stripeSecretKey: null, gatewayKeyPepper: null, databaseKind: 'sqlite', cookieSecure: true, bootstrapAdmin: null, maxApiKeysPerUser: 5 });
    expect(Object.isFrozen(env)).toBe(true);
    expect(JSON.stringify(describeEnv(env))).not.toContain('x'.repeat(40));
  });

  test('build phase gets a placeholder secret; runtime never does', () => {
    expect(readEnv({ ...base, PAYLOAD_SECRET: undefined, NEXT_PHASE: 'phase-production-build' } as unknown as NodeJS.ProcessEnv).payloadSecret).toBe(BUILD_PLACEHOLDER_SECRET);
    expectVariable({ ...base, PAYLOAD_SECRET: undefined }, 'PAYLOAD_SECRET');
    expectVariable({ ...base, PAYLOAD_SECRET: 'short' }, 'PAYLOAD_SECRET');
  });

  test('each rule names its variable', () => {
    for (const [patch, variable] of [
      [{ CMS_BOGUS: '1' }, 'CMS_BOGUS'], [{ STRIPE_KEY: 'x' }, 'STRIPE_KEY'],
      [{ DATABASE_URL: 'mysql://x' }, 'DATABASE_URL'], [{ NODE_ENV: 'production' }, 'DATABASE_URL'],
      [{ PUBLIC_SITE_URL: 'http://worldhotlines.org' }, 'PUBLIC_SITE_URL'], [{ PUBLIC_SITE_URL: 'https://worldhotlines.org/' }, 'PUBLIC_SITE_URL'],
      [{ CMS_ACCOUNTS_REGISTRATION: 'yes' }, 'CMS_ACCOUNTS_REGISTRATION'], [{ CMS_REQUIRE_EMAIL_VERIFICATION: 'maybe' }, 'CMS_REQUIRE_EMAIL_VERIFICATION'],
      [{ SMTP_URL: 'http://mail' }, 'SMTP_URL'], [{ SMTP_FROM_ADDRESS: 'nope' }, 'SMTP_FROM_ADDRESS'],
      [{ STRIPE_SECRET_KEY: 'sk_test_short' }, 'STRIPE_SECRET_KEY'], [{ STRIPE_SECRET_KEY: `sk_test_${'a'.repeat(40)}` }, 'STRIPE_WEBHOOK_SECRET'],
      [{ STRIPE_SECRET_KEY: `sk_test_${'a'.repeat(40)}`, STRIPE_WEBHOOK_SECRET: 'nope' }, 'STRIPE_WEBHOOK_SECRET'], [{ STRIPE_WEBHOOK_SECRET: `whsec_${'b'.repeat(32)}` }, 'STRIPE_WEBHOOK_SECRET'],
      [{ STRIPE_SECRET_KEY: `sk_live_${'a'.repeat(40)}`, STRIPE_WEBHOOK_SECRET: `whsec_${'b'.repeat(32)}`, PUBLIC_SITE_URL: 'http://localhost:8080' }, 'PUBLIC_SITE_URL'],
      [{ STRIPE_SECRET_KEY: `sk_live_${'a'.repeat(40)}`, STRIPE_WEBHOOK_SECRET: `whsec_${'b'.repeat(32)}`, CMS_STRIPE_API_BASE: 'http://127.0.0.1:1' }, 'CMS_STRIPE_API_BASE'],
      [{ CMS_STRIPE_API_BASE: 'https://api.stripe.com' }, 'CMS_STRIPE_API_BASE'], [{ GATEWAY_KEY_PEPPER: 'short' }, 'GATEWAY_KEY_PEPPER'],
      [{ CMS_MAX_API_KEYS_PER_USER: '0' }, 'CMS_MAX_API_KEYS_PER_USER'], [{ CMS_ADMIN_EMAIL: 'admin@example.org' }, 'CMS_ADMIN_PASSWORD'], [{ CMS_ADMIN_PASSWORD: 'x'.repeat(20) }, 'CMS_ADMIN_EMAIL'],
    ] as [Record<string, string>, string][]) expectVariable({ ...base, ...patch }, variable);
    expect(readEnv({ ...base, STRIPE_SECRET_KEY: `rk_live_${'a'.repeat(40)}`, STRIPE_WEBHOOK_SECRET: `whsec_${'b'.repeat(32)}` } as unknown as NodeJS.ProcessEnv).stripeMode).toBe('live');
    expect(readEnv({ ...base, DATABASE_URL: 'postgresql://u:p@h:5432/d', NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv).databaseKind).toBe('postgres');
    expect(KNOWN_VARIABLES).toContain('GATEWAY_KEY_PEPPER');
    // Read directly by the users_customers_per_mode migration, never by readEnv() itself: recognized so it never
    // trips the unknown-CMS_-variable fail-closed check, but otherwise inert here.
    expect(KNOWN_VARIABLES).toContain('CMS_LEGACY_STRIPE_CUSTOMER_MODE');
    expect(() => readEnv({ ...base, CMS_LEGACY_STRIPE_CUSTOMER_MODE: 'live' } as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });

  test('empty optional variables mean not configured, as Compose and Railway pass them', () => {
    const env = readEnv({ ...base, SMTP_URL: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', GATEWAY_KEY_PEPPER: '', CMS_ADMIN_EMAIL: '', CMS_ADMIN_PASSWORD: '', CMS_STRIPE_API_BASE: '', CMS_ACCOUNTS_REGISTRATION: '', CMS_MAX_API_KEYS_PER_USER: '' } as unknown as NodeJS.ProcessEnv);
    expect(env).toMatchObject({ smtpUrl: null, stripeMode: 'disabled', stripeSecretKey: null, stripeWebhookSecret: null, gatewayKeyPepper: null, bootstrapAdmin: null, stripeApiBase: null, registration: 'closed', maxApiKeysPerUser: 5 });
    expectVariable({ ...base, PAYLOAD_SECRET: '' }, 'PAYLOAD_SECRET');
  });

  test('origin validation', () => {
    for (const ok of ['https://worldhotlines.org', 'http://localhost:8080', 'http://127.0.0.1:3000']) expect(validOrigin(ok)).toBe(true);
    for (const bad of ['http://worldhotlines.org', 'https://worldhotlines.org/x', 'https://a:b@worldhotlines.org', 'https://*.example.org', '']) expect(validOrigin(bad)).toBe(false);
  });
});
