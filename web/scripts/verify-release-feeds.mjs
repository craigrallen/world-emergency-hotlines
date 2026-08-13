import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffDatasets, diffSnapshots, snapshotDataset, utf16Compare, validateSnapshot, valueIdentity } from './dataset-diff.mjs';
import { verifyBootstrap } from './verify-dataset-append-only.mjs';
import { assertXml10, orderedFeedEntries, renderFeeds, validateDate, validateRegistry, validateReleaseId, validateRenderedFeeds } from './release-feeds.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = (char) => `sha256:${char.repeat(64)}`;
const hotline = (id, extra = {}) => ({ id, name: `Service ${id}`, languages: ['en', 'sv'], ...extra });
const country = (code, name, records, extra = {}) => ({ country: name, 'alpha-2': code, ...extra, hotlines: records });
const dataset = (...countries) => ({ $schema_version: '2.0', countries });
const zeroCounts = { added: 0, removed: 0, modified: 0, country_metadata_added: 0, country_metadata_removed: 0, country_metadata_modified: 0, country_metadata_changed: 0, total_changes: 0 };
const baseline = dataset(country('AA', 'A', [hotline('one'), hotline('two')], { 'alpha-3': 'AAA', region: 'R', subregion: 'S', general_emergency: { police: '111' }, notes: 'country note' }));

assert.equal(utf16Compare('\uE000', '\u{10000}'), 1, 'must compare JavaScript UTF-16 code units');
assert.deepEqual(['\u{10000}', '\uE000', 'a', 'aa'].sort(utf16Compare), ['a', 'aa', '\u{10000}', '\uE000']);
const identical = diffDatasets(baseline, structuredClone(baseline), { fromDatasetVersion: version('a'), toDatasetVersion: version('a') });
assert.deepEqual(identical.counts, zeroCounts);

const changed = dataset(country('AA', 'Renamed', [hotline('one', { name: 'Changed', cost: 'free' }), hotline('three')], { 'alpha-3': 'AAX', region: 'R2', subregion: 'S', general_emergency: { police: 'SECRET-999' }, notes: 'SECRET-NOTE' }));
const delta = diffDatasets(baseline, changed, { fromDatasetVersion: version('a'), toDatasetVersion: version('b') });
assert.deepEqual(delta.counts, { added: 1, removed: 1, modified: 1, country_metadata_added: 0, country_metadata_removed: 0, country_metadata_modified: 1, country_metadata_changed: 1, total_changes: 4 });
assert.deepEqual(delta.changes.find((entry) => entry.id === 'one').changed_fields, ['cost', 'name']);
assert.deepEqual(delta.country_metadata_changes, [{ country_code: 'AA', country_name: 'Renamed', change_type: 'modified', changed_fields: ['alpha-3', 'country', 'general_emergency', 'notes', 'region'] }]);
assert.equal(JSON.stringify(delta).includes('SECRET'), false, 'raw country metadata values leaked into delta');
assert.equal(JSON.stringify(delta).includes('Changed'), false, 'raw hotline values leaked into delta');
const renamedOnly = structuredClone(baseline); renamedOnly.countries[0].country = 'Only renamed';
const renameDelta = diffDatasets(baseline, renamedOnly, { fromDatasetVersion: version('a'), toDatasetVersion: version('b') });
assert.equal(renameDelta.changes.length, 0, 'country rename inflated record changes'); assert.equal(renameDelta.country_metadata_changes.length, 1);

