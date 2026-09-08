// Verifies the Stripe payments foundation stays prepared-but-disabled:
//   1. the offers contract and OpenAPI document agree with the service code;
//   2. Caddy fails closed and the CSP admits only Stripe's hosted origins;
//   3. secret hygiene: env files are ignored and no Stripe key material is tracked;
//   4. the built /billing pages are noindex, unlinked from the sitemap, disabled by
//      default, and load no Stripe script.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { KNOWN_VARIABLES, OFFER_ID, OFFER_MODES } from '../../payments/src/config.mjs';
import { ERRORS, ROUTES, STRIPE_METHODS } from '../../payments/src/server.mjs';

const web = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repo = resolve(web, '..');
const read = (path) => readFileSync(resolve(repo, path), 'utf8');

// 1. Contracts -----------------------------------------------------------------
const offers = JSON.parse(read('payments/contracts/v1/offers.json'));
assert.equal(offers.schema, 'payments-offers/v1');
assert.equal(offers.status, 'prepared_not_enabled');
assert.equal(offers.price_publication, 'not_published');
assert.equal(offers.non_offer, true);
assert.equal(offers.free_static_surfaces_unchanged, true);
assert.ok(Array.isArray(offers.offers) && offers.offers.length >= 1 && offers.offers.length <= 50);
const ids = offers.offers.map((offer) => offer.id);
assert.equal(new Set(ids).size, ids.length, 'offer ids must be unique');
for (const offer of offers.offers) {
  assert.deepEqual(Object.keys(offer).sort(), ['description', 'id', 'label', 'mode', 'plan', 'requires_explicit_opt_in'], `offer ${offer.id} keys`);
  assert.match(offer.id, OFFER_ID);
  assert.ok(OFFER_MODES.includes(offer.mode), `offer ${offer.id} mode`);
  assert.equal(offer.requires_explicit_opt_in, true);
  assert.ok(!/\$|USD|€|£|\d+(?:\.\d+)?\s*(?:per|\/)\s*(?:month|year)/i.test(`${offer.label} ${offer.description}`), `offer ${offer.id} must not publish a price`);
}

const api = await SwaggerParser.validate(resolve(repo, 'payments/contracts/v1/openapi.json'));
assert.equal(api.openapi, '3.1.0');
assert.match(api.info.description, /NOT ENABLED/);
assert.match(api.info.description, /not deployed/i);
assert.deepEqual(Object.keys(api.paths).sort(), Object.values(ROUTES).sort(), 'OpenAPI paths must equal the server routes');
assert.deepEqual([...api.components.schemas.Error.properties.error.properties.code.enum].sort(), Object.keys(ERRORS).sort(), 'OpenAPI error codes must equal the server catalogue');
for (const [path, item] of Object.entries(api.paths)) {
  const methods = Object.keys(item).filter((key) => ['get', 'head', 'post', 'put', 'patch', 'delete'].includes(key)).sort();
  assert.deepEqual(methods, path === ROUTES.health ? ['get', 'head'] : ['post'], `${path} methods`);
  for (const method of methods) assert.ok(item[method].responses['503'], `${method} ${path} must document the disabled 503`);
}
const readme = read('payments/contracts/v1/README.md');
assert.match(readme, /PREPARED, NOT ENABLED/);
assert.match(readme, /never paywalled/i);
const envExample = read('payments/.env.example');
assert.match(envExample, /^PAYMENTS_MODE=disabled$/m, '.env.example must default to disabled');
for (const name of KNOWN_VARIABLES) assert.ok(new RegExp(`^#?\\s*${name}=`, 'm').test(envExample), `.env.example must document ${name}`);

