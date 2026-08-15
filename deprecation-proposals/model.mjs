import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { descriptorFromReleaseBytes } from '../gateway/src/artifacts.mjs';
import { validateClaimEnvelope, validateReviewDecision } from '../provider-claims/model.mjs';
import { validateDispositionAudit, validateWorkQueue } from '../reviewer-work-queue/model.mjs';

const SHA = /^sha256:[0-9a-f]{64}$/;
const ID = /^weh_[0-9a-f]{24}$/;
const SYN_ID = /^syn_weh_[0-9a-f]{24}$/;
const DATE = /^20\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const ASCII_TEXT = /^[A-Za-z0-9_ .,'()&/\-]*$/;
const STRUCTURAL = [
  SHA, ID, SYN_ID, DATE,
  /^(?:dpr|dpe|dpa|dpae|pclm|pev|prv|rwq|rwi|rwa|rwe|drc)_syn_[a-z0-9_]{8,48}$/,
  /^\/(?!\/)[A-Za-z0-9._/-]+$/,
  /^[a-z][a-z0-9_-]{0,63}(?:\/[a-z0-9._/-]+)?$/,
];
const SYNTHETIC_IDENTITY_PATHS = new Set([
  '$.workflow.claimant_identity',
  '$.workflow.provider_identity',
  '$.workflow.assigned_reviewer',
  '$.approval.approver_identity',
]);
const SYNTHETIC_IDENTITY = /^[a-z0-9][a-z0-9._-]*\.invalid$/;
const HOSTNAME = /(?:^|[^A-Za-z0-9_-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?:$|[^A-Za-z0-9_-])/;
const EFFECT_KEYS = ['canonical_mutation', 'verified_status', 'ranking_or_search_effect', 'publication'];
const GENESIS = `sha256:${'0'.repeat(64)}`;
const STATUSES = new Set([
  'verified_web', 'verified_authority', 'verified_knowledge', 'cross_referenced',
  'legacy_unverified', 'disputed', 'deprecated',
]);
const EXPECTED = Object.freeze({
  proposalIds: ['dpr_syn_without_replacement', 'dpr_syn_with_replacement'],
  targetIds: ['weh_6540247c54375be69435801c', 'weh_6f878a831e4c5a6b987b043b'],
  evidenceIds: ['dpe_syn_without_reference', 'dpe_syn_with_reference'],
  eventIds: ['dpae_syn_held_event_01', 'dpae_syn_held_event_02'],
  proposalPins: [
    'sha256:8273c1cdbbb69944e99bda5d74c7b1321205b014ebb3cd1c48aef252c5eb0428',
    'sha256:8425d72e004477daeeaa4d98b179451c85bde966f42a5ce3d88749ece573a9a1',
  ],
  finalHead: 'sha256:db7f138e7469178e6afe38fde352ec9811a755b5ffbfad11b35dfadebb9d1931',
});

const plain = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function exact(value, keys, label) {
  assert.ok(plain(value), `${label} must be a plain object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or prohibited fields`);
}

export function pin(bytes) {
  assert.ok(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'exact bytes are required');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function parseExact(bytes, value, label) {
  assert.deepEqual(JSON.parse(Buffer.from(bytes)), value, `${label} exact-byte mismatch`);
}

function effects(value) {
  exact(value, EFFECT_KEYS, 'effects');
  for (const key of EFFECT_KEYS) assert.equal(value[key], false, `${key} must be false`);
}

function date(value, label) {
  assert.match(value, DATE);
  assert.equal(new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10), value, `invalid ${label}`);
}

function canonicalRecords(bytes) {
  const canonical = JSON.parse(bytes);
  assert.ok(Array.isArray(canonical.countries), 'canonical countries are required');
  return new Map(canonical.countries.flatMap((country) => (
    (country.hotlines ?? []).map((record) => [record.id, record])
  )));
}

export function deriveCanonicalLifecycle(record, label = 'record') {
  assert.ok(STATUSES.has(record.verification_status), `${label} has unknown verification status`);
  const replacedBy = record.replaced_by ?? null;
  assert.ok(replacedBy === null || ID.test(replacedBy), `${label} has invalid replaced_by`);
  assert.ok(replacedBy === null || record.verification_status === 'deprecated', `${label} replaced_by requires deprecated status`);
  return { status: record.verification_status, deprecated: record.verification_status === 'deprecated', replacedBy };
}

export function validateReplacementRecord(record) {
  const state = deriveCanonicalLifecycle(record, 'replacement');
  assert.equal(state.deprecated, false, 'replacement is deprecated');
  assert.notEqual(state.status, 'disputed', 'replacement is disputed');
  assert.equal(state.replacedBy, null, 'replacement has replaced_by');
  return true;
}

function workflowFor(inputs, proposalId) {
  assert.ok(plain(inputs.workflows), 'proposal-specific workflows are required');
  const workflow = inputs.workflows[proposalId];
  assert.ok(workflow, `missing workflow for ${proposalId}`);
  return workflow;
}

function validateCheckpoint(checkpoint, bytes, dispositionAudit) {
  parseExact(bytes, checkpoint, 'review checkpoint');
  exact(checkpoint, [
    'schema', 'checkpoint_id', 'reviewer_identity', 'review_id', 'decision', 'conflict_state',
    'reviewed_on', 'disposition_event_head_sha256', 'authority',
  ], 'review checkpoint');
  assert.equal(checkpoint.schema, 'deprecation-synthetic-review-checkpoint/v1');
  assert.match(checkpoint.checkpoint_id, /^drc_syn_[a-z0-9_]{8,48}$/);
  assert.equal(checkpoint.authority, 'synthetic_review_date_binding_only');
  assert.equal(checkpoint.disposition_event_head_sha256, dispositionAudit.event_head_sha256);
  date(checkpoint.reviewed_on, 'reviewed_on');
}

function validateWorkflow(binding, targetStableId, workflow) {
  const {
    claim, review, queue, dispositionAudit, checkpoint,
    claimBytes, reviewBytes, queueBytes, dispositionAuditBytes, checkpointBytes,
  } = workflow;
  parseExact(claimBytes, claim, 'provider claim');
  parseExact(reviewBytes, review, 'provider review');
  parseExact(queueBytes, queue, 'review queue');
  parseExact(dispositionAuditBytes, dispositionAudit, 'disposition audit');
  validateClaimEnvelope(claim);
  validateReviewDecision(review, claim);
  validateWorkQueue(queue, claim, claimBytes);
  validateDispositionAudit(dispositionAudit, queue, claim, review, queueBytes, claimBytes, reviewBytes);
  validateCheckpoint(checkpoint, checkpointBytes, dispositionAudit);

  assert.equal(claim.listing_context.synthetic_stable_id, `syn_${targetStableId}`, 'claim stable ID is not the deterministic target projection');
  assert.equal(review.decision_basis.decision, 'needs_more_evidence', 'provider lifecycle evidence must remain ineligible');
  assert.deepEqual(claim.proposed_changes, [{
    field: 'service_description',
    proposed_value: targetStableId === EXPECTED.targetIds[0]
      ? 'Untrusted lifecycle evidence requests deprecation without replacement'
      : 'Untrusted lifecycle evidence requests deprecation with replacement',
  }], 'provider claim must carry target-specific untrusted deprecation intent');
  assert.equal(dispositionAudit.terminal_disposition.candidate_eligible, false, 'workflow must never infer candidate eligibility');
  assert.equal(checkpoint.reviewer_identity, review.reviewer.identity);
  assert.equal(checkpoint.review_id, review.review_id);
  assert.equal(checkpoint.decision, review.decision_basis.decision);
  assert.equal(checkpoint.conflict_state, review.conflict_declaration.no_conflict ? 'no_conflict' : 'conflict');

  exact(binding, [
    'claim_id', 'claim_pin', 'claimant_identity', 'provider_identity', 'claim_evidence_ids',
    'queue_id', 'queue_pin', 'queue_item_id', 'assigned_reviewer', 'review_id', 'review_pin',
    'decision', 'conflict_state', 'disposition_audit_id', 'disposition_audit_pin',
    'disposition_event_head_sha256', 'review_checkpoint_id', 'review_checkpoint_pin',
    'reviewed_on', 'lifecycle_evidence_authority',
  ], 'workflow binding');
  const item = queue.items[0];
  assert.deepEqual(binding, {
    claim_id: claim.claim_id,
    claim_pin: pin(claimBytes),
    claimant_identity: claim.claimant.identity,
    provider_identity: claim.provider.identity,
    claim_evidence_ids: claim.claimant_evidence.map((entry) => entry.evidence_id),
    queue_id: queue.queue_id,
    queue_pin: pin(queueBytes),
    queue_item_id: item.item_id,
    assigned_reviewer: item.assigned_reviewer,
    review_id: review.review_id,
    review_pin: pin(reviewBytes),
    decision: review.decision_basis.decision,
    conflict_state: review.conflict_declaration.no_conflict ? 'no_conflict' : 'conflict',
    disposition_audit_id: dispositionAudit.audit_id,
    disposition_audit_pin: pin(dispositionAuditBytes),
    disposition_event_head_sha256: dispositionAudit.event_head_sha256,
    review_checkpoint_id: checkpoint.checkpoint_id,
    review_checkpoint_pin: pin(checkpointBytes),
    reviewed_on: checkpoint.reviewed_on,
    lifecycle_evidence_authority: 'untrusted_evidence_only_not_deprecation_authority',
  }, 'workflow binding must identify the validated proposal-specific artifacts exactly');
  return { workflow, reviewedOn: checkpoint.reviewed_on };
}

function validateRelease(target, inputs) {
  const { canonicalBytes, releaseBytes, indexBytes, recordsBytes } = inputs;
  const release = JSON.parse(releaseBytes);
  const index = JSON.parse(indexBytes);
  const recordsArtifact = index.artifacts.find((entry) => entry.path === '/api/v1/records.json');
  descriptorFromReleaseBytes(releaseBytes, indexBytes);
  assert.equal(release.dataset_version, pin(canonicalBytes), 'release dataset_version is not the canonical digest');
  assert.equal(release.artifact_index.path, '/release/v1/artifacts.json');
  assert.equal(release.artifact_index.sha256, pin(indexBytes), 'release artifact-index digest mismatch');
  assert.deepEqual(release.relationships['/api/v1/records.json'], recordsArtifact, 'records relationship mismatch');
  assert.equal(recordsArtifact.sha256, pin(recordsBytes), 'records bytes do not match the assessed index');
  assert.equal(recordsArtifact.bytes, recordsBytes.length, 'records byte count mismatch');

  exact(target, [
    'stable_id', 'canonical_sha256', 'assessed_release_sha256', 'release_id', 'dataset_version',
    'artifact_index_path', 'artifact_index_sha256', 'records_artifact', 'canonical_status',
  ], 'target');
  assert.match(target.stable_id, ID);
  assert.equal(target.canonical_sha256, pin(canonicalBytes));
  assert.equal(target.assessed_release_sha256, pin(releaseBytes));
  assert.equal(target.release_id, release.release_id);
  assert.equal(target.dataset_version, release.dataset_version);
  assert.equal(target.artifact_index_path, release.artifact_index.path);
  assert.equal(target.artifact_index_sha256, pin(indexBytes));
  assert.deepEqual(target.records_artifact, recordsArtifact);

  const canonical = canonicalRecords(canonicalBytes);
  const canonicalRecord = canonical.get(target.stable_id);
  assert.ok(canonicalRecord, 'unknown canonical stable ID');
  const state = deriveCanonicalLifecycle(canonicalRecord, 'target');
  assert.equal(target.canonical_status, state.status, 'target status was not derived from canonical bytes');

  const records = JSON.parse(recordsBytes);
  assert.equal(records.dataset_version, release.dataset_version, 'records dataset version mismatch');
  const indexed = records.records?.[target.stable_id];
  assert.ok(indexed, 'target missing from assessed records artifact');
  assert.equal(indexed.id, canonicalRecord.id, 'indexed target ID differs from canonical');
  assert.equal(indexed.verification_status, canonicalRecord.verification_status, 'indexed target status differs from canonical');
  assert.equal(indexed.replaced_by ?? null, canonicalRecord.replaced_by ?? null, 'indexed target replaced_by differs from canonical');
  return canonical;
}

export function validateExportLeakage(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateExportLeakage(item, `${path}[${index}]`));
    return true;
  }
  if (plain(value)) {
    for (const [key, child] of Object.entries(value)) validateExportLeakage(child, `${path}.${key}`);
    return true;
  }
  if (typeof value !== 'string') return true;
  const normalized = value.normalize('NFKC');
  if (SYNTHETIC_IDENTITY_PATHS.has(path) && SYNTHETIC_IDENTITY.test(normalized)) return true;
  if (STRUCTURAL.some((pattern) => pattern.test(normalized))) return true;
  assert.ok(normalized.length <= 240, `unbounded exported text at ${path}`);
  assert.match(normalized, ASCII_TEXT, `exported free-text is outside the ASCII closed grammar at ${path}`);
  assert.doesNotMatch(normalized, /(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:/, `URI scheme leaked at ${path}`);
  assert.doesNotMatch(normalized, /\/\/[A-Za-z0-9]/, `protocol-relative locator leaked at ${path}`);
  assert.doesNotMatch(normalized, /(?:^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:$|[^A-Za-z0-9.-])/, `email leaked at ${path}`);
  assert.doesNotMatch(normalized, /@/, `contact form leaked at ${path}`);
  assert.doesNotMatch(normalized, HOSTNAME, `hostname leaked at ${path}`);
  const runs = normalized.match(/[\p{Decimal_Number}][\p{Decimal_Number}(). /-]*[\p{Decimal_Number}]/gu) ?? [];
  assert.equal(runs.some((run) => (run.match(/\p{Decimal_Number}/gu) ?? []).length >= 7), false, `phone-like sequence leaked at ${path}`);
  return true;
}

export function validateProposal(proposal, inputs) {
  exact(proposal, [
    'schema', 'proposal_id', 'kind', 'state', 'target', 'intent', 'evidence', 'workflow',
    'reviewed_on', 'approval', 'uncertainty', 'effects',
  ], 'proposal');
  validateExportLeakage(proposal);
  const canonical = validateRelease(proposal.target, inputs);
  const workflow = workflowFor(inputs, proposal.proposal_id);
  const validated = validateWorkflow(proposal.workflow, proposal.target.stable_id, workflow);
  assert.equal(proposal.schema, 'deprecation-replacement-proposal/v1');
  assert.match(proposal.proposal_id, /^dpr_syn_[a-z0-9_]{8,48}$/);
  assert.equal(proposal.kind, 'deprecation');
  assert.equal(proposal.state, 'held_pending_independent_approval');

  exact(proposal.intent, ['transition', 'effective_date', 'replacement_stable_id'], 'intent');
  assert.deepEqual(proposal.intent.transition, { from: proposal.target.canonical_status, to: 'deprecated' });
  assert.notEqual(proposal.target.canonical_status, 'deprecated', 'already-deprecated records cannot be proposed');
  assert.equal(proposal.reviewed_on, validated.reviewedOn, 'reviewed_on must come from the pinned checkpoint');
  date(proposal.intent.effective_date, 'effective date');
  assert.ok(proposal.intent.effective_date > proposal.reviewed_on, 'effective date must follow reviewed_on');
  const replacement = proposal.intent.replacement_stable_id;
  assert.ok(replacement === null || ID.test(replacement));
  if (replacement) {
    assert.notEqual(replacement, proposal.target.stable_id, 'replacement cannot self-reference');
    const replacementRecord = canonical.get(replacement);
    assert.ok(replacementRecord, 'unknown replacement stable ID');
    validateReplacementRecord(replacementRecord);
  }

  assert.ok(Array.isArray(proposal.evidence) && proposal.evidence.length > 0 && proposal.evidence.length <= 5);
  const evidenceIds = new Set();
  for (const evidence of proposal.evidence) {
    exact(evidence, ['evidence_id', 'claim_evidence_id', 'classification', 'kind', 'locator_sha256', 'summary'], 'evidence');
    assert.match(evidence.evidence_id, /^dpe_syn_[a-z0-9_]{8,48}$/);
    assert.ok(!evidenceIds.has(evidence.evidence_id), 'duplicate proposal evidence ID');
    evidenceIds.add(evidence.evidence_id);
    const claimantEvidence = workflow.claim.claimant_evidence.find((entry) => entry.evidence_id === evidence.claim_evidence_id);
    assert.ok(claimantEvidence, 'evidence is not bound to the proposal-specific provider claim');
    assert.equal(evidence.classification, 'untrusted_claimant_evidence_reference');
    assert.equal(evidence.kind, 'claimant_document_reference');
    assert.equal(evidence.locator_sha256, pin(Buffer.from(claimantEvidence.locator)), 'locator hash is not derived from exact locator bytes');
  }

  exact(proposal.approval, ['required', 'status', 'approver_identity', 'candidate_eligible'], 'approval');
  assert.equal(proposal.approval.required, true);
  assert.equal(proposal.approval.status, 'not_requested');
  assert.equal(proposal.approval.approver_identity, null);
  assert.equal(proposal.approval.candidate_eligible, false);
  assert.equal(proposal.uncertainty, 'material_uncertainty');
  effects(proposal.effects);
  return true;
}

function committed(event) {
  return {
    event_id: event.event_id,
    sequence: event.sequence,
    proposal_id: event.proposal_id,
    action: event.action,
    workflow_disposition_head_sha256: event.workflow_disposition_head_sha256,
    previous_event_sha256: event.previous_event_sha256,
  };
}

export function validateAuditExport(audit, proposals, proposalBytes, inputs) {
  validateExportLeakage(audit);
  assert.equal(proposals.length, 2, 'closed v1 fixture requires exactly two proposals');
  assert.equal(proposalBytes.length, 2, 'closed v1 fixture requires exactly two proposal byte sets');
  const keyed = { proposals: new Set(), targets: new Set(), evidence: new Set() };
  const workflowKeys = {
    claims: new Set(), listings: new Set(), claimEvidence: new Set(), claimants: new Set(),
    providers: new Set(), reviewers: new Set(), queues: new Set(), reviews: new Set(), dispositions: new Set(),
  };
  proposals.forEach((proposal, index) => {
    parseExact(proposalBytes[index], proposal, 'proposal');
    assert.ok(!keyed.proposals.has(proposal.proposal_id), 'duplicate proposal ID');
    assert.ok(!keyed.targets.has(proposal.target.stable_id), 'duplicate target stable ID');
    keyed.proposals.add(proposal.proposal_id);
    keyed.targets.add(proposal.target.stable_id);
    for (const evidence of proposal.evidence) {
      assert.ok(!keyed.evidence.has(evidence.evidence_id), 'duplicate evidence ID across export');
      keyed.evidence.add(evidence.evidence_id);
    }
    const workflow = workflowFor(inputs, proposal.proposal_id);
    for (const [setName, value] of [
      ['claims', workflow.claim.claim_id], ['listings', workflow.claim.listing_context.synthetic_listing_id],
      ['claimEvidence', workflow.claim.claimant_evidence[0].evidence_id], ['claimants', workflow.claim.claimant.identity],
      ['providers', workflow.claim.provider.identity], ['reviewers', workflow.review.reviewer.identity],
      ['queues', workflow.queue.queue_id], ['reviews', workflow.review.review_id],
      ['dispositions', workflow.dispositionAudit.audit_id],
    ]) {
      assert.ok(!workflowKeys[setName].has(value), `duplicate proposal workflow ${setName}`);
      workflowKeys[setName].add(value);
    }
    validateProposal(proposal, inputs);
  });
  assert.deepEqual(proposals.map((p) => p.proposal_id), EXPECTED.proposalIds, 'closed fixture proposal IDs are incomplete or reordered');
  assert.deepEqual(proposals.map((p) => p.target.stable_id), EXPECTED.targetIds, 'closed fixture target IDs are incomplete or reordered');
  assert.deepEqual(proposals.flatMap((p) => p.evidence.map((e) => e.evidence_id)), EXPECTED.evidenceIds, 'closed fixture evidence IDs are incomplete or reordered');
  assert.deepEqual(proposalBytes.map(pin), EXPECTED.proposalPins, 'closed fixture proposal byte pins differ');

  exact(audit, [
    'schema', 'export_id', 'closed', 'expected_proposal_count', 'expected_event_count',
    'canonical_sha256', 'assessed_release_sha256', 'release_id', 'artifact_index_sha256',
    'proposals', 'events', 'event_head_sha256', 'redactions', 'effects',
  ], 'audit export');
  assert.equal(audit.schema, 'deprecation-proposal-audit-export/v1');
  assert.match(audit.export_id, /^dpa_syn_[a-z0-9_]{8,48}$/);
  assert.equal(audit.closed, true);
  assert.equal(audit.expected_proposal_count, 2);
  assert.equal(audit.expected_event_count, 2);
  assert.equal(audit.canonical_sha256, pin(inputs.canonicalBytes));
  assert.equal(audit.assessed_release_sha256, pin(inputs.releaseBytes));
  assert.equal(audit.release_id, JSON.parse(inputs.releaseBytes).release_id);
  assert.equal(audit.artifact_index_sha256, pin(inputs.indexBytes));
  assert.deepEqual(audit.proposals, proposals.map((proposal, index) => ({
    proposal_id: proposal.proposal_id,
    proposal_sha256: pin(proposalBytes[index]),
    stable_id: proposal.target.stable_id,
    replacement_stable_id: proposal.intent.replacement_stable_id,
    state: proposal.state,
    approval_status: proposal.approval.status,
  })), 'proposal summary or pin drift');

  assert.equal(audit.events.length, 2, 'closed v1 fixture requires exactly two events');
  const eventIds = new Set();
  let previous = GENESIS;
  audit.events.forEach((event, index) => {
    exact(event, [
      'event_id', 'sequence', 'proposal_id', 'action', 'workflow_disposition_head_sha256',
      'previous_event_sha256', 'event_sha256',
    ], 'event');
    assert.ok(!eventIds.has(event.event_id), 'duplicate audit event ID');
    eventIds.add(event.event_id);
    assert.equal(event.event_id, EXPECTED.eventIds[index], 'closed fixture event ID mismatch');
    assert.equal(event.sequence, index + 1);
    assert.equal(event.proposal_id, proposals[index].proposal_id);
    assert.equal(event.action, 'held_for_independent_approval');
    assert.equal(event.workflow_disposition_head_sha256, workflowFor(inputs, proposals[index].proposal_id).dispositionAudit.event_head_sha256);
    assert.equal(event.previous_event_sha256, previous, 'broken event chain');
    assert.equal(event.event_sha256, pin(Buffer.from(JSON.stringify(committed(event)))), 'audit event hash mismatch');
    previous = event.event_sha256;
  });
  assert.equal(audit.event_head_sha256, previous, 'closed fixture final head mismatch');
  assert.equal(audit.event_head_sha256, EXPECTED.finalHead, 'closed fixture does not match its pinned final head');
  exact(audit.redactions, ['phone_or_contact_values', 'source_locator_values'], 'redactions');
  assert.equal(audit.redactions.phone_or_contact_values, 'excluded');
  assert.equal(audit.redactions.source_locator_values, 'excluded');
  effects(audit.effects);
  return true;
}

export function deriveAuditSummary(audit, proposals, proposalBytes, inputs) {
  validateAuditExport(audit, proposals, proposalBytes, inputs);
  return Object.freeze({
    schema: 'deprecation-proposal-audit-summary/v1',
    proposal_count: 2,
    event_count: 2,
    closed: true,
    event_head_sha256: audit.event_head_sha256,
    approval_status: 'not_requested',
    candidate_eligible: false,
    canonical_mutation: false,
    publication: false,
  });
}
