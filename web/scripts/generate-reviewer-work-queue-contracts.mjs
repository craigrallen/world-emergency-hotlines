import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const SOURCE = resolve(REPO_ROOT, 'reviewer-work-queue/contracts/v1');
const OUTPUT = resolve(WEB_ROOT, 'public/reviewer-work-queue/v1');
export const FILES = Object.freeze(['README.md', 'disposition-audit.schema.json', 'disposition-audit.synthetic.json', 'queue.schema.json', 'queue.synthetic.json']);
function check(root) {
  const rel = relative(REPO_ROOT, root); if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error('unsafe reviewer-work-queue path');
  const metadata = lstatSync(root); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('reviewer-work-queue root must be a real directory');
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify([...FILES].sort())) throw new Error('unexpected reviewer-work-queue contract manifest');
  for (const name of FILES) { const item = lstatSync(resolve(root, name)); if (!item.isFile() || item.isSymbolicLink()) throw new Error(`unsafe reviewer-work-queue artifact: ${name}`); }
}
export function generateReviewerWorkQueueContracts() { check(SOURCE); if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true }); mkdirSync(OUTPUT, { recursive: true }); for (const name of FILES) cpSync(resolve(SOURCE, name), resolve(OUTPUT, name), { errorOnExist: true }); }
export function verifyReviewerWorkQueueContractDrift() { check(SOURCE); check(OUTPUT); for (const name of FILES) if (!readFileSync(resolve(SOURCE, name)).equals(readFileSync(resolve(OUTPUT, name)))) throw new Error(`stale reviewer-work-queue contract: ${name}`); }
if (process.argv[1] === fileURLToPath(import.meta.url)) generateReviewerWorkQueueContracts();
