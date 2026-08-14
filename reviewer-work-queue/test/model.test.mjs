import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deriveDispositionSummary, validateDispositionAudit, validateWorkQueue } from '../model.mjs';

const repo = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(repo, path));
const claimBytes = read('provider-claims/contracts/v1/claim.synthetic.json');
const reviewBytes = read('provider-claims/contracts/v1/review.synthetic.json');
const claim = JSON.parse(claimBytes); const review = JSON.parse(reviewBytes);
const queueBytes = read('reviewer-work-queue/contracts/v1/queue.synthetic.json');
const queue = JSON.parse(queueBytes);
const audit = JSON.parse(read('reviewer-work-queue/contracts/v1/disposition-audit.synthetic.json'));
const mutate = (value, fn) => { const copy = structuredClone(value); fn(copy); return copy; };
const pin = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const eventPin = (event) => pin(Buffer.from(JSON.stringify({ event_id: event.event_id, sequence: event.sequence, item_id: event.item_id, claim_id: event.claim_id, actor: event.actor, action: event.action, from: event.from, to: event.to, previous_event_sha256: event.previous_event_sha256 })));
const rechain = (value) => { let previous = `sha256:${'0'.repeat(64)}`; for (const event of value.events) { event.previous_event_sha256 = previous; event.event_sha256 = eventPin(event); previous = event.event_sha256; } value.event_head_sha256 = previous; };

test('validates pinned queue/audit and derives deterministic non-effect summary', () => {
  assert.equal(validateWorkQueue(queue, claim, claimBytes), true);
  assert.equal(validateDispositionAudit(audit, queue, claim, review, queueBytes, claimBytes, reviewBytes), true);
  const first = deriveDispositionSummary(audit, queue, claim, review, queueBytes, claimBytes, reviewBytes);
  assert.deepEqual(first, deriveDispositionSummary(audit, queue, claim, review, queueBytes, claimBytes, reviewBytes));
  assert.deepEqual(Object.keys(first), ['schema', 'queue_id', 'audit_id', 'item_count', 'terminal_decision', 'candidate_eligible', 'canonical_mutation', 'verified_status', 'ranking_or_search_effect', 'publication']);
});

const tamperedClaim = mutate(claim, (x) => { x.claim_id = 'pclm_syn_tampered_0001'; });
for (const [name, value, bytes, pattern] of [
  ['claim bytes tampering', claim, Buffer.concat([claimBytes, Buffer.from(' ')]), /claim content pin mismatch/],
  ['claim document tampering', tamperedClaim, jsonBytes(tamperedClaim), /queue item claim substitution/],
]) test(`rejects ${name}`, () => assert.throws(() => validateWorkQueue(queue, value, bytes), pattern));

test('rejects claim object/byte mismatch through queue and audit validation', () => {
  const changedClaim = mutate(claim, (x) => { x.proposed_changes[0].proposed_value = 'Different Synthetic Example Service'; });
  const mismatch = /claim object must be encoded by its exact pinned bytes/;
  assert.throws(() => validateWorkQueue(queue, changedClaim, claimBytes), mismatch);
  assert.throws(() => validateDispositionAudit(audit, queue, changedClaim, review, queueBytes, claimBytes, reviewBytes), mismatch);
});

for (const [name, value] of [
  ['arbitrary metadata', mutate(queue, (x) => { x.metadata = {}; })],
  ['priority field', mutate(queue, (x) => { x.items[0].priority = 'high'; })],
  ['risk score field', mutate(queue, (x) => { x.items[0].risk_score = 1; })],
  ['ranking field', mutate(queue, (x) => { x.items[0].ranking = 1; })],
  ['canonical-shaped item ID', mutate(queue, (x) => { x.items[0].item_id = 'weh_0123456789abcdef01234567'; })],
  ['claimant queueing actor', mutate(queue, (x) => { x.queueing_actor = claim.claimant.identity; })],
  ['provider queueing actor', mutate(queue, (x) => { x.queueing_actor = claim.provider.identity; })],
  ['assigned-reviewer queueing actor', mutate(queue, (x) => { x.queueing_actor = x.items[0].assigned_reviewer; })],
  ['claimant assignment', mutate(queue, (x) => { x.items[0].assigned_reviewer = claim.claimant.identity; })],
  ['provider assignment', mutate(queue, (x) => { x.items[0].assigned_reviewer = claim.provider.identity; })],
  ['canonical effect', mutate(queue, (x) => { x.effects.canonical_mutation = true; })],
  ['non-administrative ordering', mutate(queue, (x) => { x.ordering.method = 'priority'; })],
  ['second v1 item', mutate(queue, (x) => { x.items.push({ ...x.items[0], item_id: 'rwi_syn_example_0002', administrative_sequence: 2 }); })],
]) test(`rejects queue ${name}`, () => assert.throws(() => validateWorkQueue(value, claim, claimBytes)));

