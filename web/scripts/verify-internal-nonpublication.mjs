import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { INTERNAL_MARKER, sha256 } from './accessibility-evidence-lib.mjs';
import { INVENTORY_MARKER } from './security-privacy-evidence-lib.mjs';
import { INTERNAL_MARKER as DUE_DILIGENCE_MARKER } from './technical-due-diligence-lib.mjs';
import { INTERNAL_MARKER as DESIGN_PARTNER_MARKER, PACK_PATH } from './design-partner-discovery-lib.mjs';
import { INDEX_PATH as LEGAL_REVIEW_INDEX_PATH, INTERNAL_MARKER as LEGAL_REVIEW_MARKER } from './licensing-legal-review-lib.mjs';
import { EXAMPLE_PATH as CLEARANCE_EXAMPLE_PATH, INTERNAL_MARKER as CLEARANCE_MARKER, LEDGER_PATH as CLEARANCE_LEDGER_PATH } from './field-provenance-clearance-lib.mjs';

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
    sections.push([`subtree ${path}`, value]);
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
const licensedFixtureScalars = (fixtures) => [...new Set(fixtures.flatMap(([, fixture]) => substantiveUniqueScalars(fixture)))]
  // Dates and other ordinary long values satisfy the legacy length heuristic but
  // are not distinctive enough to block independently in normalized public text.
  .filter((value) => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value))
  .map((raw) => ({ raw, normalized: normalizeScanText(raw) }));
