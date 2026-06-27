// Converts the canonical hotlines.json / information.json into the
// JSON shards the Astro site consumes from /public/data/.
//
// Output:
//   public/data/manifest.json            — country list + per-country metadata
//   public/data/countries/{alpha2 lowercase}.json  — full country shard
//   public/data/search-index.json        — lightweight search docs (client-side search)
//   public/data/categories-stats.json    — global per-category aggregates

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(WEB_ROOT, '..');
const OUT_DIR = resolve(WEB_ROOT, 'public', 'data');

const CENTROIDS = JSON.parse(readFileSync(resolve(__dirname, 'centroids.json'), 'utf-8'));

const DEFAULT_CATEGORIES = {
  emergency: 'General emergency (police/fire/ambulance)',
  suicide_crisis: 'Suicide prevention and acute suicidal crisis',
  mental_health: 'General mental health support (not acute crisis)',
  general_support: 'Loneliness, general wellbeing, listening lines',
};

const VERIFIED_STATUSES = new Set(['verified_web', 'verified_authority', 'verified_knowledge']);

// Normalizes legacy information.json format to schema v2
function normalizeLegacy(country) {
  return {
    country: country.country,
    'alpha-2': country['alpha-2'],
    'alpha-3': country['alpha-3'],
    region: null,
    subregion: null,
    general_emergency: [],
    notes: null,
    hotlines: (country.hotlines ?? []).map((h) => ({
      name: h.name,
      organization: h.name,
      category: /suicide|crisis/i.test(h.name) ? 'suicide_crisis' : 'general_support',
      voice_numbers: h.numbers ?? [],
      sms_numbers: [],
      text_numbers: [],
      short_codes: [],
      chat_url: null,
      email: null,
      website: null,
      hours: null,
      languages: [],
      cost: 'unknown',
      target: null,
      geography: country.country,
      notes: '',
      verification_status: 'legacy_unverified',
      last_verified: null,
      sources: ['information.json'],
    })),
  };
}

function loadCanonical() {
  const hotlinesPath = resolve(REPO_ROOT, 'hotlines.json');
  const legacyPath = resolve(REPO_ROOT, 'information.json');
  if (existsSync(hotlinesPath)) {
    try {
      const parsed = JSON.parse(readFileSync(hotlinesPath, 'utf-8'));
      if (parsed && Array.isArray(parsed.countries)) {
        return {
          format: 'v2',
          countries: parsed.countries,
          categories_reference: parsed.categories_reference ?? {},
          schema_version: parsed.$schema_version ?? '2.0',
        };
      }
    } catch (err) {
      console.warn(`  ! hotlines.json failed to parse (${err.message}); falling back to information.json`);
    }
  }
  const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'));
  return {
    format: 'legacy',
    countries: legacy.map(normalizeLegacy),
    categories_reference: DEFAULT_CATEGORIES,
    schema_version: '1.0-legacy',
  };
}

// Standardizes field names and fills in defaults
function camelize(h) {
  return {
    name: h.name ?? h.organization ?? 'Hotline',
    organization: h.organization ?? null,
    category: h.category ?? 'general_support',
    voice_numbers: h.voice_numbers ?? [],
    sms_numbers: h.sms_numbers ?? [],
    text_numbers: h.text_numbers ?? [],
    short_codes: h.short_codes ?? [],
    chat_url: h.chat_url ?? null,
    email: h.email ?? null,
    website: h.website ?? null,
    hours: h.hours ?? null,
    languages: h.languages ?? [],
    cost: h.cost ?? 'unknown',
    target: h.target ?? null,
    geography: h.geography ?? null,
    notes: h.notes ?? null,
    verification_status: h.verification_status ?? 'legacy_unverified',
    last_verified: h.last_verified ?? null,
    sources: h.sources ?? [],
    // Carry provenance through if present (populated by trawler/verify passes)
    ...(h.provenance ? { provenance: h.provenance } : {}),
  };
}

