import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUILD_VERSION_INPUTS, digestInputs, generateReleaseIntegrity } from './release-integrity.mjs';
import { utf16Compare } from './dataset-diff.mjs';
import { discoverFiles, readDiscoveredFile } from './verify-release-integrity.mjs';

const webRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicRoot = resolve(webRoot, 'public');
const managed = ['data', 'api/v1', 'release', 'feeds', 'subscriptions/v1', 'gateway/v1', 'organizations/v1', 'managed-widget-config/v1', 'technical-health/v1', 'assurance-packs/v1', 'provider-claims/v1', 'reviewer-work-queue/v1', 'managed-api-plans/v1', 'deprecation-proposals/v1', 'evidence-backed-coverage/v1'];
const epoch = '1786579200';

function build(buildEpoch = epoch, root = webRoot) {
  const env = { ...process.env };
  if (buildEpoch === null) delete env.SOURCE_DATE_EPOCH;
  else env.SOURCE_DATE_EPOCH = buildEpoch;
  const result = spawnSync(process.execPath, ['scripts/build-static-data.mjs'], { cwd: root, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}
function files(root) {
  return readdirSync(root).sort(utf16Compare).flatMap((name) => {
    const path = resolve(root, name);
    const metadata = lstatSync(path);
    return metadata.isDirectory() ? files(path) : [[relative(publicRoot, path).replaceAll('\\', '/'), readFileSync(path).toString('base64')]];
  });
}
function snapshot() { return managed.flatMap((path) => files(resolve(publicRoot, path))); }

mkdirSync(resolve(publicRoot, 'data/stale/nested'), { recursive: true });
writeFileSync(resolve(publicRoot, 'data/stale-top.txt'), 'stale');
writeFileSync(resolve(publicRoot, 'data/stale/nested/file.bin'), 'stale');
mkdirSync(resolve(publicRoot, 'api/v1/stale/nested'), { recursive: true });
writeFileSync(resolve(publicRoot, 'api/v1/stale-top.json'), '{}');
writeFileSync(resolve(publicRoot, 'api/v1/stale/nested/file.json'), '{}');
mkdirSync(resolve(publicRoot, 'subscriptions/v1/stale/nested'), { recursive: true });
writeFileSync(resolve(publicRoot, 'subscriptions/v1/stale/nested/file.json'), '{}');
build();
const first = snapshot();
assert.ok(!first.some(([path]) => path.includes('stale')), 'first generation retained stale managed files');

mkdirSync(resolve(publicRoot, 'data/another-stale'), { recursive: true });
writeFileSync(resolve(publicRoot, 'data/another-stale/file'), 'stale');
writeFileSync(resolve(publicRoot, 'api/v1/another-stale'), 'stale');
build();
assert.deepEqual(snapshot(), first, 'two pinned clean managed-output generations differ');

const firstReleaseId = JSON.parse(readFileSync(resolve(publicRoot, 'release/v1/release.json'), 'utf8')).release_id;
const firstGeneratedAt = JSON.parse(readFileSync(resolve(publicRoot, 'api/v1/manifest.json'), 'utf8')).generated_at;
const firstDescriptor = JSON.parse(readFileSync(resolve(publicRoot, 'release/v1/release.json'), 'utf8'));
const firstIndex = readFileSync(resolve(publicRoot, 'release/v1/artifacts.json'));
build(String(Number(epoch) + 1));
const changedDescriptor = JSON.parse(readFileSync(resolve(publicRoot, 'release/v1/release.json'), 'utf8'));
assert.notEqual(changedDescriptor.release_id, firstReleaseId, 'changed generated artifact bytes did not change release identity');
assert.notEqual(JSON.parse(readFileSync(resolve(publicRoot, 'api/v1/manifest.json'), 'utf8')).generated_at, firstGeneratedAt, 'wall-clock fixture did not exercise distinct timestamps');
assert.notDeepEqual(readFileSync(resolve(publicRoot, 'release/v1/artifacts.json')), firstIndex, 'changed timestamp did not change artifact index bytes');
assert.notEqual(changedDescriptor.artifact_index.sha256, firstDescriptor.artifact_index.sha256, 'changed artifact index did not change its digest');
assert.equal(changedDescriptor.dataset_version, firstDescriptor.dataset_version, 'timestamp changed dataset identity');
assert.deepEqual(changedDescriptor.build_versions, firstDescriptor.build_versions, 'timestamp changed finite-source build identities');
build();

const cleanCopy = mkdtempSync(resolve(tmpdir(), 'weh-clean-copy-'));
try {
  const cleanWeb = resolve(cleanCopy, 'web');
  cpSync(resolve(webRoot, '..', 'gateway'), resolve(cleanCopy, 'gateway'), { recursive: true });
  cpSync(resolve(webRoot, '..', 'managed-widget-config'), resolve(cleanCopy, 'managed-widget-config'), { recursive: true });
  cpSync(resolve(webRoot, '..', 'control-plane'), resolve(cleanCopy, 'control-plane'), { recursive: true });
  cpSync(resolve(webRoot, '..', 'technical-health'), resolve(cleanCopy, 'technical-health'), { recursive: true });
  cpSync(resolve(webRoot, '..', 'assurance-packs'), resolve(cleanCopy, 'assurance-packs'), { recursive: true });
  cpSync(resolve(webRoot, '..', 'provider-claims'), resolve(cleanCopy, 'provider-claims'), { recursive: true });
  cpSync(resolve(webRoot, '..', 'reviewer-work-queue'), resolve(cleanCopy, 'reviewer-work-queue'), { recursive: true });
  cpSync(resolve(webRoot, '..', 'managed-api-plans'), resolve(cleanCopy, 'managed-api-plans'), { recursive: true });
  cpSync(resolve(webRoot, '..', 'deprecation-proposals'), resolve(cleanCopy, 'deprecation-proposals'), { recursive: true });
  cpSync(resolve(webRoot, '..', 'evidence-backed-coverage'), resolve(cleanCopy, 'evidence-backed-coverage'), { recursive: true });
  cpSync(resolve(webRoot, '..', 'Caddyfile'), resolve(cleanCopy, 'Caddyfile'));
  const managedRoots = managed.map((entry) => resolve(publicRoot, entry));
  cpSync(webRoot, cleanWeb, { recursive: true, filter: (source) => !['node_modules', 'dist', '.astro'].includes(source.split(/[\\/]/).at(-1)) && !managedRoots.some((root) => source === root || source.startsWith(`${root}${sep}`)) });
  cpSync(resolve(webRoot, '..', 'hotlines.json'), resolve(cleanCopy, 'hotlines.json'));
  mkdirSync(resolve(cleanCopy, 'docs'));
  cpSync(resolve(webRoot, '..', 'docs/releases.json'), resolve(cleanCopy, 'docs/releases.json'));
  cpSync(resolve(webRoot, '..', 'docs/dataset-releases.json'), resolve(cleanCopy, 'docs/dataset-releases.json'));
  cpSync(resolve(webRoot, '..', 'docs/dataset-release-snapshots'), resolve(cleanCopy, 'docs/dataset-release-snapshots'), { recursive: true });
  const fixtureDatasetPath = resolve(cleanCopy, 'hotlines.json');
  const mutateDataset = (token) => { const data = JSON.parse(readFileSync(fixtureDatasetPath)); data.countries[0].notes = `deterministic fixture ${token}`; writeFileSync(fixtureDatasetPath, `${JSON.stringify(data, null, 2)}\n`); };
  const candidate = (id, interrupt) => spawnSync('npm', ['run', 'release:dataset:candidate', '--', '--id', id, '--date', '2026-08-13', '--title', `Candidate ${id}`, '--summary', 'Exercises the recoverable deterministic candidate command in an isolated clean copy.'], { cwd: cleanWeb, encoding: 'utf8', env: { ...process.env, ...(interrupt ? { WEH_CANDIDATE_INTERRUPT: interrupt } : {}) } });
  for (const absent of managed) assert.equal(lstatOrNull(resolve(cleanWeb, 'public', absent)), null, `clean fixture unexpectedly contains public/${absent}`);
  build(epoch, cleanWeb);
  const offlineIdentity = digestInputs(BUILD_VERSION_INPUTS.offline_shell, cleanWeb);
  for (const [label, copiedSource] of [
    ['PWA generator', resolve(cleanWeb, 'scripts/generate-pwa-assets.mjs')],
    ['base layout registration/status', resolve(cleanWeb, 'src/layouts/Base.astro')],
    ['Caddy PWA policy', resolve(cleanCopy, 'Caddyfile')],
  ]) {
    const copiedSourceBytes = readFileSync(copiedSource);
    writeFileSync(copiedSource, Buffer.concat([copiedSourceBytes, Buffer.from('\n# isolated offline identity mutation\n')]));
    assert.notEqual(digestInputs(BUILD_VERSION_INPUTS.offline_shell, cleanWeb), offlineIdentity, `${label} change did not change offline shell identity`);
    writeFileSync(copiedSource, copiedSourceBytes);
    assert.equal(digestInputs(BUILD_VERSION_INPUTS.offline_shell, cleanWeb), offlineIdentity, `restored ${label} did not reproduce offline shell identity`);
  }
  for (const created of ['data', 'api/v1', 'release/v1', 'feeds', 'subscriptions/v1', 'organizations/v1', 'managed-widget-config/v1', 'technical-health/v1', 'assurance-packs/v1', 'provider-claims/v1', 'reviewer-work-queue/v1', 'managed-api-plans/v1', 'deprecation-proposals/v1', 'evidence-backed-coverage/v1']) assert.ok(lstatSync(resolve(cleanWeb, 'public', created)).isDirectory(), `clean build did not create public/${created}`);
  const beforeSourceMutations = JSON.parse(readFileSync(resolve(cleanWeb, 'public/release/v1/release.json'), 'utf8'));
  const beforeApiRecords = readFileSync(resolve(cleanWeb, 'public/api/v1/records.json'));
  const beforeManagedPlanArtifacts = files(resolve(cleanWeb, 'public/managed-api-plans/v1'));
  for (const [label, copiedSource] of [
    ['API records transform', resolve(cleanWeb, 'scripts/api-records-transform.mjs')],
    ['control-plane model', resolve(cleanCopy, 'control-plane/model.mjs')],
    ['managed API plan generator', resolve(cleanWeb, 'scripts/generate-managed-api-plan-contracts.mjs')],
    ['managed API plan model', resolve(cleanCopy, 'managed-api-plans/model.mjs')],
  ]) {
    const copiedSourceBytes = readFileSync(copiedSource);
    writeFileSync(copiedSource, Buffer.concat([copiedSourceBytes, Buffer.from('\n// isolated release identity mutation\n')]));
    build(epoch, cleanWeb);
    const afterSourceMutation = JSON.parse(readFileSync(resolve(cleanWeb, 'public/release/v1/release.json'), 'utf8'));
    assert.deepEqual(readFileSync(resolve(cleanWeb, 'public/api/v1/records.json')), beforeApiRecords, `${label} mutation unexpectedly changed generated API record bytes`);
    assert.deepEqual(files(resolve(cleanWeb, 'public/managed-api-plans/v1')), beforeManagedPlanArtifacts, `${label} mutation unexpectedly changed managed API plan artifact bytes`);
    assert.notEqual(afterSourceMutation.build_versions.integration_generator, beforeSourceMutations.build_versions.integration_generator, `${label} change did not change integration generator identity`);
    assert.notEqual(afterSourceMutation.release_id, beforeSourceMutations.release_id, `${label} change did not change release identity`);
    writeFileSync(copiedSource, copiedSourceBytes); build(epoch, cleanWeb);
    assert.deepEqual(JSON.parse(readFileSync(resolve(cleanWeb, 'public/release/v1/release.json'), 'utf8')), beforeSourceMutations, `restored ${label} did not reproduce the original release descriptor`);
  }
  const snapshotRoot = resolve(cleanCopy, 'docs/dataset-release-snapshots'); const outside = resolve(cleanCopy, 'outside'); mkdirSync(outside); const sentinel = resolve(outside, 'sentinel'); writeFileSync(sentinel, 'outside-safe');
  const savedSnapshots = resolve(cleanCopy, 'saved-snapshots'); renameSync(snapshotRoot, savedSnapshots); symlinkSync(outside, snapshotRoot);
  assert.notEqual(candidate('symlink-root').status, 0, 'symlinked snapshot root was accepted'); assert.equal(readFileSync(sentinel, 'utf8'), 'outside-safe'); rmSync(snapshotRoot); renameSync(savedSnapshots, snapshotRoot);
  const docsRoot = resolve(cleanCopy, 'docs'); const savedDocs = resolve(cleanCopy, 'saved-docs'); renameSync(docsRoot, savedDocs); symlinkSync(outside, docsRoot);
  assert.notEqual(candidate('symlink-ancestor').status, 0, 'symlinked docs ancestor was accepted'); assert.equal(readFileSync(sentinel, 'utf8'), 'outside-safe'); rmSync(docsRoot); renameSync(savedDocs, docsRoot);
  mutateDataset('first');
  const targetLink = resolve(snapshotRoot, 'clean-copy-candidate.json'); symlinkSync(sentinel, targetLink);
  assert.notEqual(candidate('clean-copy-candidate').status, 0, 'symlinked candidate target was accepted'); assert.equal(readFileSync(sentinel, 'utf8'), 'outside-safe'); rmSync(targetLink);
  const transactionRoot = resolve(docsRoot, '.dataset-release-transaction'); mkdirSync(transactionRoot); symlinkSync(sentinel, resolve(transactionRoot, 'snapshot.json'));
  assert.notEqual(candidate('clean-copy-candidate').status, 0, 'symlinked staged temp was accepted'); assert.equal(readFileSync(sentinel, 'utf8'), 'outside-safe'); rmSync(transactionRoot, { recursive: true });
  const firstCandidate = candidate('clean-copy-candidate');
  assert.equal(firstCandidate.status, 0, `${firstCandidate.stdout}\n${firstCandidate.stderr}`);
  const candidateRegistry = JSON.parse(readFileSync(resolve(cleanCopy, 'docs/dataset-releases.json'), 'utf8'));
  assert.equal(candidateRegistry.releases.at(-1).id, 'clean-copy-candidate');
  assert.ok(lstatSync(resolve(cleanCopy, 'docs/dataset-release-snapshots/clean-copy-candidate.json')).isFile());
  const beforeRefusal = readFileSync(resolve(cleanCopy, 'docs/dataset-releases.json'));
  assert.notEqual(candidate('clean-copy-candidate').status, 0, 'duplicate ID silently rewrote historical data');
  assert.notEqual(candidate('unchanged-dataset').status, 0, 'unchanged canonical dataset was accepted');
  assert.deepEqual(readFileSync(resolve(cleanCopy, 'docs/dataset-releases.json')), beforeRefusal, 'failed candidate changed the registry');
  mutateDataset('interrupt-before'); const beforeInterrupt = candidate('interrupt-before', 'before-snapshot-install'); assert.notEqual(beforeInterrupt.status, 0); assert.ok(lstatSync(transactionRoot).isDirectory());
  const recoveredBefore = candidate('interrupt-before'); assert.equal(recoveredBefore.status, 0, `${recoveredBefore.stdout}\n${recoveredBefore.stderr}`); assert.equal(lstatOrNull(transactionRoot), null);
  mutateDataset('interrupt-after'); const afterInterrupt = candidate('interrupt-after', 'after-snapshot-install'); assert.notEqual(afterInterrupt.status, 0); assert.ok(lstatSync(resolve(snapshotRoot, 'interrupt-after.json')).isFile());
  const recoveredAfter = candidate('interrupt-after'); assert.equal(recoveredAfter.status, 0, `${recoveredAfter.stdout}\n${recoveredAfter.stderr}`); assert.equal(lstatOrNull(transactionRoot), null);
  mutateDataset('interrupt-registry'); const registryInterrupt = candidate('interrupt-registry', 'after-registry-install'); assert.notEqual(registryInterrupt.status, 0); assert.ok(lstatSync(transactionRoot).isDirectory());
  const installedRegistry = readFileSync(resolve(docsRoot, 'dataset-releases.json')); const recoveredRegistry = candidate('interrupt-registry'); assert.notEqual(recoveredRegistry.status, 0, 'recovered installed registry should then reject its duplicate ID'); assert.equal(lstatOrNull(transactionRoot), null); assert.deepEqual(readFileSync(resolve(docsRoot, 'dataset-releases.json')), installedRegistry);
  rmSync(resolve(cleanWeb, 'public/api'), { recursive: true });
  mkdirSync(resolve(cleanCopy, 'outside-api')); symlinkSync(resolve(cleanCopy, 'outside-api'), resolve(cleanWeb, 'public/api'));
  assert.throws(() => build(epoch, cleanWeb), /symlink component/, 'managed-root ancestor symlink was accepted');
  rmSync(resolve(cleanWeb, 'public/api'));
  rmSync(resolve(cleanWeb, 'public/subscriptions'), { recursive: true });
  mkdirSync(resolve(cleanCopy, 'outside-subscriptions')); symlinkSync(resolve(cleanCopy, 'outside-subscriptions'), resolve(cleanWeb, 'public/subscriptions'));
  assert.throws(() => build(epoch, cleanWeb), /symlink component/, 'subscription managed-root ancestor symlink was accepted');
} finally { rmSync(cleanCopy, { recursive: true, force: true }); }

const scratch = mkdtempSync(resolve(tmpdir(), 'weh-release-inputs-'));
try {
  const scratchWeb = resolve(scratch, 'web'); mkdirSync(scratchWeb);
  for (const inputs of Object.values(BUILD_VERSION_INPUTS)) for (const input of inputs) {
    const repoInput = input.startsWith('repo:'); const rel = repoInput ? input.slice('repo:'.length) : input;
    const target = resolve(repoInput ? scratch : scratchWeb, rel); mkdirSync(dirname(target), { recursive: true }); cpSync(resolve(repoInput ? resolve(webRoot, '..') : webRoot, rel), target);
  }
  for (const [identity, inputs] of Object.entries(BUILD_VERSION_INPUTS)) {
    const before = digestInputs(inputs, scratchWeb);
    for (const input of inputs) {
      const repoInput = input.startsWith('repo:'); const target = resolve(repoInput ? scratch : scratchWeb, repoInput ? input.slice('repo:'.length) : input); const original = readFileSync(target);
      writeFileSync(target, Buffer.concat([original, Buffer.from('\nidentity-test')]));
      assert.notEqual(digestInputs(inputs, scratchWeb), before, `${identity} did not change when ${input} changed`);
      writeFileSync(target, original);
    }
  }

  const outsideFile = resolve(scratch, 'outside-file'); writeFileSync(outsideFile, 'outside');
  const outsideDir = resolve(scratch, 'outside-dir'); mkdirSync(outsideDir); writeFileSync(resolve(outsideDir, 'file'), 'outside');
  symlinkSync(outsideFile, resolve(publicRoot, 'data/file-link'));
  assert.throws(() => generateReleaseIntegrity({ datasetVersion: 'sha256:test' }), /symlink/);
  rmSync(resolve(publicRoot, 'data/file-link'));
  symlinkSync(outsideDir, resolve(publicRoot, 'data/directory-link'));
  assert.throws(() => generateReleaseIntegrity({ datasetVersion: 'sha256:test' }), /symlink/);
  rmSync(resolve(publicRoot, 'data/directory-link'));

  const verifyRoot = resolve(scratch, 'verify-root'); mkdirSync(resolve(verifyRoot, 'nested'), { recursive: true });
  const verifiedPath = resolve(verifyRoot, 'nested/file'); writeFileSync(verifiedPath, 'first');
  const discovered = discoverFiles(verifyRoot)[0];
  renameSync(verifiedPath, resolve(verifyRoot, 'nested/original')); writeFileSync(verifiedPath, 'replacement');
  assert.throws(() => readDiscoveredFile(discovered), /changed during verification/);
  rmSync(verifiedPath); symlinkSync(resolve(verifyRoot, 'nested/original'), verifiedPath);
  assert.throws(() => readDiscoveredFile({ path: verifiedPath, metadata: lstatSync(resolve(verifyRoot, 'nested/original')) }));
  const linkedAncestor = resolve(scratch, 'linked-ancestor'); symlinkSync(resolve(verifyRoot, 'nested'), linkedAncestor);
  assert.throws(() => discoverFiles(scratch), /symlink/);
} finally {
  rmSync(scratch, { recursive: true, force: true });
  build();
}

console.log('Release reproducibility OK: clean checkout builds, pinned bytes repeat, timestamp byte changes alter index/release identity, finite inputs affect identity, replacements and symlinks rejected');

function lstatOrNull(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
