import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  deriveCanonicalLifecycle, validateAuditExport, validateExportLeakage, validateProposal,
  validateReplacementRecord,
} from '../model.mjs';

const repo = resolve(import.meta.dirname, '../..');
const root = resolve(repo, 'deprecation-proposals/contracts/v1');
const read = (path) => readFileSync(resolve(repo, path));
const pin = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const encode = (value) => Buffer.from(JSON.stringify(value));
const clone = (value) => structuredClone(value);

function workflow(directory) {
  const result = {};
  for (const [key, name] of [
    ['claim', 'claim.synthetic.json'], ['review', 'review.synthetic.json'],
    ['queue', 'queue.synthetic.json'], ['dispositionAudit', 'disposition-audit.synthetic.json'],
    ['checkpoint', 'review-checkpoint.synthetic.json'],
  ]) {
    result[`${key}Bytes`] = read(`deprecation-proposals/fixtures/${directory}/${name}`);
    result[key] = JSON.parse(result[`${key}Bytes`]);
  }
  return result;
}

const proposalBytes = ['proposal-without-replacement.synthetic.json', 'proposal-with-replacement.synthetic.json']
  .map((name) => readFileSync(resolve(root, name)));
const proposals = proposalBytes.map((bytes) => JSON.parse(bytes));
const audit = JSON.parse(readFileSync(resolve(root, 'audit-export.synthetic.json')));
const inputs = {
  canonicalBytes: read('hotlines.json'),
  releaseBytes: read('assurance-packs/fixtures/assessed-release.synthetic.json'),
  indexBytes: read('assurance-packs/fixtures/assessed-artifacts.synthetic.json'),
  recordsBytes: read('web/public/api/v1/records.json'),
  workflows: {
    dpr_syn_without_replacement: workflow('without-replacement'),
    dpr_syn_with_replacement: workflow('with-replacement'),
  },
};

function recomputeAudit(changedAudit) {
  let previous = `sha256:${'0'.repeat(64)}`;
  changedAudit.events.forEach((event, index) => {
    event.sequence = index + 1;
    event.previous_event_sha256 = previous;
    const committed = {
      event_id: event.event_id, sequence: event.sequence, proposal_id: event.proposal_id,
      action: event.action, workflow_disposition_head_sha256: event.workflow_disposition_head_sha256,
      previous_event_sha256: event.previous_event_sha256,
    };
    event.event_sha256 = pin(Buffer.from(JSON.stringify(committed)));
    previous = event.event_sha256;
  });
  changedAudit.event_head_sha256 = previous;
}

test('validates two distinct exact-byte workflows and the complete closed export', () => {
  proposals.forEach((proposal) => assert.equal(validateProposal(proposal, inputs), true));
  assert.equal(validateAuditExport(audit, proposals, proposalBytes, inputs), true);
  assert.notEqual(proposals[0].workflow.claim_id, proposals[1].workflow.claim_id);
  assert.notEqual(proposals[0].workflow.assigned_reviewer, proposals[1].workflow.assigned_reviewer);
});

test('derives deprecated only from exact status and enforces replaced_by consistency', () => {
  for (const status of ['verified_web', 'verified_authority', 'verified_knowledge', 'cross_referenced', 'legacy_unverified', 'disputed']) {
    assert.deepEqual(deriveCanonicalLifecycle({ verification_status: status }), { status, deprecated: false, replacedBy: null });
    assert.throws(() => deriveCanonicalLifecycle({ verification_status: status, replaced_by: 'weh_8ded356ba0c858828bc850ab' }), /requires deprecated/);
  }
  assert.deepEqual(deriveCanonicalLifecycle({ verification_status: 'deprecated' }), { status: 'deprecated', deprecated: true, replacedBy: null });
  assert.equal(validateReplacementRecord({ verification_status: 'legacy_unverified' }), true);
  assert.throws(() => validateReplacementRecord({ verification_status: 'deprecated' }), /deprecated/);
  assert.throws(() => validateReplacementRecord({ verification_status: 'disputed' }), /disputed/);
});

for (const [name, mutate, index = 1] of [
  ['claim target projection', (p) => { p.target.stable_id = 'weh_8ded356ba0c858828bc850ab'; }],
  ['claimant', (p) => { p.workflow.claimant_identity = 'attacker.invalid'; }],
  ['review checkpoint date', (p) => { p.reviewed_on = '2026-08-12'; }],
  ['checkpoint pin', (p) => { p.workflow.review_checkpoint_pin = `sha256:${'f'.repeat(64)}`; }],
  ['claim evidence', (p) => { p.evidence[0].claim_evidence_id = 'pev_syn_attacker_0001'; }],
  ['locator-derived hash', (p) => { p.evidence[0].locator_sha256 = `sha256:${'f'.repeat(64)}`; }],
  ['queue pin', (p) => { p.workflow.queue_pin = `sha256:${'f'.repeat(64)}`; }],
  ['disposition head', (p) => { p.workflow.disposition_event_head_sha256 = `sha256:${'f'.repeat(64)}`; }],
  ['assessed release pin', (p) => { p.target.assessed_release_sha256 = `sha256:${'f'.repeat(64)}`; }],
  ['same-day effective date', (p) => { p.intent.effective_date = p.reviewed_on; }],
  ['candidate eligibility', (p) => { p.approval.candidate_eligible = true; }],
  ['self replacement', (p) => { p.intent.replacement_stable_id = p.target.stable_id; }],
  ['legacy status loss', (p) => { p.target.canonical_status = 'verified_authority'; }, 0],
]) test(`rejects ${name}`, () => {
  const changed = clone(proposals[index]);
  mutate(changed);
  assert.throws(() => validateProposal(changed, inputs));
});

