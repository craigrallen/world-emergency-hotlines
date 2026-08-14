import test from 'node:test';
import assert from 'node:assert/strict';
import { FILES } from '../../web/scripts/generate-managed-api-plan-contracts.mjs';

test('public manifest is finite and contains only the unified static design artifacts', () => {
  assert.deepEqual(FILES, ['README.md','catalog.synthetic.json','plan-catalog.schema.json','planning-vector.schema.json','planning-vectors.synthetic.json']);
});
