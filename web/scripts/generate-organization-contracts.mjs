import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO = resolve(WEB, '..');
const SOURCE = resolve(REPO, 'control-plane/v1');
const OUTPUT = resolve(WEB, 'public/organizations/v1');
export const FILES = Object.freeze(['README.md', 'fixture.synthetic.json', 'model.schema.json', 'openapi.json']);

function safeContained(path, root) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || rel.split(sep).some((part) => !part || part === '.' || part === '..')) throw new Error(`unsafe organization contract path: ${path}`);
  let cursor = root;
  if (lstatSync(cursor).isSymbolicLink() || !lstatSync(cursor).isDirectory()) throw new Error('managed root must be a real directory');
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) return;
    const meta = lstatSync(cursor);
    if (meta.isSymbolicLink()) throw new Error(`refusing symlink path component: ${cursor}`);
    if (cursor !== path && !meta.isDirectory()) throw new Error(`path ancestor is not a directory: ${cursor}`);
  }
}

function validateManifest(root, label, managedRoot = REPO) {
  safeContained(root, managedRoot);
  const meta = lstatSync(root);
  if (meta.isSymbolicLink() || !meta.isDirectory()) throw new Error(`${label} must be a real directory`);
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(FILES)) throw new Error(`unexpected ${label} manifest`);
  for (const name of FILES) {
    const item = lstatSync(resolve(root, name));
    if (item.isSymbolicLink() || !item.isFile()) throw new Error(`unsafe ${label} entry: ${name}`);
  }
}

export function verifyOrganizationContractDrift(source = SOURCE, output = OUTPUT, managedRoot = REPO) {
  validateManifest(resolve(source), 'organization contract source', resolve(managedRoot));
  validateManifest(resolve(output), 'organization public output', resolve(managedRoot));
  for (const name of FILES) if (!readFileSync(resolve(source, name)).equals(readFileSync(resolve(output, name)))) throw new Error(`stale organization public contract: ${name}`);
}

function generateInto(source, output, managedRoot, afterWrite) {
  validateManifest(source, 'organization contract source', managedRoot);
  safeContained(output, managedRoot);
  if (existsSync(output)) throw new Error('organization output must be recreated before generation');
  const temporary = `${output}.tmp-${process.pid}`;
  safeContained(temporary, managedRoot);
  if (existsSync(temporary)) throw new Error('organization temporary output already exists');
  try {
    mkdirSync(temporary);
    for (const [index, name] of FILES.entries()) {
      writeFileSync(resolve(temporary, name), readFileSync(resolve(source, name)), { flag: 'wx' });
      afterWrite?.({ name, index });
    }
    renameSync(temporary, output);
  } catch (error) {
    if (existsSync(temporary) && !lstatSync(temporary).isSymbolicLink()) rmSync(temporary, { recursive: true });
    throw error;
  }
}

export function generateOrganizationContracts() { generateInto(SOURCE, OUTPUT, REPO); }
export function generateOrganizationContractsForTest({ source, output, managedRoot, afterWrite }) { generateInto(resolve(source), resolve(output), resolve(managedRoot), afterWrite); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateOrganizationContracts();
