import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadIndex, verifyExternalPack } from './licensing-legal-review-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--external-pack'), 'usage: verify-licensing-legal-review.mjs [--external-pack /absolute/path]');
loadIndex(repo);
if (args.length) verifyExternalPack(args[1]);
const scripts = JSON.parse(readFileSync(resolve(repo, 'web/package.json'), 'utf8')).scripts;
assert.equal(scripts['test:licensing-legal-review'], 'node --test scripts/licensing-legal-review.test.mjs');
assert.equal(scripts['verify:licensing-legal-review:dist'], 'npm run test:licensing-legal-review && node scripts/verify-licensing-legal-review.mjs && npm run verify:internal-nonpublication:dist');
assert.equal(scripts['verify:licensing-legal-review'], 'npm run build && npm run verify:licensing-legal-review:dist');
assert.equal((scripts['verify:all'].match(/(?:^|\s&&\s)npm run verify:licensing-legal-review:dist(?=\s&&\s|$)/g) ?? []).length, 1);
console.log(`Internal licensing legal-review handoff OK: closed held decision map, exact repository evidence, optional external binding${args.length ? ' verified' : ' not required by CI'}, and nonpublication wiring`);
