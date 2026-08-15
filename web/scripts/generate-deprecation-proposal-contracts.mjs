import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const SOURCE = resolve(REPO_ROOT, 'deprecation-proposals/contracts/v1');
const OUTPUT = resolve(WEB_ROOT, 'public/deprecation-proposals/v1');

export const FILES = Object.freeze([
  'README.md',
  'audit-export.schema.json',
  'audit-export.synthetic.json',
  'proposal-with-replacement.synthetic.json',
  'proposal-without-replacement.synthetic.json',
  'proposal.schema.json',
  'review-checkpoint.schema.json',
]);

function components(path, root) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || rel.split(sep).some((part) => !part || part === '.' || part === '..')) {
    throw new Error('unsafe deprecation-proposal path');
  }
  const result = [{ path: root, metadata: lstatSync(root) }];
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) break;
    result.push({ path: cursor, metadata: lstatSync(cursor) });
  }
  for (const [index, item] of result.entries()) {
    if (item.metadata.isSymbolicLink()) throw new Error(`refusing symlink component: ${item.path}`);
    if (index < result.length - 1 && !item.metadata.isDirectory()) throw new Error(`path component is not a directory: ${item.path}`);
  }
  return result;
}

function inspect(root, managedRoot = REPO_ROOT) {
  const pins = components(root, managedRoot);
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('contract root must be a real directory');
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify([...FILES].sort())) throw new Error('unexpected deprecation-proposal manifest');
  const bytes = new Map();
  for (const name of FILES) {
    const path = resolve(root, name);
    const file = lstatSync(path);
    if (file.isSymbolicLink() || !file.isFile()) throw new Error(`unsafe contract artifact: ${name}`);
    if (constants.O_NOFOLLOW === undefined) throw new Error('O_NOFOLLOW support is required');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      const value = readFileSync(fd);
      const after = fstatSync(fd);
      if (opened.dev !== file.dev || opened.ino !== file.ino || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error(`contract artifact changed during read: ${name}`);
      bytes.set(name, value);
    } finally {
      closeSync(fd);
    }
  }
  for (const item of pins) {
    const current = lstatSync(item.path);
    if (current.isSymbolicLink() || current.dev !== item.metadata.dev || current.ino !== item.metadata.ino) throw new Error(`contract path replaced during read: ${item.path}`);
  }
  return { bytes };
}

function equal(left, right) {
  return FILES.every((name) => left.bytes.get(name).equals(right.bytes.get(name)));
}

export function generateDeprecationProposalContracts(options = {}) {
  const source = resolve(options.source ?? SOURCE);
  const output = resolve(options.output ?? OUTPUT);
  const managedRoot = resolve(options.managedRoot ?? REPO_ROOT);
  const parent = resolve(output, '..');
  const sourceState = inspect(source, managedRoot);
  components(parent, managedRoot);
  const parentIdentity = lstatSync(parent);
  if (parentIdentity.isSymbolicLink() || !parentIdentity.isDirectory()) throw new Error('output parent must be a real directory');
  if (!existsSync(output)) {
    if (constants.O_NOFOLLOW === undefined) throw new Error('O_NOFOLLOW support is required');
    const lock = resolve(parent, '.deprecation-proposals.lock');
    const stage = `${output}.stage-${process.pid}-${randomUUID()}`;
    components(lock, managedRoot);
    components(stage, managedRoot);
    let lockFd;
    let lockIdentity;
    let stageIdentity;
    try {
      lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      lockIdentity = fstatSync(lockFd);
      writeFileSync(lockFd, `${process.pid}\n`);
      if (existsSync(output)) throw new Error('deprecation-proposal output appeared during generation');
      mkdirSync(stage, { mode: 0o755 });
      stageIdentity = lstatSync(stage);
      if (stageIdentity.isSymbolicLink() || !stageIdentity.isDirectory()) throw new Error('unsafe deprecation-proposal stage');
      for (const [index, name] of FILES.entries()) {
        const fd = openSync(resolve(stage, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        try { writeFileSync(fd, sourceState.bytes.get(name)); } finally { closeSync(fd); }
        options.hooks?.afterStageWrite?.({ index, name, stage, output, lock });
      }
      const stagedState = inspect(stage, managedRoot);
      if (!equal(stagedState, sourceState)) throw new Error('staged deprecation-proposal output differs from source');
      options.hooks?.beforePublish?.({ stage, output, lock });
      const currentParent = lstatSync(parent);
      if (currentParent.isSymbolicLink() || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) throw new Error('output parent replaced before publication');
      const currentStage = lstatSync(stage);
      if (currentStage.isSymbolicLink() || currentStage.dev !== stageIdentity.dev || currentStage.ino !== stageIdentity.ino) throw new Error('deprecation-proposal stage replaced');
      if (!equal(inspect(source, managedRoot), sourceState)) throw new Error('deprecation-proposal source changed before publication');
      if (!equal(inspect(stage, managedRoot), sourceState)) throw new Error('staged deprecation-proposal output changed before publication');
      if (existsSync(output)) throw new Error('deprecation-proposal output appeared during generation');
      options.hooks?.beforeRename?.({ stage, output, lock });
      const lockPathIdentity = lstatSync(lock);
      const heldLockIdentity = fstatSync(lockFd);
      if (lockPathIdentity.isSymbolicLink() || lockPathIdentity.dev !== lockIdentity.dev || lockPathIdentity.ino !== lockIdentity.ino || heldLockIdentity.dev !== lockIdentity.dev || heldLockIdentity.ino !== lockIdentity.ino) throw new Error('deprecation-proposal publication lock replaced');
      renameSync(stage, output);
      stageIdentity = undefined;
      return Object.freeze({ published: true, reason: 'regenerated_from_absent_output' });
    } catch (error) {
      if (stageIdentity && existsSync(stage)) {
        const currentStage = lstatSync(stage);
        if (!currentStage.isSymbolicLink() && currentStage.dev === stageIdentity.dev && currentStage.ino === stageIdentity.ino) rmSync(stage, { recursive: true });
      }
      throw error;
    } finally {
      if (lockFd !== undefined) {
        closeSync(lockFd);
        if (existsSync(lock)) {
          const currentLock = lstatSync(lock);
          if (!currentLock.isSymbolicLink() && currentLock.dev === lockIdentity.dev && currentLock.ino === lockIdentity.ino) unlinkSync(lock);
        }
      }
    }
  }
  const outputState = inspect(output, managedRoot);
  const currentParent = lstatSync(parent);
  if (currentParent.isSymbolicLink() || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) {
    throw new Error('output parent replaced during verification');
  }
  if (!equal(outputState, sourceState)) throw new Error('tracked output differs from source');
  return Object.freeze({ published: false, reason: 'exact_read_only_no_op' });
}

export function verifyDeprecationProposalContractDrift(source = SOURCE, output = OUTPUT) {
  const sourceState = inspect(resolve(source));
  const outputState = inspect(resolve(output));
  if (!equal(sourceState, outputState)) throw new Error('stale deprecation-proposal contract output');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) generateDeprecationProposalContracts();
