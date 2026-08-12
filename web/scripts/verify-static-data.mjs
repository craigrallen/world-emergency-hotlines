import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildMetadataCoverage, coverageAsOf } from './metadata-coverage.mjs';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = resolve(WEB_ROOT, 'public', 'data');
const COUNTRIES_DIR = resolve(DATA_DIR, 'countries');
const DATA_DOWNLOADS_PAGE = resolve(WEB_ROOT, 'src', 'pages', 'data.astro');
const CANONICAL_PATH = resolve(WEB_ROOT, '..', 'hotlines.json');
const RECORD_ID_RE = /^weh_[0-9a-f]{24}$/;

const errors = [];

function fail(message) {
  errors.push(message);
}

function readJson(relativePath) {
  const path = resolve(DATA_DIR, relativePath);
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    fail(`${relativePath}: ${err.message}`);
    return null;
  }
}

function asArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
    return [];
  }
  return value;
}

function sumCounts(counts, label) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    fail(`${label} must be an object`);
    return 0;
  }

  let total = 0;
  for (const [category, count] of Object.entries(counts)) {
    if (!category || typeof category !== 'string') {
      fail(`${label} has an invalid category key`);
    }
    if (!Number.isInteger(count) || count < 0) {
      fail(`${label}.${category} must be a non-negative integer`);
      continue;
    }
    total += count;
  }
  return total;
}

