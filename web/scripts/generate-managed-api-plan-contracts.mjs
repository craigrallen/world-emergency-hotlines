import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const SOURCE = resolve(REPO_ROOT, 'managed-api-plans/contracts/v1');
const OUTPUT = resolve(WEB_ROOT, 'public/managed-api-plans/v1');
export const FILES = Object.freeze(['README.md','catalog.synthetic.json','plan-catalog.schema.json','planning-vector.schema.json','planning-vectors.synthetic.json']);

function check(root) {
  const rel = relative(REPO_ROOT, root);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error('unsafe managed-api-plan path');
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('managed-api-plan root must be a real directory');
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify([...FILES].sort())) throw new Error('unexpected managed-api-plan contract manifest');
  for (const name of FILES) if (!lstatSync(resolve(root, name)).isFile() || lstatSync(resolve(root, name)).isSymbolicLink()) throw new Error(`unsafe managed-api-plan artifact: ${name}`);
}
export function generateManagedApiPlanContracts() { check(SOURCE); if (existsSync(OUTPUT)) rmSync(OUTPUT, {recursive:true}); mkdirSync(OUTPUT, {recursive:true}); for (const name of FILES) cpSync(resolve(SOURCE,name), resolve(OUTPUT,name), {errorOnExist:true}); }
export function verifyManagedApiPlanContractDrift() { check(SOURCE); check(OUTPUT); for (const name of FILES) if (!readFileSync(resolve(SOURCE,name)).equals(readFileSync(resolve(OUTPUT,name)))) throw new Error(`stale managed-api-plan contract: ${name}`); }
if (process.argv[1] === fileURLToPath(import.meta.url)) generateManagedApiPlanContracts();
