import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';

import { FILES, generateDeprecationProposalContracts } from '../../web/scripts/generate-deprecation-proposal-contracts.mjs';

const contracts = resolve(import.meta.dirname, '../contracts/v1');

function workspace({ output = true } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'deprecation-parity-'));
  mkdirSync(resolve(root, 'source'));
  mkdirSync(resolve(root, 'public/deprecation-proposals'), { recursive: true });
  if (output) mkdirSync(resolve(root, 'public/deprecation-proposals/v1'));
  for (const name of FILES) {
    cpSync(resolve(contracts, name), resolve(root, 'source', name));
    if (output) cpSync(resolve(contracts, name), resolve(root, 'public/deprecation-proposals/v1', name));
  }
  return root;
}

function verify(root) {
  return generateDeprecationProposalContracts({
    source: resolve(root, 'source'),
    output: resolve(root, 'public/deprecation-proposals/v1'),
    managedRoot: root,
  });
}

function snapshot(root) {
  const result = {};
  function visit(path) {
    const metadata = lstatSync(path);
    const name = relative(root, path) || '.';
    if (metadata.isSymbolicLink()) result[name] = { type: 'symlink' };
    else if (metadata.isDirectory()) {
      result[name] = { type: 'directory' };
      for (const child of readdirSync(path).sort()) visit(resolve(path, child));
    } else result[name] = { type: 'file', bytes: readFileSync(path).toString('base64') };
  }
  visit(root);
  return result;
}

function assertNoStages(root) {
  assert.equal(Object.keys(snapshot(root)).some((name) => name.includes('.v1-stage-')), false);
}

test('exact tracked source and output are a strictly read-only no-op', () => {
  const root = workspace();
  try {
    const before = snapshot(root);
    assert.deepEqual(verify(root), { published: false, reason: 'exact_read_only_no_op' });
    assert.deepEqual(snapshot(root), before);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('absent tracked output fails closed and remains absent without a stage', () => {
  const root = workspace({ output: false });
  try {
    const before = snapshot(root);
    assert.throws(() => verify(root), /output is absent/);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assert.deepEqual(snapshot(root), before);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('mismatched tracked output fails closed and remains byte-identical', () => {
  const root = workspace();
  try {
    const output = resolve(root, 'public/deprecation-proposals/v1');
    writeFileSync(resolve(root, 'source/README.md'), 'different source bytes\n');
    const before = snapshot(output);
    const wholeTreeBefore = snapshot(root);
    assert.throws(() => verify(root), /differs from source/);
    assert.deepEqual(snapshot(output), before);
    assert.deepEqual(snapshot(root), wholeTreeBefore);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('unexpected tracked output manifest fails closed without mutation', () => {
  const root = workspace();
  try {
    writeFileSync(resolve(root, 'public/deprecation-proposals/v1/unexpected.txt'), 'unexpected bytes\n');
    const before = snapshot(root);
    assert.throws(() => verify(root), /unexpected deprecation-proposal manifest/);
    assert.deepEqual(snapshot(root), before);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('rejects source, output, and output-parent symlinks without writes or stages', () => {
  for (const target of ['source', 'public/deprecation-proposals/v1', 'public/deprecation-proposals']) {
    const root = workspace();
    try {
      const path = resolve(root, target);
      rmSync(path, { recursive: true });
      symlinkSync(resolve(root, 'public'), path);
      const before = snapshot(root);
      assert.throws(() => verify(root), /symlink|contract root/);
      assert.deepEqual(snapshot(root), before);
      assertNoStages(root);
    } finally { rmSync(root, { recursive: true }); }
  }
});
