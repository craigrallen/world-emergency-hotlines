import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DERIVATION_FILES, FILES, generateAssurancePackContracts } from '../../web/scripts/generate-assurance-pack-contracts.mjs';

const realSource = resolve(import.meta.dirname, '../contracts/v1');
const repoRoot = resolve(import.meta.dirname, '../..');
function copyDependencies(root) { for (const name of DERIVATION_FILES) { const target = resolve(root, name); mkdirSync(dirname(target), { recursive: true }); cpSync(resolve(repoRoot, name), target); } }

test('publishes the exact closed manifest atomically', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'weh-assurance-generator-'));
  try {
    const source = resolve(root, 'source'); const output = resolve(root, 'public/v1');
    cpSync(realSource, source, { recursive: true }); mkdirSync(resolve(root, 'public'));
    generateAssurancePackContracts(source, output, root);
    assert.deepEqual(FILES, [...FILES].sort());
    for (const name of FILES) assert.deepEqual(readFileSync(resolve(output, name)), readFileSync(resolve(source, name)));
    assert.throws(() => generateAssurancePackContracts(source, output, root), /must be recreated/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects symlinked roots, sources, outputs, and occupied temporary paths', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'weh-assurance-generator-'));
  const outside = mkdtempSync(resolve(tmpdir(), 'weh-assurance-outside-'));
  try {
    const source = resolve(root, 'source'); const publicRoot = resolve(root, 'public'); const output = resolve(publicRoot, 'v1');
    cpSync(realSource, source, { recursive: true }); mkdirSync(publicRoot);
    symlinkSync(outside, resolve(root, 'link'));
    assert.throws(() => generateAssurancePackContracts(source, resolve(root, 'link/v1'), root), /symlink/);
    const linkedSource = resolve(root, 'linked-source'); symlinkSync(realSource, linkedSource);
    assert.throws(() => generateAssurancePackContracts(linkedSource, output, root), /symlink/);
    rmSync(resolve(source, FILES[0])); symlinkSync(resolve(realSource, FILES[0]), resolve(source, FILES[0]));
    assert.throws(() => generateAssurancePackContracts(source, output, root), /symlink|unsafe/);
    rmSync(resolve(source, FILES[0])); cpSync(resolve(realSource, FILES[0]), resolve(source, FILES[0]));
    mkdirSync(`${output}.tmp-${process.pid}`);
    assert.throws(() => generateAssurancePackContracts(source, output, root), /already exists/);
    assert.ok(lstatSync(`${output}.tmp-${process.pid}`).isDirectory());
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('rejects output-parent replacement before publish', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'weh-assurance-generator-'));
  try {
    const source = resolve(root, 'source'); const parent = resolve(root, 'public'); const output = resolve(parent, 'v1');
    cpSync(realSource, source, { recursive: true }); mkdirSync(parent);
    assert.throws(() => generateAssurancePackContracts(source, output, root, { beforePublish() { const moved = resolve(root, 'old-public'); cpSync(parent, moved, { recursive: true }); rmSync(parent, { recursive: true }); mkdirSync(parent); } }), /replaced during generation/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects a symlink occupying the stage name', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'weh-assurance-generator-'));
  try {
    const source = resolve(root, 'source'); const parent = resolve(root, 'public'); const output = resolve(parent, 'v1');
    cpSync(realSource, source, { recursive: true }); mkdirSync(parent); symlinkSync(source, `${output}.tmp-${process.pid}`);
    assert.throws(() => generateAssurancePackContracts(source, output, root), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects every symlinked derivation dependency', () => {
  for (const dependency of DERIVATION_FILES) {
    const root = mkdtempSync(resolve(tmpdir(), 'weh-assurance-generator-'));
    try {
      const source = resolve(root, 'source'); const output = resolve(root, 'public/v1'); const dependencyRoot = resolve(root, 'dependencies');
      cpSync(realSource, source, { recursive: true }); mkdirSync(resolve(root, 'public')); copyDependencies(dependencyRoot);
      const target = resolve(dependencyRoot, dependency); rmSync(target); symlinkSync(resolve(repoRoot, dependency), target);
      assert.throws(() => generateAssurancePackContracts(source, output, root, { dependencyRoot }), /symlink|unsafe/, dependency);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('detects derivation dependency replacement after exact-byte reads', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'weh-assurance-generator-'));
  try {
    const source = resolve(root, 'source'); const output = resolve(root, 'public/v1'); const dependencyRoot = resolve(root, 'dependencies');
    cpSync(realSource, source, { recursive: true }); mkdirSync(resolve(root, 'public')); copyDependencies(dependencyRoot);
    const target = resolve(dependencyRoot, DERIVATION_FILES[0]);
    assert.throws(() => generateAssurancePackContracts(source, output, root, { dependencyRoot, afterDependenciesRead() { const bytes = readFileSync(target); rmSync(target); cpSync(resolve(repoRoot, DERIVATION_FILES[0]), target); assert.deepEqual(readFileSync(target), bytes); } }), /changed during generation/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detects same-inode same-size in-place dependency mutation before publication', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'weh-assurance-generator-'));
  try {
    const source = resolve(root, 'source'); const output = resolve(root, 'public/v1'); const dependencyRoot = resolve(root, 'dependencies');
    cpSync(realSource, source, { recursive: true }); mkdirSync(resolve(root, 'public')); copyDependencies(dependencyRoot);
    const target = resolve(dependencyRoot, DERIVATION_FILES[1]); const before = lstatSync(target); const original = readFileSync(target); const changed = Buffer.from(original); changed[changed.indexOf(Buffer.from('assurance-trust-policy'))] = 'A'.charCodeAt(0);
    assert.throws(() => generateAssurancePackContracts(source, output, root, { dependencyRoot, beforePublish() { writeFileSync(target, changed); const after = lstatSync(target); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size); } }), /changed during generation/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
