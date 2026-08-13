import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codePointCompare, diffDatasets, diffSnapshots, snapshotDataset, validateSnapshot } from './dataset-diff.mjs';
import { verifyBootstrap } from './verify-dataset-append-only.mjs';
import { orderedFeedEntries, renderFeeds, validateChangelog, validateDate, validateRegistry, validateReleaseId, validateRenderedFeeds } from './release-feeds.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = (char) => `sha256:${char.repeat(64)}`;
const hotline = (id, extra = {}) => ({ id, name: `Service ${id}`, languages: ['en', 'sv'], ...extra });
const country = (code, name, records) => ({ country: name, 'alpha-2': code, hotlines: records });
const dataset = (...countries) => ({ $schema_version: '2.0', countries });
const baseline = dataset(country('AA', 'A', [hotline('one'), hotline('two')]));

assert.equal(codePointCompare('\uE000', '\u{10000}'), -1, 'must compare Unicode scalar values');
assert.deepEqual(['\u{10000}', '\uE000', 'a', 'aa'].sort(codePointCompare), ['a', 'aa', '\uE000', '\u{10000}']);
const identical = diffDatasets(baseline, structuredClone(baseline), { fromDatasetVersion: version('a'), toDatasetVersion: version('a') });
assert.deepEqual(identical.counts, { added: 0, removed: 0, modified: 0, country_metadata_changed: 0, total_changes: 0 });

const changed = dataset(country('AA', 'Renamed', [hotline('one', { name: 'Changed', cost: 'free' }), hotline('three')]));
const delta = diffDatasets(baseline, changed, { fromDatasetVersion: version('a'), toDatasetVersion: version('b') });
assert.deepEqual(delta.counts, { added: 1, removed: 1, modified: 1, country_metadata_changed: 1, total_changes: 4 });
assert.deepEqual(delta.changes.find((entry) => entry.id === 'one').changed_fields, ['cost', 'name']);
assert.deepEqual(delta.country_metadata_changes[0].changed_fields, ['country_name']);
assert.equal(JSON.stringify(delta).includes('Changed'), false, 'raw hotline values leaked into delta');

const moved = diffDatasets(dataset(country('AA', 'Old', [hotline('one')])), dataset(country('BB', 'New', [hotline('one')])), { fromDatasetVersion: version('a'), toDatasetVersion: version('b') });
assert.equal(moved.changes[0].change_type, 'modified'); assert.equal('changed_fields' in moved.changes[0], false); assert.deepEqual(moved.changes[0].country_changed_fields, ['country_code', 'country_name']); assert.equal(moved.counts.modified, 1);
assert.deepEqual(moved.countries, [
  { country_code: 'AA', country_name: 'Old', added: 0, removed: 0, modified: 0, moved_in: 0, moved_out: 1, metadata_changed: 0 },
  { country_code: 'BB', country_name: 'New', added: 0, removed: 0, modified: 0, moved_in: 1, moved_out: 0, metadata_changed: 0 },
]);

for (const bad of [dataset(country('AA', 'A', [{ name: 'missing' }])), dataset(country('AA', 'A', [hotline('same')]), country('BB', 'B', [hotline('same')]))]) assert.throws(() => snapshotDataset(bad, version('a')), /id|duplicate/i);
const snap = snapshotDataset(baseline, version('a')); const unknown = structuredClone(snap); unknown.extra = true; assert.throws(() => validateSnapshot(unknown), /unknown field/);
const duplicate = structuredClone(snap); duplicate.countries[0].records.push(duplicate.countries[0].records[0]); assert.throws(() => validateSnapshot(duplicate), /duplicate|sorted/);
const badHash = structuredClone(snap); badHash.dataset_version = 'SHA256:no'; assert.throws(() => validateSnapshot(badHash), /sha256/);
const badOrder = structuredClone(snap); badOrder.countries[0].records.reverse(); assert.throws(() => validateSnapshot(badOrder), /sorted/);

for (const bad of ['../escape', 'a/b', 'a\\b', '%2e%2e', 'C:drive', 'UPPER', 'a\u0000b', '.hidden', 'a--b']) assert.throws(() => validateReleaseId(bad), /slug/);
for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-01']) assert.throws(() => validateDate(bad), /calendar/);
assert.equal(validateDate('2024-02-29'), '2024-02-29');

