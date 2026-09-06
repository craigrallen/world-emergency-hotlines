import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, DEFAULT_PORT, KNOWN_VARIABLES, describeConfig, loadConfig, parseOffers, redact } from '../src/config.mjs';

const KEY = `sk_test_${'a'.repeat(40)}`;
const LIVE_KEY = `sk_live_${'a'.repeat(40)}`;
const WHSEC = `whsec_${'b'.repeat(32)}`;
const OFFERS = JSON.stringify({ growth_monthly: { price: 'price_synthetic0001', mode: 'subscription' } });
const enabled = (extra = {}) => ({ PAYMENTS_MODE: 'test', STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WHSEC, PAYMENTS_OFFERS: OFFERS, ...extra });

test('defaults are disabled, loopback, and secret-free', () => {
  const config = loadConfig({});
  assert.equal(config.mode, 'disabled');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.stripe, null);
  assert.deepEqual(config.offers, {});
  assert.equal(config.publicOrigin, 'https://worldhotlines.org');
  assert.ok(Object.isFrozen(config));
  assert.equal(JSON.stringify(describeConfig(config)).includes('sk_'), false);
});

test('disabled mode ignores Stripe variables but still rejects unknown names', () => {
  assert.equal(loadConfig({ STRIPE_SECRET_KEY: 'garbage', STRIPE_WEBHOOK_SECRET: 'garbage' }).mode, 'disabled');
  for (const name of ['PAYMENTS_FOO', 'STRIPE_WEBHOOK_SECRETS', 'STRIPE_KEY']) {
    assert.throws(() => loadConfig({ [name]: 'x' }), (error) => error instanceof ConfigError && error.variable === name);
  }
  assert.ok(KNOWN_VARIABLES.includes('STRIPE_SECRET_KEY'));
});

test('enabled modes require matching keys, a webhook secret, and offers', () => {
  const config = loadConfig(enabled());
  assert.equal(config.mode, 'test');
  assert.equal(config.stripe.secretKey, KEY);
  assert.equal(config.stripe.apiVersion, null);
  assert.deepEqual(Object.keys(config.offers), ['growth_monthly']);
  assert.equal(config.offers.growth_monthly.quantity, 1);
  const cases = [
    [enabled({ STRIPE_SECRET_KEY: undefined }), 'STRIPE_SECRET_KEY'],
    [enabled({ STRIPE_SECRET_KEY: LIVE_KEY }), 'STRIPE_SECRET_KEY'],
    [{ ...enabled(), PAYMENTS_MODE: 'live', PAYMENTS_PUBLIC_ORIGIN: 'https://worldhotlines.org' }, 'STRIPE_SECRET_KEY'],
    [enabled({ STRIPE_SECRET_KEY: 'sk_test_short' }), 'STRIPE_SECRET_KEY'],
    [enabled({ STRIPE_WEBHOOK_SECRET: undefined }), 'STRIPE_WEBHOOK_SECRET'],
    [enabled({ STRIPE_WEBHOOK_SECRET: 'whsec_replace_me' }), 'STRIPE_WEBHOOK_SECRET'],
    [enabled({ STRIPE_API_VERSION: 'latest' }), 'STRIPE_API_VERSION'],
    [enabled({ PAYMENTS_OFFERS: undefined }), 'PAYMENTS_OFFERS'],
    [enabled({ PAYMENTS_MODE: 'production' }), 'PAYMENTS_MODE'],
    [enabled({ PORT: '70000' }), 'PORT'],
    [enabled({ PORT: 'abc' }), 'PORT'],
    [enabled({ PAYMENTS_TRUST_PROXY: 'yes' }), 'PAYMENTS_TRUST_PROXY'],
    [enabled({ PAYMENTS_STRIPE_TIMEOUT_MS: '10' }), 'PAYMENTS_STRIPE_TIMEOUT_MS'],
  ];
  for (const [env, variable] of cases) {
    const clean = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
    assert.throws(() => loadConfig(clean), (error) => error instanceof ConfigError && error.variable === variable, `expected ${variable} failure`);
  }
  const live = loadConfig({ ...enabled(), PAYMENTS_MODE: 'live', STRIPE_SECRET_KEY: LIVE_KEY, STRIPE_API_VERSION: '2025-08-27.basil' });
  assert.equal(live.stripe.apiVersion, '2025-08-27.basil');
  const restricted = loadConfig(enabled({ STRIPE_SECRET_KEY: `rk_test_${'c'.repeat(40)}` }));
  assert.equal(restricted.stripe.secretKey.startsWith('rk_test_'), true);
});

