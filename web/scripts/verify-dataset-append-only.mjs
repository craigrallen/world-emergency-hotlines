import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, diffSnapshots, snapshotDataset } from './dataset-diff.mjs';
import { validateRegistry, validateReleaseId } from './release-feeds.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const datasetIdentity = (bytes) => `sha256:${digest(bytes)}`;
const zeroCounts = { added: 0, removed: 0, modified: 0, country_metadata_added: 0, country_metadata_removed: 0, country_metadata_modified: 0, country_metadata_changed: 0, total_changes: 0 };
const LEGACY_BASELINE = Object.freeze({
  registrySha256: '0f499ba47630f3788cc2a30d85c06e4a572b954e6ce0f4eee3c6f1f3ebae2989',
  snapshotSha256: '2f5a38d9fc478978813c61923c8aa15756c7d7435a8b1910cede6ebe5bc1cf47',
  entryHash: 'sha256:37ebe1c79b7ddbd1934c2e430a81fa5ba3572a025dab92fb887cde3e961f0b0b',
  id: 'dataset-baseline-2026-08-13',
  datasetVersion: 'sha256:e893c9f6b0afcc57832054547002c826e80b5387e544b4cf6909afc9424dde3a',
});

export function verifyBootstrap(current, baseDatasetBytes, readSnapshot) {
  if (!Array.isArray(current.releases) || current.releases.length !== 1) throw new Error('bootstrap registry must contain exactly one baseline entry');
  let baseDataset;
  try { baseDataset = JSON.parse(Buffer.from(baseDatasetBytes).toString('utf8')); }
  catch (error) { throw new Error(`trusted base hotlines.json is not valid JSON: ${error.message}`); }
  const version = datasetIdentity(baseDatasetBytes);
  const baseline = current.releases[0];
  validateRegistry(current, baseDataset, version, { readSnapshot });
  const expectedSnapshot = snapshotDataset(baseDataset, version);
  const expectedDelta = diffSnapshots(expectedSnapshot, expectedSnapshot);
  if (canonicalJson(baseline.changes) !== canonicalJson(expectedDelta) || canonicalJson(baseline.changes.counts) !== canonicalJson(zeroCounts)) {
    throw new Error('bootstrap baseline must be the exact zero delta for the trusted base dataset');
  }
  return baseline;
}

export function verifyUnchangedPrefix(current, prior, fromGit, readCurrentSnapshot) {
  if (!Array.isArray(prior.releases) || !Array.isArray(current.releases) || current.releases.length < prior.releases.length) throw new Error('dataset release history was removed');
  for (let index = 0; index < prior.releases.length; index++) {
    const before = prior.releases[index]; const after = current.releases[index]; validateReleaseId(before.id);
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`dataset release history is not an unchanged prefix at ${before.id}`);
    const path = `docs/${before.snapshot.path}`;
    const baseSnapshot = Buffer.from(fromGit(path)); const currentSnapshot = Buffer.from(readCurrentSnapshot(path));
    if (!baseSnapshot.equals(currentSnapshot)) throw new Error(`immutable snapshot changed: ${path}`);
  }
}

export function verifyBaselineSchemaMigration(current, priorRegistryBytes, priorSnapshotBytes, baseDatasetBytes, readCurrentSnapshot) {
  const prior = JSON.parse(Buffer.from(priorRegistryBytes));
  const legacy = prior.releases?.[0];
  if (digest(priorRegistryBytes) !== LEGACY_BASELINE.registrySha256 || digest(priorSnapshotBytes) !== LEGACY_BASELINE.snapshotSha256 || prior.releases?.length !== 1 || legacy?.id !== LEGACY_BASELINE.id || legacy?.entry_hash !== LEGACY_BASELINE.entryHash) throw new Error('dataset history rewrite is not the single allowlisted PR #85 baseline migration');
  if (datasetIdentity(baseDatasetBytes) !== LEGACY_BASELINE.datasetVersion) throw new Error('allowlisted baseline migration requires the unchanged PR #85 canonical dataset');
  if (current.schema_version !== '2.0' || current.releases?.length !== 1 || current.releases[0]?.id !== LEGACY_BASELINE.id || current.releases[0]?.changes?.to_dataset_version !== LEGACY_BASELINE.datasetVersion) throw new Error('allowlisted migration must replace only the single baseline in registry schema 2.0');
  const dataset = JSON.parse(Buffer.from(baseDatasetBytes));
  validateRegistry(current, dataset, LEGACY_BASELINE.datasetVersion, { readSnapshot: readCurrentSnapshot });
  return current.releases[0];
}

function run() {
  const base = process.env.DATASET_RELEASE_BASE_REF;
  if (!base) {
    console.log('Dataset append-only base comparison skipped: DATASET_RELEASE_BASE_REF is unset; registry consistency is validated by verify:feeds.');
    return;
  }
  const current = JSON.parse(readFileSync(resolve(repoRoot, 'docs/dataset-releases.json')));
  const git = (args, options = {}) => execFileSync('git', args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, ...options });
  git(['rev-parse', '--verify', `${base}^{commit}`], { stdio: 'pipe' });
  const tracked = git(['ls-tree', '-r', '--name-only', base, '--', 'docs/dataset-releases.json', 'docs/dataset-release-snapshots']).toString('utf8').trim().split('\n').filter(Boolean);
  const hasRegistry = tracked.includes('docs/dataset-releases.json');
  const snapshotPaths = tracked.filter((path) => path === 'docs/dataset-release-snapshots' || path.startsWith('docs/dataset-release-snapshots/'));
  const fromGit = (path) => git(['show', `${base}:${path}`]);
  const readCurrentSnapshot = (path) => readFileSync(resolve(repoRoot, path));

  if (!hasRegistry) {
    if (snapshotPaths.length !== 0) throw new Error('contradictory trusted base: dataset snapshots exist without a registry');
    const baseDatasetBytes = fromGit('hotlines.json');
    verifyBootstrap(current, baseDatasetBytes, (path) => readFileSync(path));
    console.log(`Dataset append-only bootstrap OK: one zero-delta baseline matches ${base}:hotlines.json (${datasetIdentity(baseDatasetBytes)})`);
    return;
  }

  const priorRegistryBytes = fromGit('docs/dataset-releases.json');
  const prior = JSON.parse(priorRegistryBytes);
  if (digest(priorRegistryBytes) === LEGACY_BASELINE.registrySha256) {
    const oldSnapshotPath = `docs/${prior.releases[0].snapshot.path}`;
    verifyBaselineSchemaMigration(current, priorRegistryBytes, fromGit(oldSnapshotPath), fromGit('hotlines.json'), readCurrentSnapshot);
    console.log('Dataset append-only migration OK: the exact allowlisted PR #85 baseline was deterministically upgraded with an unchanged canonical dataset');
    return;
  }
  verifyUnchangedPrefix(current, prior, fromGit, readCurrentSnapshot);
  console.log(`Dataset append-only check OK: ${prior.releases.length} base entries preserved byte-for-byte`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) run();
