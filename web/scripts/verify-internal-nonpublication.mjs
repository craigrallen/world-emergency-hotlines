import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_MARKER, sha256 } from './accessibility-evidence-lib.mjs';
import { INVENTORY_MARKER } from './security-privacy-evidence-lib.mjs';
import { INTERNAL_MARKER as DUE_DILIGENCE_MARKER } from './technical-due-diligence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(dir, entry.name); return entry.isDirectory() ? files(path) : [path];
});
export function forbiddenInternalEvidence(repoRoot = repo) {
  const evidenceDirs = ['reviews/accessibility-evidence', 'reviews/security-privacy-evidence', 'reviews/technical-due-diligence'].map((path) => resolve(repoRoot, path));
  const exactHashes = evidenceDirs.flatMap((path) => files(path)).map((path) => sha256(readFileSync(path)));
  return {
    markers: ['reviews/multilingual-ui', 'internal-multilingual-ui-review-pack/v1', 'pending_not_reviewed', 'static_ui_runtime_dictionaries_only', 'reviews/accessibility-evidence', INTERNAL_MARKER, 'internal_deterministic_regression_evidence', 'accessibility-evidence/v1/baseline.json', 'reviews/security-privacy-evidence', INVENTORY_MARKER, 'repository_internal_deterministic_regression_evidence', 'security-privacy-evidence/v1/inventory.json', 'reviews/technical-due-diligence', DUE_DILIGENCE_MARKER, 'technical-due-diligence/v1/index.json'],
    exactHashes,
  };
}
export function assertInternalNonpublication(dist, repoRoot = repo) {
  if (!existsSync(dist)) throw new Error('web/dist is absent; build current sources before the dist-only non-publication scan');
  const forbidden = forbiddenInternalEvidence(repoRoot);
  for (const path of files(dist)) {
    const bytes = readFileSync(path);
    for (const marker of forbidden.markers) if (bytes.includes(Buffer.from(marker))) throw new Error(`internal review-pack marker published in ${path}`);
    if (forbidden.exactHashes.includes(sha256(bytes))) throw new Error(`internal evidence exact copy published in ${path}`);
  }
}
export function verifyInternalNonpublication(dist = resolve(repo, 'web/dist')) {
  const dockerignore = readFileSync(resolve(repo, '.dockerignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
  if (!dockerignore.includes('reviews')) throw new Error('.dockerignore must exclude the complete reviews/ tree');
  assertInternalNonpublication(dist, repo);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyInternalNonpublication();
  console.log('Internal non-publication OK: complete reviews tree excluded from Docker context; current web/dist scanned for listed markers and exact complete artifact hashes');
}