test('configuration errors never echo secret values', () => {
  const secret = `sk_live_${'z'.repeat(40)}`;
  try { loadConfig(enabled({ STRIPE_SECRET_KEY: secret })); assert.fail('should throw'); } catch (error) {
    assert.equal(error.message.includes('z'.repeat(10)), false);
  }
  try { loadConfig(enabled({ PAYMENTS_OFFERS: JSON.stringify({ growth_monthly: { price: secret, mode: 'subscription' } }) })); assert.fail('should throw'); } catch (error) {
    assert.equal(error.message.includes('z'.repeat(10)), false);
  }
});

test('offers are a closed, bounded map keyed by safe ids', () => {
  const parsed = parseOffers(JSON.stringify({ a1: { price: 'price_synthetic0001', mode: 'payment', quantity: 3 } }));
  assert.deepEqual(parsed.a1, { id: 'a1', price: 'price_synthetic0001', mode: 'payment', quantity: 3 });
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.a1));
  const bad = [
    'not json', '[]', '{}', JSON.stringify({ 'Bad-Id': { price: 'price_synthetic0001', mode: 'payment' } }),
    JSON.stringify({ ok: { price: 'price_synthetic0001' } }), JSON.stringify({ ok: { price: 'prod_synthetic0001', mode: 'payment' } }),
    JSON.stringify({ ok: { price: 'price_synthetic0001', mode: 'setup' } }), JSON.stringify({ ok: { price: 'price_synthetic0001', mode: 'payment', quantity: 0 } }),
    JSON.stringify({ ok: { price: 'price_synthetic0001', mode: 'payment', extra: true } }),
    JSON.stringify(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`o${i}`, { price: 'price_synthetic0001', mode: 'payment' }]))),
  ];
  for (const raw of bad) assert.throws(() => parseOffers(raw), ConfigError, raw.slice(0, 40));
});

test('public origin and paths are validated per mode', () => {
  assert.equal(loadConfig(enabled({ PAYMENTS_PUBLIC_ORIGIN: 'http://localhost:4321' })).publicOrigin, 'http://localhost:4321');
  assert.throws(() => loadConfig({ ...enabled({ PAYMENTS_PUBLIC_ORIGIN: 'http://localhost:4321' }), PAYMENTS_MODE: 'live', STRIPE_SECRET_KEY: LIVE_KEY }), (error) => error.variable === 'PAYMENTS_PUBLIC_ORIGIN');
  for (const origin of ['https://worldhotlines.org/', 'https://worldhotlines.org/billing', 'https://user:pw@worldhotlines.org', 'http://example.com', 'https://*.example.com', 'worldhotlines.org']) {
    assert.throws(() => loadConfig(enabled({ PAYMENTS_PUBLIC_ORIGIN: origin })), (error) => error.variable === 'PAYMENTS_PUBLIC_ORIGIN', origin);
  }
  for (const [name, value] of [['PAYMENTS_SUCCESS_PATH', 'billing/success'], ['PAYMENTS_CANCEL_PATH', '/billing?x=1'], ['PAYMENTS_RETURN_PATH', '/../etc'], ['PAYMENTS_SUCCESS_PATH', '/a#b'], ['PAYMENTS_SUCCESS_PATH', `/${'a'.repeat(300)}`]]) {
    assert.throws(() => loadConfig(enabled({ [name]: value })), (error) => error.variable === name, `${name}=${value}`);
  }
  assert.equal(loadConfig(enabled({ PAYMENTS_SUCCESS_PATH: '/thanks' })).successPath, '/thanks');
});

test('redact removes Stripe key material from strings and objects', () => {
  const key = `sk_live_${'q'.repeat(30)}`;
  assert.equal(redact(`Bearer ${key} whsec_${'r'.repeat(20)} pk_test_${'s'.repeat(20)}`), 'Bearer [REDACTED] [REDACTED] [REDACTED]');
  assert.deepEqual(redact({ authorization: 'x', nested: { STRIPE_SECRET_KEY: key, note: `see ${key}` }, list: [key] }), { authorization: '[REDACTED]', nested: { STRIPE_SECRET_KEY: '[REDACTED]', note: 'see [REDACTED]' }, list: ['[REDACTED]'] });
  assert.equal(redact(42), 42);
});
