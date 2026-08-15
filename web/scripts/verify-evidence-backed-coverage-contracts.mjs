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
const releasedRecords=JSON.parse(args[3]).records,sourceArtifact=JSON.parse(args[4]),observationState={present:'observed',absent:'not_observed',indeterminate:'unknown',not_reviewed:'not_assessed'},date=/^20\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
function independentLiteral(recordId,dimension,record){if(record===null||typeof record!=='object'||Array.isArray(record)||record.id!==recordId)return'not_reviewed';if(dimension==='channels'){const v=record.channels;if(v===null||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='chat,phone,text'||Object.values(v).some(x=>typeof x!=='boolean'))return'not_reviewed';return Object.values(v).some(Boolean)?'present':'absent'}if(dimension==='documented_geography')return typeof record.geography==='string'?(record.geography.length?'present':'absent'):'not_reviewed';if(dimension==='documented_hours')return record.hours===null?'absent':typeof record.hours==='string'?(record.hours.length?'present':'absent'):'not_reviewed';if(dimension==='documented_languages')return Array.isArray(record.languages)&&record.languages.every(x=>typeof x==='string'&&x.length)?(record.languages.length?'present':'absent'):'not_reviewed';if(dimension==='field_evidence')return Array.isArray(record.sources)&&record.sources.every(x=>typeof x==='string'&&x.length)?(record.sources.length?'present':'absent'):'not_reviewed';if(dimension==='recorded_verification_date'){const value=record.last_verified;return value===null?'absent':typeof value==='string'&&date.test(value)&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value?'present':'not_reviewed'}return'not_reviewed'}
const retainedById=new Map(sourceArtifact.sources.map(s=>[s.source_id,s.retained_observation]));
for(const row of sourceArtifact.evidence){const retained=retainedById.get(row.source_id),literal=independentLiteral(row.record_id,row.dimension,releasedRecords[row.record_id]);assert.ok(retained,`independent source missing for ${row.evidence_id}`);assert.equal(retained.record_id,row.record_id,`independent retained record mismatch for ${row.evidence_id}`);assert.equal(retained.dimension,row.dimension,`independent retained dimension mismatch for ${row.evidence_id}`);assert.equal(retained.literal_observation,literal,`independent released-byte literal mismatch for ${row.evidence_id}`);assert.equal(row.state,observationState[literal],`independent released-byte state mismatch for ${row.evidence_id}`)}
const ajv=new Ajv2020({strict:true,allErrors:true});addFormats(ajv);ajv.addKeyword({keyword:'x-runtime-invariants',schemaType:'array',valid:true});
const inputSchema=json('evidence-backed-coverage/contracts/v1/evidence-input.schema.json'),assessmentSchema=json('evidence-backed-coverage/contracts/v1/assessment.schema.json');ajv.addSchema(inputSchema);
const validateInputSchema=ajv.getSchema(inputSchema.$id),validateAssessmentSchema=ajv.compile(assessmentSchema);assert.equal(validateInputSchema(input),true,ajv.errorsText(validateInputSchema.errors));assert.equal(validateAssessmentSchema(assessment),true,ajv.errorsText(validateAssessmentSchema.errors));
function independentState(d,n){assert.equal(d.numerator+d.unknown_count+d.not_observed_count,d.denominator);assert.equal(d.denominator+d.not_assessed_count,n);if(d.denominator===0)return'not_assessed';if(d.not_assessed_count>0)return'partially_assessed';if(d.unknown_count>0)return'unknown';if(d.numerator===n)return'observed';if(d.not_observed_count===n)return'not_observed';return'mixed'}
for(const dimension of assessment.dimensions)assert.equal(dimension.coverage_state,independentState(dimension,assessment.footprint.record_count),`independent terminal-state mismatch for ${dimension.name}`);
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
  ['observed with not assessed',{numerator:1,denominator:1,unknown_count:0,not_observed_count:0,not_assessed_count:1,coverage_state:'observed'}],
  ['not observed with not assessed',{numerator:0,denominator:1,unknown_count:0,not_observed_count:1,not_assessed_count:1,coverage_state:'not_observed'}],
  ['mixed outcomes called not observed',{numerator:1,denominator:2,unknown_count:0,not_observed_count:1,not_assessed_count:0,coverage_state:'not_observed'}],
  ['zero assessed called observed',{numerator:0,denominator:0,unknown_count:0,not_observed_count:0,not_assessed_count:2,coverage_state:'observed'}],
];
for(const [label,values] of contradictions){const probe=structuredClone(assessment);Object.assign(probe.dimensions[0],values);assert.equal(validateAssessmentSchema(probe),false,`schema accepted ${label}`)}
const validPartitions=[
  ['observed with not assessed',{numerator:1,denominator:1,unknown_count:0,not_observed_count:0,not_assessed_count:1,coverage_state:'partially_assessed'}],
  ['not observed with not assessed',{numerator:0,denominator:1,unknown_count:0,not_observed_count:1,not_assessed_count:1,coverage_state:'partially_assessed'}],
  ['mixed assessed outcomes',{numerator:1,denominator:2,unknown_count:0,not_observed_count:1,not_assessed_count:0,coverage_state:'mixed'}],
  ['zero assessed',{numerator:0,denominator:0,unknown_count:0,not_observed_count:0,not_assessed_count:2,coverage_state:'not_assessed'}],
  ['complete observed',{numerator:2,denominator:2,unknown_count:0,not_observed_count:0,not_assessed_count:0,coverage_state:'observed'}],
  ['complete not observed',{numerator:0,denominator:2,unknown_count:0,not_observed_count:2,not_assessed_count:0,coverage_state:'not_observed'}],
];
for(const [label,values] of validPartitions){const probe=structuredClone(assessment);Object.assign(probe.dimensions[0],values);assert.equal(validateAssessmentSchema(probe),true,`${label}: ${ajv.errorsText(validateAssessmentSchema.errors)}`);assert.equal(values.coverage_state,independentState(values,2),`${label} independent derivation`)}
assert.equal(digest(read('hotlines.json')),digest(canonicalBefore),'verification changed hotlines.json');assert.deepEqual(read('hotlines.json'),canonicalBefore,'verification changed canonical bytes');
console.log('Evidence-backed coverage contract OK: independent six-dimension released-byte semantics; exact source/review byte binding; exhaustive schema partitions; complete production records parity; canonical bytes preserved');
