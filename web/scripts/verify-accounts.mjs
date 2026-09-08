// Verifies the Payload CMS account foundation stays prepared-but-disabled and wired
// consistently across the site, Caddy, the payments service, and the gateway:
//   1. Caddy fails closed for /cms/*, /admin, and /_next/* until CMS_UPSTREAM is set;
//   2. the CMS documents every environment variable it reads and keeps secrets out of git;
//   3. the payments store and gateway key sync speak the CMS contract;
//   4. the built /account pages are noindex, unlinked from the sitemap, disabled by
//      default, and load nothing from Stripe or the CMS at build time.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_VARIABLES as PAYMENTS_VARIABLES, STORE_KINDS } from '../../payments/src/config.mjs';
import { KEY_RECORDS_SCHEMA } from '../../gateway/src/cms-keys.mjs';

const web = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repo = resolve(web, '..');
const read = (path) => readFileSync(resolve(repo, path), 'utf8');
const DISABLED_BODY = '{"error":{"code":"accounts_disabled","message":"Accounts are not enabled"}}';

// 1. Caddy -----------------------------------------------------------------------
const caddy = read('Caddyfile');
assert.match(caddy, /@cms path \/cms\/\* \/admin \/admin\/\* \/_next\/\*/, 'Caddy must match exactly the CMS route family');
assert.match(caddy, /handle @cms \{/);
assert.match(caddy, /@cmsEnabled expression `\{env\.CMS_UPSTREAM\} != ""`/, 'the CMS routes must be gated on CMS_UPSTREAM');
assert.match(caddy, /reverse_proxy @cmsEnabled \{env\.CMS_UPSTREAM\}/);
assert.ok(caddy.includes(`respond \`${DISABLED_BODY}\` 503`), 'Caddy fallback must be the exact accounts_disabled response');
const cmsBlock = caddy.slice(caddy.indexOf('handle @cms {'), caddy.indexOf('# Release descriptors are cross-origin'));
assert.ok(cmsBlock.length > 0 && !/file_server|try_files/.test(cmsBlock), 'CMS routes must never serve from disk');
assert.match(cmsBlock, /@cmsWebhook path \/cms\/api\/stripe\/webhooks/);
assert.match(cmsBlock, /request_body @cmsWebhook \{\s*max_size 262144\s*\}/);
assert.match(caddy, /request>uri query \{\s*delete session_id\s*delete token\s*\}/);
assert.match(cmsBlock, /Cache-Control "no-store"/);
for (const header of ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']) assert.ok(cmsBlock.includes(`header_down -${header}`), `proxied CMS responses must not duplicate ${header}`);

// 2. CMS configuration surface --------------------------------------------------------
const envSource = read('cms/src/env.ts');
const known = /^export const KNOWN_VARIABLES = Object\.freeze\(\[([\s\S]*?)\]\);/m.exec(envSource);
assert.ok(known, 'cms/src/env.ts must declare KNOWN_VARIABLES');
const cmsVariables = [...known[1].matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1]);
assert.ok(cmsVariables.length >= 10);
const cmsEnvExample = read('cms/.env.example');
for (const name of cmsVariables) assert.ok(new RegExp(`^#?\\s*${name}=`, 'm').test(cmsEnvExample), `cms/.env.example must document ${name}`);
assert.match(cmsEnvExample, /^CMS_ACCOUNTS_REGISTRATION=closed$/m, 'registration must default to closed');
assert.match(cmsEnvExample, /^PUBLIC_SITE_URL=https:\/\/worldhotlines\.org$/m);
assert.ok(!/^STRIPE_SECRET_KEY=/m.test(cmsEnvExample) && !/^GATEWAY_KEY_PEPPER=/m.test(cmsEnvExample), 'Stripe and pepper stay commented out in the example');
for (const [file, rules] of [['cms/.gitignore', ['.env', '.env.*', '!.env.example']], ['cms/.dockerignore', ['.env', '.env.*', '!.env.example', 'node_modules']]]) {
  const lines = read(file).split('\n');
  for (const rule of rules) assert.ok(lines.includes(rule), `${file} must contain ${rule}`);
}
const payloadConfig = read('cms/src/payload.config.ts');
assert.match(payloadConfig, /routes: \{ admin: '\/admin', api: '\/cms\/api' \}/, 'Payload routes must match the Caddy CMS route family');
assert.match(payloadConfig, /graphQL: \{ disable: true \}/, 'GraphQL stays off');
assert.match(payloadConfig, /csrf: \[env\.siteUrl\]/);
assert.match(payloadConfig, /cors: \[env\.siteUrl\]/);
assert.ok(!payloadConfig.includes('stripePlugin'), 'the plugin webhook route acknowledges Stripe before handlers run; the CMS owns its webhook endpoint');
assert.match(payloadConfig, /stripeWebhookEndpoint/, 'the signed webhook endpoint must be registered');
const stripeWebhook = read('cms/src/endpoints/stripe-webhook.ts');
assert.match(stripeWebhook, /path: STRIPE_WEBHOOK_PATH/);
assert.match(stripeWebhook, /export const STRIPE_WEBHOOK_PATH = '\/stripe\/webhooks'/, 'webhook path must stay under the Caddy CMS route family');
assert.match(stripeWebhook, /constructEvent\(/, 'the webhook must verify Stripe-Signature');
assert.match(stripeWebhook, /fail\(req, 'handler_failed'\)/, 'a failed handler must answer non-2xx so Stripe retries');
assert.match(read('cms/src/collections/StripeEvents.ts'), /name: 'claimKey',\n\s+type: 'text',\n\s+required: true,\n\s+unique: true/, 'ledger claims are unique per consumer and event');
assert.ok(existsSync(resolve(repo, 'cms/src/app/(payload)/cms/api/[...slug]/route.ts')), 'the REST route folder must match routes.api');
assert.ok(!existsSync(resolve(repo, 'cms/src/app/(payload)/api')), 'no REST route may exist at /api: it would shadow the static /api/v1');
assert.match(read('cms/Dockerfile'), /^ENV NODE_ENV=production/m);
assert.match(read('cms/railway.toml'), /healthcheckPath = "\/cms\/api\/account\/status"/);
const cmsPackage = JSON.parse(read('cms/package.json'));
for (const name of ['payload', '@payloadcms/next', '@payloadcms/db-postgres', '@payloadcms/db-sqlite']) assert.equal(cmsPackage.dependencies[name], cmsPackage.dependencies.payload, `${name} must be pinned to the payload version`);

// 3. Cross-service wiring -------------------------------------------------------------
assert.deepEqual([...STORE_KINDS], ['memory', 'cms']);
for (const name of ['PAYMENTS_STORE', 'PAYMENTS_CMS_URL', 'PAYMENTS_CMS_API_KEY']) assert.ok(PAYMENTS_VARIABLES.includes(name), `payments must know ${name}`);
assert.match(read('payments/src/cms-store.mjs'), /stripe-events/);
assert.match(read('payments/src/cms-store.mjs'), /claimKey/, 'the payments store must claim events under its own consumer key');
assert.match(read('payments/src/cms-store.mjs'), /status === 409/, 'the payments store must treat a CMS 409 as an ordering conflict');
assert.match(read('payments/src/cms-store.mjs'), /entitlements/);
assert.match(read('cms/src/collections/StripeEvents.ts'), /slug: 'stripe-events'/);
assert.match(read('cms/src/collections/Entitlements.ts'), /slug: 'entitlements'/);
assert.equal(KEY_RECORDS_SCHEMA, 'gateway-key-records/v1');
assert.match(read('cms/src/endpoints/gateway.ts'), /export const KEY_RECORDS_SCHEMA = 'gateway-key-records\/v1'/, 'CMS and gateway must agree on the key-records schema id');
assert.match(read('gateway/src/cli.mjs'), /sync-keys/);
const compose = read('docker-compose.yml');
for (const service of ['postgres:', 'cms:', 'payments:', 'web:']) assert.ok(compose.includes(`  ${service}`), `docker-compose.yml must define ${service.replace(':', '')}`);
for (const variable of ['CMS_UPSTREAM', 'PAYMENTS_UPSTREAM', 'PAYMENTS_STORE', 'PAYMENTS_CMS_URL']) assert.ok(compose.includes(variable), `docker-compose.yml must wire ${variable}`);
assert.ok(!/(sk|rk)_(test|live)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}/.test(compose), 'compose must carry no Stripe material');

// 4. Built pages -----------------------------------------------------------------------
const dist = resolve(web, 'dist');
assert.ok(existsSync(dist), 'web/dist is required: run `npm run build` first');
const page = (path) => { const file = resolve(dist, path); assert.ok(existsSync(file), `missing built page ${path}`); return readFileSync(file, 'utf8'); };
const account = page('account/index.html');
const verify = page('account/verify/index.html');
const reset = page('account/reset-password/index.html');
for (const [name, html] of [['account', account], ['verify', verify], ['reset-password', reset]]) {
  assert.match(html, /<meta name="robots" content="noindex,follow">/, `${name} must be noindex`);
  assert.ok(!html.includes('rel="canonical"'), `${name} must not emit a canonical link`);
  assert.ok(!/stripe\.com\/v3|js\.stripe\.com|pk_(?:test|live)_/.test(html), `${name} must not load Stripe.js or embed a publishable key`);
  assert.ok(!/href="\/admin/.test(html), `${name} must not link to /admin in static HTML (it is injected for staff at runtime)`);
}
assert.match(account, /data-accounts-mode="disabled"/, 'CI builds must render the disabled state');
assert.match(account, /data-accounts-disabled-notice/);
assert.match(account, /Accounts are not enabled/);
// Only the account controls themselves are gated; the shared header (theme and
// language switchers) stays interactive.
const articleStart = account.indexOf('<article');
const articleEnd = account.indexOf('</article>');
assert.ok(articleStart >= 0 && articleEnd > articleStart, 'account page renders its article');
const article = account.slice(articleStart, articleEnd);
assert.match(article, /data-account-root/);
const buttons = article.match(/<button\b[^>]*>/g) ?? [];
assert.ok(buttons.length >= 8, 'account page renders its controls');
for (const button of buttons) assert.match(button, /\sdisabled(?:[\s>]|$)/, `every account control must be disabled by default: ${button}`);
const inputs = article.match(/<input\b[^>]*>/g) ?? [];
assert.ok(inputs.length >= 8, 'account page renders its inputs');
for (const input of inputs) assert.match(input, /\sdisabled(?:[\s>]|$)/, `every account input must be disabled by default: ${input}`);
assert.match(reset, /data-accounts-mode="disabled"/);
assert.match(verify, /Verify your email/);
assert.match(reset, /Choose a new password/);
assert.ok(!/\/cms\/api\//.test(article.replace(/<script[\s\S]*?<\/script>/g, '')), 'CMS endpoints are referenced only from the client script, never as static links or form actions');
const robots = readFileSync(resolve(dist, 'robots.txt'), 'utf8');
for (const path of ['/account/', '/admin/', '/cms/']) assert.ok(robots.includes(`Disallow: ${path}`), `robots.txt must disallow ${path}`);
const sitemap = readFileSync(resolve(dist, 'sitemap.xml'), 'utf8');
assert.ok(!sitemap.includes('/account'), 'sitemap must not list account pages');
for (const path of ['admin', 'cms', '_next']) assert.ok(!existsSync(resolve(dist, path)), `dist must not contain anything under /${path}`);
const home = page('index.html');
assert.match(home, /href="\/account"/, 'site navigation links to the account page');

console.log(`Accounts foundation OK: Caddy fails closed for CMS routes; ${cmsVariables.length} CMS variables documented; payments store and gateway key sync speak the CMS contract; /account pages noindex and disabled with ${buttons.length} controls off`);
