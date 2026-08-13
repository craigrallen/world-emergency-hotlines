import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, diffSnapshots, SHA256_RE, snapshotDataset, utf16Compare, validateSnapshot, valueIdentity } from './dataset-diff.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(WEB_ROOT, '..');
const PUBLIC_ROOT = resolve(WEB_ROOT, 'public');
export const ORIGIN = 'https://worldhotlines.org';
export const REGISTRY_PATH = resolve(REPO_ROOT, 'docs', 'dataset-releases.json');
export const SNAPSHOT_ROOT = resolve(REPO_ROOT, 'docs', 'dataset-release-snapshots');
export const RELEASE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const closed = (value, required, optional, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} has unknown field: ${key}`);
  for (const key of required) if (!own(value, key)) throw new Error(`${label} is missing field: ${key}`);
};
const safeText = (value, label) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be a bounded control-free string`);
  return value;
};
const hash = (value, label) => { if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new Error(`${label} must be a lowercase sha256 identity`); };
const count = (value, label) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`); };
const sortedUnique = (values, label) => { for (let i = 1; i < values.length; i++) if (utf16Compare(values[i - 1], values[i]) >= 0) throw new Error(`${label} must be strictly UTF-16 code-unit sorted and unique`); };

export function validateDate(value, label = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD`);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error(`${label} is not a real calendar date`);
  return value;
}

export function validateReleaseId(value, label = 'release ID') {
  if (typeof value !== 'string' || !RELEASE_ID_RE.test(value) || value.length > 100 || /[%\\/:]/u.test(value) || /^[a-z]:/iu.test(value)) throw new Error(`${label} must be a conservative lowercase slug`);
  return value;
}

function contained(root, path, label) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`${label} escapes its managed root`);
  return path;
}

function snapshotPath(entry) {
  const expected = `dataset-release-snapshots/${entry.id}.json`;
  if (entry.snapshot.path !== expected) throw new Error(`snapshot path must be ${expected}`);
  return contained(resolve(REPO_ROOT, 'docs'), resolve(REPO_ROOT, 'docs', entry.snapshot.path), 'snapshot path');
}

function recreate(root) {
  const publicRoot = realpathSync(PUBLIC_ROOT);
  contained(publicRoot, root, 'generated output root');
  let cursor = publicRoot;
  for (const part of relative(publicRoot, root).split(sep)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`refusing generated symlink component: ${cursor}`);
  }
  rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
}

export function registryEntryIdentity(entry) { const { entry_hash: ignored, ...payload } = entry; return valueIdentity(payload); }

function validateCounts(value, label) {
  closed(value, ['added', 'removed', 'modified', 'country_metadata_added', 'country_metadata_removed', 'country_metadata_modified', 'country_metadata_changed', 'total_changes'], [], label);
  for (const [key, number] of Object.entries(value)) count(number, `${label}.${key}`);
  if (value.country_metadata_changed !== value.country_metadata_added + value.country_metadata_removed + value.country_metadata_modified) throw new Error(`${label}.country_metadata_changed is inconsistent`);
  if (value.total_changes !== value.added + value.removed + value.modified + value.country_metadata_changed) throw new Error(`${label}.total_changes is inconsistent`);
}

