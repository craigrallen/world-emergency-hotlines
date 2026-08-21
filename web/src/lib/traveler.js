import { dedupeMessageContacts, phoneContacts } from './contact.ts';
import { resolveGuidedHelp } from './finder.js';

export const TRAVELER_MANIFEST_URL = '/data/manifest.json';
export const TRAVELER_RECORDS_URL = '/api/v1/records.json';
export const TRAVELER_CARD_MANIFEST_URL = '/api/v1/manifest.json';
export const TRAVELER_CARD_BUNDLE_URL = '/api/v1/traveler-cards.json';
export const TRAVELER_RECORDS_API_VERSION = '1.0';
export const TRAVELER_CARD_BUNDLE_MAX_BYTES = 1024 * 1024;
export const TRAVELER_CARD_BROWSER_COMPATIBILITY_MESSAGE = 'Country-card downloads require standard JSON, UTF-8 decoding, file downloads, and streaming response support. Use a current browser or the regular Traveler Mode search below.';
// Keep cards compact while ensuring validated destinations outrank display-only values.
export const TRAVELER_CARD_CONTACT_LIMIT = 2;

const NO_CROSS_BORDER_REASON = 'No usable current-country support record was found after the finder’s documented fallbacks. No regional or global hotline is shown because the released data does not establish cross-border access or eligibility.';

function normalizeCode(value) {
  return String(value ?? '').trim().toUpperCase();
}

/** Stable-partition normalized contacts by usability, then apply the card limit. */
export function selectTravelerContacts(contacts, limit = TRAVELER_CARD_CONTACT_LIMIT) {
  if (!Array.isArray(contacts)) throw new TypeError('Traveler contacts must be an array.');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('Traveler contact limit must be a non-negative safe integer.');
  const usable = contacts.filter(({ uri }) => typeof uri === 'string' && uri.length > 0);
  const displayOnly = contacts.filter(({ uri }) => typeof uri !== 'string' || uri.length === 0);
  return [...usable, ...displayOnly].slice(0, limit);
}

