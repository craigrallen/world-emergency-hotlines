import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const SOURCE = resolve(REPO_ROOT, 'technical-health/contracts/v1');
const OUTPUT = resolve(WEB_ROOT, 'public/technical-health/v1');
export const FILES = Object.freeze(['README.md','aggregate-batch.schema.json','aggregate.synthetic.json','dashboard.schema.json','dashboard.synthetic.json']);

function check(root) {
  const rel = relative(REPO_ROOT, root);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error('unsafe technical-health path');
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('technical-health root must be a real directory');
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify([...FILES].sort())) throw new Error('unexpected technical-health contract manifest');
  for (const name of FILES) if (!lstatSync(resolve(root, name)).isFile() || lstatSync(resolve(root, name)).isSymbolicLink()) throw new Error(`unsafe technical-health artifact: ${name}`);
}

export function generateTechnicalHealthContracts() {
  check(SOURCE);
  if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true });
  mkdirSync(OUTPUT, { recursive: true });
  for (const name of FILES) cpSync(resolve(SOURCE, name), resolve(OUTPUT, name), { errorOnExist: true });
}

export function verifyTechnicalHealthContractDrift() {
  check(SOURCE); check(OUTPUT);
  for (const name of FILES) if (!readFileSync(resolve(SOURCE, name)).equals(readFileSync(resolve(OUTPUT, name)))) throw new Error(`stale technical-health contract: ${name}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) generateTechnicalHealthContracts();
