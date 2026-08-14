import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const SOURCE = resolve(REPO_ROOT, 'provider-claims/contracts/v1');
const OUTPUT = resolve(WEB_ROOT, 'public/provider-claims/v1');
export const FILES = Object.freeze(['README.md', 'claim-envelope.schema.json', 'claim.synthetic.json', 'review-decision.schema.json', 'review.synthetic.json']);

function check(root) {
  const rel = relative(REPO_ROOT, root);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error('unsafe provider-claim path');
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('provider-claim root must be a real directory');
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify([...FILES].sort())) throw new Error('unexpected provider-claim contract manifest');
  for (const name of FILES) { const item = lstatSync(resolve(root, name)); if (!item.isFile() || item.isSymbolicLink()) throw new Error(`unsafe provider-claim artifact: ${name}`); }
}

export function generateProviderClaimContracts() {
  check(SOURCE);
  if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true });
  mkdirSync(OUTPUT, { recursive: true });
  for (const name of FILES) cpSync(resolve(SOURCE, name), resolve(OUTPUT, name), { errorOnExist: true });
}

export function verifyProviderClaimContractDrift() {
  check(SOURCE); check(OUTPUT);
  for (const name of FILES) if (!readFileSync(resolve(SOURCE, name)).equals(readFileSync(resolve(OUTPUT, name)))) throw new Error(`stale provider-claim contract: ${name}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) generateProviderClaimContracts();