// Restricted-key permissions documented for operators must match what the service
// actually calls, so a new Stripe method wired into the server forces a docs update.
assert.deepEqual([...STRIPE_METHODS].sort(), ['createCheckoutSession', 'retrieveCheckoutSession', 'retrieveInvoice', 'retrieveSubscription'].sort(), 'STRIPE_METHODS changed; update the restricted-key permissions documented in docs/PAYMENTS.md and payments/.env.example alongside this list');
assert.ok(!STRIPE_METHODS.includes('createBillingPortalSession'), 'the payments service must never call Billing Portal; that permission belongs only to the CMS\'s separate restricted key');
const paymentsDoc = read('docs/PAYMENTS.md');
const keyBullet = /- \[ \] Restricted API key created with:[^\n]+/.exec(paymentsDoc)?.[0];
assert.ok(keyBullet, 'docs/PAYMENTS.md must document the restricted key permissions');
assert.match(keyBullet, /Checkout Sessions write/i, 'restricted key docs must grant Checkout Sessions write');
assert.match(keyBullet, /Subscriptions read/i, 'restricted key docs must grant Subscriptions read (reconciliation reads subscriptions)');
assert.match(keyBullet, /Invoices read/i, 'restricted key docs must grant Invoices read (reconciliation reads invoices)');
assert.doesNotMatch(keyBullet, /(?:Customer|Billing) Portal (?:read|write)/i, 'the payments service restricted key must not request Billing/Customer Portal access; that belongs to the CMS key');
assert.match(envExample, /Do not grant Billing Portal/i, '.env.example must explicitly deny Billing Portal permission to the payments-service key');
assert.match(envExample, /Subscriptions read/i, '.env.example must document Subscriptions read');
assert.match(envExample, /Invoices read/i, '.env.example must document Invoices read');