function sameCounts(left, right) {
  const leftKeys = Object.keys(left ?? {}).sort();
  const rightKeys = Object.keys(right ?? {}).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function hasSearchableSurface(entry) {
  return [
    entry.name,
    entry.organization,
    entry.category,
    entry.country_name,
    ...(Array.isArray(entry.numbers) ? entry.numbers : []),
  ].some((value) => typeof value === 'string' && value.trim().length > 0);
}

const manifest = readJson('manifest.json');
const searchIndex = readJson('search-index.json');
const categoriesStats = readJson('categories-stats.json');
const metadataCoverage = readJson('metadata-coverage.json');
const canonicalRaw = readFileSync(CANONICAL_PATH);
const canonical = JSON.parse(canonicalRaw);
const expectedDatasetVersion = `sha256:${createHash('sha256').update(canonicalRaw).digest('hex')}`;
if (manifest?.dataset_version !== expectedDatasetVersion) {
  fail(`manifest.dataset_version does not match canonical hotlines.json (${manifest?.dataset_version})`);
}
if (categoriesStats?.dataset_version !== expectedDatasetVersion) {
  fail('categories-stats.dataset_version does not match manifest/canonical dataset version');
}
if (metadataCoverage?.dataset_version !== expectedDatasetVersion) fail('metadata-coverage.dataset_version does not match canonical data');
const expectedCoverageAsOf = coverageAsOf(manifest?.source_last_updated);
if (metadataCoverage?.as_of !== expectedCoverageAsOf) fail('metadata-coverage.as_of must use deterministic source date or legacy fallback');
if (metadataCoverage?.total_records !== manifest?.total_hotlines) fail('metadata-coverage total does not match manifest');
if (metadataCoverage?.interpretation?.no_composite_score !== true) fail('metadata-coverage must explicitly prohibit a composite score');
for (const text of ['not prove', 'not service availability']) {
  if (!JSON.stringify(metadataCoverage?.interpretation).includes(text)) fail(`metadata-coverage interpretation missing ${text}`);
}
const recomputedCoverage = buildMetadataCoverage(canonical, expectedCoverageAsOf, 365, expectedDatasetVersion);
if (JSON.stringify(metadataCoverage) !== JSON.stringify(recomputedCoverage)) {
  fail('metadata-coverage does not match independent recomputation from canonical data');
}
try {
  const pythonReport = JSON.parse(execFileSync('python3', [
    resolve(WEB_ROOT, '..', 'scripts', 'metadata_coverage_report.py'),
    '--input', CANONICAL_PATH, '--as-of', expectedCoverageAsOf, '--current-days', '365',
  ], { encoding: 'utf-8' }));
  if (JSON.stringify(recomputedCoverage) !== JSON.stringify(pythonReport)) {
    fail('Python and JavaScript metadata-coverage contracts differ');
  }
} catch (err) {
  fail(`Python metadata-coverage parity check failed: ${err.message}`);
}

try {
  const dataDownloadsPage = readFileSync(DATA_DOWNLOADS_PAGE, 'utf-8');
  if (/countries\/\{ALPHA2\}\.json/.test(dataDownloadsPage)) {
    fail('src/pages/data.astro advertises uppercase countries/{ALPHA2}.json; use lowercase countries/{alpha2}.json');
  }
  if (/\/data\/countries\/[A-Z]{2}\.json/.test(dataDownloadsPage)) {
    fail('src/pages/data.astro advertises uppercase country shard examples; use lowercase /data/countries/{alpha2}.json URLs');
  }
} catch (err) {
  fail(`src/pages/data.astro: ${err.message}`);
}

const countries = asArray(manifest?.countries, 'manifest.countries');
if (!Number.isInteger(manifest?.total_countries)) {
  fail('manifest.total_countries must be an integer');
} else if (manifest.total_countries !== countries.length) {
  fail(`manifest.total_countries (${manifest.total_countries}) does not match countries length (${countries.length})`);
}

if (!Number.isInteger(manifest?.total_hotlines) || manifest.total_hotlines < 0) {
  fail('manifest.total_hotlines must be a non-negative integer');
}

const expectedShardNames = new Set(
  countries
    .map((country) => country?.alpha2)
    .filter((alpha2) => /^[A-Z]{2}$/.test(alpha2 ?? ''))
    .map((alpha2) => `${alpha2.toLowerCase()}.json`),
);

try {
  for (const shardName of readdirSync(COUNTRIES_DIR)) {
    if (shardName.endsWith('.json') && !expectedShardNames.has(shardName)) {
      fail(`unexpected country shard: public/data/countries/${shardName}`);
    }
  }
} catch (err) {
  fail(`countries directory: ${err.message}`);
}

const manifestByAlpha2 = new Map();
const manifestCategoriesByCountry = new Map();
let manifestHotlineTotal = 0;
const recordIds = new Set();

for (const country of countries) {
  const alpha2 = country?.alpha2;
  const countryLabel = alpha2 || country?.name || '<unknown country>';

  if (!/^[A-Z]{2}$/.test(alpha2 ?? '')) {
    fail(`manifest country ${countryLabel} has invalid alpha2: ${alpha2}`);
    continue;
  }
  if (manifestByAlpha2.has(alpha2)) {
    fail(`duplicate manifest country alpha2: ${alpha2}`);
  }
  manifestByAlpha2.set(alpha2, country);

  const shardName = `${alpha2.toLowerCase()}.json`;
  const shardPath = resolve(COUNTRIES_DIR, shardName);
  if (!existsSync(shardPath)) {
    fail(`missing country shard: public/data/countries/${shardName}`);
    continue;
  }

  let shard;
  try {
    shard = JSON.parse(readFileSync(shardPath, 'utf-8'));
  } catch (err) {
    fail(`countries/${shardName}: ${err.message}`);
    continue;
  }

  const hotlines = asArray(shard.hotlines, `countries/${shardName}.hotlines`);
  if (shard.dataset_version !== expectedDatasetVersion) {
    fail(`countries/${shardName}.dataset_version does not match manifest/canonical dataset version`);
  }
  const categoryCounts = shard.category_counts ?? {};
  const categoryTotal = sumCounts(categoryCounts, `countries/${shardName}.category_counts`);
  const manifestCategoryTotal = sumCounts(country.category_counts ?? {}, `manifest country ${alpha2}.category_counts`);

  if (shard.alpha2 !== alpha2) {
    fail(`countries/${shardName}.alpha2 (${shard.alpha2}) does not match manifest (${alpha2})`);
  }
  if (shard.country !== country.name) {
    fail(`countries/${shardName}.country (${shard.country}) does not match manifest name (${country.name})`);
  }
  if (country.hotline_count !== hotlines.length) {
    fail(`manifest ${alpha2}.hotline_count (${country.hotline_count}) does not match shard hotlines length (${hotlines.length})`);
  }
  if (categoryTotal !== hotlines.length) {
    fail(`countries/${shardName}.category_counts total (${categoryTotal}) does not match shard hotlines length (${hotlines.length})`);
  }
  if (manifestCategoryTotal !== country.hotline_count) {
    fail(`manifest ${alpha2}.category_counts total (${manifestCategoryTotal}) does not match hotline_count (${country.hotline_count})`);
  }
  if (!sameCounts(categoryCounts, country.category_counts ?? {})) {
    fail(`manifest ${alpha2}.category_counts does not match countries/${shardName}.category_counts`);
  }

  const categories = new Set(Object.keys(country.category_counts ?? {}));
  manifestCategoriesByCountry.set(alpha2, categories);
  manifestHotlineTotal += Number.isInteger(country.hotline_count) ? country.hotline_count : 0;
  for (const [index, hotline] of hotlines.entries()) {
    if (!RECORD_ID_RE.test(hotline?.id ?? '')) {
      fail(`countries/${shardName}.hotlines[${index}] has invalid record ID: ${hotline?.id}`);
    } else if (recordIds.has(hotline.id)) {
      fail(`duplicate record ID across country shards: ${hotline.id}`);
    } else {
      recordIds.add(hotline.id);
    }
  }
}

if (Number.isInteger(manifest?.total_hotlines) && manifestHotlineTotal !== manifest.total_hotlines) {
  fail(`manifest country hotline total (${manifestHotlineTotal}) does not match manifest.total_hotlines (${manifest.total_hotlines})`);
}

const searchDocs = asArray(searchIndex, 'search-index');
if (Number.isInteger(manifest?.total_hotlines) && searchDocs.length !== manifest.total_hotlines) {
  fail(`search-index length (${searchDocs.length}) does not match manifest.total_hotlines (${manifest.total_hotlines})`);
}

for (const [index, entry] of searchDocs.entries()) {
  const alpha2 = entry?.country_code;
  const category = entry?.category;
  if (!RECORD_ID_RE.test(entry?.id ?? '') || !recordIds.has(entry.id)) {
    fail(`search-index[${index}] references invalid or unknown record ID: ${entry?.id}`);
  }
  if (!manifestByAlpha2.has(alpha2)) {
    fail(`search-index[${index}] references unknown country_code: ${alpha2}`);
  } else if (!manifestCategoriesByCountry.get(alpha2)?.has(category)) {
    fail(`search-index[${index}] references category ${category} not present for ${alpha2}`);
  }
  if (!hasSearchableSurface(entry)) {
    fail(`search-index[${index}] has no searchable surface`);
  }
}

const categoryStats = asArray(categoriesStats?.categories, 'categories-stats.categories');
const categoryStatsSlugs = new Set();
let categoryStatsTotal = 0;
for (const stat of categoryStats) {
  const slug = stat?.slug;
  if (!slug || typeof slug !== 'string') {
    fail('categories-stats entry has invalid slug');
    continue;
  }
  if (categoryStatsSlugs.has(slug)) {
    fail(`duplicate categories-stats slug: ${slug}`);
  }
  categoryStatsSlugs.add(slug);
  if (!Number.isInteger(stat.count) || stat.count < 0) {
    fail(`categories-stats ${slug}.count must be a non-negative integer`);
    continue;
  }
  if (!Number.isInteger(stat.countries) || stat.countries < 0 || stat.countries > countries.length || stat.countries > stat.count) {
    fail(`categories-stats ${slug}.countries (${stat.countries}) is impossible for count ${stat.count}`);
  }
  if (!Number.isInteger(stat.verified_count) || stat.verified_count < 0 || stat.verified_count > stat.count) {
    fail(`categories-stats ${slug}.verified_count (${stat.verified_count}) is impossible for count ${stat.count}`);
  }
  categoryStatsTotal += stat.count;
}

if (Number.isInteger(manifest?.total_hotlines) && categoryStatsTotal !== manifest.total_hotlines) {
  fail(`categories-stats total count (${categoryStatsTotal}) does not match manifest.total_hotlines (${manifest.total_hotlines})`);
}

if (errors.length > 0) {
  console.error(`Static data integrity check failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(
  `Static data integrity OK: ${countries.length} countries, ${manifest.total_hotlines} hotlines, ${categoryStats.length} categories`,
);
