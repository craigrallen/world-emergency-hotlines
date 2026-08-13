import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { byteIdentity, canonicalFile, diffSnapshots, snapshotDataset } from './dataset-diff.mjs';
import { registryEntryIdentity, validateDate, validateRegistry, validateReleaseId } from './release-feeds.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function parseArgs(argv) { const result = {}; for (let i = 0; i < argv.length; i += 2) { const key = argv[i]; if (!['--id','--date','--title','--summary'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('usage: --id ID --date YYYY-MM-DD --title TITLE --summary SUMMARY'); if (result[key]) throw new Error(`duplicate argument: ${key}`); result[key] = argv[i + 1]; } if (Object.keys(result).length !== 4) throw new Error('all explicit arguments are required'); return result; }
function text(value, label, max) { if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be bounded and control-free`); return value; }
const input = parseArgs(process.argv.slice(2)); validateReleaseId(input['--id']); validateDate(input['--date']); text(input['--title'], 'title', 160); text(input['--summary'], 'summary', 500);
const datasetBytes = readFileSync(resolve(repoRoot, 'hotlines.json')); const dataset = JSON.parse(datasetBytes); const datasetVersion = `sha256:${createHash('sha256').update(datasetBytes).digest('hex')}`;
const registryPath = resolve(repoRoot, 'docs/dataset-releases.json'); const snapshotRoot = resolve(repoRoot, 'docs/dataset-release-snapshots'); const registry = JSON.parse(readFileSync(registryPath, 'utf8')); validateRegistry(registry); const prior = registry.releases.at(-1);
if (registry.releases.some((entry) => entry.id === input['--id'])) throw new Error('release ID already exists; historical releases are never rewritten'); if (input['--date'] < prior.date) throw new Error('candidate date must preserve chronological append order');
const priorSnapshot = JSON.parse(readFileSync(resolve(repoRoot, 'docs', prior.snapshot.path), 'utf8')); const snapshot = snapshotDataset(dataset, datasetVersion); const snapshotBytes = canonicalFile(snapshot); const filename = `${input['--id']}.json`; const target = resolve(snapshotRoot, filename); if (existsSync(target)) throw new Error(`refusing to overwrite snapshot: ${filename}`);
const entry = { id: input['--id'], date: input['--date'], title: input['--title'], summary: input['--summary'], previous_entry_hash: registry.history_head, snapshot: { path: `dataset-release-snapshots/${filename}`, sha256: byteIdentity(snapshotBytes) }, changes: diffSnapshots(priorSnapshot, snapshot) }; entry.entry_hash = registryEntryIdentity(entry); const next = { ...registry, history_head: entry.entry_hash, releases: [...registry.releases, entry] };
validateRegistry(next, dataset, datasetVersion, { readSnapshot: (path) => path === target ? snapshotBytes : readFileSync(path) });
mkdirSync(snapshotRoot, { recursive: true }); const nonce = `${process.pid}-${Date.now()}`; const snapshotTemp = `${target}.${nonce}.tmp`; const registryTemp = `${registryPath}.${nonce}.tmp`;
let snapshotInstalled = false;
try { writeFileSync(snapshotTemp, snapshotBytes, { flag: 'wx' }); writeFileSync(registryTemp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' }); renameSync(snapshotTemp, target); snapshotInstalled = true; renameSync(registryTemp, registryPath); snapshotInstalled = false; } finally { rmSync(snapshotTemp, { force: true }); rmSync(registryTemp, { force: true }); if (snapshotInstalled) rmSync(target, { force: true }); }
console.log(`Wrote candidate ${input['--id']} (${entry.changes.counts.total_changes} events); review the new snapshot and registry append together.`);
