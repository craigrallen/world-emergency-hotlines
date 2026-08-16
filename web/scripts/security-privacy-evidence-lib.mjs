import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export const INVENTORY_MARKER = 'internal-security-privacy-evidence-only/v1';
export const INVENTORY_PATH = 'reviews/security-privacy-evidence/v1/inventory.json';
export const STATUSES = Object.freeze(['verified_static', 'manual', 'not_assessed', 'held']);
export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function rejectDuplicateJsonMembers(source, label = 'JSON') {
  let i = 0;
  const ws = () => { while (/\s/.test(source[i] ?? '')) i++; };
  const string = () => { const start = i++; while (i < source.length) { if (source[i] === '\\') i += 2; else if (source[i++] === '"') return JSON.parse(source.slice(start, i)); } throw new SyntaxError(`${label}: unterminated string`); };
  const value = (path) => {
    ws();
    if (source[i] === '{') { i++; ws(); const keys = new Set(); if (source[i] === '}') { i++; return; } while (true) { ws(); if (source[i] !== '"') throw new SyntaxError(`${label}: expected object key`); const key = string(); if (keys.has(key)) throw new SyntaxError(`${label}: duplicate member ${[...path, key].join('.')}`); keys.add(key); ws(); if (source[i++] !== ':') throw new SyntaxError(`${label}: expected colon`); value([...path, key]); ws(); if (source[i] === '}') { i++; return; } if (source[i++] !== ',') throw new SyntaxError(`${label}: expected comma`); } }
    if (source[i] === '[') { i++; ws(); if (source[i] === ']') { i++; return; } while (true) { value(path); ws(); if (source[i] === ']') { i++; return; } if (source[i++] !== ',') throw new SyntaxError(`${label}: expected comma`); } }
    if (source[i] === '"') { string(); return; }
    const match = source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/); if (!match) throw new SyntaxError(`${label}: invalid value`); i += match[0].length;
  };
  value([]); ws(); if (i !== source.length) throw new SyntaxError(`${label}: trailing input`);
}

