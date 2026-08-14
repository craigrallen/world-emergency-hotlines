import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { transitionClaim, validateClaimEnvelope, validateReviewDecision } from '../provider-claims/model.mjs';

const IDS = { queue: /^rwq_syn_[a-z0-9_]{8,48}$/, item: /^rwi_syn_[a-z0-9_]{8,48}$/, audit: /^rwa_syn_[a-z0-9_]{8,48}$/, event: /^rwe_syn_[a-z0-9_]{8,48}$/ };
const SYNTHETIC = /^[a-z0-9][a-z0-9._-]*\.invalid$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const EFFECT_KEYS = ['canonical_mutation', 'verified_status', 'ranking_or_search_effect', 'publication'];
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function exact(v, keys, label) { assert.ok(plain(v), `${label} must be a plain object`); assert.deepEqual(Object.keys(v).sort(), [...keys].sort(), `${label} has missing or prohibited fields`); }
function effects(v) { exact(v, EFFECT_KEYS, 'effects'); for (const key of EFFECT_KEYS) assert.equal(v[key], false, `${key} must be false`); }
function identity(v, label) { assert.equal(typeof v, 'string'); assert.match(v, SYNTHETIC, `${label} must be synthetic .invalid`); }
function pin(bytes) { assert.ok(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'pinned document must be exact bytes'); return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function encodedBy(bytes, value, label) { assert.deepEqual(JSON.parse(Buffer.from(bytes).toString('utf8')), value, `${label} object must be encoded by its exact pinned bytes`); }
const GENESIS_EVENT_SHA256 = `sha256:${'0'.repeat(64)}`;
function eventPin(event) {
  const committed = {
    event_id: event.event_id, sequence: event.sequence, item_id: event.item_id, claim_id: event.claim_id,
    actor: event.actor, action: event.action, from: event.from, to: event.to,
    previous_event_sha256: event.previous_event_sha256,
  };
  return pin(Buffer.from(JSON.stringify(committed)));
}

export function validateWorkQueue(queue, claim, claimBytes) {
  validateClaimEnvelope(claim);
  encodedBy(claimBytes, claim, 'claim');
  exact(queue, ['schema', 'queue_id', 'queueing_actor', 'ordering', 'items', 'effects'], 'queue'); assert.equal(queue.schema, 'reviewer-work-queue/v1'); assert.match(queue.queue_id, IDS.queue); identity(queue.queueing_actor, 'queueing actor'); assert.notEqual(queue.queueing_actor, claim.claimant.identity, 'claimant cannot queue'); assert.notEqual(queue.queueing_actor, claim.provider.identity, 'provider cannot queue');
  exact(queue.ordering, ['method', 'meaning'], 'ordering'); assert.equal(queue.ordering.method, 'administrative_sequence'); assert.equal(queue.ordering.meaning, 'explicit_non_priority_non_ranking_order');
  assert.ok(Array.isArray(queue.items) && queue.items.length === 1, 'v1 queue must contain exactly one item');
  const itemIds = new Set(); const claimIds = new Set();
  queue.items.forEach((item, index) => {
    exact(item, ['item_id', 'administrative_sequence', 'claim_id', 'claim_pin', 'assigned_reviewer', 'state'], 'queue item'); assert.match(item.item_id, IDS.item); assert.ok(!itemIds.has(item.item_id), 'duplicate queue item ID'); itemIds.add(item.item_id);
    assert.equal(item.administrative_sequence, index + 1, 'administrative sequence must be explicit, contiguous, and array ordered'); assert.equal(item.claim_id, claim.claim_id, 'queue item claim substitution'); assert.ok(!claimIds.has(item.claim_id), 'duplicate queue claim ID'); claimIds.add(item.claim_id);
    assert.match(item.claim_pin, SHA); assert.equal(item.claim_pin, pin(claimBytes), 'claim content pin mismatch'); identity(item.assigned_reviewer, 'assigned reviewer'); assert.notEqual(item.assigned_reviewer, claim.claimant.identity, 'claimant cannot be assigned'); assert.notEqual(item.assigned_reviewer, claim.provider.identity, 'provider cannot be assigned'); assert.notEqual(item.assigned_reviewer, queue.queueing_actor, 'queueing actor cannot be assigned'); assert.ok(['queued', 'assigned', 'disposed'].includes(item.state), 'invalid queue state');
  }); effects(queue.effects); return true;
}

export function validateDispositionAudit(audit, queue, claim, review, queueBytes, claimBytes, reviewBytes) {
  validateWorkQueue(queue, claim, claimBytes); validateReviewDecision(review, claim);
  encodedBy(queueBytes, queue, 'queue'); encodedBy(reviewBytes, review, 'review');
  exact(audit, ['schema', 'audit_id', 'queue_id', 'queue_pin', 'append_only', 'events', 'event_head_sha256', 'terminal_disposition', 'effects'], 'audit'); assert.equal(audit.schema, 'reviewer-disposition-audit/v1'); assert.match(audit.audit_id, IDS.audit); assert.equal(audit.queue_id, queue.queue_id); assert.match(audit.queue_pin, SHA); assert.equal(audit.queue_pin, pin(queueBytes), 'queue content pin mismatch'); assert.equal(audit.append_only, true);
  assert.ok(Array.isArray(audit.events) && audit.events.length === 3, 'v1 audit must contain exactly three events');
  const eventIds = new Set(); const expected = [['queued', 'not_queued', 'queued'], ['assigned', 'queued', 'assigned'], ['disposed', 'assigned', 'disposed']];
  audit.events.forEach((event, index) => {
    exact(event, ['event_id', 'sequence', 'item_id', 'claim_id', 'actor', 'action', 'from', 'to', 'previous_event_sha256', 'event_sha256'], 'audit event'); assert.match(event.event_id, IDS.event); assert.ok(!eventIds.has(event.event_id), 'duplicate event ID'); eventIds.add(event.event_id); assert.equal(event.sequence, index + 1, 'audit sequence reordered, skipped, or duplicated');
    const item = queue.items[0]; const phase = expected[index]; assert.equal(event.item_id, item.item_id, 'cross-item event substitution'); assert.equal(event.claim_id, item.claim_id, 'cross-claim event substitution'); identity(event.actor, 'event actor'); assert.deepEqual([event.action, event.from, event.to], phase, 'invalid audit transition');
    assert.match(event.previous_event_sha256, SHA); assert.equal(event.previous_event_sha256, index === 0 ? GENESIS_EVENT_SHA256 : audit.events[index - 1].event_sha256, 'broken audit event history link'); assert.match(event.event_sha256, SHA); assert.equal(event.event_sha256, eventPin(event), 'audit event content hash mismatch');
    if (event.action === 'queued') assert.equal(event.actor, queue.queueing_actor, 'queueing actor identity substitution');
    else assert.equal(event.actor, item.assigned_reviewer, 'assignment identity substitution');
  });
  assert.match(audit.event_head_sha256, SHA); assert.equal(audit.event_head_sha256, audit.events[2].event_sha256, 'audit event head mismatch');
  const terminal = audit.terminal_disposition; exact(terminal, ['item_id', 'claim_id', 'review_id', 'review_pin', 'decision', 'candidate_eligible'], 'terminal disposition'); const item = queue.items[0]; assert.equal(item.state, 'disposed', 'full audit requires disposed queue state'); assert.equal(terminal.item_id, item.item_id); assert.equal(terminal.claim_id, item.claim_id); assert.equal(terminal.review_id, review.review_id); assert.match(terminal.review_pin, SHA); assert.equal(terminal.review_pin, pin(reviewBytes), 'review content pin mismatch'); assert.equal(item.assigned_reviewer, review.reviewer.identity, 'queue reviewer does not match provider review reviewer identity');
  const result = transitionClaim(claim, review); assert.equal(terminal.decision, review.decision_basis.decision, 'terminal decision mismatch'); assert.equal(terminal.candidate_eligible, result.candidate_eligible, 'terminal eligibility mismatch'); if (terminal.decision !== 'accepted_for_candidate') assert.equal(terminal.candidate_eligible, false, 'non-accepted decisions cannot be eligible'); effects(audit.effects);
  return true;
}

export function deriveDispositionSummary(audit, queue, claim, review, queueBytes, claimBytes, reviewBytes) {
  validateDispositionAudit(audit, queue, claim, review, queueBytes, claimBytes, reviewBytes);
  return Object.freeze({ schema: 'reviewer-disposition-summary/v1', queue_id: queue.queue_id, audit_id: audit.audit_id, item_count: queue.items.length, terminal_decision: audit.terminal_disposition.decision, candidate_eligible: audit.terminal_disposition.candidate_eligible, canonical_mutation: false, verified_status: false, ranking_or_search_effect: false, publication: false });
}
