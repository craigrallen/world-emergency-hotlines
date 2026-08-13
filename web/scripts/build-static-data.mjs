// Converts the canonical hotlines.json / information.json into the
// JSON shards the Astro site consumes from /public/data/.
//
// Output:
//   public/data/manifest.json            — country list + per-country metadata
//   public/data/countries/{alpha2 lowercase}.json  — full country shard
//   public/data/search-index.json        — lightweight search docs (client-side search)
//   public/data/categories-stats.json    — global per-category aggregates

import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { utf16Compare } from './dataset-diff.mjs';
import { classifyScope, getHotlineChannels } from '../src/lib/finder.js';
import { buildMetadataCoverage, coverageAsOf } from './metadata-coverage.mjs';
import { API_MAJOR, RESOLVER_MAJOR, WIDGET_MAJOR, buildVersions, generateReleaseIntegrity } from './release-integrity.mjs';
import { generateReleaseFeeds } from './release-feeds.mjs';
import { generateSubscriptionContracts } from './generate-subscription-contracts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(WEB_ROOT, '..');
const OUT_DIR = resolve(WEB_ROOT, 'public', 'data');
const API_DIR = resolve(WEB_ROOT, 'public', 'api', 'v1');
const API_VERSION = '1.0';
const GENERATED_AT = new Date(process.env.SOURCE_DATE_EPOCH
  ? Number(process.env.SOURCE_DATE_EPOCH) * 1000
  : Date.now()).toISOString();

const CENTROIDS = JSON.parse(readFileSync(resolve(__dirname, 'centroids.json'), 'utf-8'));

const VERIFIED_STATUSES = new Set(['verified_web', 'verified_authority', 'verified_knowledge']);