function validateChange(change, index) {
  const label = `changes[${index}]`; closed(change, ['id', 'change_type', 'country_code', 'country_name'], ['changed_fields', 'country_changed_fields', 'moved_from'], label);
  safeText(change.id, `${label}.id`); safeText(change.country_code, `${label}.country_code`); safeText(change.country_name, `${label}.country_name`);
  if (!['added', 'removed', 'modified'].includes(change.change_type)) throw new Error(`${label}.change_type is invalid`);
  if (change.change_type !== 'modified' && (own(change, 'changed_fields') || own(change, 'country_changed_fields') || own(change, 'moved_from'))) throw new Error(`${label} has fields that only make sense for modified records`);
  if (change.change_type === 'modified' && (!Array.isArray(change.changed_fields) || !change.changed_fields.length) && (!Array.isArray(change.country_changed_fields) || !change.country_changed_fields.length)) throw new Error(`${label} must name record or country metadata changes`);
  if (own(change, 'changed_fields')) { if (!Array.isArray(change.changed_fields) || change.changed_fields.length === 0) throw new Error(`${label}.changed_fields must be a non-empty array when present`); change.changed_fields.forEach((field) => safeText(field, `${label}.changed_fields`)); sortedUnique(change.changed_fields, `${label}.changed_fields`); }
  if (own(change, 'country_changed_fields')) { if (!Array.isArray(change.country_changed_fields) || change.country_changed_fields.length === 0) throw new Error(`${label}.country_changed_fields must be a non-empty array when present`); change.country_changed_fields.forEach((field) => safeText(field, `${label}.country_changed_fields`)); sortedUnique(change.country_changed_fields, `${label}.country_changed_fields`); }
  if (own(change, 'moved_from')) { if (change.change_type !== 'modified' || !change.country_changed_fields?.includes('country_code')) throw new Error(`${label}.moved_from requires a country modification`); closed(change.moved_from, ['country_code', 'country_name'], [], `${label}.moved_from`); safeText(change.moved_from.country_code, `${label}.moved_from.country_code`); safeText(change.moved_from.country_name, `${label}.moved_from.country_name`); }
}

function validateDiff(diff, label = 'changes') {
  closed(diff, ['schema_version', 'from_dataset_version', 'to_dataset_version', 'counts', 'countries', 'changes', 'country_metadata_changes', 'value_policy'], [], label);
  if (diff.schema_version !== '2.0' || diff.value_policy !== 'Only field names and cryptographic identities are compared; no before/after field values are published.') throw new Error(`${label} contract is invalid`);
  hash(diff.from_dataset_version, `${label}.from_dataset_version`); hash(diff.to_dataset_version, `${label}.to_dataset_version`); validateCounts(diff.counts, `${label}.counts`);
  if (!Array.isArray(diff.changes) || !Array.isArray(diff.countries) || !Array.isArray(diff.country_metadata_changes)) throw new Error(`${label} arrays are malformed`);
  diff.changes.forEach(validateChange); sortedUnique(diff.changes.map((item) => item.id), `${label} record IDs`);
  for (const [index, item] of diff.country_metadata_changes.entries()) {
    const itemLabel = `${label}.country_metadata_changes[${index}]`;
    closed(item, ['country_code', 'country_name', 'change_type', 'changed_fields'], [], itemLabel);
    safeText(item.country_code, `${itemLabel}.country_code`); safeText(item.country_name, `${itemLabel}.country_name`);
    if (!['added', 'removed', 'modified'].includes(item.change_type)) throw new Error(`${itemLabel}.change_type is invalid`);
    if (!Array.isArray(item.changed_fields) || item.changed_fields.length === 0) throw new Error(`${itemLabel}.changed_fields must be non-empty`);
    item.changed_fields.forEach((field) => safeText(field, `${itemLabel}.changed_fields`)); sortedUnique(item.changed_fields, `${itemLabel}.changed_fields`);
  }
  sortedUnique(diff.country_metadata_changes.map((item) => item.country_code), `${label} metadata country codes`);
  for (const [index, item] of diff.countries.entries()) { closed(item, ['country_code', 'country_name', 'added', 'removed', 'modified', 'moved_in', 'moved_out', 'metadata_added', 'metadata_removed', 'metadata_modified'], [], `${label}.countries[${index}]`); safeText(item.country_code, 'country code'); safeText(item.country_name, 'country name'); for (const key of ['added', 'removed', 'modified', 'moved_in', 'moved_out', 'metadata_added', 'metadata_removed', 'metadata_modified']) count(item[key], `country summary ${key}`); }
  sortedUnique(diff.countries.map((item) => item.country_code), `${label} country summaries`);
}

