import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  deriveAuditSummary,
  validateAuditExport,
  validateProposal,
} from '../../deprecation-proposals/model.mjs';
import { verifyDeprecationProposalContractDrift } from './generate-deprecation-proposal-contracts.mjs';

const repo = resolve(import.meta.dirname, '../..');
const root = resolve(repo, 'deprecation-proposals/contracts/v1');
const read = (path) => readFileSync(resolve(repo, path));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonicalBytes = read('hotlines.json');
const canonicalBefore = digest(canonicalBytes);

function workflow(directory) {
  const fixtureRoot = `deprecation-proposals/fixtures/${directory}`;
  const result = {};
  for (const [key, name] of [
    ['claim', 'claim.synthetic.json'],
    ['review', 'review.synthetic.json'],
    ['queue', 'queue.synthetic.json'],
    ['dispositionAudit', 'disposition-audit.synthetic.json'],
    ['checkpoint', 'review-checkpoint.synthetic.json'],
  ]) {
    result[`${key}Bytes`] = read(`${fixtureRoot}/${name}`);
    result[key] = JSON.parse(result[`${key}Bytes`]);
  }
  return result;
}

const inputs = {
  canonicalBytes,
  releaseBytes: read('assurance-packs/fixtures/assessed-release.synthetic.json'),
  indexBytes: read('assurance-packs/fixtures/assessed-artifacts.synthetic.json'),
  recordsBytes: read('web/public/api/v1/records.json'),
  workflows: {
    dpr_syn_without_replacement: workflow('without-replacement'),
    dpr_syn_with_replacement: workflow('with-replacement'),
  },
};

verifyDeprecationProposalContractDrift();
assert.equal(digest(read('hotlines.json')), canonicalBefore, 'verification changed hotlines.json');

const proposalNames = [
  'proposal-without-replacement.synthetic.json',
  'proposal-with-replacement.synthetic.json',
];
const proposalBytes = proposalNames.map((name) => readFileSync(resolve(root, name)));
const proposals = proposalBytes.map((bytes) => JSON.parse(bytes));
const audit = JSON.parse(readFileSync(resolve(root, 'audit-export.synthetic.json')));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addKeyword({ keyword: 'x-runtime-invariants', schemaType: 'array', valid: true });
for (const [schemaName, fixtures] of [
  ['proposal.schema.json', proposals],
  ['audit-export.schema.json', [audit]],
  ['review-checkpoint.schema.json', Object.values(inputs.workflows).map((item) => item.checkpoint)],
]) {
  const validate = ajv.compile(JSON.parse(readFileSync(resolve(root, schemaName))));
  for (const fixture of fixtures) {
    assert.ok(validate(fixture), `${schemaName}: ${ajv.errorsText(validate.errors)}`);
  }
}

proposals.forEach((proposal) => {
  validateProposal(proposal, inputs);
});
validateAuditExport(audit, proposals, proposalBytes, inputs);
const firstSummary = deriveAuditSummary(audit, proposals, proposalBytes, inputs);
const secondSummary = deriveAuditSummary(audit, proposals, proposalBytes, inputs);
assert.deepEqual(firstSummary, secondSummary, 'audit derivation is not deterministic');

console.log(
  'Deprecation proposal contract OK: two proposal-specific source-only workflows and dated checkpoints, '
  + 'canonical status and records projection, held ineligible state, runtime leakage grammar, '
  + 'exact closed fixture completeness, and read-only source/public parity',
);