test('rejects drift in every workflow exact-byte dependency', () => {
  for (const key of ['claimBytes', 'reviewBytes', 'queueBytes', 'dispositionAuditBytes', 'checkpointBytes']) {
    const changedInputs = clone(inputs);
    changedInputs.canonicalBytes = inputs.canonicalBytes;
    changedInputs.releaseBytes = inputs.releaseBytes;
    changedInputs.indexBytes = inputs.indexBytes;
    changedInputs.recordsBytes = inputs.recordsBytes;
    changedInputs.workflows.dpr_syn_without_replacement[key] = Buffer.concat([
      inputs.workflows.dpr_syn_without_replacement[key], Buffer.from(' '),
    ]);
    assert.throws(() => validateProposal(proposals[0], changedInputs), key);
  }
});

for (const [name, text] of [
  ['mailto', 'mailto:user@example.invalid'],
  ['email', 'person@example.invalid'],
  ['ftp', 'ftp://host.invalid/file'],
  ['protocol-relative host', '//host.invalid/file'],
  ['scheme-less invalid hostname', 'Evidence evidence-leak.example.invalid remains untrusted'],
  ['ordinary domain-like hostname', 'Evidence from example.com remains untrusted'],
  ['ASCII digits', 'Contact 123 456 7890'],
  ['Unicode digits', 'Contact ١٢٣٤٥٦٧٨'],
  ['NFKC obfuscated separators', 'Contact １．２．３．４．５．６．７．８'],
]) test(`runtime leakage validator rejects ${name}`, () => {
  const changed = clone(proposals[0]);
  changed.evidence[0].summary = text;
  assert.throws(() => validateProposal(changed, inputs));
});

test('leakage validator rejects literal mailto scheme', () => {
  assert.throws(() => validateExportLeakage({ value: 'mailto:user@example.invalid' }), /grammar|scheme|email/);
});

test('rejects truncation and a fully recomputed one-item prefix', () => {
  const prefixProposals = [proposals[0]];
  const prefixBytes = [proposalBytes[0]];
  const prefixAudit = clone(audit);
  prefixAudit.proposals.length = 1;
  prefixAudit.events.length = 1;
  prefixAudit.expected_proposal_count = 1;
  prefixAudit.expected_event_count = 1;
  recomputeAudit(prefixAudit);
  assert.throws(() => validateAuditExport(prefixAudit, prefixProposals, prefixBytes, inputs), /exactly two/);
});

test('rejects duplicate proposal IDs and targets with exact recomputed proposal pins', () => {
  for (const [label, mutate, pattern] of [
    ['proposal', (p) => { p.proposal_id = proposals[0].proposal_id; }, /duplicate proposal ID/],
    ['target', (p) => { p.target.stable_id = proposals[0].target.stable_id; }, /duplicate target stable ID/],
  ]) {
    const changed = proposals.map(clone);
    mutate(changed[1]);
    const bytes = changed.map(encode);
    const changedAudit = clone(audit);
    changedAudit.proposals = changed.map((p, i) => ({ ...audit.proposals[i], proposal_id: p.proposal_id, stable_id: p.target.stable_id, proposal_sha256: pin(bytes[i]) }));
    changedAudit.events[1].proposal_id = changed[1].proposal_id;
    recomputeAudit(changedAudit);
    assert.throws(() => validateAuditExport(changedAudit, changed, bytes, inputs), pattern, label);
  }
});

test('rejects duplicate evidence and event IDs with recomputed bytes and chain', () => {
  const changed = proposals.map(clone);
  changed[1].evidence[0].evidence_id = changed[0].evidence[0].evidence_id;
  const bytes = changed.map(encode);
  const changedAudit = clone(audit);
  changedAudit.proposals.forEach((entry, i) => { entry.proposal_sha256 = pin(bytes[i]); });
  assert.throws(() => validateAuditExport(changedAudit, changed, bytes, inputs), /duplicate evidence ID/);

  const changedEvents = clone(audit);
  changedEvents.events[1].event_id = changedEvents.events[0].event_id;
  recomputeAudit(changedEvents);
  assert.throws(() => validateAuditExport(changedEvents, proposals, proposalBytes, inputs), /duplicate audit event ID/);
});

for (const [name, mutate] of [
  ['proposal', (p) => { p.unknown = false; }],
  ['target', (p) => { p.target.unknown = false; }],
  ['evidence', (p) => { p.evidence[0].unknown = false; }],
  ['workflow', (p) => { p.workflow.unknown = false; }],
]) test(`rejects unknown ${name} field`, () => {
  const changed = clone(proposals[0]);
  mutate(changed);
  assert.throws(() => validateProposal(changed, inputs), /prohibited fields/);
});

test('rejects unknown audit and event fields', () => {
  for (const mutate of [(a) => { a.unknown = false; }, (a) => { a.events[0].unknown = false; }]) {
    const changed = clone(audit);
    mutate(changed);
    assert.throws(() => validateAuditExport(changed, proposals, proposalBytes, inputs), /prohibited fields/);
  }
});
