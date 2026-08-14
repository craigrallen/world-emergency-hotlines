import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { deriveDispositionSummary, validateDispositionAudit, validateWorkQueue } from '../../reviewer-work-queue/model.mjs';
import { generateReviewerWorkQueueContracts, verifyReviewerWorkQueueContractDrift } from './generate-reviewer-work-queue-contracts.mjs';
const repo = resolve(import.meta.dirname, '../..'); const root = resolve(repo, 'reviewer-work-queue/contracts/v1'); const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const canonical = resolve(repo, 'hotlines.json'); const before = digest(canonical); generateReviewerWorkQueueContracts(); assert.equal(digest(canonical), before); verifyReviewerWorkQueueContractDrift();
const claimBytes = readFileSync(resolve(repo, 'provider-claims/contracts/v1/claim.synthetic.json')); const reviewBytes = readFileSync(resolve(repo, 'provider-claims/contracts/v1/review.synthetic.json')); const queueBytes = readFileSync(resolve(root, 'queue.synthetic.json'));
const claim = JSON.parse(claimBytes); const review = JSON.parse(reviewBytes); const queue = JSON.parse(queueBytes); const audit = JSON.parse(readFileSync(resolve(root, 'disposition-audit.synthetic.json')));
const ajv = new Ajv2020({ strict: true, allErrors: true }); ajv.addKeyword({ keyword: 'x-runtime-invariants', schemaType: 'array', valid: true });
for (const [name, fixture] of [['queue.schema.json', queue], ['disposition-audit.schema.json', audit]]) { const validate = ajv.compile(JSON.parse(readFileSync(resolve(root, name)))); assert.ok(validate(fixture), `${name}: ${ajv.errorsText(validate.errors)}`); }
validateWorkQueue(queue, claim, claimBytes); validateDispositionAudit(audit, queue, claim, review, queueBytes, claimBytes, reviewBytes); assert.deepEqual(deriveDispositionSummary(audit, queue, claim, review, queueBytes, claimBytes, reviewBytes), deriveDispositionSummary(audit, queue, claim, review, queueBytes, claimBytes, reviewBytes));
assert.ok(!readFileSync(resolve(import.meta.dirname, 'generate-reviewer-work-queue-contracts.mjs'), 'utf8').includes('hotlines.json'));
console.log('Reviewer-work-queue contract OK: exact claim/queue/review pins, trusted queueing-actor and assigned-reviewer bindings, single-item administrative ordering, hash-chained static audit snapshot, source/public parity');
