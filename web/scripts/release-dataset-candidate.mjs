import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { byteIdentity, canonicalFile, diffSnapshots, snapshotDataset } from './dataset-diff.mjs';
import { registryEntryIdentity, validateDate, validateRegistry, validateReleaseId } from './release-feeds.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docsRoot = resolve(repoRoot, 'docs');
const registryPath = resolve(docsRoot, 'dataset-releases.json');
const snapshotRoot = resolve(docsRoot, 'dataset-release-snapshots');
const transactionRoot = resolve(docsRoot, '.dataset-release-transaction');
const markerPath = resolve(transactionRoot, 'marker.json');
const stagedSnapshotPath = resolve(transactionRoot, 'snapshot.json');
const stagedRegistryPath = resolve(transactionRoot, 'registry.json');
const TRANSACTION_FILES = new Set(['marker.json', 'snapshot.json', 'registry.json']);

function parseArgs(argv) { const result = {}; for (let i = 0; i < argv.length; i += 2) { const key = argv[i]; if (!['--id','--date','--title','--summary'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('usage: --id ID --date YYYY-MM-DD --title TITLE --summary SUMMARY'); if (result[key]) throw new Error(`duplicate argument: ${key}`); result[key] = argv[i + 1]; } if (Object.keys(result).length !== 4) throw new Error('all explicit arguments are required'); return result; }
function text(value, label, max) { if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be bounded and control-free`); return value; }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function closed(value, required, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); if (Object.keys(value).some((key) => !required.includes(key))) throw new Error(`${label} has unknown fields`); for (const key of required) if (!own(value, key)) throw new Error(`${label} is missing ${key}`); }
function contained(root, target, label) { const rel = relative(root, target); if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`${label} escapes its root`); return target; }
function stat(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

function assertRealDirectory(path, label) {
  const metadata = stat(path);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must be a real directory`);
  if (realpathSync(path) !== resolve(path)) throw new Error(`${label} realpath is not the expected contained path`);
}

function ensureSafeDirectory(path, parent, label) {
  contained(parent, path, label);
  const metadata = stat(path);
  if (!metadata) mkdirSync(path, { mode: 0o755 });
  assertRealDirectory(path, label);
}

function validateRoots({ createTransaction = false } = {}) {
  assertRealDirectory(repoRoot, 'repository root');
  assertRealDirectory(docsRoot, 'docs root');
  ensureSafeDirectory(snapshotRoot, docsRoot, 'snapshot root');
  if (createTransaction) ensureSafeDirectory(transactionRoot, docsRoot, 'transaction root');
  else if (stat(transactionRoot)) assertRealDirectory(transactionRoot, 'transaction root');
}

function assertDirectFile(path, root, name, { allowMissing = false } = {}) {
  if (resolve(root, name) !== path || dirname(path) !== root) throw new Error(`${name} is not a direct-child path`);
  const metadata = stat(path);
  if (!metadata) { if (allowMissing) return null; throw new Error(`${name} is missing`); }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${name} must be a regular non-symlink file`);
  return metadata;
}

function writeExclusive(path, bytes) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, 0o644);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path) { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function unlinkValidated(path, root, name) { const metadata = assertDirectFile(path, root, name, { allowMissing: true }); if (metadata) unlinkSync(path); }

function validateMarker(marker) {
  const fields = ['schema_version', 'release_id', 'snapshot_path', 'snapshot_sha256', 'registry_path', 'registry_sha256'];
  closed(marker, fields, 'transaction marker');
  if (marker.schema_version !== '1.0') throw new Error('unsupported transaction marker schema');
  validateReleaseId(marker.release_id);
  const expectedSnapshot = `dataset-release-snapshots/${marker.release_id}.json`;
  if (marker.snapshot_path !== expectedSnapshot || marker.registry_path !== 'dataset-releases.json') throw new Error('transaction marker paths are invalid');
  for (const key of ['snapshot_sha256', 'registry_sha256']) if (!/^sha256:[0-9a-f]{64}$/.test(marker[key])) throw new Error(`transaction marker ${key} is invalid`);
  return marker;
}

function cleanTransactionFiles() {
  for (const [path, name] of [[markerPath, 'marker.json'], [stagedSnapshotPath, 'snapshot.json'], [stagedRegistryPath, 'registry.json']]) unlinkValidated(path, transactionRoot, name);
  if (stat(transactionRoot)) { syncDirectory(docsRoot); rmdirSync(transactionRoot); }
}

function recoverTransaction() {
  validateRoots();
  if (!stat(transactionRoot)) return;
  const entries = readdirSync(transactionRoot);
  for (const name of entries) if (!TRANSACTION_FILES.has(name)) throw new Error(`transaction root contains unvalidated path: ${name}`);
  for (const name of entries) assertDirectFile(resolve(transactionRoot, name), transactionRoot, name);
  if (!stat(markerPath)) { cleanTransactionFiles(); return; }
  const marker = validateMarker(JSON.parse(readFileSync(markerPath, 'utf8')));
  const target = resolve(snapshotRoot, `${marker.release_id}.json`); contained(snapshotRoot, target, 'transaction snapshot target');
  const registryBytes = readFileSync(registryPath);
  const registryInstalled = byteIdentity(registryBytes) === marker.registry_sha256;
  if (registryInstalled) {
    const registry = JSON.parse(registryBytes); const last = registry.releases?.at(-1);
    if (!last || last.id !== marker.release_id || last.snapshot?.path !== marker.snapshot_path || last.snapshot.sha256 !== marker.snapshot_sha256) throw new Error('installed registry does not match transaction marker');
  } else if (stat(target)) {
    assertDirectFile(target, snapshotRoot, `${marker.release_id}.json`);
    if (byteIdentity(readFileSync(target)) !== marker.snapshot_sha256) throw new Error('uncommitted snapshot does not match transaction marker');
    unlinkSync(target); syncDirectory(snapshotRoot);
  }
  cleanTransactionFiles();
}

recoverTransaction();
const input = parseArgs(process.argv.slice(2)); validateReleaseId(input['--id']); validateDate(input['--date']); text(input['--title'], 'title', 160); text(input['--summary'], 'summary', 500);
validateRoots();
const datasetBytes = readFileSync(resolve(repoRoot, 'hotlines.json')); const dataset = JSON.parse(datasetBytes); const datasetVersion = `sha256:${createHash('sha256').update(datasetBytes).digest('hex')}`;
const registry = JSON.parse(readFileSync(registryPath, 'utf8')); validateRegistry(registry); const prior = registry.releases.at(-1);
if (registry.releases.some((entry) => entry.id === input['--id'])) throw new Error('release ID already exists; historical releases are never rewritten');
if (input['--date'] < prior.date) throw new Error('candidate date must preserve chronological append order');
if (prior.changes.to_dataset_version === datasetVersion) throw new Error('canonical dataset identity is unchanged; redundant releases are forbidden');
const priorSnapshotPath = resolve(docsRoot, prior.snapshot.path); contained(snapshotRoot, priorSnapshotPath, 'prior snapshot'); assertDirectFile(priorSnapshotPath, snapshotRoot, `${prior.id}.json`);
const priorSnapshot = JSON.parse(readFileSync(priorSnapshotPath, 'utf8')); const snapshot = snapshotDataset(dataset, datasetVersion); const snapshotBytes = canonicalFile(snapshot);
const filename = `${input['--id']}.json`; const target = resolve(snapshotRoot, filename); contained(snapshotRoot, target, 'snapshot target'); if (stat(target)) throw new Error(`refusing to overwrite snapshot: ${filename}`);
const entry = { id: input['--id'], date: input['--date'], title: input['--title'], summary: input['--summary'], previous_entry_hash: registry.history_head, snapshot: { path: `dataset-release-snapshots/${filename}`, sha256: byteIdentity(snapshotBytes) }, changes: diffSnapshots(priorSnapshot, snapshot) }; entry.entry_hash = registryEntryIdentity(entry);
const next = { ...registry, history_head: entry.entry_hash, releases: [...registry.releases, entry] }; const registryBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
validateRegistry(next, dataset, datasetVersion, { readSnapshot: (path) => path === target ? snapshotBytes : readFileSync(path) });

validateRoots({ createTransaction: true });
writeExclusive(stagedSnapshotPath, snapshotBytes); writeExclusive(stagedRegistryPath, registryBytes);
if (byteIdentity(readFileSync(stagedSnapshotPath)) !== entry.snapshot.sha256 || byteIdentity(readFileSync(stagedRegistryPath)) !== byteIdentity(registryBytes)) throw new Error('staged candidate verification failed');
const marker = { schema_version: '1.0', release_id: entry.id, snapshot_path: entry.snapshot.path, snapshot_sha256: entry.snapshot.sha256, registry_path: 'dataset-releases.json', registry_sha256: byteIdentity(registryBytes) };
validateMarker(marker); writeExclusive(markerPath, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`)); syncDirectory(transactionRoot);
if (process.env.WEH_CANDIDATE_INTERRUPT === 'before-snapshot-install') throw new Error('simulated interruption before snapshot install');
renameSync(stagedSnapshotPath, target); syncDirectory(snapshotRoot);
if (process.env.WEH_CANDIDATE_INTERRUPT === 'after-snapshot-install') throw new Error('simulated interruption after snapshot install');
renameSync(stagedRegistryPath, registryPath); syncDirectory(docsRoot);
if (process.env.WEH_CANDIDATE_INTERRUPT === 'after-registry-install') throw new Error('simulated interruption after registry install');
cleanTransactionFiles();
console.log(`Wrote recoverable candidate ${input['--id']} (${entry.changes.counts.total_changes} events); review the new snapshot and registry append together.`);
