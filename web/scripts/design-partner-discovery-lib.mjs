import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseStrictJson, readTrackedRegularFile, sourceMap, withStableGitIndex } from './security-privacy-evidence-lib.mjs';

export const PACK_PATH = 'reviews/design-partner-discovery/v1/pack.json';
export const SCHEMA_PATH = 'reviews/design-partner-discovery/v1/pack.schema.json';
export const INTERNAL_MARKER = 'internal-design-partner-discovery-decision-pack-only/v1';
export const SOURCE_PATHS = Object.freeze([
  'docs/DESIGN_PARTNER_PILOT.md', 'docs/INTEGRATIONS.md', 'docs/PACKAGING.md',
  'reviews/accessibility-evidence/v1/README.md', 'reviews/accessibility-evidence/v1/baseline.json',
  'reviews/multilingual-ui/v1/README.md', 'reviews/multilingual-ui/v1/review-pack.json', 'reviews/multilingual-ui/v1/review-pack.schema.json', 'reviews/multilingual-ui/v1/safety-classification.json',
  'reviews/security-privacy-evidence/v1/README.md', 'reviews/security-privacy-evidence/v1/inventory.json',
  'reviews/technical-due-diligence/v1/README.md', 'reviews/technical-due-diligence/v1/index.json',
]);

export const BOUNDARIES = Object.freeze([
  'No outreach, messages, forms, enrollment, or real organization/contact records.',
  'No price publication, commercial offer, contract, paid commitment, billing, or external spending.',
  'No SLA, DPA, security, privacy, compliance, legal, availability, response, verification, or outcome assurance.',
  'No telemetry or user, provider, customer, contact, personal, interview, or crisis-case data.',
  'No production service or managed-service activation; public crisis information remains free.',
  'The repository has no license; public accessibility does not grant reuse permission, so permission and terms remain unresolved.',
  'This pack is non-authoritative internal preparation and cannot approve outreach, enrollment, production reuse, a pilot, or a continue decision.',
]);

export const CAPABILITY_MATRIX = Object.freeze([
  { id: 'public_static_surfaces', current_capability: 'Public keyless static beta finder, API, widget, and snapshot integration surfaces are documented.', limitations: 'No uptime, support, SLA, production-reuse permission, guaranteed coverage, currency, reachability, or outcomes.', evidence: ['docs/INTEGRATIONS.md', 'docs/PACKAGING.md'] },
  { id: 'bounded_synthetic_pilot_draft', current_capability: 'A draft describes a partner-controlled non-production, synthetic-only 4–6 week evaluation shape.', limitations: 'Enrollment is not open; the draft is not an offer, agreement, capacity promise, or authorization to run a pilot.', evidence: ['docs/DESIGN_PARTNER_PILOT.md'] },
  { id: 'static_internal_evidence', current_capability: 'Versioned internal artifacts bind selected accessibility, multilingual, security/privacy, and technical checks to repository evidence.', limitations: 'They are not audits, assessments, certifications, legal opinions, qualified language review, runtime assurance, or operational evidence.', evidence: ['reviews/accessibility-evidence/v1/baseline.json', 'reviews/accessibility-evidence/v1/README.md', 'reviews/multilingual-ui/v1/review-pack.json', 'reviews/multilingual-ui/v1/review-pack.schema.json', 'reviews/multilingual-ui/v1/safety-classification.json', 'reviews/multilingual-ui/v1/README.md', 'reviews/security-privacy-evidence/v1/inventory.json', 'reviews/security-privacy-evidence/v1/README.md', 'reviews/technical-due-diligence/v1/index.json', 'reviews/technical-due-diligence/v1/README.md'] },
  { id: 'reuse_permission', current_capability: 'Repository documentation explicitly exposes the current permission question for review.', limitations: 'No repository license exists, public access grants no reuse right, and production packaging or reuse commitments remain blocked.', evidence: ['docs/INTEGRATIONS.md', 'docs/PACKAGING.md', 'docs/DESIGN_PARTNER_PILOT.md'] },
]);

export const DISCOVERY_QUESTIONS = Object.freeze([
  { topic: 'countries_categories', questions: ['Which countries and hotline categories create the recurring operational need?', 'Which synthetic country/category and fallback cases would demonstrate that need without real crisis data?'] },
  { topic: 'integration_surface', questions: ['Why is a public link insufficient, and which one clearly identified static API, widget, snapshot, or documentation capability is required?', 'Which partner-controlled non-production surface and teardown path could be used for synthetic evaluation?'] },
  { topic: 'process_pain', questions: ['What current process is slow, error-prone, or unavailable, and how often does the same problem occur?', 'What bounded observable result would distinguish a solved workflow problem from general enthusiasm?'] },
  { topic: 'operational_assurance', questions: ['Which operational evidence would be required before any later production decision?', 'Which availability, security, privacy, accessibility, legal, localization, and content-review claims must remain explicitly unmade today?'] },
  { topic: 'ownership_approvals', questions: ['Who would own engineering, safety, privacy, security, accessibility, legal/licensing, content review, stop authority, and teardown?', 'Which written internal approvals would be prerequisites to a separately authorized next step?'] },
  { topic: 'bounded_funding_signal', questions: ['Would an organization independently request and be willing to fund a bounded managed pilot for the same clearly identified operational capability while public crisis information remains free?', 'What exact scope and budget authority would that willingness cover, without accepting a price, contract, enrollment, or paid commitment now?'] },
]);

