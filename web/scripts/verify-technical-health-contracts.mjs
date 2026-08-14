import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { validateAggregateBatch, validateDashboard, deriveDashboard } from '../../technical-health/model.mjs';
import { verifyTechnicalHealthContractDrift } from './generate-technical-health-contracts.mjs';

verifyTechnicalHealthContractDrift();
const root = resolve(import.meta.dirname, '../../technical-health/contracts/v1');
const batch = JSON.parse(readFileSync(resolve(root, 'aggregate.synthetic.json')));
const dashboard = JSON.parse(readFileSync(resolve(root, 'dashboard.synthetic.json')));
const ajv = new Ajv2020({ strict: true, allErrors: true });
let validateBatchSchema;
for (const [schemaName, fixture] of [['aggregate-batch.schema.json', batch], ['dashboard.schema.json', dashboard]]) {
  const validate = ajv.compile(JSON.parse(readFileSync(resolve(root, schemaName))));
  if (!validate(fixture)) throw new Error(`${schemaName} rejected its fixture: ${ajv.errorsText(validate.errors)}`);
  if (schemaName === 'aggregate-batch.schema.json') validateBatchSchema = validate;
}
validateAggregateBatch(batch); validateDashboard(dashboard);
const adversarialBatches = [
  ['non-v1 threshold', (value) => { value.minimum_event_count = 101; value.cells[0].count = 101; }],
  ['duplicate coordinates with equal counts', (value) => { value.cells.push(structuredClone(value.cells[0])); }],
  ['duplicate coordinates with different counts', (value) => { value.cells.push({ ...value.cells[0], count: value.cells[0].count + 1 }); }],
];
for (const [name, mutate] of adversarialBatches) {
  const value = structuredClone(batch);
  mutate(value);
  assert.equal(validateBatchSchema(value), false, `JSON Schema accepted ${name}`);
  assert.throws(() => validateAggregateBatch(value), undefined, `runtime accepted ${name}`);
}
const release = { release_id: dashboard.release.release_id, dataset_version: dashboard.release.dataset_version, artifact_count: dashboard.release.artifact_count };
if (JSON.stringify(deriveDashboard(batch, release)) !== JSON.stringify(dashboard)) throw new Error('synthetic dashboard is stale');
console.log('Technical-health contract OK: strict weekly cube, deterministic static dashboard, source/public parity');