export function parseStrictJson(bytes, label = INVENTORY_PATH) {
  let source;
  try { source = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (error) { throw new SyntaxError(`${label}: malformed UTF-8`, { cause: error }); }
  assert.ok(!source.startsWith('\ufeff'), `${label}: UTF-8 BOM is not allowed`);
  rejectDuplicateJsonMembers(source, label);
  return JSON.parse(source);
}

const defaultIo = { execFileSync, lstatSync, realpathSync, openSync, fstatSync, readFileSync, closeSync };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const stableFile = (a, b) => sameFile(a, b) && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const EXPECTED_SECURITY_SCRIPTS = Object.freeze({
  'verify:security-privacy-evidence:dist': 'npm run test:security-privacy-evidence && node scripts/verify-security-privacy-evidence.mjs && npm run verify:internal-nonpublication:dist',
  'test:security-privacy-evidence': 'node --test scripts/security-privacy-evidence.test.mjs',
  'update:security-privacy-evidence-sources': 'node scripts/print-security-privacy-evidence-sources.mjs',
  'verify:security-privacy-evidence': 'npm run build && npm run verify:security-privacy-evidence:dist',
});

function gitIndexSnapshot(repo, options = {}) {
  const io = { ...defaultIo, ...(options.io ?? {}) };
  return Buffer.from(io.execFileSync('git', ['-C', io.realpathSync(repo), 'ls-files', '-s', '-z'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }));
}

function withStableGitIndex(repo, options, operation) {
  if (options.testOnlySkipGitIndex) return operation();
  const before = gitIndexSnapshot(repo, options);
  const result = operation();
  const after = gitIndexSnapshot(repo, options);
  assert.ok(before.equals(after), 'Git index changed during evidence operation');
  return result;
}

function assertWebCiContract(workflow) {
  assert.equal((workflow.match(/^jobs:\s*$/gm) ?? []).length, 1, 'Web CI must contain the expected jobs structure');
  const jobsStart = workflow.match(/^jobs:\s*$/m).index;
  const jobs = workflow.slice(jobsStart);
  assert.equal((jobs.match(/^  web:\s*$/gm) ?? []).length, 1, 'Web CI must contain exactly one jobs.web job');
  const webStart = jobs.match(/^  web:\s*$/m).index;
  const afterWeb = jobs.slice(webStart);
  const nextJob = afterWeb.slice(1).search(/^  [A-Za-z0-9_-]+:\s*$/m);
  const web = nextJob < 0 ? afterWeb : afterWeb.slice(0, nextJob + 1);
  assert.equal((web.match(/^    steps:\s*$/gm) ?? []).length, 1, 'Web CI jobs.web must contain exactly one steps list');
  assert.equal((web.match(/^    if\s*:/gm) ?? []).length, 0, 'Web CI jobs.web must not have a job-level condition');
  const exactStep = /^      - name: Build and verify all static contracts\r?\n        run: npm run verify:all\s*$/gm;
  assert.equal((web.match(exactStep) ?? []).length, 1, 'Web CI jobs.web must contain the exact active verify:all step contract');
  assert.equal((workflow.match(/^\s*run:\s*npm run verify:all\s*$/gm) ?? []).length, 1, 'Web CI must run npm run verify:all exactly once');
}

function readTrackedRegularFile(repo, path, options = {}) {
  const io = { ...defaultIo, ...(options.io ?? {}) };
  assert.equal(typeof path, 'string');
  assert.ok(path && !path.startsWith('/') && !path.split('/').some((part) => !part || part === '.' || part === '..'), `unsafe evidence path: ${path}`);
  const root = io.realpathSync(repo); let cursor = root;
  const ancestors = [[root, io.lstatSync(root, { bigint: true })]];
  for (const part of path.split('/')) { cursor = resolve(cursor, part); const meta = io.lstatSync(cursor, { bigint: true }); assert.ok(!meta.isSymbolicLink(), `symlinked evidence path: ${path}`); ancestors.push([cursor, meta]); }
  assert.equal(relative(root, io.realpathSync(cursor)).split(sep)[0], path.split('/')[0], `evidence path escapes repository: ${path}`);
  let fd;
  try {
    fd = io.openSync(cursor, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = io.fstatSync(fd, { bigint: true });
    assert.ok(before.isFile(), `evidence path is not a regular file: ${path}`);
    const bytes = io.readFileSync(fd);
    options.afterRead?.({ path, absolutePath: cursor, fd });
    const after = io.fstatSync(fd, { bigint: true });
    assert.ok(stableFile(before, after), `evidence descriptor changed during read: ${path}`);
    for (const [ancestorPath, ancestorBefore] of ancestors) {
      const ancestorAfter = io.lstatSync(ancestorPath, { bigint: true });
      assert.ok(!ancestorAfter.isSymbolicLink() && stableFile(ancestorBefore, ancestorAfter), `evidence path ancestor changed during read: ${path}`);
    }
    const pathAfter = io.lstatSync(cursor, { bigint: true });
    assert.ok(!pathAfter.isSymbolicLink() && pathAfter.isFile(), `evidence path changed type during read: ${path}`);
    assert.ok(stableFile(after, pathAfter), `evidence path changed during read: ${path}`);
    if (!options.testOnlySkipGitIndex) {
      let indexBytes;
      try {
        io.execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', path], { stdio: 'ignore' });
        indexBytes = io.execFileSync('git', ['-C', root, 'show', `:${path}`], { encoding: 'buffer', maxBuffer: Math.max(bytes.length + 1024, 1024 * 1024) });
      } catch { throw new Error(`evidence path is not present in the Git index: ${path}`); }
      assert.ok(Buffer.from(indexBytes).equals(bytes), `working-tree evidence bytes differ from Git index: ${path}`);
    }
    return { bytes, identity: `${after.dev}:${after.ino}` };
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

const exactKeys = (value, keys, label) => assert.deepEqual(Object.keys(value), keys, `${label}: fields changed`);
function validateInventoryOperation(inventory, repo, { verifyHashes = true, io, afterRead, testOnlySkipGitIndex = false } = {}) {
  exactKeys(inventory, ['schema_version', 'internal_only_marker', 'scope', 'disclaimer', 'status_vocabulary', 'sources', 'checks', 'categories'], 'inventory');
  assert.equal(inventory.schema_version, '1.0'); assert.equal(inventory.internal_only_marker, INVENTORY_MARKER); assert.equal(inventory.scope, 'repository_internal_deterministic_regression_evidence'); assert.match(inventory.disclaimer, /does not claim security or privacy compliance/); assert.deepEqual(inventory.status_vocabulary, STATUSES);
  assert.ok(inventory.sources && !Array.isArray(inventory.sources)); const paths = Object.keys(inventory.sources); assert.deepEqual(paths, [...paths].sort(), 'source paths must be sorted'); assert.ok(paths.length > 0);
  const identities = new Map();
  for (const path of paths) { assert.match(inventory.sources[path], /^sha256:[0-9a-f]{64}$/); const file = readTrackedRegularFile(repo, path, { io, afterRead, testOnlySkipGitIndex }); assert.ok(!identities.has(file.identity), `duplicate canonical file identity: ${path} aliases ${identities.get(file.identity)}`); identities.set(file.identity, path); if (verifyHashes) assert.equal(sha256(file.bytes), inventory.sources[path], `changed evidence bytes: ${path}`); }
  assert.ok(Array.isArray(inventory.checks) && inventory.checks.length > 0); const checkIds = new Set(); const commands = new Set();
  const readOptions = { io, afterRead, testOnlySkipGitIndex };
  const packageScripts = parseStrictJson(readTrackedRegularFile(repo, 'web/package.json', readOptions).bytes, 'web/package.json').scripts;
  const workflow = readTrackedRegularFile(repo, '.github/workflows/web-ci.yml', readOptions).bytes.toString('utf8');
  assertWebCiContract(workflow);
  assert.equal((packageScripts['verify:all']?.match(/(?:^|\s&&\s)npm run verify:security-privacy-evidence:dist(?=\s&&\s|$)/g) ?? []).length, 1, 'verify:all must include exactly one security/privacy dist verifier');
  for (const [name, command] of Object.entries(EXPECTED_SECURITY_SCRIPTS)) assert.equal(packageScripts[name], command, `closed security/privacy wrapper wiring changed: ${name}`);
  for (const check of inventory.checks) { exactKeys(check, ['id', 'command'], `check ${check.id ?? '<missing>'}`); assert.match(check.id, /^[a-z0-9_]+$/); assert.ok(!checkIds.has(check.id), `duplicate check id: ${check.id}`); assert.ok(!commands.has(check.command), `duplicate check command: ${check.command}`); checkIds.add(check.id); commands.add(check.command); const npm = check.command.match(/^npm run ([a-z0-9:.-]+)$/); if (npm) assert.equal(typeof packageScripts[npm[1]], 'string', `missing package script for check: ${check.command}`); else assert.equal(check.command, 'sh web/scripts/verify-docker-image.sh', `unsupported check command: ${check.command}`); }
  assert.ok(Array.isArray(inventory.categories) && inventory.categories.length > 0); const categoryIds = new Set(); const assertionIds = new Set(); let gaps = 0;
  for (const category of inventory.categories) { exactKeys(category, ['id', 'assertions'], `category ${category.id ?? '<missing>'}`); assert.match(category.id, /^[a-z0-9_]+$/); assert.ok(!categoryIds.has(category.id), `duplicate category id: ${category.id}`); categoryIds.add(category.id); assert.ok(category.assertions.length > 0);
    for (const item of category.assertions) { exactKeys(item, ['id', 'status', 'statement', 'evidence', 'checks'], `assertion ${item.id ?? '<missing>'}`); assert.match(item.id, /^[a-z0-9_]+$/); assert.ok(!assertionIds.has(item.id), `duplicate assertion id: ${item.id}`); assertionIds.add(item.id); assert.ok(STATUSES.includes(item.status), `unknown status: ${item.status}`); assert.ok(item.statement.length > 10); assert.ok(Array.isArray(item.evidence) && item.evidence.length > 0); assert.equal(new Set(item.evidence).size, item.evidence.length); for (const path of item.evidence) assert.ok(Object.hasOwn(inventory.sources, path), `unbound evidence path: ${path}`); assert.ok(Array.isArray(item.checks)); assert.equal(new Set(item.checks).size, item.checks.length, `duplicate check reference: ${item.id}`); for (const id of item.checks) assert.ok(checkIds.has(id), `unknown check id: ${id}`); if (item.status === 'verified_static') assert.ok(item.checks.length > 0, `verified_static assertion ${item.id} must cite a check`); else { gaps++; assert.equal(item.checks.length, 0, `gap ${item.id} must not cite an automated check`); } }
  }
  const wiring = [...inventory.categories.flatMap(({ assertions }) => assertions)].find(({ id }) => id === 'required_web_ci_wiring');
  assert.ok(wiring, 'required_web_ci_wiring assertion is missing');
  assert.equal(wiring.status, 'verified_static');
  assert.deepEqual(wiring.evidence, ['.github/workflows/web-ci.yml', 'web/package.json', 'web/scripts/security-privacy-evidence-lib.mjs', 'web/scripts/security-privacy-evidence.test.mjs', 'web/scripts/verify-security-privacy-evidence.mjs']);
  assert.deepEqual(wiring.checks, ['web_verify_security_privacy_evidence']);
  assert.ok(gaps >= 3, 'inventory must retain explicit manual/not-assessed/held gaps'); return inventory;
}

export function validateInventory(inventory, repo, options = {}) {
  return withStableGitIndex(repo, options, () => validateInventoryOperation(inventory, repo, options));
}

export function loadInventory(repo, options = {}) { const file = readTrackedRegularFile(repo, INVENTORY_PATH, options); const inventory = parseStrictJson(file.bytes); validateInventory(inventory, repo, options); assert.ok(file.bytes.length > 0 && file.bytes.at(-1) === 0x0a, 'inventory must end with one LF'); return inventory; }
export function sourceMap(repo, paths, options = {}) { return withStableGitIndex(repo, options, () => { const identities = new Map(); return Object.fromEntries([...paths].sort().map((path) => { const file = readTrackedRegularFile(repo, path, options); assert.ok(!identities.has(file.identity), `duplicate canonical file identity: ${path} aliases ${identities.get(file.identity)}`); identities.set(file.identity, path); return [path, sha256(file.bytes)]; })); }); }
