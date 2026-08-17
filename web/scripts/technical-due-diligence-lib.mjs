import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseStrictJson, readTrackedRegularFile, sourceMap, withStableGitIndex } from './security-privacy-evidence-lib.mjs';

export const INDEX_PATH = 'reviews/technical-due-diligence/v1/index.json';
export const SCHEMA_PATH = 'reviews/technical-due-diligence/v1/index.schema.json';
export const INTERNAL_MARKER = 'internal-technical-due-diligence-evidence-only/v1';
export const STATUSES = Object.freeze(['verified_static', 'manual', 'not_assessed', 'held']);
export const DOMAINS = Object.freeze(['release_integrity', 'deployment_build', 'accessibility', 'multilingual_qualification_review', 'security_privacy', 'internal_control_integrity']);
const ROOT_KEYS = ['schema_version', 'internal_only_marker', 'purpose', 'limitations', 'status_vocabulary', 'sources', 'domains'];
const DOMAIN_KEYS = ['id', 'artifacts'];
const ARTIFACT_KEYS = ['path', 'proves_narrowly', 'does_not_prove', 'review_status', 'next_qualified_or_manual_gate'];
const benignAvailability = /\bartifact available for download\b/gi;
const forbiddenAssurance = /\b(?:certif(?:y|ies|ied|ying|ication|ications)|conform(?:s|ed|ing|ance|ant)?|compl(?:y|ies|ied|ying|iance|iant)|security(?:[- ]assessment(?:s)?|[- ]assessed)|audited|audit[- ]opinions?|legal[- ](?:advice|opinions?)|assur(?:e|es|ed|ing|ance|ances)|guarantee(?:s|d|ing)?|uptime|availability|available|sales[- ](?:artifacts?|ready)|production[- ]ready)\b/i;
const safePath = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const exactKeys = (value, keys, label) => assert.deepEqual(Object.keys(value), keys, `${label}: fields changed`);

export function expectedSchema() {
  const artifact = { type: 'object', additionalProperties: false, required: ARTIFACT_KEYS, properties: {
    path: { type: 'string', pattern: '^(?!.*(?:^|/)\\.\\.?(?:/|$))[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$' }, proves_narrowly: { type: 'string', minLength: 20 }, does_not_prove: { type: 'string', minLength: 20 }, review_status: { enum: STATUSES }, next_qualified_or_manual_gate: { type: 'string', minLength: 20 },
  } };
  const domain = (id) => ({ type: 'object', additionalProperties: false, required: DOMAIN_KEYS, properties: { id: { const: id }, artifacts: { type: 'array', minItems: 1, items: artifact } } });
  const definitions = Object.fromEntries(DOMAINS.map((id) => [`domain_${id}`, domain(id)]));
  return {
    '$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': 'internal-technical-due-diligence-evidence-index/v1', type: 'object', additionalProperties: false,
    required: ROOT_KEYS,
    properties: {
      schema_version: { const: '1.0' }, internal_only_marker: { const: INTERNAL_MARKER }, purpose: { const: 'repository_internal_deterministic_regression_evidence_index' },
      limitations: { type: 'array', minItems: 8, uniqueItems: true, items: { type: 'string', minLength: 10 } },
      status_vocabulary: { const: STATUSES },
      sources: { type: 'object', minProperties: 1, propertyNames: { pattern: '^(?!.*(?:^|/)\\.\\.?(?:/|$))[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$' }, additionalProperties: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } },
      domains: { type: 'array', minItems: DOMAINS.length, maxItems: DOMAINS.length, prefixItems: DOMAINS.map((id) => ({ '$ref': `#/$defs/${id}` })), items: false },
    },
    '$defs': {
      artifact,
      ...Object.fromEntries(DOMAINS.map((id) => [id, { '$ref': `#/$defs/domain_${id}` }])),
      ...Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, { ...definition, properties: { ...definition.properties, artifacts: { type: 'array', minItems: 1, items: { '$ref': '#/$defs/artifact' } } } }])),
    },
  };
}

function trackedJson(repo, path, options) {
  const file = readTrackedRegularFile(repo, path, options);
  assert.ok(file.bytes.length && file.bytes.at(-1) === 0x0a, `${path} must end with LF`);
  return { bytes: file.bytes, value: parseStrictJson(file.bytes, path) };
}

