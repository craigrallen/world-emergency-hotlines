import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPack } from './design-partner-discovery-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
loadPack(repo);
const scripts = JSON.parse(readFileSync(resolve(repo, 'web/package.json'), 'utf8')).scripts;
assert.equal(scripts['test:design-partner-discovery'], 'node --test scripts/design-partner-discovery.test.mjs');
assert.equal(scripts['verify:design-partner-discovery:dist'], 'npm run test:design-partner-discovery && node scripts/verify-design-partner-discovery.mjs && npm run verify:internal-nonpublication:dist');
assert.equal(scripts['verify:design-partner-discovery'], 'npm run build && npm run verify:design-partner-discovery:dist');
assert.equal((scripts['verify:all'].match(/(?:^|\s&&\s)npm run verify:design-partner-discovery:dist(?=\s&&\s|$)/g) ?? []).length, 1);
console.log('Internal design-partner discovery pack OK: exact contracts, tracked evidence, unavailable future gate mechanism, derived held fixture, and CI wiring');
