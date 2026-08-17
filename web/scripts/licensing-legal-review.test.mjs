import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import { assertInternalNonpublication, forbiddenInternalEvidence } from './verify-internal-nonpublication.mjs';
import { DOMAIN_IDS, EXTERNAL, INDEX_PATH, INTERNAL_MARKER, loadIndex, POPULATION_IDS, SCHEMA_PATH, SOURCE_PATHS, validateIndex, verifyExternalPack } from './licensing-legal-review-lib.mjs';
import { parseStrictJson } from './security-privacy-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const committed = parseStrictJson(readFileSync(resolve(repo, INDEX_PATH)), INDEX_PATH);
const clone = () => structuredClone(committed); const roots = [];
const temporaryRoot = (prefix) => { const root = mkdtempSync(resolve(tmpdir(), prefix)); roots.push(root); return root; };
const trackedCopy = () => { const root = temporaryRoot('weh-legal-'); for (const path of [...SOURCE_PATHS, INDEX_PATH, SCHEMA_PATH]) { mkdirSync(resolve(root, path, '..'), { recursive: true }); copyFileSync(resolve(repo, path), resolve(root, path)); } execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '--', '.']); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('tracked handoff satisfies closed schema, exact bytes, and held inventories', () => assert.doesNotThrow(() => loadIndex(trackedCopy())));
test('strict JSON rejects duplicate members and malformed UTF-8', () => {
  assert.throws(() => parseStrictJson('{"outcome":"held","outcome":"approved"}', INDEX_PATH), /duplicate member/);
  assert.throws(() => parseStrictJson(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), INDEX_PATH), /malformed UTF-8/);
});
test('runtime rejects outcome, inventory, evidence, and external-binding ambiguity', () => {
  const options = { testOnlySkipGitIndex: true };
  const approved = clone(); approved.outcome = 'approved'; assert.throws(() => validateIndex(approved, repo, options), /held/);
  const domain = clone(); domain.decision_domains[0].id = 'documentation'; assert.throws(() => validateIndex(domain, repo, options), /decision-domain/);
  const population = clone(); population.provenance_populations.pop(); assert.throws(() => validateIndex(population, repo, options), /provenance-population/);
  const drift = clone(); drift.sources['hotlines.json'] = `sha256:${'0'.repeat(64)}`; assert.throws(() => validateIndex(drift, repo, options), /exact tracked repository evidence bytes changed/);
  const uncited = clone(); uncited.provenance_populations.at(-1).repository_evidence = ['hotlines.json', 'sources/web_verified_crisis_directory/final_countries_crisis_directory.json']; assert.throws(() => validateIndex(uncited, repo, options), /every bound repository source must be cited/);
  const external = clone(); external.external_decision_pack.repository_bound = true; assert.throws(() => validateIndex(external, repo, options), /external decision-pack binding changed/);
  assert.deepEqual(committed.decision_domains.map(({ id }) => id), DOMAIN_IDS); assert.deepEqual(committed.provenance_populations.map(({ id }) => id), POPULATION_IDS);
});
test('tracked reader rejects worktree drift, symlinks, and path replacement', () => {
  const drift = trackedCopy(); writeFileSync(resolve(drift, INDEX_PATH), `${readFileSync(resolve(drift, INDEX_PATH), 'utf8')} `); assert.throws(() => loadIndex(drift), /working-tree evidence bytes differ from Git index/);
  const linked = trackedCopy(); rmSync(resolve(linked, SCHEMA_PATH)); symlinkSync('index.json', resolve(linked, SCHEMA_PATH)); assert.throws(() => loadIndex(linked), /symlinked evidence path/);
  const replaced = trackedCopy(); let done = false; assert.throws(() => loadIndex(replaced, { afterRead: ({ path, absolutePath }) => { if (done || path !== INDEX_PATH) return; done = true; const replacement = `${absolutePath}.new`; writeFileSync(replacement, readFileSync(absolutePath)); execFileSync('mv', [replacement, absolutePath]); } }), /changed during read/);
});
test('optional external pack requires exact basename and bytes and is not a CI input', () => {
  const dir = temporaryRoot('weh-external-'); const expected = resolve(dir, EXTERNAL.expected_filename); writeFileSync(expected, 'wrong');
  assert.throws(() => verifyExternalPack(expected), /bytes differ/);
  assert.throws(() => verifyExternalPack(resolve(dir, 'renamed.md')), /basename differs/);
  assert.equal(committed.external_decision_pack.availability, 'external_optional_not_required_by_ci');
});
test('nonpublication rejects marker, exact renamed copies, and extracted semantic content', () => {
  const forbidden = forbiddenInternalEvidence(repo); assert.ok(forbidden.markers.includes(INTERNAL_MARKER));
  const dist = temporaryRoot('weh-legal-dist-'); writeFileSync(resolve(dist, 'renamed.bin'), readFileSync(resolve(repo, INDEX_PATH))); assert.throws(() => assertInternalNonpublication(dist, repo), /marker|exact copy/);
  rmSync(dist, { recursive: true, force: true }); mkdirSync(dist); const stripped = clone(); delete stripped.internal_only_marker; writeFileSync(resolve(dist, 'reformatted.json'), JSON.stringify(stripped, null, 3)); assert.throws(() => assertInternalNonpublication(dist, repo), /semantic section|scalar fingerprint/);
  rmSync(dist, { recursive: true, force: true }); mkdirSync(dist); writeFileSync(resolve(dist, 'leak.js'), `export default ${JSON.stringify(committed.provenance_populations[0].counsel_question)}`); assert.throws(() => assertInternalNonpublication(dist, repo), /scalar fingerprint/);
});
