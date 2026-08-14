import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import * as model from '../../managed-api-plans/model.mjs';
import { verifyManagedApiPlanContractDrift } from './generate-managed-api-plan-contracts.mjs';

const root = resolve(import.meta.dirname, '../../managed-api-plans/contracts/v1');
const catalog = JSON.parse(readFileSync(resolve(root,'catalog.synthetic.json')));
const vectorsDoc = JSON.parse(readFileSync(resolve(root,'planning-vectors.synthetic.json')));
const ajv = new Ajv2020({allErrors:true,strict:true}); addFormats(ajv);
const catalogValidator = ajv.compile(JSON.parse(readFileSync(resolve(root,'plan-catalog.schema.json'))));
const vectorsValidator = ajv.compile(JSON.parse(readFileSync(resolve(root,'planning-vector.schema.json'))));
assert.ok(catalogValidator(catalog), ajv.errorsText(catalogValidator.errors)); assert.ok(vectorsValidator(vectorsDoc), ajv.errorsText(vectorsValidator.errors));
assert.equal(model.validateCatalog(catalog), true); verifyManagedApiPlanContractDrift();

for (const vector of vectorsDoc.vectors) {
  const run = () => model.planManagedMeteredRequest({authoritative_state:vector.authoritative_state,instant:new Date(vector.instant),request:vector.request});
  if (vector.expected_error) assert.throws(run, new RegExp(vector.expected_error), vector.name);
  else assert.deepEqual(run(), vector.expected, vector.name);
}

const valid = structuredClone(vectorsDoc);
for (const target of ['authoritative_state','expected_state','next_state']) {
  const altered = structuredClone(valid);
  const vector = altered.vectors.find((item) => item.expected?.transition);
  const state = target === 'authoritative_state' ? vector.authoritative_state : vector.expected.transition[target];
  state.used_units = 100001;
  assert.equal(vectorsValidator(altered), false, `AJV accepted over-cap ${target}`);
}
assert.throws(() => model.planManagedMeteredRequest({authoritative_state:{generation:1,utc_month:'2026-08',used_units:100001},instant:new Date('2026-08-01T00:00:00.000Z'),request:{method:'GET',route_class:'managed_artifact',authenticated:true,authorized:true}}), /used_units/);
for (const name of ['evaluateAllowance','resetForUtcMonth','applyFullStateCas']) assert.equal(name in model, false);
console.log('Managed API plan contract OK: one ordered authoritative planner, atomic month rollover, bounded usage, derived full-state CAS, source/public parity');