export const DEMAND_GATE = Object.freeze({
  minimum_distinct_credible_organizations: 3,
  same_capability_required: true,
  independent_request_required: true,
  general_enthusiasm_counts: false,
  rule: 'Do not recommend managed-service activation until at least three distinct credible organizations independently request the same clearly identified operational capability; general enthusiasm does not count.',
  proof_requirement: 'A separately authorized future evidence mechanism must prove distinctness, credibility, independence, same-capability grouping, operational request substance, and non-enthusiasm.',
  current_pack_evidence_mechanism: 'unavailable',
  current_pack_gate_status: 'held',
});

export const DECISION_RUBRIC = Object.freeze({
  outcomes: ['stop', 'hold', 'continue'],
  predicate_fields: ['boundary_status', 'real_data_status', 'evidence_consistency', 'reuse_permission_status', 'required_evidence_status', 'future_evidence_mechanism', 'distinctness_status', 'credibility_status', 'independence_status', 'same_capability_status', 'operational_request_status', 'non_enthusiasm_status'],
  rules: [
    { outcome: 'stop', when: 'A prohibited boundary fails, real organization/contact/interview/crisis data is present, reuse permission is assumed, decision evidence is contradictory, or an already-started evaluation/pilot has permission uncertainty.' },
    { outcome: 'hold', when: 'No stop predicate applies, but required evidence is incomplete or a separately authorized mechanism has not proven three distinct credible independent same-capability operational requests that are not general enthusiasm.' },
    { outcome: 'continue', when: 'No stop or hold predicate applies and a separately authorized evidence mechanism proves at least three distinct credible organizations independently request the same clearly identified operational capability; this vocabulary entry does not authorize this pack to emit or recommend continue or activation.' },
  ],
});

export const SYNTHETIC_EXAMPLES = Object.freeze([{
  scenario_id: 'synthetic-held-example-001', fixture_kind: 'fixed_non_collecting_synthetic_scenario', capability_id: 'bounded_static_snapshot_change_handoff',
  boundary_status: 'pass', real_data_status: 'absent', evidence_consistency: 'consistent', reuse_permission_status: 'unresolved', required_evidence_status: 'incomplete', future_evidence_mechanism: 'unavailable',
  distinctness_status: 'unestablished', credibility_status: 'unestablished', independence_status: 'unestablished', same_capability_status: 'unestablished', operational_request_status: 'unestablished', non_enthusiasm_status: 'unestablished',
  outcome: 'hold', rationale: 'The static pack has no authorized evidence mechanism and cannot establish the demand gate.',
}]);

const SYNTHETIC_EVIDENCE_KEYS = Object.freeze([
  'fixture_kind', 'organization_evidence_id', 'request_evidence_id', 'capability_id',
  'credible_organization', 'independent_request', 'request_provenance',
  'operational_request', 'enthusiasm_only',
]);