export function loadCheckedDocuments(repo, options = {}) {
  return withStableGitIndex(repo, options, () => {
    const schema = trackedJson(repo, SCHEMA_PATH, options);
    const index = trackedJson(repo, INDEX_PATH, options);
    assert.deepEqual(schema.value, expectedSchema(), 'checked-in JSON Schema and exact schema specification differ');
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema.value);
    assert.ok(validate(index.value), `index fails Draft 2020-12 schema: ${new Ajv2020().errorsText(validate.errors)}`);
    validateIndex(index.value, repo, options);
    return { index: index.value, schema: schema.value };
  });
}

export function validateIndex(index, repo, options = {}) {
  exactKeys(index, ROOT_KEYS, 'index');
  assert.equal(index.schema_version, '1.0');
  assert.equal(index.internal_only_marker, INTERNAL_MARKER);
  assert.equal(index.purpose, 'repository_internal_deterministic_regression_evidence_index');
  assert.deepEqual(index.status_vocabulary, STATUSES);
  assert.ok(Array.isArray(index.limitations) && index.limitations.length >= 8 && new Set(index.limitations).size === index.limitations.length, 'limitations must be finite, unique, and explicit');
  const requiredLimitations = ['certification', 'conformance', 'audit opinion', 'security assessment', 'legal advice', 'uptime', 'availability', 'sales artifact'];
  const limitations = index.limitations.join(' ').toLowerCase();
  for (const phrase of requiredLimitations) assert.ok(limitations.includes(phrase), `missing explicit limitation: ${phrase}`);
  assert.ok(index.sources && !Array.isArray(index.sources));
  const paths = Object.keys(index.sources);
  assert.ok(paths.length > 0);
  assert.deepEqual(paths, [...paths].sort(), 'source paths must be sorted');
  for (const [path, digest] of Object.entries(index.sources)) { assert.match(path, safePath, `non-canonical source path: ${path}`); assert.match(digest, /^sha256:[0-9a-f]{64}$/, `malformed source digest: ${path}`); }
  assert.deepEqual(sourceMap(repo, paths, options), index.sources, 'exact tracked evidence source bytes changed');

  assert.ok(Array.isArray(index.domains));
  assert.deepEqual(index.domains.map(({ id }) => id), DOMAINS, 'domain inventory/order changed');
  const used = new Set(); let gaps = 0;
  for (const domain of index.domains) {
    exactKeys(domain, DOMAIN_KEYS, `domain ${domain.id ?? '<missing>'}`);
    assert.ok(Array.isArray(domain.artifacts) && domain.artifacts.length > 0);
    for (const artifact of domain.artifacts) {
      exactKeys(artifact, ARTIFACT_KEYS, `artifact ${artifact.path ?? '<missing>'}`);
      assert.match(artifact.path, safePath, `non-canonical artifact path: ${artifact.path}`);
      assert.ok(Object.hasOwn(index.sources, artifact.path), `unbound artifact path: ${artifact.path}`);
      assert.ok(!used.has(artifact.path), `duplicate artifact path: ${artifact.path}`); used.add(artifact.path);
      assert.ok(STATUSES.includes(artifact.review_status), `unknown status: ${artifact.review_status}`);
      for (const field of ['proves_narrowly', 'does_not_prove', 'next_qualified_or_manual_gate']) assert.ok(typeof artifact[field] === 'string' && artifact[field].length >= 20, `${artifact.path}: invalid ${field}`);
      assert.doesNotMatch(artifact.proves_narrowly.replace(benignAvailability, ''), forbiddenAssurance, `${artifact.path}: unsupported assurance language in proves_narrowly`);
      if (artifact.review_status !== 'verified_static') gaps++;
    }
  }
  assert.deepEqual([...used].sort(), paths, 'source map and artifact inventory must be exactly complete');
  assert.ok(gaps >= 8, 'index must retain conservative manual/not-assessed/held gaps');
  return index;
}

export function loadIndex(repo, options = {}) {
  return loadCheckedDocuments(repo, options).index;
}

export function validateSchemaSpecification(repo, options = {}) {
  return loadCheckedDocuments(repo, options).schema;
}

export function currentSourceMap(repo, options = {}) {
  return withStableGitIndex(repo, options, () => {
    const index = trackedJson(repo, INDEX_PATH, options).value;
    const sources = sourceMap(repo, Object.keys(index.sources), options);
    validateIndex({ ...index, sources }, repo, options);
    return sources;
  });
}
