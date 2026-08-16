import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import { INVENTORY_PATH, loadInventory, parseStrictJson, sourceMap, validateInventory } from './security-privacy-evidence-lib.mjs';
import { assertInternalNonpublication, forbiddenInternalEvidence } from './verify-internal-nonpublication.mjs';

const repo = resolve(import.meta.dirname, '../..');
const committed = parseStrictJson(readFileSync(resolve(repo, INVENTORY_PATH)));
const clone = () => structuredClone(committed);
const temporaryRoots = [];
const temporaryRoot = (prefix) => { const root = mkdtempSync(resolve(tmpdir(), prefix)); temporaryRoots.push(root); return root; };
afterEach(() => { for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const copiedRepo = () => { const root = temporaryRoot('weh-sp-evidence-'); cpSync(repo, root, { recursive: true, filter: (source) => !source.split('/').some((part) => part === 'node_modules' || part === 'dist' || part === '.git') }); return root; };
const copiedOptions = { testOnlySkipGitIndex: true };

test('committed inventory and exact tracked source bytes verify', () => assert.doesNotThrow(() => loadInventory(repo)));
test('real Git index parity rejects staged source bytes differing from working-tree bytes', () => {
  const root = temporaryRoot('weh-sp-index-'); const path = resolve(root, 'source.txt'); writeFileSync(path, 'staged\n');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '--', 'source.txt']); writeFileSync(path, 'working tree\n');
  assert.throws(() => sourceMap(root, ['source.txt']), /working-tree evidence bytes differ from Git index/);
});
test('whole-index snapshot rejects an unrelated concurrent restage during source-map generation', () => {
  const root = temporaryRoot('weh-sp-index-snapshot-'); writeFileSync(resolve(root, 'source.txt'), 'source\n'); writeFileSync(resolve(root, 'unrelated.txt'), 'before\n');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '--', 'source.txt', 'unrelated.txt']);
  let mutated = false;
  assert.throws(() => sourceMap(root, ['source.txt'], { afterRead: () => { if (mutated) return; mutated = true; writeFileSync(resolve(root, 'unrelated.txt'), 'after\n'); execFileSync('git', ['-C', root, 'add', '--', 'unrelated.txt']); } }), /Git index changed during evidence operation/);
});
test('strict JSON rejects duplicate members, malformed syntax, BOM, and trailing bytes', () => {
  assert.throws(() => parseStrictJson('{"x":1,"x":2}'), /duplicate member/); assert.throws(() => parseStrictJson('{'), /expected object key|invalid/);
  assert.throws(() => parseStrictJson(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), /BOM/); assert.throws(() => parseStrictJson(Buffer.from('{}x')), /trailing input/);
});
test('strict JSON rejects malformed UTF-8 raw bytes', () => {
  for (const bytes of [[0x7b, 0xff, 0x7d], [0x7b, 0x80, 0x7d], [0x7b, 0xc2, 0x7d], [0x7b, 0xe2, 0x82], [0x7b, 0xc0, 0xaf, 0x7d], [0x7b, 0xf0, 0x80, 0x80, 0xaf, 0x7d]]) assert.throws(() => parseStrictJson(Buffer.from(bytes)), /malformed UTF-8/);
});
test('schema extras, missing fields, duplicate assertions, unknown status, and unbound evidence fail', () => {
  const missing = clone(); delete missing.categories[0].assertions[0].status; assert.throws(() => validateInventory(missing, repo, { verifyHashes: false }), /fields changed/);
  const extra = clone(); extra.categories[0].unexpected = true; assert.throws(() => validateInventory(extra, repo, { verifyHashes: false }), /fields changed/);
  const duplicate = clone(); duplicate.categories[0].assertions.push(structuredClone(duplicate.categories[0].assertions[0])); assert.throws(() => validateInventory(duplicate, repo, { verifyHashes: false }), /duplicate assertion/);
  const unknown = clone(); unknown.categories[0].assertions[0].status = 'certified'; assert.throws(() => validateInventory(unknown, repo, { verifyHashes: false }), /unknown status/);
  const unbound = clone(); unbound.categories[0].assertions[0].evidence = ['README.md']; assert.throws(() => validateInventory(unbound, repo, { verifyHashes: false }), /unbound evidence/);
});
test('verified checks are nonempty and unique; check IDs, commands, and vocabulary are closed', () => {
  const empty = clone(); empty.categories[0].assertions[0].checks = []; assert.throws(() => validateInventory(empty, repo, { verifyHashes: false }), /must cite a check/);
  const reference = clone(); reference.categories[0].assertions[0].checks = ['web_verify_data', 'web_verify_data']; assert.throws(() => validateInventory(reference, repo, { verifyHashes: false }), /duplicate check reference/);
  const id = clone(); id.checks.push({ ...id.checks[0], command: 'npm run verify:search' }); assert.throws(() => validateInventory(id, repo, { verifyHashes: false }), /duplicate check id/);
  const command = clone(); command.checks.push({ id: 'another_check', command: command.checks[0].command }); assert.throws(() => validateInventory(command, repo, { verifyHashes: false }), /duplicate check command/);
  const unsupported = clone(); unsupported.checks[0].command = 'node arbitrary.mjs'; assert.throws(() => validateInventory(unsupported, repo, { verifyHashes: false }), /unsupported check command/);
});
test('missing files, directory substitution, and untracked sources fail closed', () => {
  const root = copiedRepo(); const source = Object.keys(committed.sources)[0]; unlinkSync(resolve(root, source)); assert.throws(() => validateInventory(committed, root, { verifyHashes: false, ...copiedOptions }), /ENOENT/);
  const root2 = copiedRepo(); const source2 = Object.keys(committed.sources)[0]; unlinkSync(resolve(root2, source2)); mkdirSync(resolve(root2, source2)); assert.throws(() => validateInventory(committed, root2, { verifyHashes: false, ...copiedOptions }), /regular file/);
  assert.throws(() => validateInventory(committed, repo, { verifyHashes: false, io: { execFileSync: (command, args, options) => { if (args.includes('-s')) return execFileSync(command, args, options); throw new Error('untracked'); } } }), /not present in the Git index/);
});
test('ancestor and leaf symlinks fail closed', () => {
  const root = copiedRepo(); const leaf = resolve(root, 'Caddyfile'); renameSync(leaf, `${leaf}.real`); symlinkSync('Caddyfile.real', leaf); assert.throws(() => validateInventory(committed, root, { verifyHashes: false, ...copiedOptions }), /symlinked evidence path/);
  const root2 = copiedRepo(); const dir = resolve(root2, 'gateway'); renameSync(dir, `${dir}.real`); symlinkSync('gateway.real', dir); assert.throws(() => validateInventory(committed, root2, { verifyHashes: false, ...copiedOptions }), /symlinked evidence path/);
});
test('hard-link aliases and observed leaf replacement fail closed', () => {
  const root = copiedRepo(); const inventory = clone(); const alias = 'Caddyfile.alias'; linkSync(resolve(root, 'Caddyfile'), resolve(root, alias)); inventory.sources[alias] = inventory.sources.Caddyfile; inventory.sources = Object.fromEntries(Object.entries(inventory.sources).sort()); assert.throws(() => validateInventory(inventory, root, { verifyHashes: false, ...copiedOptions }), /duplicate canonical file identity/);
  const root2 = copiedRepo(); let replaced = false; assert.throws(() => validateInventory(committed, root2, { verifyHashes: false, ...copiedOptions, afterRead: ({ path, absolutePath }) => { if (!replaced && path === '.dockerignore') { replaced = true; const replacement = `${absolutePath}.replacement`; writeFileSync(replacement, readFileSync(absolutePath)); renameSync(replacement, absolutePath); } } }), /changed during read/);
});
test('deterministic ancestor replacement after the descriptor read fails closed', () => {
  const root = copiedRepo(); let replaced = false;
  assert.throws(() => validateInventory(committed, root, { verifyHashes: false, ...copiedOptions, afterRead: ({ path }) => {
    if (replaced || path !== 'gateway/contracts/v1/privacy.json') return;
    replaced = true; const directory = resolve(root, 'gateway/contracts/v1'); const old = `${directory}.old`; renameSync(directory, old); mkdirSync(directory); copyFileSync(resolve(old, 'privacy.json'), resolve(directory, 'privacy.json'));
  } }), /ancestor changed during read/);
});
test('CI, verify:all, and every public security/privacy wrapper are inspected', () => {
  const mutations = [
    ['.github/workflows/web-ci.yml', (text) => text.replace('run: npm run verify:all', 'run: npm run typecheck')],
    ['.github/workflows/web-ci.yml', (text) => text.replace('      - name: Build and verify all static contracts\n        run: npm run verify:all', '      - name: Build and verify all static contracts\n        run: npm run typecheck\n\n      - name: Disabled unrelated command\n        if: false\n        run: npm run verify:all')],
    ['.github/workflows/web-ci.yml', (text) => text.replace('      - name: Build and verify all static contracts\n        run: npm run verify:all', '      - name: Build and verify all static contracts\n        run: npm run typecheck\n\n  unrelated:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - name: Unrelated command\n        run: npm run verify:all')],
    ['.github/workflows/web-ci.yml', (text) => text.replace('  web:\n', '  web:\n    if: false\n')],
    ['web/package.json', (text) => text.replace(' && npm run verify:security-privacy-evidence:dist', '')],
    ...['verify:security-privacy-evidence:dist', 'test:security-privacy-evidence', 'update:security-privacy-evidence-sources', 'verify:security-privacy-evidence'].map((name) => ['web/package.json', (text) => { const value = JSON.parse(text); value.scripts[name] = 'node unexpected.mjs'; return `${JSON.stringify(value, null, 2)}\n`; }]),
  ];
  for (const [path, mutate] of mutations) { const root = copiedRepo(); const target = resolve(root, path); writeFileSync(target, mutate(readFileSync(target, 'utf8'))); assert.throws(() => validateInventory(committed, root, { verifyHashes: false, ...copiedOptions }), /Web CI|verify:all|closed security\/privacy wrapper wiring/); }
});
test('renamed exact copies are caught; modified marker-stripped copies are outside the stated scan', () => {
  const root = temporaryRoot('weh-sp-nonpub-'); const dist = resolve(root, 'dist'); mkdirSync(dist); cpSync(resolve(repo, INVENTORY_PATH), resolve(dist, 'arbitrary.bin')); assert.throws(() => assertInternalNonpublication(dist, repo), /security\/privacy|internal review/);
  const root2 = temporaryRoot('weh-sp-nonpub-'); const dist2 = resolve(root2, 'dist'); mkdirSync(dist2); let modified = readFileSync(resolve(repo, INVENTORY_PATH), 'utf8'); for (const marker of forbiddenInternalEvidence(repo).markers) modified = modified.replaceAll(marker, 'marker-removed'); writeFileSync(resolve(dist2, 'arbitrary.bin'), modified); assert.doesNotThrow(() => assertInternalNonpublication(dist2, repo));
});