export function validateChangelog(changelog) {
  closed(changelog, ['schema_version', 'contract', 'releases'], [], 'milestone changelog');
  if (changelog.schema_version !== '1.0') throw new Error('unsupported milestone changelog schema'); safeText(changelog.contract, 'milestone contract');
  if (!Array.isArray(changelog.releases) || changelog.releases.length === 0) throw new Error('milestone changelog releases are malformed');
  const ids = [];
  for (const [index, entry] of changelog.releases.entries()) { closed(entry, ['id', 'date', 'title', 'facts'], [], `milestone[${index}]`); validateReleaseId(entry.id, 'milestone ID'); validateDate(entry.date); safeText(entry.title, 'milestone title'); if (!Array.isArray(entry.facts) || !entry.facts.length) throw new Error('milestone facts are required'); entry.facts.forEach((fact) => safeText(fact, 'milestone fact')); ids.push(entry.id); }
  if (new Set(ids).size !== ids.length) throw new Error('duplicate milestone IDs');
  return changelog;
}

export function validateRegistry(registry, currentDataset = null, exactDatasetVersion = null, { readSnapshot = (path) => readFileSync(path) } = {}) {
  closed(registry, ['schema_version', 'contract', 'history_head', 'releases'], [], 'dataset registry');
  if (registry.schema_version !== '2.0') throw new Error('unsupported dataset registry schema'); safeText(registry.contract, 'registry contract'); hash(registry.history_head, 'registry history_head');
  if (!Array.isArray(registry.releases) || registry.releases.length === 0) throw new Error('dataset registry releases must be non-empty');
  let previousHash = null; let previousSnapshot = null; let previousDate = null; const ids = [];
  for (const [index, entry] of registry.releases.entries()) {
    closed(entry, ['id', 'date', 'title', 'summary', 'previous_entry_hash', 'snapshot', 'changes', 'entry_hash'], [], `release[${index}]`);
    validateReleaseId(entry.id); validateDate(entry.date); safeText(entry.title, 'release title'); safeText(entry.summary, 'release summary'); ids.push(entry.id);
    if (previousDate && entry.date < previousDate) throw new Error('dataset releases must be oldest-first by date'); previousDate = entry.date;
    if (entry.previous_entry_hash !== previousHash) throw new Error(`dataset release history chain is broken at ${entry.id}`);
    closed(entry.snapshot, ['path', 'sha256'], [], `release ${entry.id}.snapshot`); safeText(entry.snapshot.path, 'snapshot path'); hash(entry.snapshot.sha256, 'snapshot sha256');
    const bytes = readSnapshot(snapshotPath(entry)); if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error('snapshot reader must return bytes');
    if (digest(bytes) !== entry.snapshot.sha256) throw new Error(`snapshot bytes were altered: ${entry.id}`);
    const snapshot = validateSnapshot(JSON.parse(Buffer.from(bytes).toString('utf8')));
    if (!Buffer.from(bytes).equals(Buffer.from(`${canonicalJson(snapshot)}\n`))) throw new Error(`snapshot is not exact canonical JSON: ${entry.id}`);
    validateDiff(entry.changes, `release ${entry.id}.changes`);
    const expected = diffSnapshots(previousSnapshot ?? snapshot, snapshot);
    if (canonicalJson(entry.changes) !== canonicalJson(expected)) throw new Error(`release delta does not match complete snapshots: ${entry.id}`);
    if (entry.entry_hash !== registryEntryIdentity(entry)) throw new Error(`dataset release entry was altered: ${entry.id}`);
    previousHash = entry.entry_hash; previousSnapshot = snapshot;
  }
  if (new Set(ids).size !== ids.length) throw new Error('duplicate dataset release IDs');
  if (registry.history_head !== previousHash) throw new Error('dataset release history head is stale');
  const current = registry.releases.at(-1); if (currentDataset !== null) { hash(exactDatasetVersion, 'exact dataset version');
  if (previousSnapshot.dataset_version !== exactDatasetVersion || current.changes.to_dataset_version !== exactDatasetVersion) throw new Error('canonical dataset has no matching reviewed registry release');
  if (canonicalJson(snapshotDataset(currentDataset, exactDatasetVersion)) !== canonicalJson(previousSnapshot)) throw new Error('latest complete snapshot does not match canonical records'); }
  return current;
}