/** Accept only absolute HTTP(S) destinations for outbound Traveler actions. */
export function safeTravelerUrl(value) {
  try {
    const url = new URL(String(value));
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Runs non-critical scrolling without allowing browser quirks to fail a successful result. */
export function scrollTravelerOutputBestEffort(scroll) {
  try {
    scroll();
    return true;
  } catch {
    return false;
  }
}

/** Creates monotonically increasing request generations for guarding async UI work. */
export function createLatestGenerationGate() {
  let latest = 0;
  return {
    begin() { latest += 1; return latest; },
    isLatest(generation) { return generation === latest; },
    run(generation, callback) {
      if (generation !== latest) return false;
      callback();
      return true;
    },
  };
}

/** Owns the printable result lifecycle without depending on the DOM. */
export function createTravelerPrintReadinessController() {
  let generation = 0;
  let state = Object.freeze({ generation, ready: false, payload: null });
  const notReady = () => (state = Object.freeze({ generation, ready: false, payload: null }));
  return {
    getState() { return state; },
    invalidate() { generation += 1; return notReady(); },
    begin({ selection, categoryLabel, channelLabel }) {
      generation += 1;
      const submitted = Object.freeze({
        selection: Object.freeze({ ...selection }),
        categoryLabel: String(categoryLabel ?? ''),
        channelLabel: String(channelLabel ?? ''),
      });
      state = Object.freeze({ generation, ready: false, payload: submitted });
      return generation;
    },
    isLatest(candidate) { return candidate === generation; },
    run(candidate, callback) {
      if (candidate !== generation) return false;
      callback();
      return true;
    },
    publish(candidate, releaseContext) {
      if (candidate !== generation) return false;
      const payload = Object.freeze({
        ...state.payload,
        releaseContext: Object.freeze({ ...releaseContext }),
      });
      state = Object.freeze({ generation, ready: true, payload });
      return state;
    },
    fail(candidate) {
      if (candidate !== generation) return false;
      return notReady();
    },
  };
}

/** Owns one downloadable object URL and prevents stale/blank publication. */
export function createTravelerDownloadController({ createObjectURL, revokeObjectURL }) {
  let generation = 0;
  let url = null;
  const revoke = () => {
    if (url) revokeObjectURL(url);
    url = null;
  };
  return {
    begin() { generation += 1; revoke(); return generation; },
    invalidate() { generation += 1; revoke(); },
    isLatest(candidate) { return candidate === generation; },
    publish(candidate, blob) {
      if (candidate !== generation || !blob || typeof blob.size !== 'number' || blob.size <= 0) return null;
      revoke();
      url = createObjectURL(blob);
      return url;
    },
    release(candidate) {
      if (candidate !== generation) return false;
      revoke();
      return true;
    },
  };
}

/** Captures the complete traveler selection before asynchronous work begins. */
export function createTravelerSelectionSnapshot({ currentCode, homeCode = '', category, channel = 'any', locality = '' }) {
  return Object.freeze({
    currentCode: normalizeCode(currentCode),
    homeCode: normalizeCode(homeCode),
    category: String(category ?? ''),
    channel: String(channel || 'any'),
    locality: String(locality ?? '').trim(),
  });
}

/** Extracts deterministic release metadata suitable for displaying with a static result. */
export function getTravelerReleaseContext(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('The static manifest has an invalid release context.');
  }
  const { dataset_version: datasetVersion, source_last_updated: sourceLastUpdated, schema_version: schemaVersion, generated_at: generatedAt } = manifest;
  if (typeof datasetVersion !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(datasetVersion)) {
    throw new Error('The static manifest has an invalid dataset version.');
  }
  if (sourceLastUpdated !== null) {
    const parsedSourceDate = typeof sourceLastUpdated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sourceLastUpdated)
      ? new Date(`${sourceLastUpdated}T00:00:00.000Z`)
      : null;
    if (!parsedSourceDate || Number.isNaN(parsedSourceDate.getTime()) || parsedSourceDate.toISOString().slice(0, 10) !== sourceLastUpdated) {
      throw new Error('The static manifest has an invalid source-update date.');
    }
  }
  if (typeof schemaVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(schemaVersion)) {
    throw new Error('The static manifest has an invalid schema version.');
  }
  if (typeof generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error('The static manifest has an invalid generation date.');
  }
  return Object.freeze({ datasetVersion, sourceLastUpdated, schemaVersion, generatedAt });
}

function safeCardText(value, fallback = '') {
  const cleaned = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 500);
}

// JavaScript relational string comparison is locale-independent UTF-16 code-unit order.
function utf16Compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Produces a deterministic, link-free UTF-8 country card from parity-checked data. */
export function serializeTravelerCountryCard({ country, releaseContext, apiVersion = TRAVELER_RECORDS_API_VERSION }) {
  if (!country?.country || !/^[A-Z]{2}$/.test(country?.alpha2) || !releaseContext?.datasetVersion) {
    throw new Error('A validated country and release context are required for download.');
  }
  const phoneLabel = ({ value, uri }) => {
    const display = safeCardText(value);
    return display ? (uri ? `Call ${display}` : `Phone ${display} (not callable)`) : '';
  };
  const messageLabel = ({ kind, value, uri }) => {
    const displayKind = safeCardText(kind);
    const displayValue = safeCardText(value);
    return displayKind && displayValue ? `${displayKind} ${displayValue}${uri ? '' : ' (not messageable)'}` : '';
  };
  const emergency = phoneContacts(country.general_emergency || [], []).map(phoneLabel).filter(Boolean);
  const records = (country.hotlines || []).filter((record) => record?.verification_status !== 'deprecated').slice().sort((a, b) => utf16Compare(safeCardText(a.id), safeCardText(b.id)));
  const lines = [
    `EMERGENCY — ${safeCardText(country.country)} (${country.alpha2})`,
    emergency.length ? `Recorded general emergency contacts: ${emergency.join(', ')}` : 'No general emergency number is recorded in this directory.',
    'If there is immediate danger, check and follow current local emergency guidance.',
    '',
    'RECORDED SUPPORT LISTINGS',
  ];
  if (!records.length) lines.push('No support listings are recorded for this country.');
  for (const record of records) {
    const phones = phoneContacts(record.voice_numbers || [], record.short_codes || []).map(phoneLabel).filter(Boolean);
    const messages = dedupeMessageContacts(record.sms_numbers || [], record.text_numbers || []).map(messageLabel).filter(Boolean);
    const contacts = [...phones, ...messages];
    lines.push(`${safeCardText(record.name, 'Unnamed service')} — ${contacts.length ? contacts.join('; ') : 'No phone or text contact recorded'} [record ${safeCardText(record.id, 'not stated')}; source checked ${safeCardText(record.last_verified, 'not recorded')}; verification ${safeCardText(record.verification_status, 'not stated').replace(/_/g, ' ')}]`);
  }
  lines.push(
    '',
    'DATASET AND LIMITATIONS',
    `Canonical dataset version: ${safeCardText(releaseContext.datasetVersion)}`,
    `Static API version: ${safeCardText(apiVersion)}`,
    `Schema version: ${safeCardText(releaseContext.schemaVersion)}`,
    `Artifact generation date: ${safeCardText(releaseContext.generatedAt)}`,
    `Canonical source date: ${safeCardText(releaseContext.sourceLastUpdated, 'not recorded')}`,
    'Provenance: generated static artifacts derived from the project canonical dataset; record source-check dates and verification labels are shown above.',
    'Limitations: this is a snapshot, not live information, and it may become stale. Source verification does not prove answering or availability. Eligibility may vary. Check current local emergency guidance.',
    '',
  );
  return lines.join('\n');
}

