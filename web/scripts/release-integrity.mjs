import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utf16Compare } from './dataset-diff.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = resolve(SCRIPT_DIR, '..');
export const PUBLIC_ROOT = resolve(WEB_ROOT, 'public');
export const RELEASE_DIR = resolve(PUBLIC_ROOT, 'release', 'v1');
export const CANONICAL_ORIGIN = 'https://worldhotlines.org';
export const RELEASE_SCHEMA_VERSION = '1.0';
export const API_MAJOR = 1;
export const RESOLVER_MAJOR = 1;
export const WIDGET_MAJOR = 1;
export const BUILD_VERSION_INPUTS = {
  integration_generator: ['scripts/build-static-data.mjs', 'scripts/centroids.json', 'scripts/dataset-diff.mjs', 'scripts/generate-gateway-contracts.mjs', 'scripts/generate-managed-widget-config-contracts.mjs', 'scripts/generate-organization-contracts.mjs', 'repo:control-plane/model.mjs', 'repo:managed-widget-config/model.mjs', 'scripts/generate-subscription-contracts.mjs', 'scripts/metadata-coverage.mjs', 'scripts/release-feeds.mjs', 'scripts/release-integrity.mjs', 'scripts/subscription-events.mjs'],
  resolver_code: ['src/lib/finder.js'],
  widget_code: ['public/widget/v1/hotlines-widget.js'],
};

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function digestFile(path) {
  return `sha256:${sha256(readFileSync(path))}`;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(utf16Compare).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function walkFiles(root) {
  const files = [];
  for (const name of readdirSync(root).sort(utf16Compare)) {
    const path = resolve(root, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`symlink is not allowed in managed artifacts: ${path}`);
    if (metadata.isDirectory()) files.push(...walkFiles(path));
    else if (metadata.isFile()) files.push({ path, metadata });
    else throw new Error(`unsupported managed artifact type: ${path}`);
  }
  return files;
}

function readDiscoveredFile(file) {
  if (constants.O_NOFOLLOW === undefined) throw new Error('release generation requires O_NOFOLLOW support');
  const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== file.metadata.dev || opened.ino !== file.metadata.ino) throw new Error(`managed artifact changed during generation: ${file.path}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function publicPath(filePath) {
  if (lstatSync(filePath).isSymbolicLink()) throw new Error(`symlink is not allowed in managed artifacts: ${filePath}`);
  const rel = relative(PUBLIC_ROOT, filePath);
  const realPublic = realpathSync(PUBLIC_ROOT);
  const realFile = realpathSync(filePath);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..') || (realFile !== realPublic && !realFile.startsWith(`${realPublic}${sep}`))) {
    throw new Error(`unsafe artifact path outside public root: ${filePath}`);
  }
  return `/${rel.split(sep).join('/')}`;
}

export function digestInputs(inputs, root = WEB_ROOT) {
  const hash = createHash('sha256');
  for (const input of inputs) {
    let path;
    if (input.startsWith('repo:')) {
      const rel = input.slice('repo:'.length);
      if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || rel.includes('\\') || /^[A-Za-z]:/.test(rel)) throw new Error(`unsafe repository build input: ${input}`);
      path = resolve(root, '..', rel);
      const repoRoot = resolve(root, '..');
      if (relative(repoRoot, path).startsWith('..')) throw new Error(`unsafe repository build input: ${input}`);
    } else {
      if (!input || input.startsWith('/') || input.split('/').includes('..') || input.includes('\\') || /^[A-Za-z]:/.test(input)) throw new Error(`unsafe web build input: ${input}`);
      path = resolve(root, input);
      if (relative(root, path).startsWith('..')) throw new Error(`unsafe web build input: ${input}`);
    }
    const bytes = readFileSync(path);
    hash.update(`${Buffer.byteLength(input)}:`).update(input).update(`:${bytes.length}:`).update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function buildVersions() {
  return Object.fromEntries(Object.entries(BUILD_VERSION_INPUTS).map(([name, inputs]) => {
    return [name, digestInputs(inputs)];
  }));
}

export function releaseIdentityPayload({ dataset_version, build_versions, compatibility, artifact_index }) {
  return {
    schema_version: RELEASE_SCHEMA_VERSION,
    canonical_origin: CANONICAL_ORIGIN,
    dataset_version,
    build_versions,
    compatibility,
    artifact_index_sha256: artifact_index.sha256,
  };
}

export function generateReleaseIntegrity({ datasetVersion }) {
  mkdirSync(RELEASE_DIR, { recursive: true });
  const artifactFiles = [
    ...walkFiles(resolve(PUBLIC_ROOT, 'data')),
    ...walkFiles(resolve(PUBLIC_ROOT, 'api', 'v1')),
    ...walkFiles(resolve(PUBLIC_ROOT, 'feeds')),
    ...walkFiles(resolve(PUBLIC_ROOT, 'subscriptions', 'v1')),
    ...walkFiles(resolve(PUBLIC_ROOT, 'gateway', 'v1')),
    ...walkFiles(resolve(PUBLIC_ROOT, 'organizations', 'v1')),
    ...walkFiles(resolve(PUBLIC_ROOT, 'managed-widget-config', 'v1')),
    ...walkFiles(RELEASE_DIR).filter(({ path }) => !path.endsWith(`${sep}artifacts.json`) && !path.endsWith(`${sep}release.json`)),
    (() => { const path = resolve(PUBLIC_ROOT, 'widget', 'v1', 'hotlines-widget.js'); return { path, metadata: lstatSync(path) }; })(),
  ];
  const artifacts = artifactFiles.map((file) => {
    if (file.metadata.isSymbolicLink() || !file.metadata.isFile()) throw new Error(`unsupported managed artifact: ${file.path}`);
    const bytes = readDiscoveredFile(file);
    return { path: publicPath(file.path), sha256: `sha256:${sha256(bytes)}`, bytes: bytes.length };
  }).sort((a, b) => utf16Compare(a.path, b.path));

  const artifactIndex = {
    schema_version: RELEASE_SCHEMA_VERSION,
    semantics: 'Each sha256 value identifies the exact bytes served at path for this generated release. Paths are mutable deployment locations.',
    artifacts,
  };
  const indexPath = resolve(RELEASE_DIR, 'artifacts.json');
  writeFileSync(indexPath, `${JSON.stringify(artifactIndex, null, 2)}\n`);

  const versions = buildVersions();
  const byPath = new Map(artifacts.map((entry) => [entry.path, entry]));
  const subscriptionRelationshipPaths = [
    '/subscriptions/v1/README.md', '/subscriptions/v1/common.schema.json', '/subscriptions/v1/event.schema.json',
    '/subscriptions/v1/subscription-request.schema.json', '/subscriptions/v1/subscription-response.schema.json', '/subscriptions/v1/error.schema.json',
    '/subscriptions/v1/openapi.json', '/subscriptions/v1/webhook-contract.json',
    '/subscriptions/v1/fixture-baseline.json', '/subscriptions/v1/fixture-no-change.json', '/subscriptions/v1/fixture-added.json',
    '/subscriptions/v1/fixture-modified.json', '/subscriptions/v1/fixture-country-metadata.json',
  ];
  const relationshipPaths = [
    '/data/manifest.json', '/api/v1/manifest.json', '/api/v1/records.json',
    '/api/v1/resolver.js', '/widget/v1/hotlines-widget.js',
    '/data/metadata-coverage.json', '/data/categories-stats.json', '/data/search-index.json',
    '/release/v1/changes.json', '/release/v1/changes/latest.json',
    '/feeds/releases.json', '/feeds/releases.rss', '/feeds/releases.atom',
    ...subscriptionRelationshipPaths,
    '/gateway/v1/README.md', '/gateway/v1/artifact-descriptor.schema.json', '/gateway/v1/error.schema.json', '/gateway/v1/health.schema.json', '/gateway/v1/key-record.schema.json', '/gateway/v1/openapi.json', '/gateway/v1/privacy.json', '/gateway/v1/security.json',
    '/organizations/v1/README.md', '/organizations/v1/fixture.synthetic.json', '/organizations/v1/model.schema.json', '/organizations/v1/openapi.json',
    '/managed-widget-config/v1/README.md', '/managed-widget-config/v1/config.schema.json', '/managed-widget-config/v1/envelope.schema.json', '/managed-widget-config/v1/fixture.synthetic.json', '/managed-widget-config/v1/keys.synthetic.json', '/managed-widget-config/v1/openapi.json',
  ];
  const payload = {
    schema_version: RELEASE_SCHEMA_VERSION,
    canonical_origin: CANONICAL_ORIGIN,
    dataset_version: datasetVersion,
    generated_at: null,
    generated_at_semantics: 'Release identity is derived from deterministic content and code identities, not wall-clock build metadata.',
    build_versions: versions,
    build_version_semantics: {
      algorithm: 'SHA-256 over the listed ordered source files, each framed by UTF-8 path length/path and byte length. These identities cover only their finite inputs.',
      inputs: BUILD_VERSION_INPUTS,
    },
    compatibility: {
      api: { major: API_MAJOR },
      resolver: { major: RESOLVER_MAJOR, tested_api_majors: [API_MAJOR] },
      widget: { major: WIDGET_MAJOR, tested_api_majors: [API_MAJOR], tested_resolver_majors: [RESOLVER_MAJOR] },
      claim_scope: 'Only the listed major-version combinations are exercised by repository verification.',
    },
    relationships: Object.fromEntries(relationshipPaths.map((path) => [path, byPath.get(path)])),
    artifact_index: {
      path: '/release/v1/artifacts.json',
      sha256: digestFile(indexPath),
      artifact_count: artifacts.length,
      coverage: ['/data/**', '/api/v1/**', '/widget/v1/hotlines-widget.js', '/release/v1/changes.json', '/release/v1/changes/**', '/feeds/**', '/subscriptions/v1/**', '/gateway/v1/**', '/organizations/v1/**', '/managed-widget-config/v1/**'],
      excludes: ['/release/v1/artifacts.json', '/release/v1/release.json'],
    },
    checksum_semantics: 'Unsigned SHA-256 checksums detect byte mismatch after a descriptor is obtained through a trusted channel; they do not prove publisher identity or freshness.',
    mutable_paths: true,
  };
  const descriptor = {
    ...payload,
    release_id: `sha256:${sha256(stableJson(releaseIdentityPayload(payload)))}`,
    release_id_semantics: 'Identity of canonical origin, dataset bytes, finite build inputs, declared compatibility, and the non-circular exact-byte artifact-index digest.',
  };
  writeFileSync(resolve(RELEASE_DIR, 'release.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
  return descriptor;
}
