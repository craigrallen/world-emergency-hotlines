import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { deriveAssurancePack, validateAssurancePack, validateAssessedRelease, validateEvidenceInput } from '../../assurance-packs/model.mjs';
import { verifyAssurancePackContractDrift } from './generate-assurance-pack-contracts.mjs';

const json = (path) => JSON.parse(readFileSync(path));
const root = resolve(import.meta.dirname, '../../assurance-packs');
const input = json(resolve(root, 'fixtures/evidence.synthetic.json'));
const policyBytes = readFileSync(resolve(root, 'fixtures/trust-policy.synthetic.json'));
const policy = JSON.parse(policyBytes);
const pack = json(resolve(root, 'contracts/v1/assurance-pack.synthetic.json'));
const canonicalBytes = readFileSync(resolve(root, '../hotlines.json'));
const releaseBytes = readFileSync(resolve(root, 'fixtures/assessed-release.synthetic.json'));
const indexBytes = readFileSync(resolve(root, 'fixtures/assessed-artifacts.synthetic.json'));

verifyAssurancePackContractDrift();
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addKeyword({ keyword: 'x-runtime-invariants', schemaType: 'array', valid: true });
const schemaValidate = ajv.compile(json(resolve(root, 'contracts/v1/assurance-pack.schema.json')));
assert.equal(schemaValidate(pack), true, `schema rejected fixture: ${ajv.errorsText(schemaValidate.errors)}`);
validateAssessedRelease(releaseBytes, indexBytes, input.dataset_version);
validateEvidenceInput(input, policy, policyBytes, canonicalBytes, releaseBytes, indexBytes);
validateAssurancePack(pack);
assert.deepEqual(deriveAssurancePack(input, policy, policyBytes, canonicalBytes, releaseBytes, indexBytes), pack, 'derived synthetic assurance pack is stale');

const parityMutations = [
  ['top-level array', (x) => x.records = {}],
  ['empty records', (x) => x.records = []],
  ['unsafe integer', (x) => x.coverage.record_count = Number.MAX_SAFE_INTEGER + 1],
  ['negative count', (x) => x.records[0].evidence_summary.unresolved_or_unknown = -1],
  ['bad identity format', (x) => x.dataset_version = 'sha256:ABC'],
  ['bad record pattern', (x) => x.records[0].record_id = 'weh_bad'],
  ['bad country pattern', (x) => x.footprint.countries[0] = 'se'],
  ['bad category pattern', (x) => x.footprint.categories[0] = 'General'],
  ['empty artifacts', (x) => x.release.artifacts = []],
  ['unsafe artifact path', (x) => x.release.artifacts[0].path = '/api/../secret'],
  ['zero artifact bytes', (x) => x.release.artifacts[0].bytes = 0],
  ['extra nested field', (x) => x.records[0].evidence_summary.ranking = 1],
  ['bad lifecycle', (x) => x.records[0].lifecycle = 'available'],
  ['active replacement', (x) => x.records[0].replacement_record_id = x.records[1].record_id],
  ['deprecated null replacement', (x) => { x.records[0].lifecycle = 'deprecated'; x.records[0].replacement_record_id = null; }],
  ['bad uncertainty', (x) => x.records[0].uncertainty = 'verified'],
  ['accepted evidence marked unresolved', (x) => x.records[1].uncertainty = 'unresolved'],
  ['accepted evidence marked unknown', (x) => x.records[1].uncertainty = 'unknown'],
  ['pending evidence marked reviewed', (x) => x.records[0].uncertainty = 'independently_reviewed'],
  ['pending evidence marked unknown', (x) => x.records[0].uncertainty = 'unknown'],
  ['rejected evidence marked reviewed', (x) => { x.records[0].evidence_summary.provider_claims_pending = 0; x.records[0].evidence_summary.provider_claims_rejected = 1; x.records[0].uncertainty = 'independently_reviewed'; }],
  ['zero classified evidence marked reviewed', (x) => { x.records[0].evidence_summary.provider_claims_pending = 0; x.records[0].uncertainty = 'independently_reviewed'; }],
  ['zero classified evidence marked unresolved', (x) => { x.records[0].evidence_summary.provider_claims_pending = 0; x.records[0].uncertainty = 'unresolved'; }],
  ['bad limitation', (x) => x.limitations[0] = 'quality assured'],
];
for (const [name, mutate] of parityMutations) {
  const value = structuredClone(pack); mutate(value);
  assert.equal(schemaValidate(value), false, `schema accepted adversarial mutation: ${name}`);
  assert.throws(() => validateAssurancePack(value), undefined, `runtime accepted adversarial mutation: ${name}`);
}

const validBranches = [
  { evidence_summary: { independently_accepted: 1, provider_claims_pending: 1, provider_claims_rejected: 1, unresolved_or_unknown: 0 }, uncertainty: 'independently_reviewed' },
  { evidence_summary: { independently_accepted: 0, provider_claims_pending: 1, provider_claims_rejected: 0, unresolved_or_unknown: 0 }, uncertainty: 'unresolved' },
  { evidence_summary: { independently_accepted: 0, provider_claims_pending: 0, provider_claims_rejected: 1, unresolved_or_unknown: 0 }, uncertainty: 'unresolved' },
  { evidence_summary: { independently_accepted: 0, provider_claims_pending: 0, provider_claims_rejected: 0, unresolved_or_unknown: 1 }, uncertainty: 'unknown' },
];
for (const branch of validBranches) { const value = structuredClone(pack); Object.assign(value.records[0], branch); assert.equal(schemaValidate(value), true, `schema rejected valid uncertainty branch: ${branch.uncertainty}`); }
const validDeprecated = structuredClone(pack); validDeprecated.records[0].lifecycle = 'deprecated'; validDeprecated.records[0].replacement_record_id = validDeprecated.records[1].record_id; assert.equal(schemaValidate(validDeprecated), true, 'schema rejected valid deprecated replacement branch');

const semanticMutations = [
  ['unsorted footprint', (x) => x.footprint.categories.reverse()],
  ['duplicate footprint', (x) => x.footprint.countries.push(x.footprint.countries[0])],
  ['unsorted records', (x) => x.records.reverse()],
  ['unsorted artifacts', (x) => x.release.artifacts.reverse()],
  ['inexact footprint', (x) => x.footprint.countries.push('NO')],
  ['self replacement', (x) => { x.records[0].lifecycle = 'deprecated'; x.records[0].replacement_record_id = x.records[0].record_id; }],
  ['missing replacement target', (x) => { x.records[0].lifecycle = 'deprecated'; x.records[0].replacement_record_id = 'weh_000000000000000000000000'; }],
  ['count inconsistency', (x) => x.coverage.record_count++],
];
for (const [name, mutate] of semanticMutations) { const value = structuredClone(pack); mutate(value); assert.throws(() => validateAssurancePack(value), undefined, `runtime accepted semantic mutation: ${name}`); }

console.log('Assurance-pack contract OK: external trust policy; exact synthetic fixture bytes; portable schema constraints plus documented runtime invariants; deterministic source/public bytes');