for (const [name, value, changedReview, changedReviewBytes] of [
  ['review byte tampering', audit, review, Buffer.concat([reviewBytes, Buffer.from(' ')])],
  ['cross-claim substitution', mutate(audit, (x) => { x.events[1].claim_id = 'pclm_syn_other_0001'; }), review, reviewBytes],
  ['reviewer identity substitution', mutate(audit, (x) => { x.events[1].actor = 'other-reviewer.example.invalid'; }), review, reviewBytes],
  ['reordered audit history', mutate(audit, (x) => { [x.events[0], x.events[1]] = [x.events[1], x.events[0]]; }), review, reviewBytes],
  ['missing event', mutate(audit, (x) => { x.events.splice(1, 1); }), review, reviewBytes],
  ['duplicate event ID', mutate(audit, (x) => { x.events[1].event_id = x.events[0].event_id; }), review, reviewBytes],
  ['skipped sequence', mutate(audit, (x) => { x.events[1].sequence = 3; }), review, reviewBytes],
  ['invalid transition', mutate(audit, (x) => { x.events[1].to = 'disposed'; }), review, reviewBytes],
  ['decision mismatch', mutate(audit, (x) => { x.terminal_disposition.decision = 'rejected'; }), review, reviewBytes],
  ['eligibility mismatch', mutate(audit, (x) => { x.terminal_disposition.candidate_eligible = false; }), review, reviewBytes],
  ['canonical event ID', mutate(audit, (x) => { x.events[0].event_id = 'weh_0123456789abcdef01234567'; }), review, reviewBytes],
  ['event priority field', mutate(audit, (x) => { x.events[0].priority = 1; }), review, reviewBytes],
  ['audit publication effect', mutate(audit, (x) => { x.effects.publication = true; }), review, reviewBytes],
  ['non-disposed full-audit queue', audit, review, reviewBytes],
]) test(`rejects audit ${name}`, () => {
  const selectedQueue = name === 'non-disposed full-audit queue' ? mutate(queue, (x) => { x.items[0].state = 'assigned'; }) : queue;
  const selectedQueueBytes = name === 'non-disposed full-audit queue' ? jsonBytes(selectedQueue) : queueBytes;
  const selectedAudit = name === 'non-disposed full-audit queue' ? mutate(value, (x) => { x.queue_pin = pin(selectedQueueBytes); }) : value;
  assert.throws(() => validateDispositionAudit(selectedAudit, selectedQueue, claim, changedReview, selectedQueueBytes, claimBytes, changedReviewBytes));
});

test('rejects provider review reviewer identity substitution even with exact recomputed review bytes and pin', () => {
  const changedReview = mutate(review, (x) => { x.reviewer.identity = 'reviewer-substitute.example.invalid'; });
  const changedReviewBytes = jsonBytes(changedReview); const changedAudit = mutate(audit, (x) => { x.terminal_disposition.review_pin = pin(changedReviewBytes); });
  assert.throws(() => validateDispositionAudit(changedAudit, queue, claim, changedReview, queueBytes, claimBytes, changedReviewBytes), /queue reviewer does not match provider review reviewer identity/);
});

test('rejects coherent queue and event-actor substitution despite recomputed queue pin and event chain', () => {
  const changedQueue = mutate(queue, (x) => { x.items[0].assigned_reviewer = 'reviewer-substitute.example.invalid'; }); const changedQueueBytes = jsonBytes(changedQueue);
  const changedAudit = mutate(audit, (x) => { x.queue_pin = pin(changedQueueBytes); x.events[1].actor = changedQueue.items[0].assigned_reviewer; x.events[2].actor = changedQueue.items[0].assigned_reviewer; rechain(x); });
  assert.throws(() => validateDispositionAudit(changedAudit, changedQueue, claim, review, changedQueueBytes, claimBytes, reviewBytes), /queue reviewer does not match provider review reviewer identity/);
});

test('rejects queued actor substitution despite a fully recomputed event chain and head', () => {
  const changedAudit = mutate(audit, (x) => { x.events[0].actor = 'alternate-queue-system.example.invalid'; rechain(x); });
  assert.throws(() => validateDispositionAudit(changedAudit, queue, claim, review, queueBytes, claimBytes, reviewBytes), /queueing actor identity substitution/);
});

test('rejects historical event-prefix rewriting through the committed successor link', () => {
  const changedAudit = mutate(audit, (x) => { x.events[0].event_id = 'rwe_syn_alternate_0001'; x.events[0].event_sha256 = eventPin(x.events[0]); });
  assert.throws(() => validateDispositionAudit(changedAudit, queue, claim, review, queueBytes, claimBytes, reviewBytes), /broken audit event history link/);
});

for (const [label, field, text] of [
  ['phone-like bounded text', 'reason', 'Synthetic contact 555-123-4567'],
  ['contact-like bounded text', 'reason', 'My crisis narrative'],
]) test(`inherits provider-claim rejection of ${label}`, () => {
  const changed = mutate(review, (x) => { x.decision_basis[field] = text; });
  assert.throws(() => validateDispositionAudit(audit, queue, claim, changed, queueBytes, claimBytes, Buffer.from(JSON.stringify(changed))));
});

test('rejected and needs-more-evidence dispositions never become eligible', () => {
  for (const [decision, reason_code, uncertainty] of [['rejected', 'claim_rejected', 'material_uncertainty'], ['needs_more_evidence', 'additional_evidence_required', 'insufficient_evidence']]) {
    const changedReview = mutate(review, (x) => { x.transition.to = decision; x.decision_basis.decision = decision; x.decision_basis.reason_code = reason_code; x.decision_basis.uncertainty = uncertainty; x.effects.candidate_eligibility_only = false; });
    const bytes = Buffer.from(`${JSON.stringify(changedReview, null, 2)}\n`);
    const changedAudit = structuredClone(audit);
    changedAudit.terminal_disposition.review_pin = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    changedAudit.terminal_disposition.decision = decision; changedAudit.terminal_disposition.candidate_eligible = false;
    assert.equal(validateDispositionAudit(changedAudit, queue, claim, changedReview, queueBytes, claimBytes, bytes), true);
  }
});
