import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadIndex, validateSchemaSpecification } from './technical-due-diligence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
loadIndex(repo);
validateSchemaSpecification(repo);
const scripts = JSON.parse(readFileSync(resolve(repo, 'web/package.json'), 'utf8')).scripts;
assert.equal(scripts['test:technical-due-diligence'], 'node --test scripts/technical-due-diligence.test.mjs');
assert.equal(scripts['verify:technical-due-diligence:dist'], 'npm run test:technical-due-diligence && node scripts/verify-technical-due-diligence.mjs && npm run verify:internal-nonpublication:dist');
assert.equal(scripts['verify:technical-due-diligence'], 'npm run build && npm run verify:technical-due-diligence:dist');
assert.equal(scripts['update:technical-due-diligence-sources'], 'node scripts/print-technical-due-diligence-sources.mjs');
assert.equal((scripts['verify:all'].match(/(?:^|\s&&\s)npm run verify:technical-due-diligence:dist(?=\s&&\s|$)/g) ?? []).length, 1, 'verify:all must run the due-diligence verifier exactly once');
console.log('Internal technical due-diligence index OK: exact checked-in schema/specification, Ajv 2020 validation, runtime-only invariants, tracked source bytes, conservative gates, and CI wiring');
