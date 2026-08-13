import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUILD_VERSION_INPUTS, digestInputs, generateReleaseIntegrity } from './release-integrity.mjs';
import { discoverFiles, readDiscoveredFile } from './verify-release-integrity.mjs';

const webRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicRoot = resolve(webRoot, 'public');
const managed = ['data', 'api/v1', 'release', 'feeds'];
const epoch = '1786579200';

function build(buildEpoch = epoch, root = webRoot) {
  const env = { ...process.env };
  if (buildEpoch === null) delete env.SOURCE_DATE_EPOCH;
  else env.SOURCE_DATE_EPOCH = buildEpoch;
  const result = spawnSync(process.execPath, ['scripts/build-static-data.mjs'], { cwd: root, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}
function files(root) {
  return readdirSync(root).sort().flatMap((name) => {
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
  cpSync(webRoot, cleanWeb, { recursive: true, filter: (source) => !['node_modules', 'dist', '.astro'].includes(source.split(/[\\/]/).at(-1)) && !source.includes(`${resolve(webRoot, 'public', 'data')}`) && !source.includes(`${resolve(webRoot, 'public', 'api')}`) && !source.includes(`${resolve(webRoot, 'public', 'release')}`) && !source.includes(`${resolve(webRoot, 'public', 'feeds')}`) });
  cpSync(resolve(webRoot, '..', 'hotlines.json'), resolve(cleanCopy, 'hotlines.json'));
  mkdirSync(resolve(cleanCopy, 'docs'));
  cpSync(resolve(webRoot, '..', 'docs/releases.json'), resolve(cleanCopy, 'docs/releases.json'));
  cpSync(resolve(webRoot, '..', 'docs/dataset-releases.json'), resolve(cleanCopy, 'docs/dataset-releases.json'));
  cpSync(resolve(webRoot, '..', 'docs/dataset-release-snapshots'), resolve(cleanCopy, 'docs/dataset-release-snapshots'), { recursive: true });
  for (const absent of ['data', 'api', 'release', 'feeds']) assert.equal(lstatOrNull(resolve(cleanWeb, 'public', absent)), null, `clean fixture unexpectedly contains public/${absent}`);
  build(epoch, cleanWeb);
  for (const created of ['data', 'api/v1', 'release/v1', 'feeds']) assert.ok(lstatSync(resolve(cleanWeb, 'public', created)).isDirectory(), `clean build did not create public/${created}`);
  const candidateArgs = ['run', 'release:dataset:candidate', '--', '--id', 'clean-copy-candidate', '--date', '2026-08-13', '--title', 'Clean copy candidate', '--summary', 'Exercises the public deterministic candidate command in an isolated clean copy.'];
  const candidate = spawnSync('npm', candidateArgs, { cwd: cleanWeb, encoding: 'utf8' });
  assert.equal(candidate.status, 0, `${candidate.stdout}\n${candidate.stderr}`);
  const candidateRegistry = JSON.parse(readFileSync(resolve(cleanCopy, 'docs/dataset-releases.json'), 'utf8'));
  assert.equal(candidateRegistry.releases.at(-1).id, 'clean-copy-candidate');
  assert.ok(lstatSync(resolve(cleanCopy, 'docs/dataset-release-snapshots/clean-copy-candidate.json')).isFile());
  const beforeRefusal = readFileSync(resolve(cleanCopy, 'docs/dataset-releases.json'));
  const refused = spawnSync('npm', candidateArgs, { cwd: cleanWeb, encoding: 'utf8' });
  assert.notEqual(refused.status, 0, 'candidate command silently rewrote historical data');
  assert.deepEqual(readFileSync(resolve(cleanCopy, 'docs/dataset-releases.json')), beforeRefusal, 'failed candidate changed the registry');
  build(epoch, cleanWeb);
  rmSync(resolve(cleanWeb, 'public/api'), { recursive: true });
  mkdirSync(resolve(cleanCopy, 'outside-api')); symlinkSync(resolve(cleanCopy, 'outside-api'), resolve(cleanWeb, 'public/api'));
  assert.throws(() => build(epoch, cleanWeb), /symlink component/, 'managed-root ancestor symlink was accepted');
} finally { rmSync(cleanCopy, { recursive: true, force: true }); }

const scratch = mkdtempSync(resolve(tmpdir(), 'weh-release-inputs-'));
try {
  for (const inputs of Object.values(BUILD_VERSION_INPUTS)) for (const input of inputs) {
    const target = resolve(scratch, input); mkdirSync(dirname(target), { recursive: true }); cpSync(resolve(webRoot, input), target);
  }
  for (const [identity, inputs] of Object.entries(BUILD_VERSION_INPUTS)) {
    const before = digestInputs(inputs, scratch);
    for (const input of inputs) {
      const target = resolve(scratch, input); const original = readFileSync(target);
      writeFileSync(target, Buffer.concat([original, Buffer.from('\nidentity-test')]));
      assert.notEqual(digestInputs(inputs, scratch), before, `${identity} did not change when ${input} changed`);
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