const metadataCases = [
  ['general_emergency', { police: '222' }], ['region', 'R3'], ['subregion', 'S3'], ['alpha-3', 'AAZ'], ['notes', 'other note'],
];
for (const [field, value] of metadataCases) {
  const copy = structuredClone(baseline); copy.countries[0][field] = value;
  const result = diffDatasets(baseline, copy, { fromDatasetVersion: version('a'), toDatasetVersion: version('b') });
  assert.deepEqual(result.country_metadata_changes[0].changed_fields, [field], `${field} did not produce a metadata delta`);
  assert.equal(result.changes.length, 0, `${field} inflated record changes`);
  assert.equal(JSON.stringify(result).includes(typeof value === 'string' ? value : '222'), false, `${field} raw value leaked`);
}
const withEmpty = dataset(...structuredClone(baseline.countries), country('ZZ', 'Empty', [], { region: 'Hidden empty region' }));
const emptyAdded = diffDatasets(baseline, withEmpty, { fromDatasetVersion: version('a'), toDatasetVersion: version('b') });
assert.deepEqual(emptyAdded.country_metadata_changes.at(-1), { country_code: 'ZZ', country_name: 'Empty', change_type: 'added', changed_fields: ['alpha-2', 'country', 'region'] });
assert.equal(emptyAdded.changes.length, 0); assert.equal(JSON.stringify(emptyAdded).includes('Hidden empty region'), false);
const emptyRemoved = diffDatasets(withEmpty, baseline, { fromDatasetVersion: version('b'), toDatasetVersion: version('c') });
assert.equal(emptyRemoved.country_metadata_changes.at(-1).change_type, 'removed'); assert.equal(emptyRemoved.changes.length, 0);

const moved = diffDatasets(dataset(country('AA', 'Old', [hotline('one')])), dataset(country('BB', 'New', [hotline('one')])), { fromDatasetVersion: version('a'), toDatasetVersion: version('b') });
assert.equal(moved.changes[0].change_type, 'modified'); assert.equal('changed_fields' in moved.changes[0], false); assert.deepEqual(moved.changes[0].country_changed_fields, ['country_code', 'country_name']); assert.equal(moved.counts.modified, 1);
assert.equal(moved.country_metadata_changes.length, 2, 'country remove/add metadata events must coexist with one record move');

for (const bad of [dataset(country('AA', 'A', [{ name: 'missing' }])), dataset(country('AA', 'A', [hotline('same')]), country('BB', 'B', [hotline('same')]))]) assert.throws(() => snapshotDataset(bad, version('a')), /id|duplicate/i);
const snap = snapshotDataset(baseline, version('a'));
assert.ok(Object.keys(snap.countries[0].fields).includes('general_emergency'));
for (const mutate of [
  (copy) => { copy.extra = true; },
  (copy) => { copy.countries[0].fields = {}; },
  (copy) => { delete copy.countries[0].fields.country; },
  (copy) => { copy.countries[0].fields.country = version('f'); },
  (copy) => { copy.countries[0].records[0].fields = {}; },
  (copy) => { delete copy.countries[0].records[0].fields.id; },
  (copy) => { copy.countries[0].records[0].fields.id = valueIdentity('wrong'); },
]) { const copy = structuredClone(snap); mutate(copy); assert.throws(() => validateSnapshot(copy)); }
const duplicate = structuredClone(snap); duplicate.countries[0].records.push(duplicate.countries[0].records[0]); assert.throws(() => validateSnapshot(duplicate), /duplicate|sorted/);
const badOrder = structuredClone(snap); badOrder.countries[0].records.reverse(); assert.throws(() => validateSnapshot(badOrder), /sorted/);

for (const bad of ['../escape', 'a/b', 'a\\b', '%2e%2e', 'C:drive', 'UPPER', 'a\u0000b', '.hidden', 'a--b']) assert.throws(() => validateReleaseId(bad), /slug/);
for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-01']) assert.throws(() => validateDate(bad), /calendar/);
assert.equal(validateDate('2024-02-29'), '2024-02-29');

