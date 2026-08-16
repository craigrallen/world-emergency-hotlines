import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_MARKER, sha256 } from './accessibility-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(dir, entry.name); return entry.isDirectory() ? files(path) : [path];
});
export function forbiddenInternalEvidence(repoRoot = repo) {
  const evidenceDir = resolve(repoRoot, 'reviews/accessibility-evidence');
  const exactHashes = files(evidenceDir).map((path) => sha256(readFileSync(path)));
  return {
    markers: ['reviews/multilingual-ui', 'internal-multilingual-ui-review-pack/v1', 'pending_not_reviewed', 'static_ui_runtime_dictionaries_only', 'reviews/accessibility-evidence', INTERNAL_MARKER, 'internal_deterministic_regression_evidence', 'accessibility-evidence/v1/baseline.json'],
    exactHashes,
  };
}
export function assertInternalNonpublication(dist, repoRoot = repo) {
  if (!existsSync(dist)) throw new Error('web/dist is absent; build current sources before the dist-only non-publication scan');
  const forbidden = forbiddenInternalEvidence(repoRoot);
  for (const path of files(dist)) {
    const bytes = readFileSync(path);
    for (const marker of forbidden.markers) if (bytes.includes(Buffer.from(marker))) throw new Error(`internal review-pack marker published in ${path}`);
    if (forbidden.exactHashes.includes(sha256(bytes))) throw new Error(`exact internal accessibility-evidence artifact published in ${path}`);
  }
}
export function verifyInternalNonpublication(dist = resolve(repo, 'web/dist')) {
  const dockerignore = readFileSync(resolve(repo, '.dockerignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
  if (!dockerignore.includes('reviews')) throw new Error('.dockerignore must exclude the complete reviews/ tree');
  assertInternalNonpublication(dist, repo);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyInternalNonpublication();
  console.log('Internal review and accessibility-evidence non-publication OK: current web/dist scanned by markers and exact artifact hashes');
}