/** Requires the independently cached records artifact to identify the same static release. */
export function validateTravelerRecordsIdentity(recordsArtifact, releaseContext) {
  if (!recordsArtifact || typeof recordsArtifact !== 'object' || Array.isArray(recordsArtifact)) {
    throw new Error('The static support-record artifact has an invalid identity.');
  }
  if (recordsArtifact.api_version !== TRAVELER_RECORDS_API_VERSION) {
    throw new Error('The static support-record artifact has an invalid API version.');
  }
  if (typeof recordsArtifact.dataset_version !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(recordsArtifact.dataset_version)) {
    throw new Error('The static support-record artifact has an invalid dataset version.');
  }
  if (recordsArtifact.dataset_version !== releaseContext?.datasetVersion) {
    throw new Error('The static manifest and support-record artifact dataset versions do not match.');
  }
  return recordsArtifact;
}

function manifestCountry(entry) {
  if (!entry || typeof entry !== 'object' || !/^[A-Z]{2}$/.test(entry.alpha2) || typeof entry.name !== 'string' || !Array.isArray(entry.general_emergency)) {
    throw new Error('The static manifest has an invalid country entry.');
  }
  return {
    country: entry.name,
    alpha2: entry.alpha2,
    general_emergency: [...entry.general_emergency],
    hotlines: [],
  };
}

/** Returns distinct choices for a travel location and an optional supported home country. */
export function getTravelerCountryChoices(manifest) {
  if (!manifest || !Array.isArray(manifest.countries)) throw new Error('The static manifest has an invalid shape.');
  const countries = manifest.countries.map((entry) => {
    const country = manifestCountry(entry);
    if (!Number.isSafeInteger(entry.hotline_count) || entry.hotline_count < 0) throw new Error('The static manifest has an invalid country entry.');
    return { ...country, hotline_count: entry.hotline_count };
  }).sort((a, b) => a.country.localeCompare(b.country) || a.alpha2.localeCompare(b.alpha2));
  return {
    currentCountries: countries,
    homeCountries: countries.filter(({ hotline_count }) => hotline_count > 0),
  };
}