export function assertXml10(value, label = 'XML text') {
  const text = String(value);
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${label} contains an unpaired high surrogate`);
      index++;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error(`${label} contains an unpaired low surrogate`);
    if (!(unit === 0x9 || unit === 0xa || unit === 0xd || unit >= 0x20) || unit === 0xfffe || unit === 0xffff) throw new Error(`${label} contains an XML 1.0-illegal character`);
  }
  return text;
}
const xml = (value) => assertXml10(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const rfc3339 = (date) => `${date}T00:00:00Z`;
const rfc822 = (date) => new Date(rfc3339(date)).toUTCString();

export function orderedFeedEntries(changelog, registry) {
  validateChangelog(changelog);
  const milestones = changelog.releases.map((entry) => ({ kind: 'milestone', date: entry.date, source_id: entry.id, title: entry.title, text: entry.facts.join(' '), url: `${ORIGIN}/releases#${entry.id}` }));
  const datasets = registry.releases.map((entry) => ({ kind: 'dataset', date: entry.date, source_id: entry.id, title: entry.title, text: entry.summary, url: `${ORIGIN}/release/v1/changes/${entry.id}.json` }));
  return [...milestones, ...datasets].sort((a, b) => utf16Compare(b.date, a.date) || utf16Compare(a.kind, b.kind) || utf16Compare(a.source_id, b.source_id));
}

export function renderFeeds(changelog, registry) {
  const entries = orderedFeedEntries(changelog, registry); if (!entries.length) throw new Error('feeds require at least one entry');
  const feedIds = entries.map((entry) => `${ORIGIN}/releases/${entry.kind}/${entry.source_id}`);
  if (new Set(feedIds).size !== feedIds.length) throw new Error('feed entry IDs must be unique');
  for (const [index, entry] of entries.entries()) { assertXml10(entry.title, `feed entry ${index} title`); assertXml10(entry.text, `feed entry ${index} text`); assertXml10(entry.url, `feed entry ${index} URL`); }
  const items = entries.map((entry) => ({ id: `${ORIGIN}/releases/${entry.kind}/${entry.source_id}`, url: entry.url, title: entry.title, content_text: entry.text, date_published: rfc3339(entry.date) }));
  const jsonFeed = { version: 'https://jsonfeed.org/version/1.1', title: 'World Hotlines releases', home_page_url: `${ORIGIN}/releases`, feed_url: `${ORIGIN}/feeds/releases.json`, description: 'Factual public product and dataset release summaries.', authors: [{ name: 'World Hotlines', url: ORIGIN }], items };
  const rssItems = entries.map((entry) => `    <item><title>${xml(entry.title)}</title><link>${xml(entry.url)}</link><guid isPermaLink="false">${xml(`${ORIGIN}/releases/${entry.kind}/${entry.source_id}`)}</guid><pubDate>${rfc822(entry.date)}</pubDate><description>${xml(entry.text)}</description></item>`).join('\n');
  const rss = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>World Hotlines releases</title><link>${ORIGIN}/releases</link><description>Factual public product and dataset release summaries.</description><language>en</language><lastBuildDate>${rfc822(entries[0].date)}</lastBuildDate><atom:link href="${ORIGIN}/feeds/releases.rss" rel="self" type="application/rss+xml"/>\n${rssItems}\n  </channel></rss>\n`;
  const atomEntries = entries.map((entry) => `  <entry><id>${xml(`${ORIGIN}/releases/${entry.kind}/${entry.source_id}`)}</id><title>${xml(entry.title)}</title><link href="${xml(entry.url)}"/><updated>${rfc3339(entry.date)}</updated><summary>${xml(entry.text)}</summary></entry>`).join('\n');
  const atom = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>${ORIGIN}/feeds/releases.atom</id><title>World Hotlines releases</title><author><name>World Hotlines</name><uri>${ORIGIN}</uri></author><link href="${ORIGIN}/releases"/><link href="${ORIGIN}/feeds/releases.atom" rel="self" type="application/atom+xml"/><updated>${rfc3339(entries[0].date)}</updated>\n${atomEntries}\n</feed>\n`;
  return { jsonFeed, rss, atom };
}

