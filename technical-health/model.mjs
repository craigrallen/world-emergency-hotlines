import assert from 'node:assert/strict';

const ID = /^sha256:[0-9a-f]{64}$/;
const WINDOW = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;
const EVENT_DIMENSIONS = Object.freeze({
  integration_loaded: Object.freeze({ integration_mode: ['finder_link', 'api', 'widget', 'snapshot'], major_version: ['v1'] }),
  artifact_fetch_result: Object.freeze({ artifact_type: ['manifest', 'country', 'resolver', 'widget', 'snapshot'], result: ['success', 'http_error', 'network_error', 'parse_error', 'empty'], major_version: ['v1'] }),
  resolver_execution_result: Object.freeze({ result: ['success', 'parse_error', 'empty'], major_version: ['v1'] }),
});

function exact(value, keys, label) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or prohibited fields`);
}

export function validateAggregateBatch(batch) {
  exact(batch, ['schema', 'window', 'retention_days', 'boundary_deletion_days', 'minimum_event_count', 'cells', 'suppressed_cell_count'], 'batch');
  assert.equal(batch.schema, 'technical-health-aggregate/v1');
  assert.match(batch.window, WINDOW);
  assert.ok(Number.isSafeInteger(batch.retention_days) && batch.retention_days >= 1 && batch.retention_days <= 90);
  assert.ok(Number.isSafeInteger(batch.boundary_deletion_days) && batch.boundary_deletion_days >= 1 && batch.boundary_deletion_days <= 7);
  assert.equal(batch.minimum_event_count, 100);
  assert.ok(Number.isSafeInteger(batch.suppressed_cell_count) && batch.suppressed_cell_count >= 0);
  assert.ok(Array.isArray(batch.cells));
  const seen = new Set();
  for (const cell of batch.cells) {
    const dimensions = EVENT_DIMENSIONS[cell?.event];
    assert.ok(dimensions, 'unknown event');
    exact(cell, ['event', ...Object.keys(dimensions), 'count'], 'cell');
    for (const [name, allowed] of Object.entries(dimensions)) assert.ok(allowed.includes(cell[name]), `invalid ${cell.event}.${name}`);
    assert.ok(Number.isSafeInteger(cell.count) && cell.count >= batch.minimum_event_count, 'cell is below the release threshold');
    const key = JSON.stringify(Object.fromEntries(['event', ...Object.keys(dimensions)].map((name) => [name, cell[name]])));
    assert.ok(!seen.has(key), 'duplicate cube cell');
    seen.add(key);
  }
  return true;
}

export function validateReleaseDescriptor(release) {
  exact(release, ['release_id', 'dataset_version', 'artifact_count'], 'release descriptor');
  assert.match(release.release_id, ID);
  assert.match(release.dataset_version, ID);
  assert.ok(Number.isSafeInteger(release.artifact_count) && release.artifact_count > 0);
  return true;
}

export function deriveDashboard(batch, release) {
  validateAggregateBatch(batch);
  validateReleaseDescriptor(release);
  return {
    schema: 'technical-health-dashboard/v1',
    dashboard_kind: 'static_reference',
    release: { ...release, state: 'descriptor_indexed' },
    aggregate: {
      state: 'thresholded_aggregate_present', window: batch.window,
      minimum_event_count: batch.minimum_event_count, released_cell_count: batch.cells.length,
      suppressed_cell_count: batch.suppressed_cell_count,
    },
    interpretation: 'Technical aggregate and static release evidence only; not hotline availability, uptime, user outcomes, live monitoring, or an SLA.',
  };
}

export function validateDashboard(value) {
  exact(value, ['schema', 'dashboard_kind', 'release', 'aggregate', 'interpretation'], 'dashboard');
  assert.equal(value.schema, 'technical-health-dashboard/v1');
  assert.equal(value.dashboard_kind, 'static_reference');
  exact(value.release, ['release_id', 'dataset_version', 'artifact_count', 'state'], 'dashboard release');
  validateReleaseDescriptor({ release_id: value.release.release_id, dataset_version: value.release.dataset_version, artifact_count: value.release.artifact_count });
  assert.equal(value.release.state, 'descriptor_indexed');
  exact(value.aggregate, ['state', 'window', 'minimum_event_count', 'released_cell_count', 'suppressed_cell_count'], 'dashboard aggregate');
  assert.equal(value.aggregate.state, 'thresholded_aggregate_present');
  assert.match(value.aggregate.window, WINDOW);
  assert.equal(value.aggregate.minimum_event_count, 100);
  for (const name of ['released_cell_count', 'suppressed_cell_count']) assert.ok(Number.isSafeInteger(value.aggregate[name]) && value.aggregate[name] >= 0);
  assert.equal(value.interpretation, 'Technical aggregate and static release evidence only; not hotline availability, uptime, user outcomes, live monitoring, or an SLA.');
  return true;
}