export function reconstructTravelerCountries(manifest, recordsArtifact, currentCode, homeCode = '') {
  if (!manifest || !Array.isArray(manifest.countries)) throw new Error('The static manifest has an invalid shape.');
  if (!recordsArtifact || !recordsArtifact.records || typeof recordsArtifact.records !== 'object' || Array.isArray(recordsArtifact.records)) {
    throw new Error('The static support-record artifact has an invalid shape.');
  }
  const wantedCurrent = normalizeCode(currentCode);
  const wantedHome = normalizeCode(homeCode);
  const entries = new Map(manifest.countries.map((entry) => [normalizeCode(entry?.alpha2), entry]));
  const currentEntry = entries.get(wantedCurrent);
  if (!currentEntry) throw new Error('The selected current country is not in the static manifest.');
  const currentCountry = manifestCountry(currentEntry);
  const homeEntry = wantedHome && wantedHome !== wantedCurrent ? entries.get(wantedHome) : null;
  if (wantedHome && wantedHome !== wantedCurrent && !homeEntry) throw new Error('The selected home country is not in the static manifest.');
  const homeCountry = homeEntry ? manifestCountry(homeEntry) : null;

  for (const record of Object.values(recordsArtifact.records)) {
    if (!record || typeof record !== 'object') throw new Error('The static support-record artifact contains an invalid record.');
    const code = normalizeCode(record.country_code);
    if (code === wantedCurrent) currentCountry.hotlines.push(record);
    else if (homeCountry && code === wantedHome) homeCountry.hotlines.push(record);
  }
  return { currentCountry, homeCountry };
}

export function getTravelerEmergencyMetadata(manifest, currentCode) {
  if (!manifest || !Array.isArray(manifest.countries)) throw new Error('The static manifest has an invalid shape.');
  const code = normalizeCode(currentCode);
  const entry = manifest.countries.find((country) => normalizeCode(country?.alpha2) === code);
  if (!entry) throw new Error('The selected current country is not in the static manifest.');
  return manifestCountry(entry);
}