// 2. Caddy ---------------------------------------------------------------------
const caddy = read('Caddyfile');
const csp = /Content-Security-Policy "([^"]+)"/.exec(caddy)?.[1];
assert.ok(csp, 'Caddyfile must set a CSP');
const directives = Object.fromEntries(csp.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
assert.deepEqual(directives['form-action'], ["'self'", 'https://checkout.stripe.com', 'https://billing.stripe.com'], 'form-action must allow exactly the Stripe hosted origins');
for (const name of ['script-src', 'connect-src', 'child-src', 'style-src', 'img-src']) assert.ok(!directives[name].some((value) => value.includes('stripe')), `${name} must not admit Stripe: hosted Checkout only`);
assert.ok(!Object.hasOwn(directives, 'frame-src'), 'no frame-src: Stripe is never embedded');
assert.match(caddy, /Permissions-Policy "[^"]*payment=\(\)/, 'Permissions-Policy must keep payment=() on this origin');
assert.match(caddy, /handle \/billing\/api\/\* \{/, 'Caddy must route /billing/api/*');
assert.match(caddy, /@paymentsEnabled expression `\{env\.PAYMENTS_UPSTREAM\} != ""`/, 'the route must be gated on PAYMENTS_UPSTREAM');
assert.match(caddy, /reverse_proxy @paymentsEnabled \{env\.PAYMENTS_UPSTREAM\}/);
const [disabledStatus, disabledMessage] = ERRORS.payments_disabled;
const fallback = `respond \`${JSON.stringify({ error: { code: 'payments_disabled', message: disabledMessage } })}\` ${disabledStatus}`;
assert.ok(caddy.includes(fallback), `Caddy fallback must match the service's payments_disabled response: ${fallback}`);
const billingBlock = caddy.slice(caddy.indexOf('handle /billing/api/* {'), caddy.indexOf('# Release descriptors are cross-origin'));
assert.ok(!/file_server|try_files/.test(billingBlock), '/billing/api must never serve from disk');
assert.match(billingBlock, /Cache-Control "no-store"/);

// 3. Secret hygiene ------------------------------------------------------------
const gitignore = read('.gitignore');
for (const rule of ['.env', '.env.*', '!.env.example']) assert.ok(gitignore.split('\n').includes(rule), `.gitignore must contain ${rule}`);
const dockerignore = read('.dockerignore');
for (const rule of ['.env', '**/.env', '**/.env.*']) assert.ok(dockerignore.split('\n').includes(rule), `.dockerignore must contain ${rule}`);
assert.match(read('payments/.dockerignore'), /^\.env$/m);
assert.match(read('Dockerfile'), /^COPY payments\/contracts\/ \.\/payments\/contracts\/$/m, 'the site image must carry the offers contract');
assert.match(read('payments/Dockerfile'), /PAYMENTS_MODE=disabled/, 'the service image must default to disabled');

const tracked = execFileSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
const keyLike = /\b(?:sk|rk|pk)_(?:test|live)_([A-Za-z0-9]{24,})\b|\bwhsec_([A-Za-z0-9]{24,})\b/g;
const suspicious = [];
for (const path of tracked) {
  if (/\.(?:png|jpg|jpeg|webp|ico|woff2|xlsx|sqlite|bundle|gz)$/i.test(path)) continue;
  // Scan the working-tree bytes when present, otherwise the exact staged blob. This
  // keeps tracked deletions covered without following paths or resurrecting files.
  const text = existsSync(resolve(repo, path))
    ? readFileSync(resolve(repo, path), 'utf8')
    : execFileSync('git', ['-C', repo, 'show', `:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const match of text.matchAll(keyLike)) {
    const body = match[1] ?? match[2];
    // Synthetic fixtures use a repeated character; real Stripe material is high-entropy.
    if (new Set(body).size >= 10) suspicious.push(`${path}: ${match[0].slice(0, 12)}…`);
  }
}
assert.deepEqual(suspicious, [], 'tracked files must not contain Stripe key material');
for (const path of tracked) assert.ok(!/(^|\/)\.env(\.(?!example$)[^/]*)?$/.test(path), `environment file must not be tracked: ${path}`);

// 4. Built pages --------------------------------------------------------------------
const dist = resolve(web, 'dist');
assert.ok(existsSync(dist), 'web/dist is required: run `npm run build` first');
const page = (path) => { const file = resolve(dist, path); assert.ok(existsSync(file), `missing built page ${path}`); return readFileSync(file, 'utf8'); };
const billing = page('billing/index.html');
const success = page('billing/success/index.html');
const cancelled = page('billing/cancelled/index.html');
for (const [name, html] of [['billing', billing], ['success', success], ['cancelled', cancelled]]) {
  assert.match(html, /<meta name="robots" content="noindex,follow">/, `${name} must be noindex`);
  assert.ok(!html.includes('rel="canonical"'), `${name} must not emit a canonical link`);
  assert.ok(!/stripe\.com\/v3|js\.stripe\.com|pk_(?:test|live)_/.test(html), `${name} must not load Stripe.js or embed a publishable key`);
}
assert.match(billing, /data-payments-mode="disabled"/, 'CI builds must render the disabled state');
assert.match(billing, /data-payments-disabled-notice/);
assert.match(billing, /Payments are not enabled/);
for (const id of ids) assert.ok(billing.includes(`<input type="hidden" name="offer" value="${id}">`), `billing page must offer ${id}`);
assert.equal((billing.match(new RegExp(`action="${ROUTES.checkout}"`, 'g')) ?? []).length, ids.length, 'one checkout form per offer');
assert.equal((billing.match(/<button[^>]*\sdisabled[\s>]/g) ?? []).length, ids.length, 'every checkout button must be disabled by default');
assert.doesNotMatch(billing, /portal-session|name="session_id"/);
assert.match(success, /href="\/account"/);
// The success page only scrubs a legacy session_id from the visible URL/history for
// old in-flight Checkout Sessions returning after deployment; it must never restore
// the removed anonymous portal form, API call, or input field.
assert.match(success, /searchParams\.delete\('session_id'\)/, 'success page must scrub a legacy session_id query parameter');
assert.match(success, /history\.replaceState/, 'success page must scrub the URL via history.replaceState, not a reload');
assert.doesNotMatch(success, /portal-session|name="session_id"|<form|fetch\(/i, 'success page must not restore the anonymous portal form or any API call');
assert.match(cancelled, /Nothing was charged/);
const robots = readFileSync(resolve(dist, 'robots.txt'), 'utf8');
assert.ok(robots.includes('Disallow: /billing/'), 'robots.txt must disallow /billing/');
const sitemap = readFileSync(resolve(dist, 'sitemap.xml'), 'utf8');
assert.ok(!sitemap.includes('/billing'), 'sitemap must not list billing pages');
assert.ok(!existsSync(resolve(dist, 'billing/api')), 'dist must not contain anything under /billing/api');

console.log(`Payments foundation OK: ${ids.length} offer(s) without prices; OpenAPI/route/error parity; Caddy fails closed with Stripe-only form-action; env files ignored; ${tracked.length} tracked files free of key material; /billing pages noindex and disabled`);
