import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utf16Compare } from './dataset-diff.mjs';

import {
  API_MAJOR, BUILD_VERSION_INPUTS, CANONICAL_ORIGIN, PUBLIC_ROOT, RELEASE_DIR, RESOLVER_MAJOR, WIDGET_MAJOR,
  buildVersions, digestFile, releaseIdentityPayload, sha256, stableJson,
} from './release-integrity.mjs';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(WEB_ROOT, '..');
const errors = [];
const fail = (message) => errors.push(message);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function discoverFiles(root) {
  return readdirSync(root).sort(utf16Compare).flatMap((name) => {
    const path = resolve(root, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`symlink is not allowed in covered artifacts: ${path}`);
    if (metadata.isDirectory()) return discoverFiles(path);
    if (!metadata.isFile()) throw new Error(`special file is not allowed in covered artifacts: ${path}`);
    return [{ path, metadata }];
  });
}

export function isSafeArtifactPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('%') || /^[A-Za-z]:/.test(path)) return false;
  const components = path.slice(1).split('/');
  return components.length > 0 && components.every((part) => part && part !== '.' && part !== '..');
}

export function readDiscoveredFile(file) {
  if (constants.O_NOFOLLOW === undefined) throw new Error('release verification requires O_NOFOLLOW support');
  const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== file.metadata.dev || opened.ino !== file.metadata.ino) throw new Error(`covered artifact changed during verification: ${file.path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function validateArtifactEntries(entries, readBytes) {
  const findings = [];
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) findings.push('duplicate artifact paths');
  if (paths.some((path) => !isSafeArtifactPath(path))) findings.push('unsafe artifact path');
  if (paths.some((path) => path === '/release/v1/artifacts.json' || path === '/release/v1/release.json')) findings.push('circular release artifact inclusion');
  if (paths.some((path, index) => index > 0 && utf16Compare(paths[index - 1], path) > 0)) findings.push('artifact paths are not sorted');
  for (const entry of entries) {
    if (!isSafeArtifactPath(entry.path)) continue;
    const bytes = readBytes(entry.path);
    if (!bytes) { findings.push(`missing artifact: ${entry.path}`); continue; }
    if (`sha256:${sha256(bytes)}` !== entry.sha256) findings.push(`digest mismatch: ${entry.path}`);
    if (bytes.length !== entry.bytes) findings.push(`byte length mismatch: ${entry.path}`);
  }
  return findings;
}

export function falseOperationalClaims(text) {
  const claims = [];
  const patterns = [
    [/all systems (?:are )?operational/i, 'operational assertion'],
    [/no (?:active |current )?incidents/i, 'incident assertion'],
    [/\b(?:99(?:\.\d+)?|100)% uptime\b/i, 'uptime assertion'],
    [/hotlines? (?:are|is) (?:currently )?(?:available|open|reachable)/i, 'hotline availability assertion'],
    [/\bSLA (?:is|of|guarantees?)\b/i, 'SLA assertion'],
  ];
  for (const [pattern, label] of patterns) if (pattern.test(text)) claims.push(label);
  return claims;
}

// Negative fixtures guard the verifier without changing repository files.
const fixtureBytes = new Map([['/api/v1/resolver.js', Buffer.from('reviewed')]]);
const fixture = [{ path: '/api/v1/resolver.js', sha256: `sha256:${sha256(Buffer.from('reviewed'))}`, bytes: 8 }];
if (validateArtifactEntries(fixture, (path) => fixtureBytes.get(path)).length) fail('self-test rejected a valid artifact fixture');
if (!validateArtifactEntries(fixture, () => Buffer.from('tampered')).some((item) => item.includes('digest mismatch'))) fail('tamper-negative self-test did not detect changed bytes');
if (!validateArtifactEntries([...fixture, fixture[0]], (path) => fixtureBytes.get(path)).includes('duplicate artifact paths')) fail('duplicate-path self-test failed');
if (!validateArtifactEntries([{ ...fixture[0], path: '/release/v1/release.json' }], () => Buffer.from('reviewed')).includes('circular release artifact inclusion')) fail('circular-inclusion self-test failed');
if (!validateArtifactEntries([{ ...fixture[0], path: '/../../etc/passwd' }], () => Buffer.from('reviewed')).includes('unsafe artifact path')) fail('unsafe-path self-test failed');
for (const path of ['/api/./v1.json', '/api/../v1.json', '/api\\v1.json', '/api/%2e/x', '/api/%2E%2E/x', '/api/%252e%252e/x', '/api/%2fetc.json', '//server/share']) {
  let reads = 0;
  if (!validateArtifactEntries([{ ...fixture[0], path }], () => { reads++; return Buffer.from('reviewed'); }).includes('unsafe artifact path') || reads !== 0) fail(`unsafe-path read guard failed: ${path}`);
}
if (!falseOperationalClaims('All systems operational; 100% uptime.').length) fail('false-claim self-test failed');

const descriptorPath = resolve(RELEASE_DIR, 'release.json');
const indexPath = resolve(RELEASE_DIR, 'artifacts.json');
for (const path of [descriptorPath, indexPath]) if (!existsSync(path)) fail(`missing ${relative(WEB_ROOT, path)}`);

if (existsSync(descriptorPath) && existsSync(indexPath)) {
  const descriptor = readJson(descriptorPath);
  const index = readJson(indexPath);
  const canonicalBytes = readFileSync(resolve(REPO_ROOT, 'hotlines.json'));
  const expectedDataset = `sha256:${createHash('sha256').update(canonicalBytes).digest('hex')}`;
  if (descriptor.canonical_origin !== CANONICAL_ORIGIN || descriptor.canonical_origin !== 'https://worldhotlines.org') fail('canonical origin regression');
  if (descriptor.dataset_version !== expectedDataset) fail('descriptor dataset_version does not identify exact canonical hotlines.json bytes');
  if (descriptor.generated_at !== null) fail('release identity descriptor must not contain wall-clock generated_at');
  if (descriptor.release_id !== `sha256:${sha256(stableJson(releaseIdentityPayload(descriptor)))}`) fail('release_id does not match reproducible identity payload');
  if (descriptor.artifact_index.sha256 !== digestFile(indexPath)) fail('descriptor artifact-index digest is stale');
  if (descriptor.artifact_index.artifact_count !== index.artifacts.length) fail('descriptor artifact count is stale');
  if (JSON.stringify(descriptor.build_versions) !== JSON.stringify(buildVersions())) fail('build/code versions are stale');
  if (JSON.stringify(descriptor.build_version_semantics?.inputs) !== JSON.stringify(BUILD_VERSION_INPUTS)) fail('build-version finite source-set documentation is stale');
  for (const input of Object.values(BUILD_VERSION_INPUTS).flat()) if (input.startsWith('/') || input.split('/').includes('..') || input.includes('\\') || /^[A-Za-z]:/.test(input) || (input.includes(':') && !input.startsWith('repo:'))) fail(`unsafe build-version source path: ${input}`);
  if (descriptor.compatibility?.api?.major !== API_MAJOR || descriptor.compatibility?.resolver?.major !== RESOLVER_MAJOR || descriptor.compatibility?.widget?.major !== WIDGET_MAJOR) fail('major compatibility metadata mismatch');
  if (JSON.stringify(descriptor.compatibility?.resolver?.tested_api_majors) !== `[${API_MAJOR}]`) fail('resolver tested API majors exceed or differ from verified scope');
  if (JSON.stringify(descriptor.compatibility?.widget?.tested_api_majors) !== `[${API_MAJOR}]` || JSON.stringify(descriptor.compatibility?.widget?.tested_resolver_majors) !== `[${RESOLVER_MAJOR}]`) fail('widget tested majors exceed or differ from verified scope');

  let discovered;
  try {
    discovered = [
      ...['manifest.webmanifest', 'offline.html', 'pwa-register.js', 'service-worker.js', 'pwa-icon-512.png'].map((name) => { const path = resolve(PUBLIC_ROOT, name); return { path, metadata: lstatSync(path) }; }),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'data')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'api', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'feeds')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'subscriptions', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'gateway', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'organizations', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'managed-widget-config', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'technical-health', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'assurance-packs', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'provider-claims', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'reviewer-work-queue', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'managed-api-plans', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'deprecation-proposals', 'v1')),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'evidence-backed-coverage', 'v1')),
      ...discoverFiles(RELEASE_DIR).filter(({ path }) => !path.endsWith(`${sep}artifacts.json`) && !path.endsWith(`${sep}release.json`)),
      ...discoverFiles(resolve(PUBLIC_ROOT, 'widget', 'v1')).filter(({ path }) => path.endsWith(`${sep}hotlines-widget.js`)),
    ];
  } catch (error) {
    fail(error.message);
    discovered = [];
  }
  const safeFiles = new Map(discovered.map((file) => [`/${relative(PUBLIC_ROOT, file.path).split(sep).join('/')}`, file]));
  const actualPaths = [...safeFiles.keys()].sort(utf16Compare);
  const indexedPaths = index.artifacts.map((entry) => entry.path);
  if (JSON.stringify(indexedPaths) !== JSON.stringify(actualPaths)) fail('artifact index path coverage is stale or incomplete');
  for (const finding of validateArtifactEntries(index.artifacts, (path) => {
    const file = safeFiles.get(path);
    if (!file) return null;
    try { return readDiscoveredFile(file); } catch (error) { fail(error.message); return null; }
  })) fail(finding);
  const indexed = new Map(index.artifacts.map((entry) => [entry.path, entry]));
  const apiManifest = readJson(resolve(PUBLIC_ROOT, 'api/v1/manifest.json'));
  if (apiManifest.compatibility?.api_major !== API_MAJOR || apiManifest.compatibility?.resolver?.major !== RESOLVER_MAJOR || apiManifest.compatibility?.widget?.major !== WIDGET_MAJOR) fail('API manifest compatibility metadata mismatch');
  if (JSON.stringify(apiManifest.build_versions) !== JSON.stringify(descriptor.build_versions)) fail('API manifest build versions differ from release descriptor');
  for (const [path, relationship] of Object.entries(descriptor.relationships ?? {})) {
    if (JSON.stringify(relationship) !== JSON.stringify(indexed.get(path))) fail(`stale or mismatched manifest relationship: ${path}`);
  }
  for (const required of ['/data/manifest.json', '/api/v1/manifest.json', '/api/v1/records.json', '/api/v1/resolver.js', '/widget/v1/hotlines-widget.js', '/data/metadata-coverage.json', '/release/v1/changes.json', '/release/v1/changes/latest.json', '/feeds/releases.json', '/feeds/releases.rss', '/feeds/releases.atom', '/subscriptions/v1/README.md', '/subscriptions/v1/common.schema.json', '/subscriptions/v1/event.schema.json', '/subscriptions/v1/subscription-request.schema.json', '/subscriptions/v1/subscription-response.schema.json', '/subscriptions/v1/error.schema.json', '/subscriptions/v1/openapi.json', '/subscriptions/v1/webhook-contract.json', '/subscriptions/v1/fixture-baseline.json', '/subscriptions/v1/fixture-no-change.json', '/subscriptions/v1/fixture-added.json', '/subscriptions/v1/fixture-modified.json', '/subscriptions/v1/fixture-country-metadata.json']) {
    if (!descriptor.relationships?.[required]) fail(`missing core relationship: ${required}`);
  }
  for (const required of ['/gateway/v1/README.md', '/gateway/v1/artifact-descriptor.schema.json', '/gateway/v1/openapi.json', '/gateway/v1/error.schema.json', '/gateway/v1/health.schema.json', '/gateway/v1/key-record.schema.json', '/gateway/v1/privacy.json', '/gateway/v1/security.json']) {
    if (!descriptor.relationships?.[required]) fail(`missing gateway relationship: ${required}`);
  }
  for (const required of ['/organizations/v1/README.md', '/organizations/v1/fixture.synthetic.json', '/organizations/v1/model.schema.json', '/organizations/v1/openapi.json']) {
    if (!descriptor.relationships?.[required]) fail(`missing organization contract relationship: ${required}`);
  }
  for (const required of ['/managed-widget-config/v1/README.md','/managed-widget-config/v1/config.schema.json','/managed-widget-config/v1/envelope.schema.json','/managed-widget-config/v1/fixture.synthetic.json','/managed-widget-config/v1/keys.synthetic.json','/managed-widget-config/v1/openapi.json']) {
    if (!descriptor.relationships?.[required]) fail(`missing managed widget configuration relationship: ${required}`);
  }
  for (const required of ['/technical-health/v1/README.md','/technical-health/v1/aggregate-batch.schema.json','/technical-health/v1/aggregate.synthetic.json','/technical-health/v1/dashboard.schema.json','/technical-health/v1/dashboard.synthetic.json']) {
    if (!descriptor.relationships?.[required]) fail(`missing technical-health contract relationship: ${required}`);
  }
  for (const required of ['/assurance-packs/v1/README.md','/assurance-packs/v1/assurance-pack.schema.json','/assurance-packs/v1/assurance-pack.synthetic.json']) {
    if (!descriptor.relationships?.[required]) fail(`missing assurance-pack contract relationship: ${required}`);
  }
  for (const required of ['/provider-claims/v1/README.md','/provider-claims/v1/claim-envelope.schema.json','/provider-claims/v1/claim.synthetic.json','/provider-claims/v1/review-decision.schema.json','/provider-claims/v1/review.synthetic.json']) {
    if (!descriptor.relationships?.[required]) fail(`missing provider-claim contract relationship: ${required}`);
  }
  for (const required of ['/reviewer-work-queue/v1/README.md','/reviewer-work-queue/v1/disposition-audit.schema.json','/reviewer-work-queue/v1/disposition-audit.synthetic.json','/reviewer-work-queue/v1/queue.schema.json','/reviewer-work-queue/v1/queue.synthetic.json']) {
    if (!descriptor.relationships?.[required]) fail(`missing reviewer-work-queue contract relationship: ${required}`);
  }
  for (const required of ['/deprecation-proposals/v1/README.md','/deprecation-proposals/v1/audit-export.schema.json','/deprecation-proposals/v1/audit-export.synthetic.json','/deprecation-proposals/v1/proposal.schema.json','/deprecation-proposals/v1/proposal-with-replacement.synthetic.json','/deprecation-proposals/v1/proposal-without-replacement.synthetic.json','/deprecation-proposals/v1/review-checkpoint.schema.json']) {
    if (!descriptor.relationships?.[required]) fail(`missing deprecation-proposal contract relationship: ${required}`);
  }
  for (const required of ['/evidence-backed-coverage/v1/README.md','/evidence-backed-coverage/v1/assessment.schema.json','/evidence-backed-coverage/v1/assessment.synthetic.json','/evidence-backed-coverage/v1/evidence-input.schema.json']) {
    if (!descriptor.relationships?.[required]) fail(`missing evidence-backed coverage relationship: ${required}`);
  }
}

const statusSource = readFileSync(resolve(WEB_ROOT, 'src/pages/status.astro'), 'utf8');
for (const phrase of ['not live monitoring', 'does not report hotline availability', 'no uptime, support, or SLA commitment']) if (!statusSource.toLowerCase().includes(phrase.toLowerCase())) fail(`status page missing honest limitation: ${phrase}`);
for (const claim of falseOperationalClaims(statusSource)) fail(`status page contains false ${claim}`);

for (const relativePath of ['src/pages/release.astro', 'src/pages/releases.astro', 'src/pages/integrate.astro', '../docs/API.md', '../docs/INTEGRATIONS.md']) {
  const source = readFileSync(resolve(WEB_ROOT, relativePath), 'utf8');
  for (const claim of falseOperationalClaims(source)) fail(`${relativePath} contains false ${claim}`);
}
for (const relativePath of ['src/pages/release.astro', 'src/pages/data.astro', '../docs/API.md', '../docs/INTEGRATIONS.md']) {
  const source = readFileSync(resolve(WEB_ROOT, relativePath), 'utf8');
  if (!/API(?:\/data| and data)|API\/data manifests|API and data manifests/i.test(source) || !/ISO/i.test(source) || !/release descriptor/i.test(source) || !/null/i.test(source) || !/SOURCE_DATE_EPOCH/.test(source) || !/byte/i.test(source)) fail(`${relativePath} does not preserve the timestamp/reproduction distinction`);
}

const changelog = readJson(resolve(REPO_ROOT, 'docs/releases.json'));
const releaseEntries = changelog.releases ?? [];
if (changelog.schema_version !== '1.0' || typeof changelog.contract !== 'string' || !releaseEntries.length) fail('release changelog schema envelope is invalid');
for (const entry of releaseEntries) {
  if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || typeof entry.title !== 'string' || !entry.title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || Number.isNaN(Date.parse(`${entry.date}T00:00:00Z`)) || !Array.isArray(entry.facts) || !entry.facts.length || entry.facts.some((fact) => typeof fact !== 'string' || !fact.trim())) fail(`invalid changelog entry schema: ${entry?.id ?? '<unknown>'}`);
}
if (new Set(releaseEntries.map((entry) => entry.id)).size !== releaseEntries.length) fail('duplicate changelog IDs');
for (let i = 1; i < releaseEntries.length; i++) if (releaseEntries[i - 1].date < releaseEntries[i].date) fail('release changelog is not newest-first');
const releasesPage = readFileSync(resolve(WEB_ROOT, 'src/pages/releases.astro'), 'utf8');
if (!/import releases from ['"]\.\.\/\.\.\/\.\.\/docs\/releases\.json['"]/.test(releasesPage) || !/releases\.releases\.map/.test(releasesPage)) fail('public releases page is not rendered directly from docs/releases.json');
for (const claim of falseOperationalClaims(JSON.stringify(changelog))) fail(`release changelog contains false ${claim}`);

if (errors.length) {
  console.error(`Release integrity verification failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`Release integrity OK: ${readJson(indexPath).artifacts.length} ordered artifact hashes, deterministic versions, scoped compatibility, tamper-negative guards, honest status`);
