import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import { assertInternalNonpublication, forbiddenInternalEvidence } from './verify-internal-nonpublication.mjs';
import { expectedSchema, INDEX_PATH, INTERNAL_MARKER, loadIndex, SCHEMA_PATH, validateIndex, validateSchemaSpecification } from './technical-due-diligence-lib.mjs';
import { parseStrictJson, sourceMap } from './security-privacy-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const committed = parseStrictJson(readFileSync(resolve(repo, INDEX_PATH)));
const clone = () => structuredClone(committed);
const roots = [];
const temporaryRoot = (prefix) => { const root = mkdtempSync(resolve(tmpdir(), prefix)); roots.push(root); return root; };
const trackedCopy = () => {
  const root = temporaryRoot('weh-dd-copy-');
  for (const path of [...Object.keys(committed.sources), INDEX_PATH, SCHEMA_PATH]) { mkdirSync(resolve(root, path, '..'), { recursive: true }); copyFileSync(resolve(repo, path), resolve(root, path)); }
  writeFileSync(resolve(root, 'whole-index-sentinel'), 'before\n');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '--', '.']);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('tracked index and schema load together and satisfy exact schema/specification plus runtime invariants', () => { const root = trackedCopy(); assert.doesNotThrow(() => loadIndex(root)); assert.doesNotThrow(() => validateSchemaSpecification(root)); });
