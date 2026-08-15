import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';

import { FILES, PUBLICATION_THREAT_MODEL, generateDeprecationProposalContracts } from '../../web/scripts/generate-deprecation-proposal-contracts.mjs';

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

function verify(root, hooks, descriptorIO) {
  return generateDeprecationProposalContracts({
    source: resolve(root, 'source'),
    output: resolve(root, 'public/deprecation-proposals/v1'),
    managedRoot: root,
    hooks,
    descriptorIO,
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
  assert.equal(Object.keys(snapshot(root)).some((name) => name.includes('v1.stage-')), false);
}

function trackedIO({ failOpenAt, failCloseAt } = {}) {
  const opened = [];
  const closed = [];
  let openCount = 0;
  let closeCount = 0;
  return {
    opened,
    closed,
    io: {
      openSync(path, flags, mode) {
        openCount++;
        if (openCount === failOpenAt) throw new Error('injected descriptor exhaustion');
        const fd = openSync(path, flags, mode);
        opened.push(fd);
        return fd;
      },
      closeSync(fd) {
        closeCount++;
        closed.push(fd);
        closeSync(fd);
        if (closeCount === failCloseAt) throw new Error('injected ambiguous close failure');
      },
    },
  };
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

test('absent managed output atomically regenerates exact source bytes', () => {
  const root = workspace({ output: false });
  try {
    assert.deepEqual(verify(root), { published: true, reason: 'regenerated_from_absent_output' });
    for (const name of FILES) assert.deepEqual(readFileSync(resolve(root, 'public/deprecation-proposals/v1', name)), readFileSync(resolve(root, 'source', name)));
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('failure after partial staged writes leaves no output or owned stage', () => {
  const root = workspace({ output: false });
  try {
    assert.throws(() => verify(root, { afterStageWrite({ index }) { if (index === 1) throw new Error('injected interruption'); } }), /injected interruption/);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/.deprecation-proposals.lock')), false);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('exclusive lock rejects a concurrent writer without partial output', () => {
  const root = workspace({ output: false });
  try {
    const lock = resolve(root, 'public/deprecation-proposals/.deprecation-proposals.lock');
    writeFileSync(lock, 'other writer\n');
    assert.throws(() => verify(root), /EEXIST/);
    assert.equal(readFileSync(lock, 'utf8'), 'other writer\n');
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('publication contract is explicitly limited to lock-cooperating writers', () => {
  assert.deepEqual(PUBLICATION_THREAT_MODEL, {
    writers: 'cooperative_single_writer',
    coordination: 'exclusive_lock',
    uncooperativeFilesystemActorProtected: false,
  });
  assert.equal(Object.isFrozen(PUBLICATION_THREAT_MODEL), true);
});

test('replaced lock fails closed and cleanup preserves replacement', () => {
  const root = workspace({ output: false });
  try {
    const lock = resolve(root, 'public/deprecation-proposals/.deprecation-proposals.lock');
    assert.throws(() => verify(root, { beforeRename() { unlinkSync(lock); writeFileSync(lock, 'replacement\n'); } }), /publication lock replaced/);
    assert.equal(readFileSync(lock, 'utf8'), 'replacement\n');
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('replaced stage fails closed and cleanup preserves replacement stage', () => {
  const root = workspace({ output: false });
  try {
    let replacement;
    assert.throws(() => verify(root, { beforePublish({ stage }) { const owned = `${stage}-owned`; renameSync(stage, owned); mkdirSync(stage); writeFileSync(resolve(stage, 'replacement'), 'other writer\n'); rmSync(owned, { recursive: true }); replacement = stage; } }), /stage replaced/);
    assert.equal(readFileSync(resolve(replacement, 'replacement'), 'utf8'), 'other writer\n');
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    rmSync(replacement, { recursive: true });
  } finally { rmSync(root, { recursive: true }); }
});

test('staged byte mutation after parity validation fails without publication', () => {
  const root = workspace({ output: false });
  try {
    assert.throws(() => verify(root, { beforePublish({ stage }) { writeFileSync(resolve(stage, FILES[0]), 'changed staged bytes\n'); } }), /changed before publication/);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('identical-byte staged replacement fails without publication', () => {
  const root = workspace({ output: false });
  try {
    assert.throws(() => verify(root, { beforePublish({ stage }) {
      const target = resolve(stage, FILES[0]);
      unlinkSync(target);
      writeFileSync(target, readFileSync(resolve(root, 'source', FILES[0])));
    } }), /changed before publication/);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('identical-byte replacement after stage inspection is rejected with replacement-safe cleanup and exact-once descriptor closes', () => {
  const root = workspace({ output: false });
  try {
    const tracked = trackedIO();
    let stage;
    assert.throws(() => verify(root, { afterStageInspection(context) {
      stage = context.stage;
      const target = resolve(stage, FILES[1]);
      const bytes = readFileSync(target);
      unlinkSync(target);
      writeFileSync(target, bytes);
    } }, tracked.io), /changed before pinning/);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assert.equal(existsSync(stage), false);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/.deprecation-proposals.lock')), false);
    assert.deepEqual([...tracked.closed].sort((a, b) => a - b), [...tracked.opened].sort((a, b) => a - b));
    assert.equal(new Set(tracked.closed).size, tracked.closed.length);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('beforeRename is the documented last hook and its replacement is rejected by the immediately following final checkpoint', () => {
  const root = workspace({ output: false });
  try {
    const tracked = trackedIO();
    let stage;
    assert.throws(() => verify(root, { beforeRename(context) {
      stage = context.stage;
      const target = resolve(stage, FILES[0]);
      unlinkSync(target);
      writeFileSync(target, readFileSync(resolve(root, 'source', FILES[0])));
    } }, tracked.io), /changed before publication/);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assert.equal(existsSync(stage), false);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/.deprecation-proposals.lock')), false);
    assert.equal(tracked.closed.length, tracked.opened.length);
    assert.equal(new Set(tracked.closed).size, tracked.closed.length);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('partial pin acquisition exhaustion closes every acquired descriptor exactly once', () => {
  const root = workspace({ output: false });
  try {
    const tracked = trackedIO({ failOpenAt: 4 });
    assert.throws(() => verify(root, undefined, tracked.io), /descriptor exhaustion/);
    assert.deepEqual([...tracked.closed].sort((a, b) => a - b), [...tracked.opened].sort((a, b) => a - b));
    assert.equal(new Set(tracked.closed).size, tracked.closed.length);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/.deprecation-proposals.lock')), false);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('close failure attempts all descriptors once, preserves original error, and removes owned lock', () => {
  const root = workspace({ output: false });
  try {
    const tracked = trackedIO({ failCloseAt: 1 });
    assert.throws(() => verify(root, { beforePublish() { throw new Error('original transaction failure'); } }, tracked.io), /^Error: original transaction failure$/);
    assert.equal(tracked.closed.length, tracked.opened.length);
    assert.equal(new Set(tracked.closed).size, tracked.closed.length);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/.deprecation-proposals.lock')), false);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('lock close failure does not prevent identity cleanup or cause a second close', () => {
  const root = workspace({ output: false });
  try {
    const tracked = trackedIO({ failCloseAt: FILES.length + 1 });
    assert.throws(() => verify(root, { beforePublish() { throw new Error('stop before publication'); } }, tracked.io), /stop before publication/);
    assert.equal(tracked.closed.length, tracked.opened.length);
    assert.equal(new Set(tracked.closed).size, tracked.closed.length);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/.deprecation-proposals.lock')), false);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), false);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('cleanup failure without a transaction error is surfaced after publication cleanup', () => {
  const root = workspace({ output: false });
  try {
    const tracked = trackedIO({ failCloseAt: 1 });
    assert.throws(() => verify(root, undefined, tracked.io), /ambiguous close failure/);
    assert.equal(tracked.closed.length, tracked.opened.length);
    assert.equal(new Set(tracked.closed).size, tracked.closed.length);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/.deprecation-proposals.lock')), false);
    assert.equal(existsSync(resolve(root, 'public/deprecation-proposals/v1')), true);
    assertNoStages(root);
  } finally { rmSync(root, { recursive: true }); }
});

test('descriptor IO seam rejects extra or missing capabilities', () => {
  const root = workspace({ output: false });
  try {
    for (const descriptorIO of [{ openSync }, { openSync, closeSync, extra: true }]) {
      assert.throws(() => verify(root, undefined, descriptorIO), /must contain exactly/);
    }
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