function loadCanonical() {
  const hotlinesPath = resolve(REPO_ROOT, 'hotlines.json');
  if (!existsSync(hotlinesPath)) throw new Error('canonical hotlines.json is required for release generation');
  const raw = readFileSync(hotlinesPath);
  const parsed = JSON.parse(raw.toString('utf-8'));
  if (!parsed || !Array.isArray(parsed.countries)) throw new Error('canonical hotlines.json must contain a countries array');
  return {
    format: 'v2',
    countries: parsed.countries,
    categories_reference: parsed.categories_reference ?? {},
    schema_version: parsed.$schema_version ?? '2.0',
    source_last_updated: parsed.last_updated ?? null,
    dataset_sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

export function recreateManagedRoot(root, publicDirectory = resolve(WEB_ROOT, 'public')) {
  const publicRoot = realpathSync(publicDirectory);
  const relativeRoot = root.slice(publicRoot.length + 1);
  if (root === publicRoot || !root.startsWith(`${publicRoot}${sep}`) || !relativeRoot || relativeRoot.split(sep).some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`refusing to clean outside public root: ${root}`);
  }
  let cursor = publicRoot;
  for (const component of relativeRoot.split(sep)) {
    cursor = resolve(cursor, component);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`refusing managed path with symlink component: ${cursor}`);
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
}

// Standardizes field names and fills in defaults
function camelize(h) {
  return {
    id: h.id ?? null,
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
    ...(h.replaced_by ? { replaced_by: h.replaced_by } : {}),
    ...(h.service_scope ? { service_scope: h.service_scope } : {}),
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
    .sort(utf16Compare)
    .reverse();
  const last_updated = verifiedDates[0] ?? null;

  return {
    country: c.country,
    dataset_version: `sha256:${canonical.dataset_sha256}`,
    schema_version: canonical.schema_version,
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

recreateManagedRoot(OUT_DIR);
recreateManagedRoot(API_DIR);
recreateManagedRoot(resolve(WEB_ROOT, 'public', 'release'));
recreateManagedRoot(resolve(WEB_ROOT, 'public', 'subscriptions'));
mkdirSync(resolve(OUT_DIR, 'countries'), { recursive: true });
mkdirSync(resolve(API_DIR, 'countries'), { recursive: true });

const manifestEntries = [];
const searchDocs = [];
const apiCountries = [];
const recordsById = {};
let totalHotlines = 0;

// Global category stats accumulator
// slug -> { count, verified_count, countries: Set<string> }
const globalCatAccum = {};

for (const raw of canonical.countries) {
  const c = countryShape(raw);
  const verified = c.hotlines.filter((h) => VERIFIED_STATUSES.has(h.verification_status)).length;

  writeFileSync(resolve(OUT_DIR, 'countries', `${c.alpha2.toLowerCase()}.json`), JSON.stringify(c, null, 2));

  const apiHotlines = c.hotlines.map((hotline) => ({
    ...hotline,
    scope: classifyScope(hotline, c.country),
    channels: getHotlineChannels(hotline),
  }));
  const apiCountry = {
    api_version: API_VERSION,
    dataset_version: c.dataset_version,
    country: c.country,
    alpha2: c.alpha2,
    alpha3: c.alpha3,
    general_emergency: c.general_emergency,
    hotlines: apiHotlines,
  };
  writeFileSync(resolve(API_DIR, 'countries', `${c.alpha2.toLowerCase()}.json`), JSON.stringify(apiCountry, null, 2));
  apiCountries.push({
    alpha2: c.alpha2,
    name: c.country,
    path: `countries/${c.alpha2.toLowerCase()}.json`,
    hotline_count: apiHotlines.length,
  });

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
    recordsById[h.id] = {
      api_version: API_VERSION,
      dataset_version: c.dataset_version,
      country_code: c.alpha2,
      country_name: c.country,
      ...h,
      scope: classifyScope(h, c.country),
      channels: getHotlineChannels(h),
    };
    searchDocs.push({
      id: h.id,
      country_code: c.alpha2,
      country_name: c.country,
      region: c.region,
      subregion: c.subregion,
      name: h.name,
      organization: h.organization,
      category: h.category,
      geography: h.geography,
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

manifestEntries.sort((a, b) => utf16Compare(a.name, b.name));

const manifest = {
  generated_at: GENERATED_AT,
  generated_at_semantics: 'Wall-clock build metadata; excluded from dataset and build identities. SOURCE_DATE_EPOCH may pin it for reproducible builds.',
  schema_version: canonical.schema_version,
  dataset_version: `sha256:${canonical.dataset_sha256}`,
  source_last_updated: canonical.source_last_updated,
  total_countries: manifestEntries.length,
  total_hotlines: totalHotlines,
  countries: manifestEntries,
  categories_reference: canonical.categories_reference,
};

writeFileSync(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(resolve(OUT_DIR, 'search-index.json'), JSON.stringify(searchDocs));

// Write global category stats
const categoriesStats = {
  generated_at: GENERATED_AT,
  generated_at_semantics: 'Wall-clock build metadata; excluded from dataset and build identities. SOURCE_DATE_EPOCH may pin it for reproducible builds.',
  schema_version: canonical.schema_version,
  dataset_version: `sha256:${canonical.dataset_sha256}`,
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
const metadataCoverage = buildMetadataCoverage(
  { $schema_version: canonical.schema_version, countries: canonical.countries },
  coverageAsOf(canonical.source_last_updated),
  365,
  `sha256:${canonical.dataset_sha256}`,
);
writeFileSync(resolve(OUT_DIR, 'metadata-coverage.json'), JSON.stringify(metadataCoverage, null, 2));

const apiManifest = {
  api_version: API_VERSION,
  compatibility: {
    api_major: API_MAJOR,
    resolver: { major: RESOLVER_MAJOR, tested_api_majors: [API_MAJOR] },
    widget: { major: WIDGET_MAJOR, tested_api_majors: [API_MAJOR], tested_resolver_majors: [RESOLVER_MAJOR] },
  },
  build_versions: buildVersions(),
  dataset_version: manifest.dataset_version,
  generated_at: manifest.generated_at,
  contract: 'static-read-only',
  total_countries: manifest.total_countries,
  total_records: manifest.total_hotlines,
  endpoints: {
    manifest: 'manifest.json',
    records: 'records.json',
    country: 'countries/{alpha2}.json',
    resolver_module: 'resolver.js',
    release_descriptor: '../../release/v1/release.json',
    artifact_index: '../../release/v1/artifacts.json',
  },
  resolver_input: {
    country: 'country artifact object',
    category: 'canonical category slug',
    channel: ['any', 'phone', 'text', 'chat'],
    locality: 'optional complete recorded geography component',
  },
  resolver_output: ['scope', 'reason', 'fallback', 'results'],
  limitations: [
    'No hosted query endpoint is provided; consumers fetch static artifacts and resolve locally.',
    'Scope reflects recorded geography and does not guarantee eligibility or current availability.',
  ],
  countries: apiCountries.sort((a, b) => utf16Compare(a.name, b.name)),
};
writeFileSync(resolve(API_DIR, 'manifest.json'), JSON.stringify(apiManifest, null, 2));
writeFileSync(resolve(API_DIR, 'records.json'), JSON.stringify({
  api_version: API_VERSION,
  dataset_version: manifest.dataset_version,
  records: recordsById,
}));
writeFileSync(resolve(API_DIR, 'resolver.js'), readFileSync(resolve(WEB_ROOT, 'src', 'lib', 'finder.js'), 'utf-8'));
generateReleaseFeeds({ currentDataset: { $schema_version: canonical.schema_version, countries: canonical.countries }, datasetVersion: manifest.dataset_version });
generateSubscriptionContracts();
const release = generateReleaseIntegrity({ datasetVersion: manifest.dataset_version });

console.log(`  wrote ${manifestEntries.length} country shards + manifest + search-index + categories-stats + metadata-coverage`);
console.log(`  wrote API v${API_VERSION}: manifest + records index + ${apiCountries.length} countries + resolver`);
console.log(`  release: ${release.release_id} (${release.artifact_index.artifact_count} checksummed artifacts)`);
console.log(`  total hotlines: ${totalHotlines}`);
console.log('  done.');