test('Ajv 2020 accepts the index and rejects schema-expressible tuple, property-name, and closed-object violations', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(expectedSchema());
  assert.equal(validate(clone()), true);
  const reordered = clone(); reordered.domains.reverse(); assert.equal(validate(reordered), false);
  const extraDomain = clone(); extraDomain.domains.push(structuredClone(extraDomain.domains[0])); assert.equal(validate(extraDomain), false);
  const unsafeSource = clone(); unsafeSource.sources['../escape'] = `sha256:${'0'.repeat(64)}`; assert.equal(validate(unsafeSource), false);
  const openArtifact = clone(); openArtifact.domains[0].artifacts[0].extra = true; assert.equal(validate(openArtifact), false);
});
test('strict JSON rejects duplicate members and malformed UTF-8', () => {
  assert.throws(() => parseStrictJson('{"schema_version":"1.0","schema_version":"2.0"}', INDEX_PATH), /duplicate member/);
  assert.throws(() => parseStrictJson(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), INDEX_PATH), /malformed UTF-8/);
});
test('closed runtime schema rejects unexpected fields, domains, statuses, missing gaps, and unsupported assurance language', () => {
  const options = { testOnlySkipGitIndex: true };
  const unexpected = clone(); unexpected.extra = true; assert.throws(() => validateIndex(unexpected, repo, options), /fields changed/);
  const domain = clone(); domain.domains[0].id = 'operations'; assert.throws(() => validateIndex(domain, repo, options), /domain inventory/);
  const status = clone(); status.domains[0].artifacts[0].review_status = 'certified'; assert.throws(() => validateIndex(status, repo, options), /unknown status/);
  const assurance = clone(); assurance.domains[0].artifacts[0].proves_narrowly = 'This artifact proves the release is certified and production-ready for every user.'; assert.throws(() => validateIndex(assurance, repo, options), /unsupported assurance language/);
  const gaps = clone(); for (const d of gaps.domains) for (const a of d.artifacts) a.review_status = 'verified_static'; assert.throws(() => validateIndex(gaps, repo, options), /retain conservative/);
});
test('source inventory rejects missing, unexpected, duplicate, traversal, and changed source bytes', () => {
  const options = { testOnlySkipGitIndex: true };
  const missing = clone(); delete missing.sources['docs/releases.json']; assert.throws(() => validateIndex(missing, repo, options), /unbound artifact|exact tracked|complete/);
  const unexpected = clone(); unexpected.sources['README.md'] = `sha256:${'0'.repeat(64)}`; assert.throws(() => validateIndex(unexpected, repo, options), /source paths must be sorted|changed/);
  const duplicate = clone(); duplicate.domains[1].artifacts.push(structuredClone(duplicate.domains[0].artifacts[0])); assert.throws(() => validateIndex(duplicate, repo, options), /duplicate artifact/);
  const traversal = clone(); traversal.domains[0].artifacts[0].path = '../docs/releases.json'; assert.throws(() => validateIndex(traversal, repo, options), /non-canonical/);
  const changed = clone(); changed.sources['docs/releases.json'] = `sha256:${'0'.repeat(64)}`; assert.throws(() => validateIndex(changed, repo, options), /exact tracked evidence source bytes changed/);
});
test('tracked reader rejects worktree/index drift and symlinked sources', () => {
  const drift = temporaryRoot('weh-dd-drift-'); writeFileSync(resolve(drift, 'source.txt'), 'indexed\n'); execFileSync('git', ['init', '-q', drift]); execFileSync('git', ['-C', drift, 'add', '--', 'source.txt']); writeFileSync(resolve(drift, 'source.txt'), 'working\n'); assert.throws(() => sourceMap(drift, ['source.txt']), /working-tree evidence bytes differ from Git index/);
  const linked = temporaryRoot('weh-dd-link-'); writeFileSync(resolve(linked, 'target.txt'), 'target\n'); symlinkSync('target.txt', resolve(linked, 'source.txt')); execFileSync('git', ['init', '-q', linked]); execFileSync('git', ['-C', linked, 'add', '--', 'source.txt', 'target.txt']); assert.throws(() => sourceMap(linked, ['source.txt']), /symlinked evidence path/);
});
test('tracked reader rejects pathname replacement and whole-index mutation during a read', () => {
  const root = temporaryRoot('weh-dd-race-'); writeFileSync(resolve(root, 'source.txt'), 'source\n'); writeFileSync(resolve(root, 'other.txt'), 'before\n'); execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '--', 'source.txt', 'other.txt']); let replaced = false;
  assert.throws(() => sourceMap(root, ['source.txt'], { afterRead: ({ absolutePath }) => { if (replaced) return; replaced = true; const replacement = resolve(root, 'replacement.txt'); writeFileSync(replacement, 'source\n'); renameSync(replacement, absolutePath); } }), /changed during read/);
  writeFileSync(resolve(root, 'source.txt'), 'source\n'); execFileSync('git', ['-C', root, 'add', '--', 'source.txt']); let staged = false;
  assert.throws(() => sourceMap(root, ['source.txt'], { afterRead: () => { if (staged) return; staged = true; writeFileSync(resolve(root, 'other.txt'), 'after\n'); execFileSync('git', ['-C', root, 'add', '--', 'other.txt']); } }), /Git index changed during evidence operation/);
});
test('complete load rejects index/schema drift, symlinks, path replacement, and whole-index mutation', () => {
  const drift = trackedCopy(); writeFileSync(resolve(drift, INDEX_PATH), `${readFileSync(resolve(drift, INDEX_PATH), 'utf8')} `); assert.throws(() => loadIndex(drift), /working-tree evidence bytes differ from Git index/);
  const linked = trackedCopy(); const schemaTarget = resolve(linked, `${SCHEMA_PATH}.target`); renameSync(resolve(linked, SCHEMA_PATH), schemaTarget); symlinkSync('index.schema.json.target', resolve(linked, SCHEMA_PATH)); assert.throws(() => loadIndex(linked), /symlinked evidence path/);
  const replaced = trackedCopy(); let didReplace = false; assert.throws(() => loadIndex(replaced, { afterRead: ({ path, absolutePath }) => { if (didReplace || path !== INDEX_PATH) return; didReplace = true; const replacement = `${absolutePath}.replacement`; writeFileSync(replacement, readFileSync(absolutePath)); renameSync(replacement, absolutePath); } }), /changed during read/);
  const mutated = trackedCopy(); let didMutate = false; assert.throws(() => loadIndex(mutated, { afterRead: ({ path }) => { if (didMutate || path !== SCHEMA_PATH) return; didMutate = true; const other = resolve(mutated, 'whole-index-sentinel'); writeFileSync(other, 'after\n'); execFileSync('git', ['-C', mutated, 'add', '--', 'whole-index-sentinel']); } }), /Git index changed during evidence operation/);
});
test('nonpublication rejects marker and exact renamed copies', () => {
  const forbidden = forbiddenInternalEvidence(repo); assert.ok(forbidden.markers.includes(INTERNAL_MARKER));
  const dist = temporaryRoot('weh-dd-dist-'); mkdirSync(resolve(dist, 'nested')); writeFileSync(resolve(dist, 'nested/renamed.txt'), readFileSync(resolve(repo, INDEX_PATH))); assert.throws(() => assertInternalNonpublication(dist, repo), /internal review-pack marker|exact copy/);
  writeFileSync(resolve(dist, 'nested/renamed.txt'), `prefix ${INTERNAL_MARKER} suffix`); assert.throws(() => assertInternalNonpublication(dist, repo), /internal review-pack marker/);
});
