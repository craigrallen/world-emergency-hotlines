import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { transitionClaim, validateClaimEnvelope, validateReviewDecision } from '../../provider-claims/model.mjs';
import { generateProviderClaimContracts, verifyProviderClaimContractDrift } from './generate-provider-claim-contracts.mjs';

const repo = resolve(import.meta.dirname, '../..');
const root = resolve(repo, 'provider-claims/contracts/v1');
const canonicalPath = resolve(repo, 'hotlines.json');
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const canonicalBefore = digest(canonicalPath);
generateProviderClaimContracts();
assert.equal(digest(canonicalPath), canonicalBefore, 'provider-claim generation changed hotlines.json');
verifyProviderClaimContractDrift();
const claim = JSON.parse(readFileSync(resolve(root, 'claim.synthetic.json')));
const review = JSON.parse(readFileSync(resolve(root, 'review.synthetic.json')));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addKeyword({ keyword: 'x-runtime-invariants', schemaType: 'array', valid: true });
for (const [schemaName, fixture] of [['claim-envelope.schema.json', claim], ['review-decision.schema.json', review]]) {
  const validate = ajv.compile(JSON.parse(readFileSync(resolve(root, schemaName))));
  assert.ok(validate(fixture), `${schemaName} rejected fixture: ${ajv.errorsText(validate.errors)}`);
}
validateClaimEnvelope(claim); validateReviewDecision(review, claim);
assert.deepEqual(transitionClaim(claim, review), { claim_id: claim.claim_id, state: 'accepted_for_candidate', candidate_eligible: true });
assert.ok(!readFileSync(resolve(import.meta.dirname, 'generate-provider-claim-contracts.mjs'), 'utf8').includes('hotlines.json'), 'generator must not depend on canonical data');
console.log('Provider-claim contract OK: independent review, fail-closed transitions, source/public parity, canonical bytes unchanged');
