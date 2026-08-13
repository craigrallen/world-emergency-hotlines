import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const PROD = 'https://worldhotlines.org';
const RAILWAY_FALLBACK = 'world-emergency-hotlines-production.up.railway.app';
const errors = [];

function fail(message) { errors.push(message); }
function read(relativePath) {
  const path = resolve(REPO_ROOT, relativePath);
  if (!existsSync(path)) { fail(`missing ${relativePath}`); return ''; }
  return readFileSync(path, 'utf8');
}
function requireAll(relativePath, phrases) {
  const source = read(relativePath);
  for (const phrase of phrases) if (!source.includes(phrase)) fail(`${relativePath} missing required phrase: ${phrase}`);
  return source;
}

function forbidRailwayOrigin(relativePath) {
  if (read(relativePath).includes(RAILWAY_FALLBACK)) fail(`${relativePath} publishes the Railway fallback origin`);
}

const SENSITIVE_I18N_KEYS = [
  'meta.siteDescription', 'footer.notice', 'home.heroBody', 'home.openDataTitle',
  'home.openDataBody', 'data.body', 'about.body', 'about.openDataTitle',
];
function nonEnglishSensitiveOverrides(source) {
  const findings = [];
  const blockPattern = /^const\s+([A-Z][A-Z_]*)\s*:\s*Partial<Dict>\s*=\s*\{([\s\S]*?)^\};/gm;
  for (const match of source.matchAll(blockPattern)) {
    for (const key of SENSITIVE_I18N_KEYS) {
      if (new RegExp(`['"]${key.replaceAll('.', '\\.')}['"]\\s*:`).test(match[2])) findings.push(`${match[1]}.${key}`);
    }
  }
  return findings;
}
function isRootLicenseName(name) {
  return /^(?:license|licence|copying|unlicense)(?:\.(?:md|txt|rst))?$/i.test(name);
}

// Guard the guard with in-memory fixtures; these must never mutate the repository.
if (!nonEnglishSensitiveOverrides("const ES: Partial<Dict> = {\n  'home.openDataTitle': 'x',\n};\n").includes('ES.home.openDataTitle')) {
  fail('guard self-test failed to detect a forbidden non-English override');
}
if (!isRootLicenseName('LiCeNcE.rSt') || isRootLicenseName('LICENSE.json')) {
  fail('guard self-test failed for root license filename recognition');
}

const integrations = requireAll('docs/INTEGRATIONS.md', [
  'Public finder', 'Static API v1', 'Widget v1', 'Direct snapshot', 'dataset_version',
  'Failure and fallback handling', 'Accessibility and safety presentation', 'Security, CSP, and privacy',
  'Verification and scope limitations', 'Testing checklist', 'Production readiness checklist',
  'public, keyless, static **beta**', 'no uptime, support, or SLA commitment',
  `${PROD}/api/v1`, `${PROD}/widget/v1/hotlines-widget.js`,
  'Public access is not a grant of reuse rights', 'currently has no license',
  'mutable deployment paths', 'dataset_version` is the canonical data SHA-256 and identifies canonical data only',
  'revalidate the manifest, `resolver.js`, and `hotlines-widget.js` independently',
  'test and review resolver and widget implementation changes even when that dataset hash is unchanged',
]);
if (/immutable responses/i.test(integrations)) fail('INTEGRATIONS.md incorrectly describes mutable v1 paths as immutable responses');

const metrics = requireAll('docs/PRIVACY_SAFE_METRICS.md', [
  'Telemetry is not implemented or enabled by this repository', 'integration_loaded',
  'artifact_fetch_result', 'resolver_execution_result', 'finder_link', 'api', 'widget', 'snapshot',
  'manifest', 'country', 'resolver', 'success', 'http_error', 'network_error', 'parse_error', 'empty',
  'major_version', 'fewer than **100 technical events**', 'within **7 days**', 'at most **90 days**',
  'one non-overlapping cube', 'no uniqueness threshold or uniqueness mechanism',
  'do not collect centrally stored per-event records', 'Allowed released aggregate batch',
  'Rejected raw event', 'Data-minimization checklist', 'Interpretation boundaries',
  'explicit qualified privacy and legal review', 'technical executions only',
]);
const allowedMetricsSpec = metrics.split('## Allowed specification')[1]?.split('## Single release cube')[0] ?? '';
const allowedMetricsExample = metrics.split('## Allowed released aggregate batch')[1]?.split('## Rejected raw event')[0] ?? '';
for (const [label, pattern] of [
  ['contact_action', /contact_action/],
  ['country dimension', /(?:`country`\s*:|"country"\s*:)/],
  ['category dimension', /(?:`category`\s*:|"category"\s*:)/],
  ['channel dimension', /(?:`channel`\s*:|"channel"\s*:)/],
  ['fallback dimension', /(?:`fallback(?:_level|_details)?`\s*:|"fallback(?:_level|_details)?"\s*:)/],
  ['distinct-client dimension', /distinct[-_ ]client/i],
  ['identifier dimension', /(?:client_id|user_id|session_id|record_id)/],
]) {
  if (pattern.test(allowedMetricsSpec) || pattern.test(allowedMetricsExample)) {
    fail(`allowed metrics specification/example contains prohibited ${label}`);
  }
}
if (!/"event": "artifact_fetch_result"[\s\S]*"artifact_type": "resolver"[\s\S]*"result": "network_error"[\s\S]*"major_version": "v1"/.test(allowedMetricsExample)) {
  fail('allowed aggregate example does not use the exact technical-only taxonomy');
}

