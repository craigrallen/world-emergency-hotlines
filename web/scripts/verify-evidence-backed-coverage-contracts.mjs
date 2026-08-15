import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { deriveAssessment, validateAssessment, validateInput } from '../../evidence-backed-coverage/model.mjs';
import { verifyEvidenceBackedCoverageContractDrift } from './generate-evidence-backed-coverage-contracts.mjs';

const repo=resolve(import.meta.dirname,'../..'),read=p=>readFileSync(resolve(repo,p)),json=p=>JSON.parse(read(p)),digest=b=>createHash('sha256').update(b).digest('hex');
const canonicalBefore=read('hotlines.json'),input=json('evidence-backed-coverage/fixtures/evidence.synthetic.json'),assessment=json('evidence-backed-coverage/contracts/v1/assessment.synthetic.json');
const args=[canonicalBefore,read('assurance-packs/fixtures/assessed-release.synthetic.json'),read('assurance-packs/fixtures/assessed-artifacts.synthetic.json'),read('web/public/api/v1/records.json'),read('evidence-backed-coverage/fixtures/source-evidence.synthetic.json'),read('evidence-backed-coverage/fixtures/review-decision.synthetic.json')];
verifyEvidenceBackedCoverageContractDrift();validateInput(input,...args);validateAssessment(assessment,input,...args);assert.deepEqual(deriveAssessment(input,...args),assessment);
const ajv=new Ajv2020({strict:true,allErrors:true});addFormats(ajv);ajv.addKeyword({keyword:'x-runtime-invariants',schemaType:'array',valid:true});
const inputSchema=json('evidence-backed-coverage/contracts/v1/evidence-input.schema.json'),assessmentSchema=json('evidence-backed-coverage/contracts/v1/assessment.schema.json');ajv.addSchema(inputSchema);
const validateInputSchema=ajv.getSchema(inputSchema.$id),validateAssessmentSchema=ajv.compile(assessmentSchema);assert.equal(validateInputSchema(input),true,ajv.errorsText(validateInputSchema.errors));assert.equal(validateAssessmentSchema(assessment),true,ajv.errorsText(validateAssessmentSchema.errors));
const rejected=structuredClone(assessment);rejected.review.decision='rejected';assert.equal(validateAssessmentSchema(rejected),false,'schema accepted rejected review');
const duplicate=structuredClone(assessment);duplicate.dimensions[1]=structuredClone(duplicate.dimensions[0]);assert.equal(validateAssessmentSchema(duplicate),false,'schema accepted duplicate dimension identity');
const contradictions=[
  ['observed partial counts',{numerator:1,denominator:2,unknown_count:0,not_observed_count:0,not_assessed_count:0,coverage_state:'observed'}],
  ['observed with unknown',{numerator:1,denominator:2,unknown_count:1,not_observed_count:0,not_assessed_count:0,coverage_state:'observed'}],
  ['unknown without unknown count',{numerator:1,denominator:2,unknown_count:0,not_observed_count:1,not_assessed_count:0,coverage_state:'unknown'}],
  ['not observed without missing count',{numerator:2,denominator:2,unknown_count:0,not_observed_count:0,not_assessed_count:0,coverage_state:'not_observed'}],
  ['not assessed with partial count',{numerator:0,denominator:0,unknown_count:0,not_observed_count:0,not_assessed_count:1,coverage_state:'not_assessed'}],
  ['not assessed with assessed item',{numerator:0,denominator:1,unknown_count:0,not_observed_count:1,not_assessed_count:1,coverage_state:'not_assessed'}],
  ['partition exceeds footprint',{numerator:2,denominator:2,unknown_count:0,not_observed_count:0,not_assessed_count:1,coverage_state:'observed'}],
];
for(const [label,values] of contradictions){const probe=structuredClone(assessment);Object.assign(probe.dimensions[0],values);assert.equal(validateAssessmentSchema(probe),false,`schema accepted ${label}`)}
assert.equal(digest(read('hotlines.json')),digest(canonicalBefore),'verification changed hotlines.json');assert.deepEqual(read('hotlines.json'),canonicalBefore,'verification changed canonical bytes');
console.log('Evidence-backed coverage contract OK: exact source/review byte binding; exhaustive schema partitions; complete production records parity; canonical bytes preserved');
