import assert from 'node:assert/strict';

const SYNTHETIC_ID = /^[a-z0-9][a-z0-9._-]*\.invalid$/;
const CLAIM_ID = /^pclm_syn_[a-z0-9_]{8,48}$/;
const LISTING_ID = /^syn_listing_[a-z0-9_]{8,48}$/;
const EVIDENCE_ID = /^pev_syn_[a-z0-9_]{8,48}$/;
const REVIEW_ID = /^prv_syn_[a-z0-9_]{8,48}$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 .,'()&/-]{0,239}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const PROPOSED_FIELDS = new Set(['organization_name', 'service_description', 'service_url']);
const EVIDENCE_KINDS = new Set(['claimant_statement', 'claimant_document_reference']);
const DECISIONS = new Set(['accepted_for_candidate', 'rejected', 'needs_more_evidence']);
const TERMINAL = new Set(DECISIONS);
const NARRATIVE_MARKERS = /\b(?:i|me|my|suicid|self[- ]?harm|abuse|victim|patient|caller|case|crisis narrative)\b/i;
const PHONE_LIKE_RUN = /(?<!\d)\+?\d[\d(). /-]*\d(?!\d)/g;

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys, label) { assert.ok(plain(value), `${label} must be a plain object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or prohibited fields`); }
function text(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  const containsPhoneLikeRun = [...value.matchAll(PHONE_LIKE_RUN)]
    .some(([candidate]) => candidate.replace(/\D/g, '').length >= 7);
  assert.equal(containsPhoneLikeRun, false, `${label} must not contain a phone or contact number`);
  assert.match(value, SAFE_TEXT, `${label} is not bounded safe text`);
  assert.doesNotMatch(value, NARRATIVE_MARKERS, `${label} must not contain personal or crisis narrative`);
}
function synthetic(value, label) { assert.equal(typeof value, 'string'); assert.match(value, SYNTHETIC_ID, `${label} must be a synthetic .invalid identity`); }
function syntheticUrl(value, label) { assert.equal(typeof value, 'string'); const url = new URL(value); assert.equal(url.protocol, 'https:', `${label} must use https`); assert.match(url.hostname, SYNTHETIC_ID, `${label} host must end in .invalid`); assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.hash, ''); }

export function validateClaimEnvelope(claim) {
  exact(claim, ['schema', 'claim_id', 'state', 'listing_context', 'claimant', 'provider', 'proposed_changes', 'claimant_evidence', 'safety'], 'claim envelope');
  assert.equal(claim.schema, 'provider-claim-staging-envelope/v1'); assert.match(claim.claim_id, CLAIM_ID); assert.equal(claim.state, 'staged');
  exact(claim.listing_context, ['synthetic_listing_id', 'synthetic_stable_id', 'context_only'], 'listing context');
  assert.match(claim.listing_context.synthetic_listing_id, LISTING_ID); assert.match(claim.listing_context.synthetic_stable_id, /^syn_weh_[0-9a-f]{24}$/); assert.equal(claim.listing_context.context_only, true);
  exact(claim.claimant, ['identity'], 'claimant'); exact(claim.provider, ['identity'], 'provider'); synthetic(claim.claimant.identity, 'claimant identity'); synthetic(claim.provider.identity, 'provider identity');
  assert.ok(Array.isArray(claim.proposed_changes) && claim.proposed_changes.length > 0 && claim.proposed_changes.length <= 3, 'proposed changes must be bounded');
  const fields = new Set();
  for (const change of claim.proposed_changes) {
    exact(change, ['field', 'proposed_value'], 'proposed change'); assert.ok(PROPOSED_FIELDS.has(change.field), 'unsupported proposed field'); assert.ok(!fields.has(change.field), 'duplicate proposed field'); fields.add(change.field);
    if (change.field === 'service_url') syntheticUrl(change.proposed_value, 'proposed service URL'); else text(change.proposed_value, 'proposed value');
  }
  assert.ok(Array.isArray(claim.claimant_evidence) && claim.claimant_evidence.length > 0 && claim.claimant_evidence.length <= 5, 'claimant evidence must be bounded');
  const evidenceIds = new Set();
  for (const evidence of claim.claimant_evidence) {
    exact(evidence, ['evidence_id', 'classification', 'kind', 'locator', 'summary'], 'claimant evidence'); assert.match(evidence.evidence_id, EVIDENCE_ID); assert.ok(!evidenceIds.has(evidence.evidence_id), 'duplicate evidence ID'); evidenceIds.add(evidence.evidence_id);
    assert.equal(evidence.classification, 'untrusted_claimant_evidence'); assert.ok(EVIDENCE_KINDS.has(evidence.kind)); syntheticUrl(evidence.locator, 'evidence locator'); text(evidence.summary, 'evidence summary');
  }
  exact(claim.safety, ['contains_personal_data', 'contains_crisis_narrative', 'canonical_mutation_requested', 'ranking_or_verification_requested'], 'safety');
  for (const value of Object.values(claim.safety)) assert.equal(value, false, 'all safety exclusions must be false');
  return true;
}

