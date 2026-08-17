import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseStrictJson, readTrackedRegularFile, sha256, sourceMap, withStableGitIndex } from './security-privacy-evidence-lib.mjs';

export const INDEX_PATH = 'reviews/licensing-legal-review/v1/index.json';
export const SCHEMA_PATH = 'reviews/licensing-legal-review/v1/index.schema.json';
export const INTERNAL_MARKER = 'internal-licensing-legal-review-handoff-only/v1';
export const SOURCE_PATHS = Object.freeze([
  'REPORTS/web_verified_directory_integration_report.md', 'docs/PACKAGING.md', 'hotlines.json', 'information.json',
  'scripts/merge_vibbrancy.py', 'sources/crisis_resources.sqlite', 'sources/findahelpline.json', 'sources/helplines_world.json',
  'sources/vibbrancy_hotlines.json', 'sources/web_verified_crisis_directory/final_countries_crisis_directory.json',
  'web/src/pages/data.astro', 'web/src/pages/index.astro',
]);
export const DOMAIN_IDS = Object.freeze(['code', 'data', 'brand', 'contributions', 'hosted_service_commercial_rights']);
export const POPULATION_IDS = Object.freeze(['unknown_information_json', 'helplines_world', 'find_a_helpline', 'psc_app', 'vibbrancy_naga', 'web_verified_directory']);
export const EXTERNAL = Object.freeze({
  repository_bound: false, expected_filename: 'licensing-decision-pack-2026-08-13.md',
  expected_sha256: 'sha256:bcdfc6018e3c6ffbca946a3961a953e4541713ff210e63462a380d86356e738f',
  availability: 'external_optional_not_required_by_ci', legal_effect: 'research_and_decision_support_only_no_authorization',
});
const ROOT_KEYS = ['schema_version', 'internal_only_marker', 'purpose', 'review_state', 'outcome', 'prohibited_claims_actions', 'external_decision_pack', 'sources', 'decision_domains', 'provenance_populations', 'unresolved_questions'];
const exactKeys = (value, keys, label) => assert.deepEqual(Object.keys(value), keys, `${label}: fields/order changed`);

export function verifyExternalPack(path) {
  assert.equal(basename(path), EXTERNAL.expected_filename, 'external pack basename differs from the bound filename');
  const bytes = readFileSync(path);
  assert.equal(sha256(bytes), EXTERNAL.expected_sha256, 'external pack bytes differ from the bound digest');
  return EXTERNAL.expected_sha256;
}

export function validateIndex(index, repo, options = {}) {
  exactKeys(index, ROOT_KEYS, 'index');
  assert.equal(index.internal_only_marker, INTERNAL_MARKER);
  assert.equal(index.review_state, 'no_legal_review_contact_or_approval_has_occurred');
  assert.equal(index.outcome, 'held');
  assert.deepEqual(index.external_decision_pack, EXTERNAL, 'external decision-pack binding changed');
  assert.deepEqual(Object.keys(index.sources), SOURCE_PATHS, 'repository source inventory/order changed');
  assert.deepEqual(sourceMap(repo, SOURCE_PATHS, options), index.sources, 'exact tracked repository evidence bytes changed');
  assert.deepEqual(index.decision_domains.map(({ id }) => id), DOMAIN_IDS, 'finite decision-domain inventory/order changed');
  assert.deepEqual(index.provenance_populations.map(({ id }) => id), POPULATION_IDS, 'finite provenance-population inventory/order changed');
  assert.ok(index.decision_domains.every(({ status }) => status === 'held'), 'every decision domain must remain held');
  assert.ok(index.provenance_populations.every(({ status }) => status === 'held'), 'every provenance population must remain held');
  const cited = [...index.decision_domains, ...index.provenance_populations].flatMap(({ repository_evidence }) => repository_evidence);
  assert.ok(cited.every((path) => Object.hasOwn(index.sources, path)), 'evidence citation is not byte-bound');
  assert.deepEqual([...new Set(cited)].sort(), [...SOURCE_PATHS].sort(), 'every bound repository source must be cited');
  assert.ok(index.prohibited_claims_actions.some((text) => /open source or open data/.test(text)));
  assert.ok(index.prohibited_claims_actions.some((text) => /counsel.*contacted/.test(text)));
  assert.match(index.prohibited_claims_actions.join(' '), /SLA.*DPA|DPA.*SLA/);
  return index;
}

export function loadIndex(repo, options = {}) {
  return withStableGitIndex(repo, options, () => {
    const schemaFile = readTrackedRegularFile(repo, SCHEMA_PATH, options);
    const indexFile = readTrackedRegularFile(repo, INDEX_PATH, options);
    assert.ok(schemaFile.bytes.at(-1) === 0x0a && indexFile.bytes.at(-1) === 0x0a, 'schema and index must end with LF');
    const schema = parseStrictJson(schemaFile.bytes, SCHEMA_PATH); const index = parseStrictJson(indexFile.bytes, INDEX_PATH);
    assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, ROOT_KEYS);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    assert.ok(validate(index), `index fails Draft 2020-12 schema: ${new Ajv2020().errorsText(validate.errors)}`);
    return validateIndex(index, repo, options);
  });
}
