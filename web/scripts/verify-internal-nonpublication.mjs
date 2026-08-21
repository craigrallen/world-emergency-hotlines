import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeHTML, decodeHTMLAttribute } from 'entities/decode';
import { parse } from 'parse5';
import { SaxesParser } from 'saxes';
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
const MAX_MARKUP_SCAN_ITEMS = 250_000;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const TEXT_ARTIFACT_EXTENSIONS = new Set([
  '.asc', '.atom', '.cjs', '.conf', '.css', '.csv', '.graphql', '.gql', '.htm', '.html', '.ics', '.ini',
  '.js', '.json', '.json5', '.jsonl', '.jsx', '.map', '.manifest', '.md', '.mjs', '.ndjson', '.rss', '.shtml',
  '.svg', '.text', '.toml', '.ts', '.tsx', '.txt', '.vtt', '.webmanifest', '.xhtml', '.xml', '.xsl', '.xslt', '.yaml', '.yml',
]);
const OPAQUE_ARTIFACT_EXTENSIONS = new Set([
  '.avif', '.bin', '.eot', '.gif', '.ico', '.jpeg', '.jpg', '.mp3', '.mp4',
  '.ogg', '.otf', '.pdf', '.png', '.ttf', '.wasm', '.webp', '.woff', '.woff2',
]);
const ARCHIVE_ARTIFACT_EXTENSIONS = new Set([
  '.7z', '.a', '.ace', '.alz', '.ar', '.arc', '.arj', '.br', '.bz', '.bz2', '.cab', '.cpio', '.deb', '.dmg',
  '.ear', '.gz', '.iso', '.jar', '.lha', '.lharc', '.lzh', '.lz', '.lz4', '.lzip', '.lzma', '.pak', '.rar',
  '.rpm', '.sit', '.sitx', '.squashfs', '.tar', '.taz', '.tb2', '.tbz', '.tbz2', '.tgz', '.tlz', '.txz',
  '.war', '.whl', '.xar', '.xz', '.z', '.zip', '.zipx', '.zst', '.zstd',
]);
const EXTENSIONLESS_TEXT_OUTPUTS = new Set([
  '_headers', '_redirects', 'ads.txt', 'assetlinks.json', 'cname', 'humans.txt', 'manifest', 'robots.txt',
  'security.txt', 'sitemap',
]);
// Generated release metadata is output, not authority. Every supported opaque
// artifact needs a reviewed source-controlled entry here and must remain at the
// exact public-root path with the exact checked-in bytes.
const GENERATED_OPAQUE_ALLOWLIST = new Map([
  ['apple-touch-icon.png', 'apple-touch-icon.png'],
  ['favicon-192x192.png', 'favicon-192x192.png'],
  ['favicon-32x32.png', 'favicon-32x32.png'],
  ['pwa-icon-512.png', 'pwa-icon-512.png'],
  ['social-card.png', 'social-card.png'],
]);
const artifactExtension = (label) => {
  const basename = label.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  const dot = basename.lastIndexOf('.');
  return { basename, extension: dot > 0 ? basename.slice(dot) : '' };
};
const archiveSignature = (bytes) => {
  const signatures = [
    ['gzip', Buffer.from([0x1f, 0x8b])], ['ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ['ZIP', Buffer.from([0x50, 0x4b, 0x05, 0x06])], ['ZIP', Buffer.from([0x50, 0x4b, 0x07, 0x08])],
    ['7z', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])], ['bzip2', Buffer.from('BZh')],
    ['xz', Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])], ['rar', Buffer.from('Rar!\x1a\x07', 'latin1')],
    ['zstd', Buffer.from([0x28, 0xb5, 0x2f, 0xfd])], ['lzip', Buffer.from('LZIP')],
    ['Unix compress', Buffer.from([0x1f, 0x9d])], ['ar/deb', Buffer.from('!<arch>\n')],
    ['cab', Buffer.from('MSCF')], ['xar', Buffer.from('xar!')], ['ACE', Buffer.from('**ACE**')],
    ['RPM', Buffer.from([0xed, 0xab, 0xee, 0xdb])], ['LZ4', Buffer.from([0x04, 0x22, 0x4d, 0x18])],
  ];
  for (const [name, signature] of signatures) {
    const offset = bytes.indexOf(signature);
    if (offset === 0 || (signature.length >= 4 && offset > 0)) return name;
  }
  for (const signature of ['070701', '070702', '070707']) if (bytes.subarray(0, 6).equals(Buffer.from(signature))) return 'cpio';
  if (bytes.length >= 265 && bytes.subarray(257, 262).equals(Buffer.from('ustar'))) return 'tar';
  return undefined;
};
const assertPublishableArtifact = (path, bytes) => {
  const { extension } = artifactExtension(path);
  if (ARCHIVE_ARTIFACT_EXTENSIONS.has(extension)) throw new Error(`compressed/archive artifact ${path} is forbidden in public dist (extension ${extension})`);
  const signature = archiveSignature(bytes);
  if (signature) throw new Error(`compressed/archive artifact ${path} is forbidden in public dist (${signature} signature)`);
};
const isOpaqueArtifactPath = (path) => {
  const { basename, extension } = artifactExtension(path);
  return OPAQUE_ARTIFACT_EXTENSIONS.has(extension)
    || (!extension && !EXTENSIONLESS_TEXT_OUTPUTS.has(basename))
    || (extension && !TEXT_ARTIFACT_EXTENSIONS.has(extension) && !ARCHIVE_ARTIFACT_EXTENSIONS.has(extension));
};
const assertCanonicalPublicRelativePath = (relativePath) => {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\') || /[\x00-\x1f\x7f]/u.test(relativePath)
      || relativePath.includes('//') || relativePath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`noncanonical public artifact relative path ${JSON.stringify(relativePath)} is forbidden`);
  }
};
const assertApprovedOpaqueArtifact = (repoRoot, relativePath, bytes) => {
  assertCanonicalPublicRelativePath(relativePath);
  const sourceRelativePath = GENERATED_OPAQUE_ALLOWLIST.get(relativePath);
  if (sourceRelativePath !== undefined) {
    const source = readFileSync(resolve(repoRoot, 'web/public', sourceRelativePath));
    if (source.length === bytes.length && source.equals(bytes) && sha256(source) === sha256(bytes)) return;
  }
  throw new Error(`opaque public artifact /${relativePath} is forbidden unless explicitly source-allowlisted at its exact canonical path and checked-in byte/SHA-256 identity`);
};
const payloadLooksTextLike = (bytes) => {
  // Latin-1 is used only for an ASCII-compatible signature check. It is never
  // accepted as the artifact encoding.
  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024)).toString('latin1');
  const trimmed = sample.replace(/^[\x00-\x20]+/u, '');
  return /^(?:<!doctype\s+html\b|<html\b|<\?xml\b|<(?:svg|rss|feed)\b|[\[{])/iu.test(trimmed)
    || /<meta\b[^>]*\bcharset\s*=|<meta\b[^>]*http-equiv\s*=\s*["']?content-type|\bcontent-type\s*:\s*(?:text\/|application\/(?:javascript|json|xml))/iu.test(sample);
};
const textArtifactClassification = (bytes, label) => {
  const { basename, extension } = artifactExtension(label);
  if (TEXT_ARTIFACT_EXTENSIONS.has(extension)) return `text extension ${extension}`;
  if (EXTENSIONLESS_TEXT_OUTPUTS.has(basename)) return `known text output ${basename}`;
  if (payloadLooksTextLike(bytes)) return 'text-like payload signature';
  if (isOpaqueArtifactPath(label)) return undefined;
  return extension ? `non-binary artifact extension ${extension}` : 'unrecognized extensionless non-binary artifact';
};
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
    if (error instanceof TypeError) {
      const classification = textArtifactClassification(bytes, label);
      if (classification) throw new Error(`${label} is a text-like artifact (${classification}) with invalid UTF-8; legacy charset declarations do not permit non-UTF-8 build output`);
      return undefined; // Opaque binary: retain byte/hash checks, but skip text normalization.
    }
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
const CLASSIC_JAVASCRIPT_MIME_ESSENCES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);
const MIME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const MIME_QUOTED_PAIR = /^[\t\x20-\x7e\x80-\xff]$/u;
const parseMimeEssence = (input) => {
  const value = input.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, '');
  const semicolon = value.indexOf(';');
  const essence = (semicolon < 0 ? value : value.slice(0, semicolon)).replace(/[\t\n\f\r ]+$/gu, '');
  const slash = essence.indexOf('/');
  if (slash <= 0 || slash !== essence.lastIndexOf('/') || !MIME_TOKEN.test(essence.slice(0, slash)) || !MIME_TOKEN.test(essence.slice(slash + 1))) return undefined;
  let rest = semicolon < 0 ? '' : value.slice(semicolon);
  while (rest) {
    if (rest[0] !== ';') return undefined;
    rest = rest.slice(1).replace(/^[\t\n\f\r ]+/u, '');
    const equals = rest.indexOf('=');
    if (equals <= 0) return undefined;
    const name = rest.slice(0, equals).replace(/[\t\n\f\r ]+$/u, '');
    if (!MIME_TOKEN.test(name)) return undefined;
    rest = rest.slice(equals + 1).replace(/^[\t\n\f\r ]+/u, '');
    if (rest[0] === '"') {
      let index = 1, closed = false;
      for (; index < rest.length; index += 1) {
        if (rest[index] === '"') { index += 1; closed = true; break; }
        if (rest[index] === '\\') {
          index += 1;
          if (index >= rest.length || !MIME_QUOTED_PAIR.test(rest[index])) return undefined;
        } else if (!MIME_QUOTED_PAIR.test(rest[index])) return undefined;
      }
      if (!closed) return undefined;
      rest = rest.slice(index).replace(/^[\t\n\f\r ]+/u, '');
    } else {
      const next = rest.indexOf(';');
      const parameter = (next < 0 ? rest : rest.slice(0, next)).replace(/[\t\n\f\r ]+$/u, '');
      if (!MIME_TOKEN.test(parameter)) return undefined;
      rest = next < 0 ? '' : rest.slice(next);
    }
  }
  return essence.toLowerCase();
};
export const classifyHtmlScriptType = (rawType) => {
  if (rawType === undefined || rawType.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, '') === '') return 'classic';
  const normalized = rawType.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, '').toLowerCase();
  if (normalized === 'module') return 'strict';
  if (normalized === 'importmap' || normalized === 'speculationrules') return 'disabled';
  const essence = parseMimeEssence(rawType);
  return essence && CLASSIC_JAVASCRIPT_MIME_ESSENCES.has(essence) ? 'classic' : 'disabled';
};
const javascriptRepresentations = (text, mode = 'unknown') => mode === 'disabled' || mode === 'strict' || hasStrictDirective(text)
  ? [text]
  : [...new Set([text, decodeLegacyOctalEscapes(text)])];