async function fetchJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response?.ok) throw new Error(`${label} returned ${response?.status ?? 'an invalid response'}.`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} could not be parsed.`);
  }
}

async function readBoundedTravelerCardBody(response) {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') throw new Error('Static country-card bundle has no readable bounded body.');
  let reader;
  try {
    reader = body.getReader();
  } catch {
    throw new Error('Static country-card bundle has no readable bounded body.');
  }
  const chunks = [];
  let total = 0;
  const cancelBestEffort = (reason) => {
    try {
      const cancellation = reader.cancel(reason);
      cancellation?.catch?.(() => {});
    } catch { /* The stable caller-facing error remains authoritative. */ }
  };
  try {
    while (true) {
      const result = await reader.read();
      if (!result || typeof result !== 'object' || typeof result.done !== 'boolean') throw new Error('invalid body read');
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new Error('invalid body chunk');
      total += result.value.byteLength;
      if (total > TRAVELER_CARD_BUNDLE_MAX_BYTES) {
        cancelBestEffort('byte-size ceiling exceeded');
        throw new Error('Static country-card bundle exceeds its byte-size ceiling.');
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof Error && /byte-size ceiling/.test(error.message)) throw error;
    cancelBestEffort('invalid country-card body');
    throw new Error('Static country-card bundle body could not be read.');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Reports whether the browser has exactly the APIs used by the raw JSON download path. */
export function supportsTravelerCardDownload() {
  return typeof Blob === 'function' && typeof TextDecoder === 'function';
}

/** Fails synchronously so callers can stop before issuing either fixed request. */
export function assertTravelerCardDownloadSupport() {
  if (!supportsTravelerCardDownload()) throw new Error(TRAVELER_CARD_BROWSER_COMPATIBILITY_MESSAGE);
}

/** Strictly decodes the already bounded raw JSON response bytes. */
export function decodeTravelerCardBundle(bytes) {
  try {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('invalid bytes');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Static country-card bundle could not be parsed.');
  }
}

/** Validates that the independently cached card bundle is exactly the manifest release. */
export function validateTravelerCardBundleIdentity(bundle, manifest) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || !bundle.cards || typeof bundle.cards !== 'object' || Array.isArray(bundle.cards)) {
    throw new Error('The static country-card bundle has an invalid shape.');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest?.traveler_card_build_version)
      || manifest.traveler_card_build_version !== manifest?.build_versions?.integration_generator) {
    throw new Error('The API manifest has an invalid country-card build version.');
  }
  for (const field of ['api_version', 'traveler_card_build_version', 'dataset_version', 'schema_version', 'generated_at', 'source_last_updated']) {
    if (bundle[field] !== manifest?.[field]) throw new Error(`The API manifest and country-card bundle ${field.replaceAll('_', ' ')} values do not match.`);
  }
  getTravelerReleaseContext(bundle);
  return bundle;
}

/** Loads only two bounded fixed URLs; the manual country selection is applied after both responses. */
export async function loadTravelerCountryCard({ fetchImpl = fetch, countryCode, decodeBundle = decodeTravelerCardBundle, requireSupport = assertTravelerCardDownloadSupport }) {
  requireSupport();
  const manifest = await fetchJson(fetchImpl, TRAVELER_CARD_MANIFEST_URL, 'Static API manifest');
  const releaseContext = getTravelerReleaseContext(manifest);
  const response = await fetchImpl(TRAVELER_CARD_BUNDLE_URL, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response?.ok) throw new Error(`Static country-card bundle returned ${response?.status ?? 'an invalid response'}.`);
  const lengthHeader = response.headers?.get?.('content-length');
  if (typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader.trim()) && Number(lengthHeader) > TRAVELER_CARD_BUNDLE_MAX_BYTES) {
    throw new Error('Static country-card bundle exceeds its byte-size ceiling.');
  }
  const bundleBytes = await readBoundedTravelerCardBody(response);
  const bundle = validateTravelerCardBundleIdentity(await decodeBundle(bundleBytes), manifest);
  const code = normalizeCode(countryCode);
  const country = manifest.countries?.find((entry) => normalizeCode(entry?.alpha2) === code);
  const content = bundle.cards[code];
  if (!country || typeof content !== 'string' || !content.startsWith('EMERGENCY') || !content.trim()) {
    throw new Error('The selected country card is not in the static bundle.');
  }
  return { content, country: { alpha2: code, country: country.name }, releaseContext };
}

/**
 * Loads two fixed static artifacts in a deterministic sequence.
 * @param {{ fetchImpl?: typeof fetch, currentCode: string, homeCode?: string, onManifest?: ((country: any) => any) | null }} options
 */
export async function loadTravelerData({ fetchImpl = fetch, currentCode, homeCode = '', onManifest = null }) {
  const manifest = await fetchJson(fetchImpl, TRAVELER_MANIFEST_URL, 'Static manifest');
  const emergencyCountry = getTravelerEmergencyMetadata(manifest, currentCode);
  if (onManifest) await onManifest(emergencyCountry);
  const releaseContext = getTravelerReleaseContext(manifest);
  const recordsArtifact = await fetchJson(fetchImpl, TRAVELER_RECORDS_URL, 'Static support records');
  validateTravelerRecordsIdentity(recordsArtifact, releaseContext);
  return { ...reconstructTravelerCountries(manifest, recordsArtifact, currentCode, homeCode), releaseContext };
}

/** @param {{ currentCountry: any, homeCountry?: any | null, category?: string, channel?: string, locality?: string }} options */
export function resolveTravelerHelp({ currentCountry, homeCountry = null, category, channel = 'any', locality = '' }) {
  if (!currentCountry?.alpha2) throw new Error('A current country is required.');
  if (homeCountry?.alpha2 === currentCountry.alpha2) homeCountry = null;
  const current = resolveGuidedHelp({ country: currentCountry, category, channel, locality });
  const primary = {
    ...current,
    level: 'current-country',
    countryCode: currentCountry.alpha2,
    countryName: currentCountry.country,
    reason: current.results.length ? `Current-country services come first. ${current.reason}` : NO_CROSS_BORDER_REASON,
    noSafeCrossBorderFallback: !current.results.length,
  };
  const home = homeCountry ? {
    ...resolveGuidedHelp({ country: homeCountry, category, channel, locality: '' }),
    level: 'home-country',
    countryCode: homeCountry.alpha2,
    countryName: homeCountry.country,
  } : null;
  return { primary, home };
}