export function validateRenderedFeeds({ jsonFeed, rss, atom }) {
  if (!jsonFeed || jsonFeed.version !== 'https://jsonfeed.org/version/1.1' || !Array.isArray(jsonFeed.authors) || !jsonFeed.authors.some((author) => author?.name === 'World Hotlines') || !Array.isArray(jsonFeed.items)) throw new Error('JSON Feed 1.1 metadata is incomplete');
  const itemIds = jsonFeed.items.map((item) => item.id); if (new Set(itemIds).size !== itemIds.length) throw new Error('JSON Feed item IDs must be unique');
  for (const [label, value] of [['home_page_url', jsonFeed.home_page_url], ['feed_url', jsonFeed.feed_url], ...jsonFeed.items.flatMap((item) => [['item.id', item.id], ['item.url', item.url]])]) {
    let url; try { url = new URL(value); } catch { throw new Error(`${label} is not a valid URL`); }
    if (url.protocol !== 'https:' || url.origin !== ORIGIN || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is not a safe canonical URL`);
  }
  assertXml10(rss, 'rendered RSS'); assertXml10(atom, 'rendered Atom');
  if (!/^<\?xml[^>]*>\n<rss version="2\.0" xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom">/u.test(rss) || !/<channel>.*<title>.*<link>.*<description>/su.test(rss) || !/<atom:link [^>]*rel="self"[^>]*type="application\/rss\+xml"/u.test(rss)) throw new Error('RSS 2.0 channel metadata is incomplete');
  if (!/^<\?xml[^>]*>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/u.test(atom) || !/<author><name>[^<]+<\/name><uri>https:\/\//u.test(atom) || !/<link [^>]*rel="self"[^>]*type="application\/atom\+xml"/u.test(atom)) throw new Error('Atom 1.0 feed metadata or author is incomplete');
  return true;
}

export function generateReleaseFeeds({ currentDataset, datasetVersion }) {
  const changelog = json(resolve(REPO_ROOT, 'docs/releases.json')); const registry = json(REGISTRY_PATH);
  const current = validateRegistry(registry, currentDataset, datasetVersion); const feeds = renderFeeds(changelog, registry); validateRenderedFeeds(feeds);
  const releaseRoot = resolve(PUBLIC_ROOT, 'release', 'v1'); const feedsRoot = resolve(PUBLIC_ROOT, 'feeds');
  recreate(releaseRoot); recreate(feedsRoot); const changesRoot = resolve(releaseRoot, 'changes'); mkdirSync(changesRoot, { recursive: true });
  const history = registry.releases.map((entry) => ({ id: entry.id, date: entry.date, title: entry.title, dataset_version: entry.changes.to_dataset_version, path: `/release/v1/changes/${entry.id}.json`, counts: entry.changes.counts }));
  const index = { schema_version: '1.0', canonical_origin: ORIGIN, ordering: 'Newest first by date, then stable release ID in JavaScript UTF-16 code-unit order.', latest: '/release/v1/changes/latest.json', releases: [...history].sort((a, b) => utf16Compare(b.date, a.date) || utf16Compare(a.id, b.id)) };
  for (const entry of registry.releases) { validateReleaseId(entry.id); const output = contained(changesRoot, resolve(changesRoot, `${entry.id}.json`), 'change output'); writeFileSync(output, pretty(entry.changes)); }
  writeFileSync(resolve(releaseRoot, 'changes.json'), pretty(index)); writeFileSync(resolve(changesRoot, 'latest.json'), pretty(current.changes));
  writeFileSync(resolve(feedsRoot, 'releases.json'), pretty(feeds.jsonFeed)); writeFileSync(resolve(feedsRoot, 'releases.rss'), feeds.rss); writeFileSync(resolve(feedsRoot, 'releases.atom'), feeds.atom);
  return { registry, current, index };
}
