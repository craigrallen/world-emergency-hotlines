import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_MARKER, sha256 } from './accessibility-evidence-lib.mjs';
import { INVENTORY_MARKER } from './security-privacy-evidence-lib.mjs';
import { INTERNAL_MARKER as DUE_DILIGENCE_MARKER } from './technical-due-diligence-lib.mjs';
import { INTERNAL_MARKER as DESIGN_PARTNER_MARKER, PACK_PATH } from './design-partner-discovery-lib.mjs';
import { INDEX_PATH as LEGAL_REVIEW_INDEX_PATH, INTERNAL_MARKER as LEGAL_REVIEW_MARKER } from './licensing-legal-review-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(dir, entry.name); return entry.isDirectory() ? files(path) : [path];
});
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const semanticHash = (value) => sha256(Buffer.from(canonicalJson(value)));
const semanticSections = (value, path = '$') => {
  const sections = [];
  if (value && typeof value === 'object') {
    sections.push([`design-partner pack subtree ${path}`, value]);
    for (const [key, child] of Object.entries(value)) sections.push(...semanticSections(child, `${path}.${key}`));
  }
  return sections;
};
const substantiveUniqueScalars = (pack) => {
  const counts = new Map();
  const visit = (value) => {
    if (typeof value === 'string' && !value.startsWith('https://json-schema.org/') && (value.length >= 24 || (/^[a-z][a-z0-9_/-]+$/.test(value) && value.length >= 18))) counts.set(value, (counts.get(value) || 0) + 1);
    else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
  };
  visit(pack);
  return [...counts].filter(([, count]) => count === 1).map(([value]) => value);
};
const findForbiddenSemanticSection = (value, fingerprints) => {
  if (!value || typeof value !== 'object') return undefined;
  const match = fingerprints.get(semanticHash(value));
  if (match) return match;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const nested = findForbiddenSemanticSection(child, fingerprints);
    if (nested) return nested;
  }
  return undefined;
};
export function forbiddenInternalEvidence(repoRoot = repo) {
  const evidenceDirs = [resolve(repoRoot, 'reviews')];
  const exactHashes = evidenceDirs.flatMap((path) => files(path)).map((path) => sha256(readFileSync(path)));
  const designPartnerPack = JSON.parse(readFileSync(resolve(repoRoot, PACK_PATH), 'utf8'));
  const legalReviewIndex = JSON.parse(readFileSync(resolve(repoRoot, LEGAL_REVIEW_INDEX_PATH), 'utf8'));
  const licensedRoot = resolve(repoRoot, 'reviews/licensed-delivery/v1');
  const licensedSchemas = JSON.parse(readFileSync(resolve(licensedRoot, 'schemas.json'), 'utf8'));
  const licensedHttp = JSON.parse(readFileSync(resolve(licensedRoot, 'http-contract.json'), 'utf8'));
  const licensedDraftText = ['DECISIONS.md', 'terms.counsel-draft.md'].map((name) => readFileSync(resolve(licensedRoot, name), 'utf8'));
  // Public release metadata legitimately contains some bound source hashes and
  // paths. Fingerprint only the legal handoff's substantive internal sections.
  const legalReviewSubstance = {
    prohibited_claims_actions: legalReviewIndex.prohibited_claims_actions,
    decision_domains: legalReviewIndex.decision_domains,
    provenance_populations: legalReviewIndex.provenance_populations,
    unresolved_questions: legalReviewIndex.unresolved_questions,
  };
  const semanticArtifacts = [['design-partner pack', designPartnerPack], ['licensing legal-review substance', legalReviewSubstance], ['licensed-delivery schemas', licensedSchemas], ['licensed-delivery HTTP contract', licensedHttp]];
  const licensedDraftScalars = licensedDraftText.flatMap((text) => text.split(/\n\s*\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 80));
  return {
    markers: ['reviews/licensed-delivery', 'internal-licensed-delivery-counsel-draft-only/v1', 'SYNTHETIC-TEST-KEY-NEVER-PUBLISH-OR-USE-IN-PRODUCTION', 'reviews/multilingual-ui', 'internal-multilingual-ui-review-pack/v1', 'pending_not_reviewed', 'static_ui_runtime_dictionaries_only', 'reviews/accessibility-evidence', INTERNAL_MARKER, 'internal_deterministic_regression_evidence', 'accessibility-evidence/v1/baseline.json', 'reviews/security-privacy-evidence', INVENTORY_MARKER, 'repository_internal_deterministic_regression_evidence', 'security-privacy-evidence/v1/inventory.json', 'reviews/technical-due-diligence', DUE_DILIGENCE_MARKER, 'technical-due-diligence/v1/index.json', 'reviews/design-partner-discovery', DESIGN_PARTNER_MARKER, 'design-partner-discovery/v1/pack.json', 'reviews/licensing-legal-review', LEGAL_REVIEW_MARKER, 'licensing-legal-review/v1/index.json'],
    exactHashes,
    semanticFingerprints: new Map(semanticArtifacts.flatMap(([artifact, value]) => semanticSections(value).filter(([, section]) => !artifact.startsWith('licensed-delivery') || canonicalJson(section).length >= 80).map(([label, section]) => [semanticHash(section), `${artifact} ${label}`]))),
    scalarFingerprints: [...new Set([...semanticArtifacts.flatMap(([, value]) => substantiveUniqueScalars(value)), ...licensedDraftScalars])],
  };
}
export function assertInternalNonpublication(dist, repoRoot = repo) {
  if (!existsSync(dist)) throw new Error('web/dist is absent; build current sources before the dist-only non-publication scan');
  const forbidden = forbiddenInternalEvidence(repoRoot);
  for (const path of files(dist)) {
    const bytes = readFileSync(path);
    for (const marker of forbidden.markers) if (bytes.includes(Buffer.from(marker))) throw new Error(`internal review-pack marker published in ${path}`);
    if (forbidden.exactHashes.includes(sha256(bytes))) throw new Error(`internal evidence exact copy published in ${path}`);
    const text = bytes.toString('utf8');
    for (const scalar of forbidden.scalarFingerprints) if (text.includes(scalar)) throw new Error(`internal review-pack scalar fingerprint published in ${path}`);
    try {
      const match = findForbiddenSemanticSection(JSON.parse(text), forbidden.semanticFingerprints);
      if (match) throw new Error(`internal review-pack semantic section (${match}) published in ${path}`);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
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