// Pure contract evaluator: accepts only closed, conspicuously synthetic in-memory
// records. It neither reads nor persists evidence and derives every gate predicate.
export function evaluateSyntheticDemandEvidence(records) {
  if (!Array.isArray(records) || records.length === 0) return { outcome: 'hold', reason: 'closed synthetic evidence is absent' };
  const organizations = new Set(); const requests = new Set(); let capabilityId;
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.getPrototypeOf(record) !== Object.prototype) return { outcome: 'hold', reason: 'evidence record is invalid' };
    if (!SYNTHETIC_EVIDENCE_KEYS.every((key, index) => Object.keys(record)[index] === key) || Object.keys(record).length !== SYNTHETIC_EVIDENCE_KEYS.length) return { outcome: 'hold', reason: 'evidence record fields are unknown, missing, or reordered' };
    if (record.fixture_kind !== 'conspicuously_synthetic_in_memory_demand_evidence') return { outcome: 'hold', reason: 'only synthetic in-memory evidence is accepted' };
    if (![record.organization_evidence_id, record.request_evidence_id, record.capability_id].every((value) => typeof value === 'string' && /^synthetic_[a-z0-9_]{8,}$/.test(value))) return { outcome: 'hold', reason: 'synthetic evidence identity is invalid' };
    if ([record.credible_organization, record.independent_request, record.operational_request, record.enthusiasm_only].some((value) => typeof value !== 'boolean')) return { outcome: 'hold', reason: 'evidence predicates are contradictory or unknown' };
    if (record.request_provenance !== 'independent_synthetic_request') return { outcome: 'hold', reason: 'request provenance is shared, derived, or unknown' };
    if (!record.credible_organization || !record.independent_request || !record.operational_request || record.enthusiasm_only) return { outcome: 'hold', reason: 'evidence does not qualify' };
    if (organizations.has(record.organization_evidence_id) || requests.has(record.request_evidence_id)) return { outcome: 'hold', reason: 'evidence identity is duplicated' };
    if (capabilityId === undefined) capabilityId = record.capability_id;
    if (record.capability_id !== capabilityId) return { outcome: 'hold', reason: 'requests do not identify the exact same canonical capability' };
    organizations.add(record.organization_evidence_id); requests.add(record.request_evidence_id);
  }
  return organizations.size >= DEMAND_GATE.minimum_distinct_credible_organizations
    ? { outcome: 'continue', capability_id: capabilityId, qualifying_organization_count: organizations.size }
    : { outcome: 'hold', reason: 'fewer than three distinct qualifying organizations' };
}

const ROOT_KEYS = ['schema_version', 'internal_only_marker', 'purpose', 'boundaries', 'sources', 'capability_matrix', 'discovery_questions', 'demand_gate', 'decision_rubric', 'example_records'];

function trackedJson(repo, path, options) {
  const file = readTrackedRegularFile(repo, path, options);
  assert.ok(file.bytes.length && file.bytes.at(-1) === 0x0a, `${path} must end with LF`);
  return parseStrictJson(file.bytes, path);
}

export function packAuthorizationOutcome(state, demandEvaluation = { outcome: 'hold' }) {
  if (state.boundary_status === 'fail' || state.real_data_status === 'present' || state.evidence_consistency === 'contradictory' || state.reuse_permission_status === 'assumed' || (state.activity_status === 'started' && state.reuse_permission_status === 'unresolved')) return 'stop';
  assert.ok(demandEvaluation && ['hold', 'continue'].includes(demandEvaluation.outcome), 'demand evaluation must be a pure evaluator result');
  // The current pack has no authorized evidence mechanism. Even a pure evaluator
  // continuation is only a contract result and cannot authorize pack action.
  return 'hold';
}
export const expectedOutcome = packAuthorizationOutcome;

export function validatePack(pack, repo, options = {}) {
  assert.deepEqual(Object.keys(pack), ROOT_KEYS, 'pack fields/order changed');
  assert.equal(pack.schema_version, '1.0');
  assert.equal(pack.internal_only_marker, INTERNAL_MARKER);
  assert.equal(pack.purpose, 'repository_internal_non_authoritative_discovery_preparation');
  assert.deepEqual(pack.boundaries, BOUNDARIES, 'authoritative boundaries changed');
  assert.deepEqual(Object.keys(pack.sources), SOURCE_PATHS, 'source inventory/order changed');
  assert.deepEqual(sourceMap(repo, SOURCE_PATHS, options), pack.sources, 'exact tracked evidence source bytes changed');
  assert.deepEqual(pack.capability_matrix, CAPABILITY_MATRIX, 'capability matrix or exact evidence assignments changed');
  assert.deepEqual(pack.discovery_questions, DISCOVERY_QUESTIONS, 'discovery questions changed');
  assert.deepEqual(pack.demand_gate, DEMAND_GATE, 'demand gate changed');
  assert.deepEqual(pack.decision_rubric, DECISION_RUBRIC, 'decision rubric changed');
  assert.deepEqual(pack.example_records, SYNTHETIC_EXAMPLES, 'fixed synthetic examples changed');
  for (const record of pack.example_records) {
    assert.equal(expectedOutcome(record), 'hold', `${record.scenario_id}: checked-in examples must derive hold`);
    assert.equal(record.outcome, expectedOutcome(record), `${record.scenario_id}: outcome is not derived from closed predicates`);
  }
  assert.ok(pack.example_records.every(({ outcome }) => outcome !== 'continue'), 'current pack cannot emit continue');
  return pack;
}

export function loadPack(repo, options = {}) {
  return withStableGitIndex(repo, options, () => {
    const schema = trackedJson(repo, SCHEMA_PATH, options); const pack = trackedJson(repo, PACK_PATH, options);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema'); assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, ROOT_KEYS);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    assert.ok(validate(pack), `pack fails Draft 2020-12 schema: ${new Ajv2020().errorsText(validate.errors)}`);
    return validatePack(pack, repo, options);
  });
}
