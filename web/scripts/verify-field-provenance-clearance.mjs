import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIELD_GROUP_IDS, loadClearanceArtifacts, POPULATION_IDS } from './field-provenance-clearance-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const { ledger, example } = loadClearanceArtifacts(repo);
assert.equal(ledger.entries.length, POPULATION_IDS.length * FIELD_GROUP_IDS.length);
assert.equal(example.entries.length, FIELD_GROUP_IDS.length);
const scripts = JSON.parse(readFileSync(resolve(repo, 'web/package.json'), 'utf8')).scripts;
assert.equal(scripts['test:field-provenance-clearance'], 'node --test scripts/field-provenance-clearance.test.mjs');
assert.equal(scripts['verify:field-provenance-clearance:dist'], 'npm run test:field-provenance-clearance && node scripts/verify-field-provenance-clearance.mjs && npm run verify:internal-nonpublication:dist');
assert.equal(scripts['verify:field-provenance-clearance'], 'npm run build && npm run verify:field-provenance-clearance:dist');
assert.equal((scripts['verify:all'].match(/(?:^|\s&&\s)npm run verify:field-provenance-clearance:dist(?=\s&&\s|$)/g) ?? []).length, 1);
console.log(`Internal field-provenance clearance ledger OK: ${ledger.entries.length} held real rows, ${example.entries.length} held synthetic rows, exact evidence bindings, and nonpublication wiring`);
