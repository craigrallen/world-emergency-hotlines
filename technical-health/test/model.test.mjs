import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveDashboard, validateAggregateBatch, validateDashboard } from '../model.mjs';

const root = resolve(import.meta.dirname, '../contracts/v1');
const fixture = JSON.parse(readFileSync(resolve(root, 'aggregate.synthetic.json')));
const dashboard = JSON.parse(readFileSync(resolve(root, 'dashboard.synthetic.json')));
const release = { release_id: dashboard.release.release_id, dataset_version: dashboard.release.dataset_version, artifact_count: 42 };
const mutate = (fn) => { const value = structuredClone(fixture); fn(value); return value; };

test('validates and deterministically derives the synthetic dashboard', () => {
  assert.equal(validateAggregateBatch(fixture), true);
  assert.deepEqual(deriveDashboard(fixture, release), dashboard);
  assert.deepEqual(deriveDashboard(fixture, release), deriveDashboard(fixture, release));
  assert.equal(validateDashboard(dashboard), true);
});

for (const [name, value] of [
  ['identifier', mutate((x) => { x.customer_id = 'customer.invalid'; })],
  ['raw event/timestamp', mutate((x) => { x.cells[0].timestamp = '2026-08-14T00:00:00Z'; })],
  ['prohibited dimension', mutate((x) => { x.cells[0].country = 'SE'; })],
  ['invalid event dimensions', mutate((x) => { x.cells[0] = { event: 'resolver_execution_result', integration_mode: 'api', major_version: 'v1', count: 100 }; })],
  ['threshold violation', mutate((x) => { x.cells[0].count = 99; })],
  ['non-v1 threshold', mutate((x) => { x.minimum_event_count = 101; x.cells[0].count = 101; })],
  ['duplicate cells', mutate((x) => { x.cells.push(structuredClone(x.cells[0])); })],
  ['duplicate coordinates with different counts', mutate((x) => { x.cells.push({ ...x.cells[0], count: x.cells[0].count + 1 }); })],
  ['invalid window', mutate((x) => { x.window = '2026-W54'; })],
  ['invalid retention', mutate((x) => { x.retention_days = 91; })],
  ['invalid boundary deletion', mutate((x) => { x.boundary_deletion_days = 8; })],
  ['alternate cube', mutate((x) => { x.marginals = []; })],
]) test(`rejects ${name}`, () => assert.throws(() => validateAggregateBatch(value)));

test('rejects bad release and dataset IDs', () => {
  assert.throws(() => deriveDashboard(fixture, { ...release, release_id: 'release-latest' }));
  assert.throws(() => deriveDashboard(fixture, { ...release, dataset_version: 'sha256:xyz' }));
});

test('rejects misleading or inconsistent dashboard state', () => {
  const misleading = structuredClone(dashboard);
  misleading.release.state = 'operational';
  assert.throws(() => validateDashboard(misleading));
  const absentAsSuccess = structuredClone(dashboard);
  absentAsSuccess.aggregate.state = 'healthy';
  assert.throws(() => validateDashboard(absentAsSuccess));
});
