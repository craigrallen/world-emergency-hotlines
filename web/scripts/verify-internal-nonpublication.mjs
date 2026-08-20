import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHTML, decodeHTMLAttribute } from 'entities/decode';
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
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const decodeUtf16 = (bytes, littleEndian, label) => {
  const payload = bytes.subarray(2);
  if (payload.length % 2 !== 0) throw new Error(`${label} has malformed odd-length BOM-marked UTF-16`);
  let text = '';
  for (let offset = 0; offset < payload.length; offset += 2) {
    const unit = littleEndian ? payload[offset] | (payload[offset + 1] << 8) : (payload[offset] << 8) | payload[offset + 1];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (offset + 3 >= payload.length) throw new Error(`${label} has invalid UTF-16 surrogate sequence`);
      const next = littleEndian ? payload[offset + 2] | (payload[offset + 3] << 8) : (payload[offset + 2] << 8) | payload[offset + 3];
      if (next < 0xdc00 || next > 0xdfff) throw new Error(`${label} has invalid UTF-16 surrogate sequence`);
      text += String.fromCharCode(unit, next); offset += 2;
    } else {
      if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error(`${label} has invalid UTF-16 surrogate sequence`);
      text += String.fromCharCode(unit);
    }
  }
  if (Buffer.byteLength(text) > MAX_NORMALIZATION_BYTES) throw new Error(`decoded ${label} exceeds bounded nonpublication normalization size`);
  return text;
};
export const decodeArtifactText = (bytes, label) => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes, true, label);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes, false, label);
  try {
    const text = strictUtf8.decode(bytes);
    if (Buffer.byteLength(text) > MAX_NORMALIZATION_BYTES) throw new Error(`decoded ${label} exceeds bounded nonpublication normalization size`);
    return text;
  } catch (error) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && error instanceof TypeError) throw new Error(`${label} has malformed BOM-marked UTF-8`);
    if (error instanceof TypeError) return undefined; // Opaque BOM-less binary: retain byte checks, but do not guess an encoding.
    throw error;
  }
};
export const decodeLegacyOctalEscapes = (text) => {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\\') { output += text[index]; continue; }
    let preceding = 0;
    for (let at = index - 1; at >= 0 && text[at] === '\\'; at -= 1) preceding += 1;
    if (preceding % 2 !== 0) { output += text[index]; continue; }
    const first = text[index + 1];
    if (first === '0') {
      const second = text[index + 2];
      if (/[0-7]/u.test(second ?? '')) {
        let digits = first + second;
        const third = text[index + 3];
        if (/[0-7]/u.test(third ?? '')) digits += third;
        output += String.fromCharCode(Number.parseInt(digits, 8)); index += digits.length; continue;
      }
      if (!/[0-9]/u.test(second ?? '')) { output += '\0'; index += 1; continue; }
    } else if (/[1-7]/u.test(first ?? '')) {
      let digits = first;
      const second = text[index + 2];
      if (/[0-7]/u.test(second ?? '')) {
        digits += second;
        const third = text[index + 3];
        if (/[0-3]/u.test(first) && /[0-7]/u.test(third ?? '')) digits += third;
      }
      output += String.fromCharCode(Number.parseInt(digits, 8)); index += digits.length; continue;
    }
    output += text[index];
  }
  return output;
};
const hasStrictDirective = (source) => {
  let rest = source.replace(/^#![^\r\n]*(?:\r?\n|$)/u, '');
  while (true) {
    const next = rest.replace(/^\s*(?:(?:\/\/[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/))/u, '');
    if (next === rest) break; rest = next;
  }
  return /^(?:"use strict"|'use strict')\s*(?:;|\r?\n|$)/u.test(rest);
};
const javascriptRepresentations = (text, mode = 'unknown') => mode === 'strict' || mode === 'disabled' || hasStrictDirective(text)
  ? [text]
  : [...new Set([text, decodeLegacyOctalEscapes(text)])];
const decodeJavaScriptEscapes = (text) => text
  // ECMAScript removes an unescaped backslash plus LineTerminatorSequence
  // before interpreting the remaining string characters. Preserve pairs of
  // backslashes: their final backslash is escaped and cannot continue a line.
  .replace(/(^|[^\\])((?:\\\\)*)\\(?:\r\n|[\n\r\u2028\u2029])/gu, (_, prefix, pairs) => `${prefix}${pairs}`)
  .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (escape, hex) => {
    const point = Number.parseInt(hex, 16);
    return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : escape;
  })
  .replace(/\\u([0-9a-f]{4})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  .replace(/\\x([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
const decodePercentEncoding = (text) => text.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
  try { return decodeURIComponent(encoded); } catch { return encoded; }
});
const normalizeDecodedText = (text) => ` ${text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const decodeBoundedText = (text, label = 'production artifact', decodeEntities = decodeHTML) => {
  let decoded = text;
  let converged = false;
  for (let i = 0; i < MAX_NORMALIZATION_PASSES; i += 1) {
    const next = decodeEntities(decodePercentEncoding(decodeJavaScriptEscapes(decoded)));
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
  let commentBytes = 0;
  let nameBytes = 0;
  let doctypeBytes = 0;
  let textBytes = 0;
  const addName = (name) => {
    if (!name) return;
    const value = decodeBoundedText(name, 'HTML name');
    nameBytes += Buffer.byteLength(value);
    if (nameBytes > MAX_NORMALIZATION_BYTES) throw new Error('decoded HTML names exceed bounded nonpublication normalization size');
    // Keep names separate from each other and from content/value representations:
    // unrelated public markup must not combine into a forbidden fingerprint.
    representations.push(value);
  };
  const addAttributeValue = (raw) => {
    if (!raw) return;
    for (const source of javascriptRepresentations(raw)) {
      const value = decodeBoundedText(source, 'HTML attribute value', decodeHTMLAttribute);
      attributeBytes += Buffer.byteLength(value);
      if (attributeBytes > MAX_NORMALIZATION_BYTES) throw new Error('decoded HTML attributes exceed bounded nonpublication normalization size');
      // Keep values separate: unrelated public attributes must not combine to
      // form a forbidden scalar or row fingerprint.
      representations.push(value);
    }
  };
  const addText = (raw, values) => {
    const value = decodeBoundedText(raw, 'HTML text value');
    textBytes += Buffer.byteLength(value);
    if (textBytes > MAX_NORMALIZATION_BYTES) throw new Error('decoded HTML text exceeds bounded nonpublication normalization size');
    values.push(value);
  };
  const addDoctype = (node) => {
    if (node.nodeName !== '#documentType') return;
    // Doctype fields are independent parser metadata. Decode and scan each one
    // in isolation so unrelated fields or documents cannot form fingerprints.
    for (const [field, raw] of [['name', node.name], ['publicId', node.publicId], ['systemId', node.systemId]]) {
      if (!raw) continue;
      const value = decodeBoundedText(raw, `HTML doctype ${field}`);
      doctypeBytes += Buffer.byteLength(value);
      if (doctypeBytes > MAX_NORMALIZATION_BYTES) throw new Error('decoded HTML doctypes exceed bounded nonpublication normalization size');
      representations.push(value);
    }
  };
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
      addDoctype(node);
      if (node.tagName) addName(node.tagName);
      for (const attribute of node.attrs ?? []) {
        addName(attribute.name);
        addAttributeValue(attribute.value);
      }
      if (node.nodeName === '#text') {
        if (node.parentNode?.tagName === 'script') {
          const type = node.parentNode.attrs?.find((attribute) => attribute.name.toLowerCase() === 'type')?.value.trim().toLowerCase();
          const mode = type === 'module' || (type && !/^(?:application|text)\/(?:javascript|ecmascript)$/u.test(type)) ? 'disabled' : 'classic';
          for (const representation of javascriptRepresentations(node.value, mode)) addText(representation, textNodes);
        } else addText(node.value, textNodes);
      }
      if (node.nodeName === '#comment') {
        const values = javascriptRepresentations(node.data).map((source) => decodeBoundedText(source, 'HTML comment value'));
        commentBytes += values.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
        if (commentBytes > MAX_NORMALIZATION_BYTES) throw new Error('decoded HTML comments exceed bounded nonpublication normalization size');
        // Keep comments separate so unrelated payloads cannot combine into a
        // forbidden fingerprint. Also render tag-like fragments inside each
        // payload, since comment contents can otherwise split normalized text.
        for (const value of values) if (value) {
          representations.push(value);
          const commentTextNodes = [];
          visit(parse(value, { scriptingEnabled }), (commentNode) => {
            addDoctype(commentNode);
            if (commentNode.tagName) addName(commentNode.tagName);
            for (const attribute of commentNode.attrs ?? []) {
              addName(attribute.name);
              addAttributeValue(attribute.value);
            }
            if (commentNode.nodeName === '#text') addText(commentNode.value, commentTextNodes);
          });
          representations.push(commentTextNodes.join(' '), commentTextNodes.join(''));
        }
      }
    });
    representations.push(textNodes.join(' '), textNodes.join(''));
    visit(parse(sourceHtml, { scriptingEnabled }), (node) => {
      addDoctype(node);
      if (node.tagName) addName(node.tagName);
      for (const attribute of node.attrs ?? []) {
        scanItems += 1;
        if (scanItems > MAX_HTML_SCAN_ITEMS) throw new Error('production HTML exceeds bounded nonpublication scan work');
        addName(attribute.name);
        addAttributeValue(attribute.value);
      }
    });
    // Attribute decoding starts after parsing the original markup, so encoded
    // angle brackets cannot alter the HTML tree. parse5 has already resolved
    // character references; bounded decoding handles percent/JS nesting.
  };
  return [...new Set(representations)];
};
const normalizeScanTexts = (text, isHtml = false, javascriptMode = 'unknown') => {
  if (Buffer.byteLength(text) > MAX_NORMALIZATION_BYTES) throw new Error('production artifact exceeds bounded nonpublication normalization size');
  const sourceRepresentations = isHtml ? [text] : javascriptRepresentations(text, javascriptMode);
  const representations = sourceRepresentations.flatMap((source) => {
    const decoded = decodeBoundedText(source);
    return isHtml ? htmlRepresentations(decoded, source) : [decoded];
  });
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
  const markers = ['reviews/licensed-delivery', 'internal-licensed-delivery-counsel-draft-only/v1', 'SYNTHETIC-TEST-KEY-NEVER-PUBLISH-OR-USE-IN-PRODUCTION', 'reviews/multilingual-ui', 'internal-multilingual-ui-review-pack/v1', 'pending_not_reviewed', 'static_ui_runtime_dictionaries_only', 'reviews/accessibility-evidence', INTERNAL_MARKER, 'internal_deterministic_regression_evidence', 'accessibility-evidence/v1/baseline.json', 'reviews/security-privacy-evidence', INVENTORY_MARKER, 'repository_internal_deterministic_regression_evidence', 'security-privacy-evidence/v1/inventory.json', 'reviews/technical-due-diligence', DUE_DILIGENCE_MARKER, 'technical-due-diligence/v1/index.json', 'reviews/design-partner-discovery', DESIGN_PARTNER_MARKER, 'design-partner-discovery/v1/pack.json', 'reviews/licensing-legal-review', LEGAL_REVIEW_MARKER, 'licensing-legal-review/v1/index.json', 'reviews/field-provenance-clearance', CLEARANCE_MARKER, 'field-provenance-clearance/v1/ledger.json', 'field-provenance-clearance/v1/example.synthetic.json'];
  return {
    markers,
    // Marker matching is exact on the complete separator-folded marker core,
    // regardless of characters immediately outside it. normalizeScanText pads
    // general fingerprints so their components cannot combine accidentally;
    // retaining that padding here would incorrectly impose word boundaries.
    normalizedMarkers: markers.map((raw) => ({ raw, normalized: normalizeScanText(raw).trim() })),
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
    const text = decodeArtifactText(bytes, `production artifact ${path}`);
    if (text === undefined) continue;
    const isHtml = /\.html?$/iu.test(path);
    const extensionMode = /\.mjs$/iu.test(path) ? 'strict' : /\.json$/iu.test(path) ? 'disabled' : 'unknown';
    const rawTexts = isHtml ? [text] : javascriptRepresentations(text, extensionMode);
    const normalizedTexts = normalizeScanTexts(text, isHtml, extensionMode);
    for (const row of forbidden.clearanceRowFingerprints) if (normalizedTexts.some((normalizedText) => row.components.every((component) => normalizedText.includes(` ${component} `)))) throw new Error(`internal field-clearance row fingerprint (${row.label}) published in ${path}`);
    for (const scalar of forbidden.scalarFingerprints) if (rawTexts.some((rawText) => rawText.includes(scalar))) throw new Error(`internal review-pack scalar fingerprint published in ${path}`);
    for (const contract of forbidden.licensedContractFingerprints) if (rawTexts.some((rawText) => rawText.includes(contract.raw)) || normalizedTexts.some((normalizedText) => normalizedText.includes(contract.normalized))) throw new Error(`internal licensed-delivery contract scalar fingerprint published in ${path}`);
    for (const fixture of forbidden.licensedFixtureFingerprints) if (rawTexts.some((rawText) => rawText.includes(fixture.raw)) || normalizedTexts.some((normalizedText) => normalizedText.includes(fixture.normalized))) throw new Error(`internal licensed-delivery fixture scalar fingerprint published in ${path}`);
    for (const draft of forbidden.licensedDraftFingerprints) if (rawTexts.some((rawText) => rawText.includes(draft.raw)) || normalizedTexts.some((normalizedText) => normalizedText.includes(draft.normalized))) throw new Error(`internal review-pack scalar fingerprint published in ${path}`);
    for (const marker of forbidden.normalizedMarkers) if (normalizedTexts.some((normalizedText) => normalizedText.includes(marker.normalized))) throw new Error(`normalized internal review-pack marker (${marker.raw}) published in ${path}`);
    try {
      const match = rawTexts.map((rawText) => {
        try { return findForbiddenSemanticSection(JSON.parse(rawText), forbidden.semanticFingerprints); } catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
      }).find(Boolean);
      if (match) throw new Error(`internal review-pack semantic section (${match}) published in ${path}`);
    } catch (error) { throw error; }
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
