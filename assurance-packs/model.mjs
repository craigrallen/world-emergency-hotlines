import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { descriptorFromReleaseBytes } from '../gateway/src/artifacts.mjs';

const SHA = /^sha256:[0-9a-f]{64}$/;
const RECORD_ID = /^weh_[0-9a-f]{24}$/;
const SYNTHETIC_ID = /^[a-z0-9][a-z0-9._-]*\.invalid$/;
const SOURCE_ID = /^src_[a-z0-9_]+$/;
const REVIEW_ID = /^rev_[a-z0-9_]+$/;
const ARTIFACT_PATH = /^\/(?:api|data)\/[-a-z0-9/.]+$/;
const CATEGORY = /^[a-z][a-z0-9_]*$/;
const COUNTRY = /^[A-Z]{2}$/;
const SOURCE_KINDS = new Set(['canonical_source', 'provider_claim']);
const CLAIM_STATES = new Set(['not_applicable', 'pending', 'rejected']);
const REVIEW_DECISIONS = new Set(['accepted', 'rejected', 'unknown']);
const REVIEW_ROLES = new Set(['independent_reviewer']);
const LIFECYCLE_STATES = new Set(['active', 'deprecated']);
const UNCERTAINTY_STATES = new Set(['independently_reviewed', 'unresolved', 'unknown']);
const LIMITATIONS = Object.freeze([
  'Static synthetic contract evidence only; not a customer or provider export.',
  'No raw crisis usage, live availability, quality, ranking, outcome, uptime, support, or SLA claim.',
  'Provider claims are untrusted input and cannot verify, rank, publish, or mutate canonical records.',
]);

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys, label) {
  assert.ok(plain(value), `${label} must be a plain object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or prohibited fields`);
}
function array(value, label, nonempty = false) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  if (nonempty) assert.ok(value.length > 0, `${label} must not be empty`);
}
function sortedUnique(values, label) {
  array(values, label);
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
  assert.deepEqual(values, [...values].sort(), `${label} must be sorted`);
}
function sha(value, label) { assert.equal(typeof value, 'string'); assert.match(value, SHA, `${label} must be a SHA-256 identity`); }
function byteIdentity(bytes) { assert.ok(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'exact fixture bytes must be supplied'); return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function validateTrustPolicyPin(pin, label = 'trust policy pin') { exact(pin, ['policy_identity', 'sha256'], label); assert.match(pin.policy_identity, SYNTHETIC_ID); sha(pin.sha256, `${label} sha256`); }
function count(value, label, positive = false) { assert.ok(Number.isSafeInteger(value) && value >= (positive ? 1 : 0), `${label} must be a safe ${positive ? 'positive' : 'nonnegative'} integer`); }
function safeArtifactPath(value) {
  return typeof value === 'string' && ARTIFACT_PATH.test(value) && !value.startsWith('//') && !value.includes('\\') && !value.includes('%')
    && value.slice(1).split('/').every((part) => part && part !== '.' && part !== '..');
}

export function validateTrustPolicy(policy) {
  exact(policy, ['schema', 'policy_identity', 'sources', 'reviewers'], 'trust policy');
  assert.equal(policy.schema, 'assurance-pack-synthetic-trust-policy/v1'); assert.match(policy.policy_identity, SYNTHETIC_ID);
  array(policy.sources, 'trusted sources', true); sortedUnique(policy.sources.map((x) => x.source_id), 'trusted source IDs');
  const providerSubmitters = new Set();
  for (const source of policy.sources) {
    exact(source, ['source_id', 'record_id', 'kind', 'locator_sha256', 'authorized_submitter_identity', 'allowed_provider_claim_states'], 'trusted source');
    assert.match(source.source_id, SOURCE_ID); assert.match(source.record_id, RECORD_ID); assert.ok(SOURCE_KINDS.has(source.kind)); sha(source.locator_sha256, 'trusted locator');
    assert.match(source.authorized_submitter_identity, SYNTHETIC_ID); array(source.allowed_provider_claim_states, 'allowed claim states', true);
    sortedUnique(source.allowed_provider_claim_states, 'allowed claim states'); assert.ok(source.allowed_provider_claim_states.every((x) => CLAIM_STATES.has(x)));
    if (source.kind === 'provider_claim') {
      assert.deepEqual(source.allowed_provider_claim_states, ['pending', 'rejected'], 'provider policy must permit only pending/rejected');
      providerSubmitters.add(source.authorized_submitter_identity);
    } else assert.deepEqual(source.allowed_provider_claim_states, ['not_applicable'], 'canonical policy claim state must be not_applicable');
  }
  array(policy.reviewers, 'trusted reviewers', true); sortedUnique(policy.reviewers.map((x) => x.reviewer_identity), 'trusted reviewer identities');
  for (const reviewer of policy.reviewers) {
    exact(reviewer, ['reviewer_identity', 'role', 'allowed_decisions'], 'trusted reviewer');
    assert.match(reviewer.reviewer_identity, SYNTHETIC_ID); assert.ok(REVIEW_ROLES.has(reviewer.role));
    array(reviewer.allowed_decisions, 'allowed review decisions', true); sortedUnique(reviewer.allowed_decisions, 'allowed review decisions');
    assert.ok(reviewer.allowed_decisions.every((x) => REVIEW_DECISIONS.has(x))); assert.ok(!providerSubmitters.has(reviewer.reviewer_identity), 'provider submitter cannot be reviewer authority');
  }
  return true;
}

export function validateAssessedRelease(releaseBytes, indexBytes, datasetVersion) {
  sha(datasetVersion, 'canonical dataset_version');
  assert.equal(createHash('sha256').update(releaseBytes).digest('hex'), '811078abc4b5a91208d99e4f8ae385394c0b02a2b5a5ccf3110cb68870da5a04', 'synthetic release fixture bytes changed');
  const descriptor = descriptorFromReleaseBytes(releaseBytes, indexBytes);
  assert.equal(descriptor.release_id, 'sha256:da1a06c5b11b20fc76afa269c324ab869293cdd67d232cf62f05724dc1fc124a', 'unexpected synthetic upstream-release fixture identity');
  assert.equal(descriptor.dataset_version, datasetVersion, 'assessed release dataset_version does not identify supplied canonical bytes');
  return { release: JSON.parse(releaseBytes), index: JSON.parse(indexBytes) };
}

export function validateEvidenceInput(value, trustPolicy, trustPolicyBytes, canonicalBytes, releaseBytes, indexBytes) {
  validateTrustPolicy(trustPolicy);
  let suppliedPolicy, canonical; try { suppliedPolicy = JSON.parse(trustPolicyBytes); canonical = JSON.parse(canonicalBytes); } catch { throw new Error('trust policy and canonical dataset must be supplied as exact valid JSON bytes'); }
  assert.deepEqual(suppliedPolicy, trustPolicy, 'separately supplied trust policy does not match retained policy bytes');
  const trustPolicyPin = { policy_identity: trustPolicy.policy_identity, sha256: byteIdentity(trustPolicyBytes) };
  const datasetVersion = byteIdentity(canonicalBytes);
  const assessed = validateAssessedRelease(releaseBytes, indexBytes, datasetVersion); const release = assessed.release; const indexByPath = new Map(assessed.index.artifacts.map((x) => [x.path, x]));
  exact(value, ['schema', 'synthetic_identity', 'trust_policy', 'dataset_version', 'release', 'footprint', 'records', 'sources', 'reviews'], 'input');
  assert.equal(value.schema, 'assurance-pack-evidence-input/v1'); assert.match(value.synthetic_identity, SYNTHETIC_ID); sha(value.dataset_version, 'dataset_version');
  validateTrustPolicyPin(value.trust_policy); assert.deepEqual(value.trust_policy, trustPolicyPin, 'input trust_policy does not identify exact separately supplied policy bytes');
  exact(value.release, ['release_id', 'artifact_index_sha256', 'artifacts'], 'release pin'); sha(value.release.release_id, 'release_id'); sha(value.release.artifact_index_sha256, 'artifact_index_sha256');
  array(value.release.artifacts, 'release artifacts', true); sortedUnique(value.release.artifacts.map((x) => x.path), 'artifact paths');
  for (const artifact of value.release.artifacts) { exact(artifact, ['path', 'sha256', 'bytes'], 'artifact'); assert.ok(safeArtifactPath(artifact.path), 'unsafe artifact path'); sha(artifact.sha256, 'artifact hash'); count(artifact.bytes, 'artifact bytes', true); assert.deepEqual(artifact, indexByPath.get(artifact.path), `artifact is not an exact synthetic fixture index entry: ${artifact.path}`); }
  assert.equal(value.dataset_version, datasetVersion, 'input dataset_version does not identify exact canonical bytes'); assert.equal(value.dataset_version, release.dataset_version); assert.equal(value.release.release_id, release.release_id); assert.equal(value.release.artifact_index_sha256, release.artifact_index.sha256);
  exact(value.footprint, ['countries', 'categories'], 'footprint'); array(value.footprint.countries, 'countries', true); array(value.footprint.categories, 'categories', true);
  sortedUnique(value.footprint.countries, 'countries'); sortedUnique(value.footprint.categories, 'categories'); assert.ok(value.footprint.countries.every((x) => COUNTRY.test(x))); assert.ok(value.footprint.categories.every((x) => CATEGORY.test(x)));
  array(value.records, 'records', true); sortedUnique(value.records.map((x) => x.record_id), 'record IDs'); const recordIds = new Set(value.records.map((x) => x.record_id));
  for (const record of value.records) {
    exact(record, ['record_id', 'country', 'category', 'lifecycle', 'replacement_record_id', 'source_ids'], 'record input'); assert.match(record.record_id, RECORD_ID);
    assert.ok(value.footprint.countries.includes(record.country)); assert.ok(value.footprint.categories.includes(record.category)); assert.ok(LIFECYCLE_STATES.has(record.lifecycle));
    assert.ok(record.replacement_record_id === null || (typeof record.replacement_record_id === 'string' && RECORD_ID.test(record.replacement_record_id)));
    assert.equal(record.lifecycle === 'deprecated', record.replacement_record_id !== null, 'deprecated records require a replacement; active records forbid one');
    if (record.replacement_record_id) assert.ok(recordIds.has(record.replacement_record_id) && record.replacement_record_id !== record.record_id, 'replacement must reference another included record');
    array(record.source_ids, `${record.record_id} source IDs`, true); sortedUnique(record.source_ids, `${record.record_id} source IDs`);
  }
  assert.deepEqual([...new Set(value.records.map((x) => x.country))].sort(), value.footprint.countries, 'country footprint must be exact'); assert.deepEqual([...new Set(value.records.map((x) => x.category))].sort(), value.footprint.categories, 'category footprint must be exact');
  const trustedSources = new Map(trustPolicy.sources.map((x) => [x.source_id, x])); array(value.sources, 'sources', true); sortedUnique(value.sources.map((x) => x.source_id), 'source IDs'); const sources = new Map();
  for (const source of value.sources) {
    exact(source, ['source_id', 'record_id', 'kind', 'locator_sha256', 'submitter_identity', 'provider_claim_status'], 'source'); const trusted = trustedSources.get(source.source_id); assert.ok(trusted, 'source is absent from trust policy');
    assert.deepEqual({ source_id: source.source_id, record_id: source.record_id, kind: source.kind, locator_sha256: source.locator_sha256, submitter_identity: source.submitter_identity }, { source_id: trusted.source_id, record_id: trusted.record_id, kind: trusted.kind, locator_sha256: trusted.locator_sha256, submitter_identity: trusted.authorized_submitter_identity }, 'source authority does not match trust policy');
    assert.ok(recordIds.has(source.record_id)); assert.ok(trusted.allowed_provider_claim_states.includes(source.provider_claim_status), 'claim state is not authorized by trust policy');
    if (source.kind === 'provider_claim') assert.ok(source.provider_claim_status === 'pending' || source.provider_claim_status === 'rejected', 'provider claims must remain pending or rejected'); sources.set(source.source_id, source);
  }
  for (const record of value.records) for (const id of record.source_ids) assert.equal(sources.get(id)?.record_id, record.record_id, 'evidence source must bind to its record');
  const trustedReviewers = new Map(trustPolicy.reviewers.map((x) => [x.reviewer_identity, x])); array(value.reviews, 'reviews'); sortedUnique(value.reviews.map((x) => x.review_id), 'review IDs'); const reviewedSources = new Set();
  for (const review of value.reviews) {
    exact(review, ['review_id', 'source_id', 'reviewer_identity', 'role', 'decision'], 'review'); assert.match(review.review_id, REVIEW_ID); const source = sources.get(review.source_id); assert.ok(source);
    const trusted = trustedReviewers.get(review.reviewer_identity); assert.ok(trusted, 'reviewer is absent from trust policy'); assert.equal(review.role, trusted.role, 'review role does not match trust policy'); assert.ok(trusted.allowed_decisions.includes(review.decision), 'review decision is not authorized');
    assert.notEqual(source.kind, 'provider_claim', 'provider claims cannot be independently accepted'); assert.notEqual(source.submitter_identity, review.reviewer_identity, 'submitter cannot review own evidence'); assert.ok(!reviewedSources.has(review.source_id), 'one review per source in v1'); reviewedSources.add(review.source_id);
  }
  if (canonical) {
    const canonicalMap = new Map(canonical.countries.flatMap((country) => (country.hotlines ?? []).map((record) => [record.id, { country: country['alpha-2'], ...record }])));
    for (const record of value.records) { const actual = canonicalMap.get(record.record_id); assert.ok(actual, 'record must exist in canonical dataset'); assert.equal(record.country, actual.country); assert.equal(record.category, actual.category); assert.equal(record.lifecycle, actual.replaced_by ? 'deprecated' : 'active'); assert.equal(record.replacement_record_id, actual.replaced_by ?? null); }
  }
  return true;
}

export function deriveAssurancePack(value, trustPolicy, trustPolicyBytes, canonicalBytes, releaseBytes, indexBytes) {
  validateEvidenceInput(value, trustPolicy, trustPolicyBytes, canonicalBytes, releaseBytes, indexBytes); const sources = new Map(value.sources.map((x) => [x.source_id, x])); const reviews = new Map(value.reviews.map((x) => [x.source_id, x]));
  const records = value.records.map((record) => { const bound = record.source_ids.map((id) => sources.get(id)); const accepted = bound.filter((x) => reviews.get(x.source_id)?.decision === 'accepted').length; const pending = bound.filter((x) => x.kind === 'provider_claim' && x.provider_claim_status === 'pending').length; const rejected = bound.filter((x) => x.kind === 'provider_claim' && x.provider_claim_status === 'rejected').length; const unknown = bound.length - accepted - pending - rejected; return { record_id: record.record_id, country: record.country, category: record.category, lifecycle: record.lifecycle, replacement_record_id: record.replacement_record_id, evidence_summary: { independently_accepted: accepted, provider_claims_pending: pending, provider_claims_rejected: rejected, unresolved_or_unknown: unknown }, uncertainty: accepted > 0 ? 'independently_reviewed' : pending > 0 || rejected > 0 ? 'unresolved' : 'unknown' }; });
  const sum = (name) => records.reduce((n, x) => n + x.evidence_summary[name], 0);
  return { schema: 'data-assurance-pack/v1', pack_kind: 'static_synthetic_reference', synthetic_identity: value.synthetic_identity, trust_policy: structuredClone(value.trust_policy), dataset_version: value.dataset_version, release: structuredClone(value.release), footprint: structuredClone(value.footprint), coverage: { record_count: records.length, country_count: value.footprint.countries.length, category_count: value.footprint.categories.length, active_count: records.filter((x) => x.lifecycle === 'active').length, deprecated_count: records.filter((x) => x.lifecycle === 'deprecated').length, replacement_reference_count: records.filter((x) => x.replacement_record_id).length, independently_accepted_evidence_count: sum('independently_accepted'), provider_claims_pending_count: sum('provider_claims_pending'), provider_claims_rejected_count: sum('provider_claims_rejected'), unresolved_or_unknown_evidence_count: sum('unresolved_or_unknown') }, records, limitations: [...LIMITATIONS] };
}

export function validateAssurancePack(pack) {
  exact(pack, ['schema', 'pack_kind', 'synthetic_identity', 'trust_policy', 'dataset_version', 'release', 'footprint', 'coverage', 'records', 'limitations'], 'pack'); assert.equal(pack.schema, 'data-assurance-pack/v1'); assert.equal(pack.pack_kind, 'static_synthetic_reference'); assert.match(pack.synthetic_identity, SYNTHETIC_ID); validateTrustPolicyPin(pack.trust_policy, 'pack trust policy'); sha(pack.dataset_version, 'dataset_version');
  exact(pack.release, ['release_id', 'artifact_index_sha256', 'artifacts'], 'pack release'); sha(pack.release.release_id, 'pack release_id'); sha(pack.release.artifact_index_sha256, 'pack artifact index'); array(pack.release.artifacts, 'pack artifacts', true); sortedUnique(pack.release.artifacts.map((x) => x.path), 'pack artifact paths'); for (const artifact of pack.release.artifacts) { exact(artifact, ['path', 'sha256', 'bytes'], 'pack artifact'); assert.ok(safeArtifactPath(artifact.path)); sha(artifact.sha256, 'pack artifact hash'); count(artifact.bytes, 'pack artifact bytes', true); }
  exact(pack.footprint, ['countries', 'categories'], 'pack footprint'); array(pack.footprint.countries, 'pack countries', true); array(pack.footprint.categories, 'pack categories', true); sortedUnique(pack.footprint.countries, 'pack countries'); sortedUnique(pack.footprint.categories, 'pack categories'); assert.ok(pack.footprint.countries.every((x) => COUNTRY.test(x))); assert.ok(pack.footprint.categories.every((x) => CATEGORY.test(x)));
  exact(pack.coverage, ['record_count', 'country_count', 'category_count', 'active_count', 'deprecated_count', 'replacement_reference_count', 'independently_accepted_evidence_count', 'provider_claims_pending_count', 'provider_claims_rejected_count', 'unresolved_or_unknown_evidence_count'], 'pack coverage'); for (const [key, value] of Object.entries(pack.coverage)) count(value, key);
  array(pack.records, 'pack records', true); sortedUnique(pack.records.map((x) => x.record_id), 'pack record IDs'); const ids = new Set(pack.records.map((x) => x.record_id));
  for (const record of pack.records) { exact(record, ['record_id', 'country', 'category', 'lifecycle', 'replacement_record_id', 'evidence_summary', 'uncertainty'], 'pack record'); assert.match(record.record_id, RECORD_ID); assert.match(record.country, COUNTRY); assert.match(record.category, CATEGORY); assert.ok(LIFECYCLE_STATES.has(record.lifecycle)); assert.ok(record.replacement_record_id === null || (typeof record.replacement_record_id === 'string' && RECORD_ID.test(record.replacement_record_id))); assert.equal(record.lifecycle === 'deprecated', record.replacement_record_id !== null, 'pack replacement state is inconsistent'); if (record.replacement_record_id) assert.ok(record.replacement_record_id !== record.record_id && ids.has(record.replacement_record_id)); exact(record.evidence_summary, ['independently_accepted', 'provider_claims_pending', 'provider_claims_rejected', 'unresolved_or_unknown'], 'pack evidence summary'); for (const [key, value] of Object.entries(record.evidence_summary)) count(value, key); assert.ok(UNCERTAINTY_STATES.has(record.uncertainty)); const e = record.evidence_summary; assert.equal(record.uncertainty, e.independently_accepted > 0 ? 'independently_reviewed' : e.provider_claims_pending + e.provider_claims_rejected > 0 ? 'unresolved' : 'unknown', 'uncertainty does not match evidence counts'); }
  assert.deepEqual([...new Set(pack.records.map((x) => x.country))].sort(), pack.footprint.countries, 'pack country footprint must be exact'); assert.deepEqual([...new Set(pack.records.map((x) => x.category))].sort(), pack.footprint.categories, 'pack category footprint must be exact'); assert.deepEqual(pack.limitations, LIMITATIONS);
  const derived = { record_count: pack.records.length, country_count: pack.footprint.countries.length, category_count: pack.footprint.categories.length, active_count: pack.records.filter((x) => x.lifecycle === 'active').length, deprecated_count: pack.records.filter((x) => x.lifecycle === 'deprecated').length, replacement_reference_count: pack.records.filter((x) => x.replacement_record_id).length, independently_accepted_evidence_count: pack.records.reduce((n, x) => n + x.evidence_summary.independently_accepted, 0), provider_claims_pending_count: pack.records.reduce((n, x) => n + x.evidence_summary.provider_claims_pending, 0), provider_claims_rejected_count: pack.records.reduce((n, x) => n + x.evidence_summary.provider_claims_rejected, 0), unresolved_or_unknown_evidence_count: pack.records.reduce((n, x) => n + x.evidence_summary.unresolved_or_unknown, 0) }; assert.deepEqual(pack.coverage, derived, 'coverage counts must exactly match records'); return true;
}
