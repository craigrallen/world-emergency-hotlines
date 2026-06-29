import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = resolve(WEB_ROOT, 'public', 'data');
const COUNTRIES_DIR = resolve(DATA_DIR, 'countries');

const URL_FIELDS = ['website', 'chat_url'];
const SOURCE_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const EMAIL_CONTROL_OR_WHITESPACE_RE = /[\s\p{Cc}]/u;
const ALLOWED_SOURCE_SCHEMES = new Set([
  'http:',
  'https:',
  // Internal generated-data provenance token, not a navigable URL.
  'xref:',
]);

const errors = [];
let checkedHotlines = 0;

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return null;
  }
}

function displayValue(value) {
  return JSON.stringify(value);
}

function fail(alpha2, hotlineName, fieldName, value, reason) {
  errors.push(
    `${alpha2} | ${hotlineName || '<unnamed hotline>'} | ${fieldName} | ${displayValue(value)} | ${reason}`,
  );
}

function hasValue(value) {
  return value !== null && value !== undefined;
}

function validateHttpUrl(value, alpha2, hotlineName, fieldName) {
  if (typeof value !== 'string') {
    fail(alpha2, hotlineName, fieldName, value, 'must be a string URL');
    return;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(alpha2, hotlineName, fieldName, value, 'must parse as a URL');
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(alpha2, hotlineName, fieldName, value, 'must use http: or https:');
  }
}

function validateEmail(value, alpha2, hotlineName) {
  if (typeof value !== 'string') {
    fail(alpha2, hotlineName, 'email', value, 'must be a string email address');
    return;
  }

  if (SOURCE_SCHEME_RE.test(value)) {
    fail(alpha2, hotlineName, 'email', value, 'must be a plain email value, not a URL');
    return;
  }

  if (EMAIL_CONTROL_OR_WHITESPACE_RE.test(value)) {
    fail(alpha2, hotlineName, 'email', value, 'must not contain whitespace or control characters');
    return;
  }

  const atCount = [...value].filter((char) => char === '@').length;
  if (atCount !== 1) {
    fail(alpha2, hotlineName, 'email', value, 'must contain exactly one @');
    return;
  }

  const [localPart, domainPart] = value.split('@');
  if (!localPart || !domainPart) {
    fail(alpha2, hotlineName, 'email', value, 'must have non-empty local and domain portions');
  }
}

function validateSources(value, alpha2, hotlineName) {
  if (!hasValue(value)) {
    return;
  }
  if (!Array.isArray(value)) {
    fail(alpha2, hotlineName, 'sources', value, 'must be an array when present');
    return;
  }

  for (const [index, source] of value.entries()) {
    const fieldName = `sources[${index}]`;
    if (typeof source !== 'string') {
      fail(alpha2, hotlineName, fieldName, source, 'must be a string');
      continue;
    }

    const schemeMatch = source.match(SOURCE_SCHEME_RE);
    if (!schemeMatch) {
      continue;
    }

    const scheme = `${schemeMatch[1].toLowerCase()}:`;
    if (!ALLOWED_SOURCE_SCHEMES.has(scheme)) {
      fail(alpha2, hotlineName, fieldName, source, 'URL-like source schemes must be http:, https:, or known internal token scheme xref:');
    }
  }
}

const manifest = readJson(resolve(DATA_DIR, 'manifest.json'), 'manifest.json');
const countries = Array.isArray(manifest?.countries) ? manifest.countries : [];
if (!Array.isArray(manifest?.countries)) {
  errors.push('manifest.json | <manifest> | countries | undefined | must be an array');
}

for (const country of countries) {
  const alpha2 = country?.alpha2;
  if (!/^[A-Z]{2}$/.test(alpha2 ?? '')) {
    errors.push(`manifest.json | <manifest> | countries.alpha2 | ${displayValue(alpha2)} | must be an uppercase ISO alpha2 code`);
    continue;
  }

  const shardName = `${alpha2.toLowerCase()}.json`;
  const shard = readJson(resolve(COUNTRIES_DIR, shardName), `countries/${shardName}`);
  const hotlines = Array.isArray(shard?.hotlines) ? shard.hotlines : [];
  if (!Array.isArray(shard?.hotlines)) {
    errors.push(`${alpha2} | <country shard> | hotlines | ${displayValue(shard?.hotlines)} | must be an array`);
    continue;
  }

  for (const hotline of hotlines) {
    checkedHotlines += 1;
    const hotlineName = typeof hotline?.name === 'string' && hotline.name ? hotline.name : '<unnamed hotline>';

    for (const fieldName of URL_FIELDS) {
      const value = hotline?.[fieldName];
      if (hasValue(value)) {
        validateHttpUrl(value, alpha2, hotlineName, fieldName);
      }
    }

    if (hasValue(hotline?.email)) {
      validateEmail(hotline.email, alpha2, hotlineName);
    }

    validateSources(hotline?.sources, alpha2, hotlineName);
  }
}

if (errors.length > 0) {
  console.error(`Contact link safety check failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(`Contact link safety OK: ${checkedHotlines} hotlines across ${countries.length} countries`);