const changelog = { schema_version: '1.0', contract: 'Fixture contract.', releases: [{ id: 'z', date: '2026-01-01', title: 'A < B & C', facts: ['Fact <tag> & value.'] }, { id: 'a', date: '2026-01-01', title: 'Same date', facts: ['Stable.'] }] };
const registryFixture = { releases: [{ id: 'd', date: '2026-01-01', title: 'Dataset & release', summary: 'Zero < delta.' }] };
assert.deepEqual(orderedFeedEntries(changelog, registryFixture).map((entry) => `${entry.kind}:${entry.source_id}`), ['dataset:d', 'milestone:a', 'milestone:z']);
const feeds = renderFeeds(changelog, registryFixture);
assert.equal(feeds.jsonFeed.version, 'https://jsonfeed.org/version/1.1'); assert.deepEqual(feeds.jsonFeed.authors, [{ name: 'World Hotlines', url: 'https://worldhotlines.org' }]);
assert.ok(feeds.jsonFeed.items.every((item) => /^https:\/\/worldhotlines\.org\//.test(item.id) && item.date_published.endsWith('T00:00:00Z')));
assert.match(feeds.rss, /<rss version="2.0"/); assert.match(feeds.rss, /<channel>/); assert.match(feeds.rss, /<guid isPermaLink="false">/); assert.match(feeds.rss, /<atom:link [^>]*rel="self"/);
assert.match(feeds.atom, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/); assert.match(feeds.atom, /<author><name>World Hotlines<\/name><uri>/); assert.match(feeds.atom, /rel="self" type="application\/atom\+xml"/); assert.match(feeds.atom, /<entry><id>/);
assert.doesNotMatch(feeds.atom, /<title>A < B/); assert.match(feeds.atom, /A &lt; B &amp; C/);
const noAuthor = feeds.atom.replace(/<author>.*?<\/author>/, ''); assert.doesNotMatch(noAuthor, /<author>/, 'negative fixture really lacks Atom author');
assert.equal(validateRenderedFeeds(feeds), true); assert.throws(() => validateRenderedFeeds({ ...feeds, atom: noAuthor }), /Atom.*author/); assert.throws(() => validateRenderedFeeds({ ...feeds, jsonFeed: { ...feeds.jsonFeed, feed_url: 'javascript:alert(1)' } }), /safe canonical URL/);
for (const malformed of [
  { releases: [] },
  { ...changelog, unknown: true },
  { ...changelog, releases: [{ ...changelog.releases[0], id: '../bad' }] },
  { ...changelog, releases: [{ ...changelog.releases[0], date: '2026-02-30' }] },
  { ...changelog, releases: [{ ...changelog.releases[0], title: 'bad\u0000title' }] },
]) assert.throws(() => validateChangelog(malformed));

const canonical = JSON.parse(readFileSync(resolve(ROOT, 'hotlines.json'), 'utf8')); const registry = JSON.parse(readFileSync(resolve(ROOT, 'docs/dataset-releases.json'), 'utf8'));
const currentVersion = registry.releases.at(-1).changes.to_dataset_version; validateRegistry(registry, canonical, currentVersion);
const canonicalBytes = readFileSync(resolve(ROOT, 'hotlines.json'));
const registrySnapshot = (path) => readFileSync(path);
assert.equal(verifyBootstrap(registry, canonicalBytes, registrySnapshot).id, registry.releases[0].id);
assert.throws(() => verifyBootstrap({ ...registry, releases: [...registry.releases, registry.releases[0]] }, canonicalBytes, registrySnapshot), /exactly one/);
assert.throws(() => verifyBootstrap(registry, Buffer.concat([canonicalBytes, Buffer.from(' ')]), registrySnapshot), /valid JSON|matching reviewed/);
for (const mutate of [
  (copy) => { copy.extra = 1; },
  (copy) => { copy.releases[0].changes.counts.total_changes++; },
  (copy) => { copy.releases[0].changes.countries.push({}); },
  (copy) => { copy.releases[0].changes.from_dataset_version = version('f'); },
  (copy) => { copy.releases[0].date = '2026-02-30'; },
  (copy) => { copy.releases[0].id = '../escape'; },
]) { const copy = structuredClone(registry); mutate(copy); assert.throws(() => validateRegistry(copy, canonical, currentVersion)); }
assert.throws(() => validateRegistry(registry, canonical, version('f')), /matching reviewed/);
assert.deepEqual(diffSnapshots(snapshotDataset(canonical, currentVersion), snapshotDataset(canonical, currentVersion)).counts, registry.releases[0].changes.counts);

console.log('Release feed unit contracts OK: complete snapshots, closed validation, Unicode scalar ordering, metadata-safe diffs, JSON Feed/RSS/Atom requirements');
