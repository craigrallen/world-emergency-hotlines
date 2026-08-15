import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
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
  if (!existsSync(output)) throw new Error('tracked deprecation-proposal output is absent');
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
