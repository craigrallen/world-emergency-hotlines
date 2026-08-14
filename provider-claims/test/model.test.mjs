import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transitionClaim, validateClaimEnvelope, validateReviewDecision } from '../model.mjs';

const root = resolve(import.meta.dirname, '../contracts/v1');
const claim = JSON.parse(readFileSync(resolve(root, 'claim.synthetic.json')));
const review = JSON.parse(readFileSync(resolve(root, 'review.synthetic.json')));
const mutate = (value, fn) => { const copy = structuredClone(value); fn(copy); return copy; };

test('validates synthetic claim and independent accepted-for-candidate review', () => {
  assert.equal(validateClaimEnvelope(claim), true);
  assert.equal(validateReviewDecision(review, claim), true);
  assert.deepEqual(transitionClaim(claim, review), { claim_id: claim.claim_id, state: 'accepted_for_candidate', candidate_eligible: true });
  assert.deepEqual(Object.keys(transitionClaim(claim, review)).sort(), ['candidate_eligible', 'claim_id', 'state']);
});

for (const [name, field, phoneLikeValue] of [
  ['organization name with hyphenated number', 'organization_name', 'Synthetic Service 555-123-4567'],
  ['service description with contiguous number', 'service_description', 'Synthetic support line 5551234567'],
  ['service description with parenthesized number', 'service_description', 'Synthetic support line (555) 123 4567'],
  ['service description with dotted number', 'service_description', 'Synthetic support line 555.123.4567'],
  ['service description with slash-separated number', 'service_description', 'Synthetic support line 555/123/4567'],
]) test(`rejects proposed ${name}`, () => {
  const value = mutate(claim, (x) => { x.proposed_changes[0] = { field, proposed_value: phoneLikeValue }; });
  assert.throws(() => validateClaimEnvelope(value), /must not contain a phone or contact number/);
});

test('rejects phone-like numbers in evidence summary', () => {
  const value = mutate(claim, (x) => { x.claimant_evidence[0].summary = 'Synthetic document contact 555-123-4567'; });
  assert.throws(() => validateClaimEnvelope(value), /evidence summary must not contain a phone or contact number/);
});

for (const [name, mutateReview] of [
  ['review reason', (x) => { x.decision_basis.reason = 'Synthetic review contact 5551234567'; }],
  ['conflict basis', (x) => { x.conflict_declaration.basis = 'Synthetic reviewer contact 555 123 4567'; }],
]) test(`rejects phone-like numbers in ${name}`, () => {
  const value = mutate(review, mutateReview);
  assert.throws(() => validateReviewDecision(value, claim), /must not contain a phone or contact number/);
});

test('allows short harmless numbers in synthetic descriptions', () => {
  for (const proposedValue of ['Synthetic service founded in 2024', 'Synthetic support for ages 12 - 18', 'Synthetic service available 24 hours 7 days']) {
    const value = mutate(claim, (x) => { x.proposed_changes[0] = { field: 'service_description', proposed_value: proposedValue }; });
    assert.equal(validateClaimEnvelope(value), true);
  }
});

for (const [name, value] of [
  ['unknown field', mutate(claim, (x) => { x.metadata = {}; })],
  ['canonical-shaped stable ID', mutate(claim, (x) => { x.listing_context.synthetic_stable_id = 'weh_0123456789abcdef01234567'; })],
  ['unsafe URL scheme', mutate(claim, (x) => { x.proposed_changes[1].proposed_value = 'javascript:alert(1)'; })],
  ['real URL host', mutate(claim, (x) => { x.claimant_evidence[0].locator = 'https://example.com/evidence'; })],
  ['personal narrative', mutate(claim, (x) => { x.claimant_evidence[0].summary = 'My crisis narrative'; })],
  ['automatic verification request', mutate(claim, (x) => { x.safety.ranking_or_verification_requested = true; })],
  ['unsupported status field', mutate(claim, (x) => { x.proposed_changes[0].field = 'verification_status'; })],
  ['duplicate proposed field', mutate(claim, (x) => { x.proposed_changes.push(structuredClone(x.proposed_changes[0])); })],
]) test(`rejects claim ${name}`, () => assert.throws(() => validateClaimEnvelope(value)));

for (const [name, value] of [
  ['self-review by claimant', mutate(review, (x) => { x.reviewer.identity = claim.claimant.identity; })],
  ['review by provider', mutate(review, (x) => { x.reviewer.identity = claim.provider.identity; })],
  ['invalid transition', mutate(review, (x) => { x.transition.from = 'accepted_for_candidate'; })],
  ['unknown evidence', mutate(review, (x) => { x.decision_basis.evidence_ids = ['pev_syn_unknown_0001']; })],
  ['missing conflict', mutate(review, (x) => { x.conflict_declaration.no_conflict = false; })],
  ['direct canonical mutation', mutate(review, (x) => { x.effects.canonical_mutation = true; })],
  ['verification effect', mutate(review, (x) => { x.effects.verified_status = true; })],
  ['ranking effect', mutate(review, (x) => { x.effects.ranking_or_search_effect = true; })],
  ['publication effect', mutate(review, (x) => { x.effects.publication = true; })],
  ['incoherent decision', mutate(review, (x) => { x.decision_basis.decision = 'rejected'; })],
  ['arbitrary metadata', mutate(review, (x) => { x.metadata = {}; })],
]) test(`rejects review ${name}`, () => assert.throws(() => validateReviewDecision(value, claim)));

test('rejects decision-specific uncertainty mismatches', () => {
  const decisions = [
    ['accepted_for_candidate', 'evidence_sufficient_for_candidate', true, 'bounded_uncertainty_remains'],
    ['rejected', 'claim_rejected', false, 'material_uncertainty'],
    ['needs_more_evidence', 'additional_evidence_required', false, 'insufficient_evidence'],
  ];
  for (const [state, reason, candidateEligible, expectedUncertainty] of decisions) {
    for (const uncertainty of ['bounded_uncertainty_remains', 'material_uncertainty', 'insufficient_evidence']) {
      if (uncertainty === expectedUncertainty) continue;
      const value = mutate(review, (x) => { x.transition.to = state; x.decision_basis.decision = state; x.decision_basis.reason_code = reason; x.decision_basis.uncertainty = uncertainty; x.effects.candidate_eligibility_only = candidateEligible; });
      assert.throws(() => validateReviewDecision(value, claim), `${state} must reject ${uncertainty}`);
    }
  }
});

test('rejected and needs-more-evidence decisions are never candidate eligible', () => {
  for (const [state, reason, uncertainty] of [['rejected', 'claim_rejected', 'material_uncertainty'], ['needs_more_evidence', 'additional_evidence_required', 'insufficient_evidence']]) {
    const value = mutate(review, (x) => { x.transition.to = state; x.decision_basis.decision = state; x.decision_basis.reason_code = reason; x.decision_basis.uncertainty = uncertainty; x.effects.candidate_eligibility_only = false; });
    assert.equal(transitionClaim(claim, value).candidate_eligible, false);
  }
});
