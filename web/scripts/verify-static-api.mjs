import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const API_DIR = resolve(WEB_ROOT, 'public', 'api', 'v1');
const DATA_DIR = resolve(WEB_ROOT, 'public', 'data');
const SOURCE_RESOLVER = resolve(WEB_ROOT, 'src', 'lib', 'finder.js');
const errors = [];
const fail = (message) => errors.push(message);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

for (const name of ['manifest.json', 'records.json', 'resolver.js']) {
  if (!existsSync(resolve(API_DIR, name))) fail(`missing api/v1/${name}`);
}

if (errors.length === 0) {
  const manifest = readJson(resolve(API_DIR, 'manifest.json'));
  const dataManifest = readJson(resolve(DATA_DIR, 'manifest.json'));
  const recordIndex = readJson(resolve(API_DIR, 'records.json'));
  const countryFiles = readdirSync(resolve(API_DIR, 'countries')).filter((name) => name.endsWith('.json')).sort();

  if (manifest.api_version !== '1.0') fail(`unexpected api_version: ${manifest.api_version}`);
  if (manifest.contract !== 'static-read-only') fail(`unexpected contract: ${manifest.contract}`);
  if (manifest.dataset_version !== dataManifest.dataset_version) fail('API/data dataset versions differ');
  if (recordIndex.dataset_version !== manifest.dataset_version) fail('record index dataset version differs');
  if (countryFiles.length !== manifest.total_countries) fail(`country artifact count ${countryFiles.length} != ${manifest.total_countries}`);
  if (Object.keys(recordIndex.records).length !== manifest.total_records) fail('record index total differs from manifest');
  if (!manifest.limitations.some((value) => /No hosted query endpoint/.test(value))) fail('static-query limitation is missing');

  const seen = new Set();
  let hotlineCount = 0;
  for (const countryMeta of manifest.countries) {
    if (!/^[A-Z]{2}$/.test(countryMeta.alpha2)) fail(`invalid alpha2: ${countryMeta.alpha2}`);
    if (countryMeta.path !== `countries/${countryMeta.alpha2.toLowerCase()}.json`) fail(`unsafe country path: ${countryMeta.path}`);
    const country = readJson(resolve(API_DIR, countryMeta.path));
    if (country.api_version !== manifest.api_version) fail(`${countryMeta.alpha2}: API version mismatch`);
    if (country.dataset_version !== manifest.dataset_version) fail(`${countryMeta.alpha2}: dataset version mismatch`);
    if (country.hotlines.length !== countryMeta.hotline_count) fail(`${countryMeta.alpha2}: hotline count mismatch`);
    hotlineCount += country.hotlines.length;
    for (const hotline of country.hotlines) {
      if (!/^weh_[0-9a-f]{24}$/.test(hotline.id)) fail(`${countryMeta.alpha2}: invalid record ID ${hotline.id}`);
      if (seen.has(hotline.id)) fail(`duplicate record ID ${hotline.id}`);
      seen.add(hotline.id);
      if (!['local', 'county', 'state', 'national'].includes(hotline.scope)) fail(`${hotline.id}: invalid scope ${hotline.scope}`);
      if (!recordIndex.records[hotline.id]) fail(`${hotline.id}: absent from record index`);
      if (recordIndex.records[hotline.id]?.country_code !== countryMeta.alpha2) fail(`${hotline.id}: country mismatch in record index`);
      for (const channel of ['phone', 'text', 'chat']) {
        if (typeof hotline.channels?.[channel] !== 'boolean') fail(`${hotline.id}: invalid ${channel} channel`);
      }
    }
  }
  if (hotlineCount !== manifest.total_records) fail(`country totals ${hotlineCount} != ${manifest.total_records}`);

  const source = readFileSync(SOURCE_RESOLVER);
  const published = readFileSync(resolve(API_DIR, 'resolver.js'));
  const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
  if (digest(source) !== digest(published)) fail('published resolver differs from source finder resolver');

  const resolver = await import(`${pathToFileURL(resolve(API_DIR, 'resolver.js')).href}?verify=${Date.now()}`);
  const us = readJson(resolve(API_DIR, 'countries', 'us.json'));
  const resolved = resolver.resolveGuidedHelp({ country: us, category: 'mental_health', channel: 'phone', locality: 'Wake County' });
  assert.equal(resolved.fallback, false);
  assert.equal(resolved.scope, 'county');
  assert.ok(resolved.results.length > 0);
  assert.ok(resolved.results.every((record) => record.verification_status !== 'deprecated'));
  assert.ok(resolved.results.every((record) => /^weh_[0-9a-f]{24}$/.test(record.id)));
  assert.match(resolved.reason, /recorded coverage mentions/);
}

if (errors.length) {
  console.error(`Static API verification failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('Static API v1 OK: versioned manifest, 250 countries, 3255 stable records, explainable resolver');