const JS_ESCAPE_CHARACTERS = new Set(["'", '"', '\\', 'b', 'f', 'n', 'r', 't', 'v', 'x', 'u']);
const decodeJavaScriptEscapes = (text, decodeNonEscapeCharacter = false) => {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\\') { output += text[index]; continue; }
    const next = text[index + 1];
    // Retain escaped backslashes as a stable pair. This representation is a
    // conservative scanner view, not an evaluator, and must not turn `\\\\a`
    // into a NonEscapeCharacter on a later fixed-point pass.
    if (next === '\\') { output += '\\\\'; index += 1; continue; }
    if (next === '\r' || next === '\n' || next === '\u2028' || next === '\u2029') {
      if (next === '\r' && text[index + 2] === '\n') index += 2;
      else index += 1;
      continue;
    }
    if (next === 'u' && text[index + 2] === '{') {
      const close = text.indexOf('}', index + 3);
      const hex = close < 0 ? '' : text.slice(index + 3, close);
      if (/^[0-9a-f]{1,6}$/iu.test(hex)) {
        const point = Number.parseInt(hex, 16);
        if (point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)) { output += String.fromCodePoint(point); index = close; continue; }
      }
    } else if (next === 'u' && /^[0-9a-f]{4}$/iu.test(text.slice(index + 2, index + 6))) {
      output += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16)); index += 5; continue;
    } else if (next === 'x' && /^[0-9a-f]{2}$/iu.test(text.slice(index + 2, index + 4))) {
      output += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 4), 16)); index += 3; continue;
    }
    if (decodeNonEscapeCharacter && next !== undefined && !JS_ESCAPE_CHARACTERS.has(next) && !/[0-9]/u.test(next)) {
      output += next; index += 1; continue;
    }
    output += '\\';
  }
  return output;
};
const decodePercentEncoding = (text) => text.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
  try { return decodeURIComponent(encoded); } catch { return encoded; }
});
export const decodeCssEscapes = (text) => {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\\') { output += text[index]; continue; }
    const next = text[index + 1];
    if (next === undefined) { output += '\\'; continue; }
    if (/[0-9a-f]/iu.test(next)) {
      let end = index + 1;
      while (end < text.length && end < index + 7 && /[0-9a-f]/iu.test(text[end])) end += 1;
      const point = Number.parseInt(text.slice(index + 1, end), 16);
      output += point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? '\ufffd' : String.fromCodePoint(point);
      if (/[\t\n\f\r ]/u.test(text[end] ?? '')) {
        if (text[end] === '\r' && text[end + 1] === '\n') end += 1;
        index = end;
      } else index = end - 1;
      continue;
    }
    if (next === '\n' || next === '\f') { index += 1; continue; }
    if (next === '\r') { index += text[index + 2] === '\n' ? 2 : 1; continue; }
    output += next; index += 1;
  }
  return output;
};
const normalizeDecodedText = (text) => ` ${text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const decodeBoundedText = (text, label = 'production artifact', decodeEntities = decodeHTML, decodeNonEscapeCharacter = false, decodeJavaScript = true) => {
  let decoded = text;
  let converged = false;
  for (let i = 0; i < MAX_NORMALIZATION_PASSES; i += 1) {
    const escaped = decodeJavaScript ? decodeJavaScriptEscapes(decoded, decodeNonEscapeCharacter) : decoded;
    const next = decodeEntities(decodePercentEncoding(escaped));
    if (Buffer.byteLength(next) > MAX_NORMALIZATION_BYTES) throw new Error(`decoded ${label} exceeds bounded nonpublication normalization size`);
    if (next === decoded) { converged = true; break; }
    decoded = next;
  }
  if (!converged) throw new Error(`${label} exceeds bounded nonpublication normalization iterations`);
  return decoded;
};
const decodedCssRepresentations = (text, label, decodeEntities = decodeHTML) => {
  const decoded = decodeBoundedText(text, label, decodeEntities, false, false);
  const cssDecoded = decodeCssEscapes(decoded);
  if (Buffer.byteLength(cssDecoded) > MAX_NORMALIZATION_BYTES) throw new Error(`decoded ${label} exceeds bounded nonpublication normalization size`);
  return [...new Set([decoded, cssDecoded])];
};
const decodedJavaScriptRepresentations = (text, label, decodeEntities = decodeHTML, mode = 'unknown', decodeNonEscapeCharacter = false) => javascriptRepresentations(text, mode)
  .map((source) => decodeBoundedText(source, label, decodeEntities, mode !== 'disabled' && mode !== 'strict' && decodeNonEscapeCharacter));
const FATAL_HTML_PARSE_ERRORS = new Set([
  'abrupt-closing-of-empty-comment', 'abrupt-doctype-public-identifier', 'abrupt-doctype-system-identifier',
  'eof-in-cdata', 'eof-in-comment', 'eof-in-doctype', 'eof-in-element-that-can-contain-only-text',
  'eof-in-script-html-comment-like-text', 'eof-in-tag', 'unexpected-null-character',
]);
const parseHtmlDocument = (source, options = {}) => {
  let firstError;
  const document = parse(source, { ...options, onParseError: (error) => { if (FATAL_HTML_PARSE_ERRORS.has(error.code)) firstError ??= error; } });
  if (firstError) throw new Error(`production HTML is malformed (${firstError.code})`);
  return document;
};
const htmlRepresentations = (html, sourceHtml, decodeNonEscapeCharacter = false) => {
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
  const addAttributeValue = (raw, css = false) => {
    if (!raw) return;
    const values = css
      ? decodedCssRepresentations(raw, 'HTML style attribute', decodeHTMLAttribute)
      : decodedJavaScriptRepresentations(raw, 'HTML attribute value', decodeHTMLAttribute, 'unknown', decodeNonEscapeCharacter);
    for (const value of values) {
      attributeBytes += Buffer.byteLength(value);
      if (attributeBytes > MAX_NORMALIZATION_BYTES) throw new Error('decoded HTML attributes exceed bounded nonpublication normalization size');
      // Keep values separate: unrelated public attributes must not combine to
      // form a forbidden scalar or row fingerprint.
      representations.push(value);
    }
  };
  const addText = (raw, values, mode = 'unknown') => {
    for (const value of decodedJavaScriptRepresentations(raw, 'HTML text value', decodeHTML, mode, decodeNonEscapeCharacter)) {
      textBytes += Buffer.byteLength(value);
      if (textBytes > MAX_NORMALIZATION_BYTES) throw new Error('decoded HTML text exceeds bounded nonpublication normalization size');
      values.push(value);
    }
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
      if (scanItems > MAX_MARKUP_SCAN_ITEMS) throw new Error('production HTML exceeds bounded nonpublication scan work');
      visitor(node);
      if (node.content) pending.push(node.content);
      const children = node.childNodes ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
    }
  };
  for (const scriptingEnabled of [true, false]) {
    const textNodes = [];
    const document = parseHtmlDocument(html, { scriptingEnabled });
    visit(document, (node) => {
      addDoctype(node);
      if (node.tagName) addName(node.tagName);
      for (const attribute of node.attrs ?? []) {
        addName(attribute.name);
        addAttributeValue(attribute.value, attribute.name.toLowerCase() === 'style');
      }
      if (node.nodeName === '#text') {
        if (node.parentNode?.tagName === 'style') {
          for (const value of decodedCssRepresentations(node.value, 'HTML style element')) {
            textBytes += Buffer.byteLength(value);
            if (textBytes > MAX_NORMALIZATION_BYTES) throw new Error('decoded HTML text exceeds bounded nonpublication normalization size');
            representations.push(value);
          }
        } else if (node.parentNode?.tagName === 'script') {
          const type = node.parentNode.attrs?.find((attribute) => attribute.name.toLowerCase() === 'type')?.value;
          const mode = classifyHtmlScriptType(type);
          const scriptValues = [];
          addText(node.value, scriptValues, mode);
          representations.push(...scriptValues);
        } else addText(node.value, textNodes);
      }
      if (node.nodeName === '#comment') {
        const values = decodedJavaScriptRepresentations(node.data, 'HTML comment value', decodeHTML, 'unknown', decodeNonEscapeCharacter);
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
              addAttributeValue(attribute.value, attribute.name.toLowerCase() === 'style');
            }
            if (commentNode.nodeName === '#text') addText(commentNode.value, commentTextNodes);
          });
          representations.push(commentTextNodes.join(' '), commentTextNodes.join(''));
        }
      }
    });
    representations.push(textNodes.join(' '), textNodes.join(''));
    visit(parseHtmlDocument(sourceHtml), (node) => {
      addDoctype(node);
      if (node.tagName) addName(node.tagName);
      for (const attribute of node.attrs ?? []) {
        scanItems += 1;
        if (scanItems > MAX_MARKUP_SCAN_ITEMS) throw new Error('production HTML exceeds bounded nonpublication scan work');
        addName(attribute.name);
        addAttributeValue(attribute.value, attribute.name.toLowerCase() === 'style');
      }
    });
    // Attribute decoding starts after parsing the original markup, so encoded
    // angle brackets cannot alter the HTML tree. parse5 has already resolved
    // character references; bounded decoding handles percent/JS nesting.
  };
  return [...new Set(representations)];
};
const xmlRepresentations = (xml, decodeNonEscapeCharacter = false) => {
  const representations = [];
  const renderedText = [];
  const stack = [];
  let scanItems = 0;
  let decodedBytes = 0;
  const account = (value, label) => {
    scanItems += 1; decodedBytes += Buffer.byteLength(value);
    if (scanItems > MAX_MARKUP_SCAN_ITEMS) throw new Error('production XML exceeds bounded nonpublication scan work');
    if (decodedBytes > MAX_NORMALIZATION_BYTES) throw new Error('decoded XML exceeds bounded nonpublication normalization size');
    if (value) representations.push(value);
  };
  const decoded = (raw, label, entities = decodeHTML) => decodedJavaScriptRepresentations(raw, label, entities, 'unknown', decodeNonEscapeCharacter);
  const addIndependent = (raw, label, entities = decodeHTML) => {
    if (!raw) return;
    for (const value of decoded(raw, label, entities)) account(value, label);
  };
  const addRendered = (raw, context) => {
    if (!raw) return;
    const values = context === 'style'
      ? decodedCssRepresentations(raw, 'XML style content')
      : context === 'script'
        ? decodedJavaScriptRepresentations(raw, 'XML script content', decodeHTML, 'unknown', decodeNonEscapeCharacter)
        : decoded(raw, 'XML rendered text');
    for (const value of values) {
      account(value, 'XML rendered text');
      if (context !== 'style' && context !== 'script') renderedText.push(value);
    }
  };
  const parser = new SaxesParser({ xmlns: false, fragment: false });
  parser.on('opentag', (node) => {
    addIndependent(node.name, 'XML element name');
    for (const [key, attribute] of Object.entries(node.attributes)) {
      const name = typeof attribute === 'string' ? key : attribute.name;
      const raw = typeof attribute === 'string' ? attribute : attribute.value;
      addIndependent(name, 'XML attribute name');
      const values = name.toLowerCase() === 'style'
        ? decodedCssRepresentations(raw, 'XML style attribute')
        : decoded(raw, 'XML attribute value');
      for (const value of values) account(value, 'XML attribute value');
    }
    stack.push(node.name.toLowerCase());
  });
  parser.on('closetag', () => { stack.pop(); });
  parser.on('text', (value) => addRendered(value, stack.at(-1)));
  parser.on('cdata', (value) => addRendered(value, stack.at(-1)));
  parser.on('comment', (value) => addIndependent(value, 'XML comment'));
  parser.on('processinginstruction', ({ target, body }) => {
    addIndependent(target, 'XML processing-instruction target');
    addIndependent(body, 'XML processing-instruction body');
  });
  parser.on('doctype', (value) => addIndependent(value, 'XML doctype and entity declarations'));
  parser.write(xml).close();
  representations.push(renderedText.join(' '), renderedText.join(''));
  return [...new Set(representations)];
};
const MARKUP_EXTENSIONS = new Map([
  ['.html', 'html'], ['.htm', 'html'], ['.shtml', 'html'],
  ['.xml', 'xml'], ['.svg', 'xml'], ['.xhtml', 'xml'], ['.atom', 'xml'], ['.rss', 'xml'], ['.xsl', 'xml'], ['.xslt', 'xml'],
]);
const markupKind = (text, label) => {
  const { extension } = artifactExtension(label);
  if (MARKUP_EXTENSIONS.has(extension)) return MARKUP_EXTENSIONS.get(extension);
  const trimmed = text.replace(/^\ufeff?[\x00-\x20]*/u, '');
  if (/^<\?xml\b/iu.test(trimmed) || /^<(?:svg|rss|feed)\b/iu.test(trimmed)) return 'xml';
  if (/^<!doctype\s+html\b/iu.test(trimmed) || /^<html\b/iu.test(trimmed)) return 'html';
  if (/^<!doctype\s+[a-z_:][\w:.-]*\b/iu.test(trimmed) || /^<[a-z_:][\w:.-]*\b[^>]*\bxmlns(?::[\w.-]+)?\s*=/iu.test(trimmed)) return 'xml';
  return undefined;
};
const normalizeScanTexts = (text, markup = undefined, javascriptMode = 'unknown') => {
  if (Buffer.byteLength(text) > MAX_NORMALIZATION_BYTES) throw new Error('production artifact exceeds bounded nonpublication normalization size');
  const sourceRepresentations = markup ? [text] : javascriptMode === 'css' ? [text] : javascriptRepresentations(text, javascriptMode);
  const representations = sourceRepresentations.flatMap((source) => {
    let decodedRepresentations;
    if (markup) {
      const contextSafe = decodeBoundedText(source, 'production artifact', decodeHTML, false, false);
      // Only apply whole-payload JavaScript decoding when nested encoding has
      // hidden the markup itself. Once markup is visible, escapes belong to the
      // parser-selected script/CSS/text context and must not bleed across it.
      decodedRepresentations = /^\s*</u.test(source)
        ? [source]
        : /^\s*</u.test(contextSafe)
          ? [contextSafe]
        : [...new Set([contextSafe, decodeBoundedText(source)])];
    } else if (javascriptMode === 'disabled') decodedRepresentations = [decodeBoundedText(source)];
    else decodedRepresentations = javascriptMode === 'css'
        ? decodedCssRepresentations(source, 'CSS artifact')
        : [...new Set([decodeBoundedText(source), decodeBoundedText(source, 'production artifact', decodeHTML, javascriptMode !== 'strict')])];
    return decodedRepresentations.flatMap((decoded) => markup === 'html'
      ? [htmlRepresentations(decoded, source), htmlRepresentations(decoded, source, true)].flat()
      : markup === 'xml'
        ? [xmlRepresentations(decoded), xmlRepresentations(decoded, true)].flat()
      : [decoded]);
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
    const link = lstatSync(path);
    if (link.isSymbolicLink()) throw new Error(`symbolic link ${path} is forbidden in public dist`);
    const metadata = statSync(path);
    if (!metadata.isFile()) throw new Error(`non-regular artifact ${path} is forbidden in public dist`);
    if (metadata.nlink !== 1) throw new Error(`hard-linked artifact ${path} is forbidden in public dist`);
    let bytes = readFileSync(path);
    const nativeRelativePath = relative(dist, path);
    if (sep !== '\\') assertCanonicalPublicRelativePath(nativeRelativePath);
    const relativePath = nativeRelativePath.split(sep).join('/');
    assertCanonicalPublicRelativePath(relativePath);
    if (relativePath === 'api/v1/traveler-cards.json.gz') {
      const rawPath = resolve(dist, 'api/v1/traveler-cards.json');
      const manifest = JSON.parse(readFileSync(resolve(dist, 'api/v1/manifest.json'), 'utf8'));
      const index = JSON.parse(readFileSync(resolve(dist, 'release/v1/artifacts.json'), 'utf8'));
      const release = JSON.parse(readFileSync(resolve(dist, 'release/v1/release.json'), 'utf8'));
      const compressed = bytes;
      try { bytes = gunzipSync(compressed, { maxOutputLength: 1024 * 1024 }); } catch { throw new Error(`generated compatibility artifact ${path} could not be boundedly gunzipped`); }
      const raw = readFileSync(rawPath);
      if (!bytes.equals(raw)) throw new Error(`generated compatibility artifact ${path} does not decompress to canonical raw JSON bytes`);
      const descriptors = manifest.traveler_card_artifacts;
      const rawHash = sha256(raw), gzipHash = sha256(compressed);
      if (descriptors?.raw?.path !== 'traveler-cards.json' || descriptors.raw.bytes !== raw.length || descriptors.raw.sha256 !== rawHash
          || descriptors?.gzip_compatibility?.path !== 'traveler-cards.json.gz' || descriptors.gzip_compatibility.bytes !== compressed.length || descriptors.gzip_compatibility.sha256 !== gzipHash
          || descriptors.gzip_compatibility.decompressed_bytes !== raw.length || descriptors.gzip_compatibility.decompressed_sha256 !== rawHash) throw new Error(`generated compatibility artifact ${path} manifest hashes or sizes mismatch`);
      for (const [publicPath, expectedBytes, expectedHash] of [['/api/v1/traveler-cards.json', raw.length, rawHash], ['/api/v1/traveler-cards.json.gz', compressed.length, gzipHash]]) {
        const entry = index.artifacts?.find((candidate) => candidate.path === publicPath);
        if (entry?.bytes !== expectedBytes || entry?.sha256 !== expectedHash || JSON.stringify(release.relationships?.[publicPath]) !== JSON.stringify(entry)) throw new Error(`generated compatibility artifact ${path} release hashes or sizes mismatch`);
      }
    } else {
      assertPublishableArtifact(path, bytes);
    }
    for (const marker of forbidden.markers) if (bytes.includes(Buffer.from(marker))) throw new Error(`internal review-pack marker published in ${path}`);
    if (forbidden.exactHashes.includes(sha256(bytes))) throw new Error(`internal evidence exact copy published in ${path}`);
    const text = decodeArtifactText(bytes, `production artifact ${path}`);
    if (text === undefined) {
      if (isOpaqueArtifactPath(relativePath)) assertApprovedOpaqueArtifact(repoRoot, relativePath, bytes);
      continue;
    }
    const markup = markupKind(text, path);
    const extensionMode = /\.css$/iu.test(path) ? 'css' : /\.mjs$/iu.test(path) ? 'strict' : /\.json$/iu.test(path) ? 'disabled' : 'unknown';
    const rawTexts = markup || extensionMode === 'css' ? [text] : javascriptRepresentations(text, extensionMode);
    const normalizedTexts = normalizeScanTexts(text, markup, extensionMode);
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
    if (isOpaqueArtifactPath(relativePath)) assertApprovedOpaqueArtifact(repoRoot, relativePath, bytes);
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