// Creates the country record shape for the output
function countryShape(c) {
  const alpha2 = c['alpha-2'];
  const centroid = CENTROIDS[alpha2] ?? null;
  const hotlines = (c.hotlines ?? []).map(camelize);

  // Derived aggregate fields — do NOT write back to canonical source
  const category_counts = {};
  const channels = { has_voice: false, has_sms: false, has_chat: false, has_email: false };

  for (const h of hotlines) {
    category_counts[h.category] = (category_counts[h.category] ?? 0) + 1;
    if (h.voice_numbers.length > 0 || h.short_codes.length > 0) channels.has_voice = true;
    if (h.sms_numbers.length > 0 || h.text_numbers.length > 0) channels.has_sms = true;
    if (h.chat_url) channels.has_chat = true;
    if (h.email) channels.has_email = true;
  }

  // Most-recent verification date for any verified hotline in this country
  const verifiedDates = hotlines
    .filter((h) => h.last_verified && VERIFIED_STATUSES.has(h.verification_status))
    .map((h) => h.last_verified)
    .sort()
    .reverse();
  const last_updated = verifiedDates[0] ?? null;

  return {
    country: c.country,
    alpha2,
    alpha3: c['alpha-3'],
    region: c.region ?? null,
    subregion: c.subregion ?? null,
    general_emergency: c.general_emergency ?? [],
    notes: c.notes ?? null,
    centroid,
    hotlines,
    // Derived fields (not in canonical source)
    category_counts,
    channels,
    last_updated,
  };
}

console.log('> build-static-data.mjs');

const canonical = loadCanonical();
console.log(`  source: ${canonical.format}, schema ${canonical.schema_version}`);
console.log(`  countries: ${canonical.countries.length}`);

mkdirSync(resolve(OUT_DIR, 'countries'), { recursive: true });
try {
  for (const f of readdirSync(resolve(OUT_DIR, 'countries'))) {
    if (f.endsWith('.json')) unlinkSync(resolve(OUT_DIR, 'countries', f));
  }
} catch (err) {
  console.warn(`  ! couldn't clean old shards: ${err.message}`);
}

const manifestEntries = [];
const searchDocs = [];
let totalHotlines = 0;

// Global category stats accumulator
// slug -> { count, verified_count, countries: Set<string> }
const globalCatAccum = {};

for (const raw of canonical.countries) {
  const c = countryShape(raw);
  const verified = c.hotlines.filter((h) => VERIFIED_STATUSES.has(h.verification_status)).length;

  writeFileSync(resolve(OUT_DIR, 'countries', `${c.alpha2.toLowerCase()}.json`), JSON.stringify(c, null, 2));

  manifestEntries.push({
    alpha2: c.alpha2,
    alpha3: c.alpha3,
    name: c.country,
    region: c.region,
    subregion: c.subregion,
    hotline_count: c.hotlines.length,
    verified_count: verified,
    categories: [...new Set(c.hotlines.map((h) => h.category))],
    category_counts: c.category_counts,
    general_emergency: c.general_emergency,
    centroid: c.centroid,
    last_updated: c.last_updated,
    channels: c.channels,
  });

  for (const h of c.hotlines) {
    searchDocs.push({
      country_code: c.alpha2,
      country_name: c.country,
      region: c.region,
      subregion: c.subregion,
      name: h.name,
      organization: h.organization,
      category: h.category,
      numbers: [...h.voice_numbers, ...h.short_codes, ...h.sms_numbers],
      languages: h.languages,
      verified: VERIFIED_STATUSES.has(h.verification_status),
      verification_status: h.verification_status,
      has_chat: !!h.chat_url,
      has_sms: h.sms_numbers.length > 0 || h.text_numbers.length > 0,
    });
    totalHotlines++;

    // Accumulate global category stats
    if (!globalCatAccum[h.category]) {
      globalCatAccum[h.category] = { count: 0, verified_count: 0, countries: new Set() };
    }
    globalCatAccum[h.category].count += 1;
    globalCatAccum[h.category].countries.add(c.alpha2);
    if (VERIFIED_STATUSES.has(h.verification_status)) {
      globalCatAccum[h.category].verified_count += 1;
    }
  }
}

manifestEntries.sort((a, b) => a.name.localeCompare(b.name));

const manifest = {
  generated_at: new Date().toISOString(),
  schema_version: canonical.schema_version,
  total_countries: manifestEntries.length,
  total_hotlines: totalHotlines,
  countries: manifestEntries,
  categories_reference: canonical.categories_reference,
};

writeFileSync(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(resolve(OUT_DIR, 'search-index.json'), JSON.stringify(searchDocs));

// Write global category stats
const categoriesStats = {
  generated_at: new Date().toISOString(),
  categories: Object.entries(globalCatAccum)
    .map(([slug, s]) => ({
      slug,
      label: canonical.categories_reference[slug] ?? slug.replace(/_/g, ' '),
      count: s.count,
      countries: s.countries.size,
      verified_count: s.verified_count,
    }))
    .sort((a, b) => b.count - a.count),
};
writeFileSync(resolve(OUT_DIR, 'categories-stats.json'), JSON.stringify(categoriesStats, null, 2));

console.log(`  wrote ${manifestEntries.length} country shards + manifest + search-index + categories-stats`);
console.log(`  total hotlines: ${totalHotlines}`);
console.log('  done.');
