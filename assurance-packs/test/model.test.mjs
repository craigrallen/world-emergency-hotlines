import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveAssurancePack, validateAssurancePack, validateAssessedRelease, validateEvidenceInput, validateTrustPolicy } from '../model.mjs';

const read = (path) => JSON.parse(readFileSync(path));
const input = read(resolve(import.meta.dirname, '../fixtures/evidence.synthetic.json'));
const pack = read(resolve(import.meta.dirname, '../contracts/v1/assurance-pack.synthetic.json'));
const canonicalBytes = readFileSync(resolve(import.meta.dirname, '../../hotlines.json'));
const policyBytes = readFileSync(resolve(import.meta.dirname, '../fixtures/trust-policy.synthetic.json'));
const policy = JSON.parse(policyBytes);
const releaseBytes = readFileSync(resolve(import.meta.dirname, '../fixtures/assessed-release.synthetic.json'));
const indexBytes = readFileSync(resolve(import.meta.dirname, '../fixtures/assessed-artifacts.synthetic.json'));
const mutate = (fn) => { const value = structuredClone(input); fn(value); return value; };

test('validates canonical/release binding and derives deterministic bytes', () => {
  assert.equal(validateTrustPolicy(policy), true);
  assert.equal(validateAssessedRelease(releaseBytes, indexBytes, input.dataset_version).release.release_id, input.release.release_id);
  assert.equal(validateEvidenceInput(input, policy, policyBytes, canonicalBytes, releaseBytes, indexBytes), true);
  assert.deepEqual(deriveAssurancePack(input, policy, policyBytes, canonicalBytes, releaseBytes, indexBytes), pack);
  assert.deepEqual(deriveAssurancePack(input, policy, policyBytes, canonicalBytes, releaseBytes, indexBytes), deriveAssurancePack(input, policy, policyBytes, canonicalBytes, releaseBytes, indexBytes));
  assert.equal(validateAssurancePack(pack), true);
});

for (const [name, value] of [
  ['unknown field', mutate((x) => { x.customer_id = 'customer.example.invalid'; })],
  ['unsorted membership', mutate((x) => { x.records.reverse(); })],
  ['duplicate membership', mutate((x) => { x.records.push(structuredClone(x.records[0])); })],
  ['country mismatch', mutate((x) => { x.records[0].country = 'NO'; })],
  ['category footprint mismatch', mutate((x) => { x.footprint.categories = ['emergency']; })],
  ['source cross-binding', mutate((x) => { x.records[0].source_ids = ['src_authority_reviewed']; })],
  ['provider relabelled canonical', mutate((x) => { x.sources[1].kind = 'canonical_source'; x.sources[1].provider_claim_status = 'not_applicable'; })],
  ['source locator relabelled', mutate((x) => { x.sources[0].locator_sha256 = `sha256:${'c'.repeat(64)}`; })],
  ['provider relabelled as reviewer', mutate((x) => { x.reviews[0].reviewer_identity = 'provider-submitter.example.invalid'; })],
  ['reviewer role invented', mutate((x) => { x.reviews[0].role = 'senior_reviewer'; })],
  ['accepted provider claim', mutate((x) => { x.sources[1].provider_claim_status = 'not_applicable'; })],
  ['provider self-review', mutate((x) => { x.reviews[0].source_id = 'src_legacy_pending'; })],
  ['unsafe artifact path', mutate((x) => { x.release.artifacts[0].path = '/api/../secret'; })],
  ['unsorted hashes', mutate((x) => { x.release.artifacts.reverse(); })],
  ['release drift', mutate((x) => { x.release.release_id = `sha256:${'0'.repeat(64)}`; })],
  ['canonical membership drift', mutate((x) => { x.records[0].record_id = 'weh_000000000000000000000000'; })],
]) test(`fails closed on ${name}`, () => assert.throws(() => validateEvidenceInput(value, policy, policyBytes, canonicalBytes, releaseBytes, indexBytes)));

test('fails closed when the separately supplied trust policy is missing or self-authorizing', () => {
  const missing = structuredClone(policy); missing.sources.shift();
  assert.throws(() => validateEvidenceInput(input, missing, policyBytes, canonicalBytes, releaseBytes, indexBytes));
  const collision = structuredClone(policy); collision.reviewers[0].reviewer_identity = 'provider-submitter.example.invalid';
  assert.throws(() => validateTrustPolicy(collision));
});