const changelog = { schema_version: '1.0', contract: 'Fixture contract.', releases: [{ id: 'z', date: '2026-01-01', title: 'A < B & C', facts: ['Fact <tag> & value.'] }, { id: 'a', date: '2026-01-01', title: 'Same date', facts: ['Stable.'] }] };
const registryFixture = { releases: [{ id: 'd', date: '2026-01-01', title: 'Dataset & release', summary: 'Zero < delta.' }] };
assert.deepEqual(orderedFeedEntries(changelog, registryFixture).map((entry) => `${entry.kind}:${entry.source_id}`), ['dataset:d', 'milestone:a', 'milestone:z']);
const feeds = renderFeeds(changelog, registryFixture);
assert.equal(feeds.jsonFeed.version, 'https://jsonfeed.org/version/1.1'); assert.deepEqual(feeds.jsonFeed.authors, [{ name: 'World Hotlines', url: 'https://worldhotlines.org' }]);
assert.match(feeds.rss, /<rss version="2.0"/); assert.match(feeds.atom, /<author><name>World Hotlines<\/name><uri>/); assert.match(feeds.atom, /A &lt; B &amp; C/);
const noAuthor = feeds.atom.replace(/<author>.*?<\/author>/, ''); assert.equal(validateRenderedFeeds(feeds), true); assert.throws(() => validateRenderedFeeds({ ...feeds, atom: noAuthor }), /Atom.*author/);
assert.throws(() => validateRenderedFeeds({ ...feeds, jsonFeed: { ...feeds.jsonFeed, feed_url: 'javascript:alert(1)' } }), /safe canonical URL/);
for (const legal of ['\u0009', '\u000a', '\u000d', '\u0020', '\u007f', '\u0085', '\u009f', '\ud7ff', '\u{10000}', '\u{10ffff}']) assert.equal(assertXml10(legal), legal);
for (const illegal of ['\u0000', '\u0008', '\u000b', '\u000c', '\u000e', '\u001f', '\ufffe', '\uffff', '\ud800', '\udfff']) assert.throws(() => assertXml10(illegal), /XML|surrogate/);
for (const illegal of ['\ufffe', '\uffff', '\ud800', '\udfff']) { const bad = structuredClone(changelog); bad.releases[0].title = `bad${illegal}`; assert.throws(() => renderFeeds(bad, registryFixture), /XML|surrogate/); }
const duplicateFeeds = { ...registryFixture, releases: [...registryFixture.releases, { ...registryFixture.releases[0] }] }; assert.throws(() => renderFeeds(changelog, duplicateFeeds), /unique/);
for (const malformed of [{ releases: [] }, { ...changelog, unknown: true }, { ...changelog, releases: [{ ...changelog.releases[0], id: '../bad' }] }, { ...changelog, releases: [{ ...changelog.releases[0], date: '2026-02-30' }] }]) assert.throws(() => orderedFeedEntries(malformed, registryFixture));

const canonical = JSON.parse(readFileSync(resolve(ROOT, 'hotlines.json'), 'utf8')); const registry = JSON.parse(readFileSync(resolve(ROOT, 'docs/dataset-releases.json'), 'utf8'));
const currentVersion = registry.releases.at(-1).changes.to_dataset_version; validateRegistry(registry, canonical, currentVersion);
const canonicalBytes = readFileSync(resolve(ROOT, 'hotlines.json')); const registrySnapshot = (path) => readFileSync(path);
assert.equal(verifyBootstrap(registry, canonicalBytes, registrySnapshot).id, registry.releases[0].id);
assert.throws(() => verifyBootstrap({ ...registry, releases: [...registry.releases, registry.releases[0]] }, canonicalBytes, registrySnapshot), /exactly one/);
assert.throws(() => verifyBootstrap(registry, Buffer.concat([canonicalBytes, Buffer.from(' ')]), registrySnapshot), /valid JSON|matching reviewed/);
for (const mutate of [(copy) => { copy.extra = 1; }, (copy) => { copy.releases[0].changes.counts.total_changes++; }, (copy) => { copy.releases[0].changes.countries.push({}); }, (copy) => { copy.releases[0].date = '2026-02-30'; }, (copy) => { copy.releases[0].changes.changes.push({ id: 'bad', change_type: 'added', country_code: 'AA', country_name: 'A', changed_fields: ['name'] }); }]) { const copy = structuredClone(registry); mutate(copy); assert.throws(() => validateRegistry(copy, canonical, currentVersion)); }
assert.throws(() => validateRegistry(registry, canonical, version('f')), /matching reviewed/);
assert.deepEqual(diffSnapshots(snapshotDataset(canonical, currentVersion), snapshotDataset(canonical, currentVersion)).counts, registry.releases[0].changes.counts);

console.log('Release feed unit contracts OK: complete country/record hashes, UTF-16 ordering, metadata-safe empty-country diffs, strict schemas, XML 1.0 safety, unique feeds');