export function validateReviewDecision(review, claim) {
  validateClaimEnvelope(claim);
  exact(review, ['schema', 'review_id', 'claim_id', 'reviewer', 'transition', 'decision_basis', 'conflict_declaration', 'effects'], 'review record');
  assert.equal(review.schema, 'provider-claim-independent-review/v1'); assert.match(review.review_id, REVIEW_ID); assert.equal(review.claim_id, claim.claim_id);
  exact(review.reviewer, ['identity', 'role'], 'reviewer'); synthetic(review.reviewer.identity, 'reviewer identity'); assert.equal(review.reviewer.role, 'independent_reviewer');
  assert.notEqual(review.reviewer.identity, claim.claimant.identity, 'claimant cannot review own claim'); assert.notEqual(review.reviewer.identity, claim.provider.identity, 'provider cannot review its claim');
  exact(review.transition, ['from', 'via', 'to'], 'transition'); assert.equal(review.transition.from, 'staged'); assert.equal(review.transition.via, 'under_review'); assert.ok(TERMINAL.has(review.transition.to));
  exact(review.decision_basis, ['decision', 'reason_code', 'reason', 'evidence_ids', 'uncertainty'], 'decision basis'); assert.ok(DECISIONS.has(review.decision_basis.decision)); assert.equal(review.transition.to, review.decision_basis.decision); text(review.decision_basis.reason, 'review reason');
  assert.match(review.decision_basis.reason_code, /^(evidence_sufficient_for_candidate|claim_rejected|additional_evidence_required)$/);
  const expectedReason = { accepted_for_candidate: 'evidence_sufficient_for_candidate', rejected: 'claim_rejected', needs_more_evidence: 'additional_evidence_required' }[review.decision_basis.decision]; assert.equal(review.decision_basis.reason_code, expectedReason);
  assert.ok(Array.isArray(review.decision_basis.evidence_ids) && review.decision_basis.evidence_ids.length > 0, 'review must cite evidence'); assert.equal(new Set(review.decision_basis.evidence_ids).size, review.decision_basis.evidence_ids.length, 'review evidence must be unique');
  const claimEvidence = new Set(claim.claimant_evidence.map((x) => x.evidence_id)); for (const id of review.decision_basis.evidence_ids) assert.ok(claimEvidence.has(id), 'review cites unknown evidence');
  const expectedUncertainty = { accepted_for_candidate: 'bounded_uncertainty_remains', rejected: 'material_uncertainty', needs_more_evidence: 'insufficient_evidence' }[review.decision_basis.decision]; assert.equal(review.decision_basis.uncertainty, expectedUncertainty);
  exact(review.conflict_declaration, ['no_conflict', 'not_claimant', 'not_provider', 'basis'], 'conflict declaration'); assert.equal(review.conflict_declaration.no_conflict, true); assert.equal(review.conflict_declaration.not_claimant, true); assert.equal(review.conflict_declaration.not_provider, true); text(review.conflict_declaration.basis, 'conflict basis');
  exact(review.effects, ['candidate_eligibility_only', 'canonical_mutation', 'verified_status', 'ranking_or_search_effect', 'publication'], 'effects'); assert.equal(review.effects.candidate_eligibility_only, review.transition.to === 'accepted_for_candidate'); for (const key of ['canonical_mutation', 'verified_status', 'ranking_or_search_effect', 'publication']) assert.equal(review.effects[key], false);
  return true;
}

export function transitionClaim(claim, review) {
  validateReviewDecision(review, claim);
  return Object.freeze({ claim_id: claim.claim_id, state: review.transition.to, candidate_eligible: review.transition.to === 'accepted_for_candidate' });
}
