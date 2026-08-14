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

test('rejected and needs-more-evidence decisions are never candidate eligible', () => {
  for (const [state, reason, uncertainty] of [['rejected', 'claim_rejected', 'material_uncertainty'], ['needs_more_evidence', 'additional_evidence_required', 'insufficient_evidence']]) {
    const value = mutate(review, (x) => { x.transition.to = state; x.decision_basis.decision = state; x.decision_basis.reason_code = reason; x.decision_basis.uncertainty = uncertainty; x.effects.candidate_eligibility_only = false; });
    assert.equal(transitionClaim(claim, value).candidate_eligible, false);
  }
});
