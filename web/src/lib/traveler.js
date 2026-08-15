import { resolveGuidedHelp } from './finder.js';

export const TRAVELER_MANIFEST_URL = '/data/manifest.json';
export const TRAVELER_RECORDS_URL = '/api/v1/records.json';
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

/** Loads two fixed static artifacts in a deterministic sequence. */
export async function loadTravelerData({ fetchImpl = fetch, currentCode, homeCode = '', onManifest }) {
  const manifest = await fetchJson(fetchImpl, TRAVELER_MANIFEST_URL, 'Static manifest');
  const emergencyCountry = getTravelerEmergencyMetadata(manifest, currentCode);
  if (onManifest) await onManifest(emergencyCountry);
  const recordsArtifact = await fetchJson(fetchImpl, TRAVELER_RECORDS_URL, 'Static support records');
  return reconstructTravelerCountries(manifest, recordsArtifact, currentCode, homeCode);
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