const packaging = requireAll('docs/PACKAGING.md', [
  'capability matrix, not a price plan', 'Public crisis access remains free and is never gated',
  'Available now — public beta', 'Public site and finder', 'Static downloads', 'Static API v1', 'Widget v1',
  'Deterministic resolver', 'Metadata reports', 'Issue intake', 'Tenant dashboards', 'Hosted branded pages',
  'Webhooks or change feed', 'Custom packs', 'Uptime or support SLA', 'DPA', 'Security attestations',
  'Signed configs or domain allowlists', 'Managed analytics', 'Priority verification',
  'Not currently offered', 'unresolved licensing decision blocks packaging',
]);
if (/\$\s*\d|€\s*\d|£\s*\d/.test(packaging)) fail('PACKAGING.md contains a price');

requireAll('docs/DESIGN_PARTNER_PILOT.md', [
  'Internal/reviewable draft only', 'Enrollment is not stated or implied to be open', '4–6 week',
  'subject to written agreement', 'Discovery questions', 'Integration readiness and safety/privacy review',
  'Success and stop criteria', 'Feedback/evidence template', 'synthetic/non-personal',
  'no real crisis case studies', 'No service availability, support, verification SLA, clinical suitability, legal compliance, or emergency outcome is promised',
]);

const page = requireAll('web/src/pages/integrate.astro', [
  'Public static beta', 'Link to the finder', 'Static API v1', 'Widget v1', 'Direct snapshot',
  `${PROD}/widget/v1/hotlines-widget.js`, '/api/v1/manifest.json', 'Current limitations',
  'Public access does not itself grant reuse rights', 'currently has no license', 'Privacy by design',
  'DESIGN_PARTNER_PILOT.md', 'target="_blank" rel="noopener noreferrer"',
]);
for (const file of [
  '.github/ISSUE_TEMPLATE/config.yml', 'README.md', 'docs/API.md', 'docs/INTEGRATIONS.md', 'docs/WIDGET.md',
  'web/src/lib/site.js', 'web/src/pages/integrate.astro', 'web/src/pages/widget.astro',
]) forbidRailwayOrigin(file);
requireAll('web/src/lib/site.js', [`DEFAULT_SITE_URL = '${PROD}'`]);

const caddy = requireAll('Caddyfile', [
  '@www host www.worldhotlines.org', 'redir @www https://worldhotlines.org{uri} permanent',
]);
if (caddy.includes(`host ${RAILWAY_FALLBACK}`)) fail('Caddyfile redirects or special-cases the Railway fallback host');
for (const [pattern, label] of [
  [/<form\b/i, 'lead form'], [/(google-analytics|gtag\(|segment\.com|posthog|mixpanel)/i, 'analytics implementation'],
  [/enterprise[- ]ready/i, 'enterprise-ready claim'], [/(buy now|available for purchase)/i, 'purchase claim'],
  [/\$\s*\d|€\s*\d|£\s*\d/, 'price'],
]) if (pattern.test(page)) fail(`integrate page contains forbidden ${label}`);

const publicClaimFiles = ['web/src/pages/data.astro', 'web/src/pages/about.astro', 'web/src/pages/index.astro', 'web/src/lib/i18n.ts'];
for (const file of publicClaimFiles) {
  const source = read(file);
  for (const pattern of [/data is open/i, /dataset is open/i, /entire dataset is open/i,
    /with or without attribution/i, /fork, mirror/i, /forken, spiegeln/i, /licen[cs]e walls/i, /lizenzmauern/i]) {
    if (pattern.test(source)) fail(`${file} still grants or implies reuse: ${pattern}`);
  }
}

const i18n = read('web/src/lib/i18n.ts');
for (const finding of nonEnglishSensitiveOverrides(i18n)) fail(`non-English locale overrides licensing-sensitive key: ${finding}`);
if (!i18n.includes('pending qualified translation and legal review')) fail('i18n fallback intent is not documented');

for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
  if (isRootLicenseName(entry.name)) fail(`${entry.name} exists at repository root; licensing copy requires qualified legal review`);
}
if (!integrations.includes('no repository license exists today') || !packaging.includes('repository currently has no license')) {
  fail('absent repository license is not stated consistently');
}

const header = read('web/src/components/Header.astro');
const footer = read('web/src/components/Footer.astro');
const sitemap = read('web/src/pages/sitemap.xml.ts');
const discovery = read('web/scripts/verify-discovery-routes.mjs');
for (const [name, source] of [['header', header], ['footer', footer], ['sitemap source', sitemap], ['discovery guard', discovery]]) {
  if (!source.includes('/integrate')) fail(`${name} does not discover /integrate`);
}
const builtPage = resolve(WEB_ROOT, 'dist', 'integrate', 'index.html');
if (existsSync(resolve(WEB_ROOT, 'dist')) && !existsSync(builtPage)) fail('built /integrate route is missing');

if (errors.length) {
  console.error(`Integration readiness verification failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('Integration readiness OK: docs, licensing boundaries, capability truth, privacy contract, snippets, and route discovery verified');