const normalizedArtifactScalars = (artifacts) => [...new Set(artifacts.flatMap(([, value]) => substantiveUniqueScalars(value)))]
  // Short schema names and standard HTTP directives become ordinary phrases
  // after separator folding. Keep normalized contract matching distinctive.
  .filter((value) => value.length >= 32)
  .map((raw) => ({ raw, normalized: normalizeScanText(raw) }));
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
const MAX_NORMALIZATION_BYTES = 32 * 1024 * 1024;
const MAX_NORMALIZATION_PASSES = 8;
const MAX_HTML_SCAN_ITEMS = 250_000;
const decodeJavaScriptEscapes = (text) => text
  .replace(/\\u([0-9a-f]{4})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  .replace(/\\x([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
const decodePercentEncoding = (text) => text.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
  try { return decodeURIComponent(encoded); } catch { return encoded; }
});
const HTML_ENTITIES = new Map([['amp', '&'], ['apos', "'"], ['gt', '>'], ['lowbar', '_'], ['lt', '<'], ['nbsp', ' '], ['newline', '\n'], ['quot', '"'], ['tab', '\t']]);
const decodeHtmlEntities = (text) => text.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|([a-z][a-z0-9]+));/giu, (entity, numeric, named) => {
  if (numeric) {
    const point = Number.parseInt(numeric.replace(/^x/iu, ''), /^x/iu.test(numeric) ? 16 : 10);
    return Number.isSafeInteger(point) && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  }
  return HTML_ENTITIES.get(named.toLocaleLowerCase('en-US')) ?? entity;
});
const normalizeDecodedText = (text) => ` ${text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const decodeBoundedText = (text, label = 'production artifact') => {
  let decoded = text;
  let converged = false;
  for (let i = 0; i < MAX_NORMALIZATION_PASSES; i += 1) {
    const next = decodeHtmlEntities(decodePercentEncoding(decodeJavaScriptEscapes(decoded)));
    if (Buffer.byteLength(next) > MAX_NORMALIZATION_BYTES) throw new Error(`decoded ${label} exceeds bounded nonpublication normalization size`);
    if (next === decoded) { converged = true; break; }
    decoded = next;
  }
  if (!converged) throw new Error(`${label} exceeds bounded nonpublication normalization iterations`);
  return decoded;
};
const htmlRepresentations = (html, sourceHtml) => {
  const representations = [];
  let scanItems = 0;
  let attributeBytes = 0;
  const visit = (document, visitor) => {
    const pending = [document];
    while (pending.length) {
      const node = pending.pop();
      scanItems += 1;
      if (scanItems > MAX_HTML_SCAN_ITEMS) throw new Error('production HTML exceeds bounded nonpublication scan work');
      visitor(node);
      if (node.content) pending.push(node.content);
      const children = node.childNodes ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
    }
  };
  for (const scriptingEnabled of [true, false]) {
    const textNodes = [];
    visit(parse(html, { scriptingEnabled }), (node) => {
      if (node.nodeName === '#text') textNodes.push(node.value);
    });
    representations.push(textNodes.join(' '), textNodes.join(''));
    visit(parse(sourceHtml, { scriptingEnabled }), (node) => {
      for (const attribute of node.attrs ?? []) {
        scanItems += 1;
        if (scanItems > MAX_HTML_SCAN_ITEMS) throw new Error('production HTML exceeds bounded nonpublication scan work');
        const value = decodeBoundedText(attribute.value, 'HTML attribute value');
        attributeBytes += Buffer.byteLength(value);
        if (attributeBytes > MAX_NORMALIZATION_BYTES) throw new Error('decoded HTML attributes exceed bounded nonpublication normalization size');
        // Keep values separate: unrelated public attributes must not combine to
        // form a forbidden scalar or row fingerprint.
        if (value) representations.push(value);
      }
    });
    // Attribute decoding starts after parsing the original markup, so encoded
    // angle brackets cannot alter the HTML tree. parse5 has already resolved
    // character references; bounded decoding handles percent/JS nesting.
  };
  return [...new Set(representations)];
};
const normalizeScanTexts = (text, isHtml = false) => {
  if (Buffer.byteLength(text) > MAX_NORMALIZATION_BYTES) throw new Error('production artifact exceeds bounded nonpublication normalization size');
  const decoded = decodeBoundedText(text);
  const representations = isHtml ? htmlRepresentations(decoded, text) : [decoded];
  return [...new Set(representations.map(normalizeDecodedText))];
};
const normalizeScanText = (text) => normalizeScanTexts(text)[0];
const clearanceRowFingerprints = (artifacts) => artifacts.flatMap(([artifact, value]) => value.entries.flatMap((entry, index) => [
  ['population-field mapping', [entry.population_id, entry.field_group_id]],
  ['evidence-population binding', [entry.population_id, ...entry.evidence_references]],
  ['held decision tuple', [entry.status, entry.permission_assertion, entry.restrictions]],
].map(([purpose, components]) => ({
  label: `${artifact} entry ${index} ${purpose}`,
  components: components.map((component) => normalizeScanText(component).trim()),
}))));
export function forbiddenInternalEvidence(repoRoot = repo) {
  const evidenceDirs = [resolve(repoRoot, 'reviews')];
  const exactHashes = evidenceDirs.flatMap((path) => files(path)).map((path) => sha256(readFileSync(path)));
  const designPartnerPack = JSON.parse(readFileSync(resolve(repoRoot, PACK_PATH), 'utf8'));
  const legalReviewIndex = JSON.parse(readFileSync(resolve(repoRoot, LEGAL_REVIEW_INDEX_PATH), 'utf8'));
  const clearanceLedger = JSON.parse(readFileSync(resolve(repoRoot, CLEARANCE_LEDGER_PATH), 'utf8'));
  const clearanceExample = JSON.parse(readFileSync(resolve(repoRoot, CLEARANCE_EXAMPLE_PATH), 'utf8'));
  const licensedRoot = resolve(repoRoot, 'reviews/licensed-delivery/v1');
  const licensedSchemas = JSON.parse(readFileSync(resolve(licensedRoot, 'schemas.json'), 'utf8'));
  const licensedHttp = JSON.parse(readFileSync(resolve(licensedRoot, 'http-contract.json'), 'utf8'));
  const licensedFixtures = ['synthetic-input.json', 'presentation.synthetic.json', 'observations.synthetic.json']
    .map((name) => [name, JSON.parse(readFileSync(resolve(licensedRoot, 'fixtures', name), 'utf8'))]);
  const licensedDraftText = ['DECISIONS.md', 'terms.counsel-draft.md'].map((name) => readFileSync(resolve(licensedRoot, name), 'utf8'));
  // Public release metadata legitimately contains some bound source hashes and
  // paths. Fingerprint only the legal handoff's substantive internal sections.
  const legalReviewSubstance = {
    prohibited_claims_actions: legalReviewIndex.prohibited_claims_actions,
    decision_domains: legalReviewIndex.decision_domains,
    provenance_populations: legalReviewIndex.provenance_populations,
    unresolved_questions: legalReviewIndex.unresolved_questions,
  };
  const clearanceSubstance = (value) => ({ evidence_catalog: value.evidence_catalog, entries: value.entries });
  const clearanceArtifacts = [['field clearance ledger', clearanceLedger], ['field clearance synthetic', clearanceExample]];
  const generalScalarArtifacts = [['design-partner pack', designPartnerPack], ['licensing legal-review substance', legalReviewSubstance], ['field clearance ledger substance', clearanceSubstance(clearanceLedger)], ['field clearance synthetic substance', clearanceSubstance(clearanceExample)]];
  const licensedContractArtifacts = [['licensed-delivery schemas', licensedSchemas], ['licensed-delivery HTTP contract', licensedHttp]];
  const generalSemanticArtifacts = [...generalScalarArtifacts, ...licensedContractArtifacts];
  const semanticArtifacts = [...generalSemanticArtifacts, ...licensedFixtures.map(([name, value]) => [`licensed-delivery fixture ${name}`, value])];
  const licensedDraftScalars = licensedDraftText.flatMap((text) => text.split(/\n\s*\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 80));
  return {
    markers: ['reviews/licensed-delivery', 'internal-licensed-delivery-counsel-draft-only/v1', 'SYNTHETIC-TEST-KEY-NEVER-PUBLISH-OR-USE-IN-PRODUCTION', 'reviews/multilingual-ui', 'internal-multilingual-ui-review-pack/v1', 'pending_not_reviewed', 'static_ui_runtime_dictionaries_only', 'reviews/accessibility-evidence', INTERNAL_MARKER, 'internal_deterministic_regression_evidence', 'accessibility-evidence/v1/baseline.json', 'reviews/security-privacy-evidence', INVENTORY_MARKER, 'repository_internal_deterministic_regression_evidence', 'security-privacy-evidence/v1/inventory.json', 'reviews/technical-due-diligence', DUE_DILIGENCE_MARKER, 'technical-due-diligence/v1/index.json', 'reviews/design-partner-discovery', DESIGN_PARTNER_MARKER, 'design-partner-discovery/v1/pack.json', 'reviews/licensing-legal-review', LEGAL_REVIEW_MARKER, 'licensing-legal-review/v1/index.json', 'reviews/field-provenance-clearance', CLEARANCE_MARKER, 'field-provenance-clearance/v1/ledger.json', 'field-provenance-clearance/v1/example.synthetic.json'],
    exactHashes,
    semanticFingerprints: new Map(semanticArtifacts.flatMap(([artifact, value]) => semanticSections(value).filter(([, section]) => !artifact.startsWith('licensed-delivery') || canonicalJson(section).length >= 80).map(([label, section]) => [semanticHash(section), `${artifact} ${label}`]))),
    scalarFingerprints: [...new Set(generalScalarArtifacts.flatMap(([, value]) => substantiveUniqueScalars(value)))],
    licensedContractFingerprints: normalizedArtifactScalars(licensedContractArtifacts),
    licensedFixtureFingerprints: licensedFixtureScalars(licensedFixtures),
    licensedDraftFingerprints: [...new Set(licensedDraftScalars)].map((raw) => ({ raw, normalized: normalizeScanText(raw) })),
    clearanceRowFingerprints: clearanceRowFingerprints(clearanceArtifacts),
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
    const normalizedTexts = normalizeScanTexts(text, /\.html?$/iu.test(path));
    for (const row of forbidden.clearanceRowFingerprints) if (normalizedTexts.some((normalizedText) => row.components.every((component) => normalizedText.includes(` ${component} `)))) throw new Error(`internal field-clearance row fingerprint (${row.label}) published in ${path}`);
    for (const scalar of forbidden.scalarFingerprints) if (text.includes(scalar)) throw new Error(`internal review-pack scalar fingerprint published in ${path}`);
    for (const contract of forbidden.licensedContractFingerprints) if (text.includes(contract.raw) || normalizedTexts.some((normalizedText) => normalizedText.includes(contract.normalized))) throw new Error(`internal licensed-delivery contract scalar fingerprint published in ${path}`);
    for (const fixture of forbidden.licensedFixtureFingerprints) if (text.includes(fixture.raw) || normalizedTexts.some((normalizedText) => normalizedText.includes(fixture.normalized))) throw new Error(`internal licensed-delivery fixture scalar fingerprint published in ${path}`);
    for (const draft of forbidden.licensedDraftFingerprints) if (text.includes(draft.raw) || normalizedTexts.some((normalizedText) => normalizedText.includes(draft.normalized))) throw new Error(`internal review-pack scalar fingerprint published in ${path}`);
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