test('binds policy bytes and identity so policy changes cannot yield an indistinguishable accepted pack', () => {
  const changedPolicy = structuredClone(policy); changedPolicy.reviewers[0].allowed_decisions = ['accepted', 'unknown'];
  const changedBytes = Buffer.from(`${JSON.stringify(changedPolicy, null, 2)}\n`);
  assert.throws(() => validateEvidenceInput(input, changedPolicy, changedBytes, canonicalBytes, releaseBytes, indexBytes), /trust_policy/);
  const changedInput = structuredClone(input); changedInput.trust_policy.sha256 = `sha256:${createHash('sha256').update(changedBytes).digest('hex')}`;
  const changedPack = deriveAssurancePack(changedInput, changedPolicy, changedBytes, canonicalBytes, releaseBytes, indexBytes);
  assert.notDeepEqual(changedPack, pack);

  const renamedPolicy = structuredClone(policy); renamedPolicy.policy_identity = 'renamed-trust-policy.example.invalid';
  const renamedBytes = Buffer.from(`${JSON.stringify(renamedPolicy, null, 2)}\n`);
  assert.throws(() => validateEvidenceInput(input, renamedPolicy, renamedBytes, canonicalBytes, releaseBytes, indexBytes), /trust_policy/);
  const renamedInput = structuredClone(input); renamedInput.trust_policy = { policy_identity: renamedPolicy.policy_identity, sha256: `sha256:${createHash('sha256').update(renamedBytes).digest('hex')}` };
  assert.notDeepEqual(deriveAssurancePack(renamedInput, renamedPolicy, renamedBytes, canonicalBytes, releaseBytes, indexBytes), pack);
});

test('rejects exact canonical-byte changes even when selected records are unchanged', () => {
  const marker = Buffer.from('https://'); const offset = canonicalBytes.indexOf(marker); assert.ok(offset >= 0);
  const changed = Buffer.from(canonicalBytes); Buffer.from('httpx://').copy(changed, offset);
  assert.equal(changed.length, canonicalBytes.length); assert.doesNotThrow(() => JSON.parse(changed));
  assert.throws(() => validateEvidenceInput(input, policy, policyBytes, changed, releaseBytes, indexBytes), /dataset_version/);
});

test('rejects altered synthetic release or index fixture bytes', () => {
  assert.throws(() => validateAssessedRelease(Buffer.concat([releaseBytes, Buffer.from(' ')]), indexBytes, input.dataset_version));
  assert.throws(() => validateAssessedRelease(releaseBytes, Buffer.concat([indexBytes, Buffer.from(' ')]), input.dataset_version));
});

test('rejects replacement and count inconsistencies', () => {
  const badReplacement = mutate((x) => { x.records[0].lifecycle = 'deprecated'; x.records[0].replacement_record_id = 'weh_000000000000000000000000'; });
  assert.throws(() => validateEvidenceInput(badReplacement, policy, policyBytes, canonicalBytes, releaseBytes, indexBytes));
  const badCount = structuredClone(pack); badCount.coverage.record_count++;
  assert.throws(() => validateAssurancePack(badCount));
});

test('accepts every valid lifecycle and uncertainty runtime branch', () => {
  const branches = [
    { lifecycle: 'active', replacement_record_id: null, evidence_summary: { independently_accepted: 1, provider_claims_pending: 2, provider_claims_rejected: 3, unresolved_or_unknown: 0 }, uncertainty: 'independently_reviewed' },
    { lifecycle: 'active', replacement_record_id: null, evidence_summary: { independently_accepted: 0, provider_claims_pending: 1, provider_claims_rejected: 0, unresolved_or_unknown: 0 }, uncertainty: 'unresolved' },
    { lifecycle: 'active', replacement_record_id: null, evidence_summary: { independently_accepted: 0, provider_claims_pending: 0, provider_claims_rejected: 1, unresolved_or_unknown: 0 }, uncertainty: 'unresolved' },
    { lifecycle: 'active', replacement_record_id: null, evidence_summary: { independently_accepted: 0, provider_claims_pending: 0, provider_claims_rejected: 0, unresolved_or_unknown: 2 }, uncertainty: 'unknown' },
  ];
  for (const branch of branches) { const value = structuredClone(pack); Object.assign(value.records[0], branch); value.coverage = { record_count: value.records.length, country_count: value.footprint.countries.length, category_count: value.footprint.categories.length, active_count: 2, deprecated_count: 0, replacement_reference_count: 0, independently_accepted_evidence_count: value.records.reduce((n, x) => n + x.evidence_summary.independently_accepted, 0), provider_claims_pending_count: value.records.reduce((n, x) => n + x.evidence_summary.provider_claims_pending, 0), provider_claims_rejected_count: value.records.reduce((n, x) => n + x.evidence_summary.provider_claims_rejected, 0), unresolved_or_unknown_evidence_count: value.records.reduce((n, x) => n + x.evidence_summary.unresolved_or_unknown, 0) }; assert.equal(validateAssurancePack(value), true); }
  const deprecated = structuredClone(pack); deprecated.records[0].lifecycle = 'deprecated'; deprecated.records[0].replacement_record_id = deprecated.records[1].record_id; deprecated.coverage.active_count = 1; deprecated.coverage.deprecated_count = 1; deprecated.coverage.replacement_reference_count = 1; assert.equal(validateAssurancePack(deprecated), true);
});
