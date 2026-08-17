import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import { assertInternalNonpublication, forbiddenInternalEvidence } from './verify-internal-nonpublication.mjs';
import { expectedSchema, INDEX_PATH, INTERNAL_MARKER, loadIndex, REQUIRED_INTERNAL_CONTROL_PATHS, SCHEMA_PATH, validateIndex, validateSchemaSpecification } from './technical-due-diligence-lib.mjs';
import { parseStrictJson, sourceMap } from './security-privacy-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const committed = parseStrictJson(readFileSync(resolve(repo, INDEX_PATH)));
const clone = () => structuredClone(committed);
const roots = [];
const temporaryRoot = (prefix) => { const root = mkdtempSync(resolve(tmpdir(), prefix)); roots.push(root); return root; };
const trackedCopy = () => {
  const root = temporaryRoot('weh-dd-copy-');
  for (const path of [...Object.keys(committed.sources), INDEX_PATH, SCHEMA_PATH]) { mkdirSync(resolve(root, path, '..'), { recursive: true }); copyFileSync(resolve(repo, path), resolve(root, path)); }
  writeFileSync(resolve(root, 'whole-index-sentinel'), 'before\n');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '--', '.']);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('tracked index and schema load together and satisfy exact schema/specification plus runtime invariants', () => { const root = trackedCopy(); assert.doesNotThrow(() => loadIndex(root)); assert.doesNotThrow(() => validateSchemaSpecification(root)); });
test('Ajv 2020 accepts the index and rejects schema-expressible tuple, property-name, and closed-object violations', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(expectedSchema());
  assert.equal(validate(clone()), true);
  const reordered = clone(); reordered.domains.reverse(); assert.equal(validate(reordered), false);
  const extraDomain = clone(); extraDomain.domains.push(structuredClone(extraDomain.domains[0])); assert.equal(validate(extraDomain), false);
  const unsafeSource = clone(); unsafeSource.sources['../escape'] = `sha256:${'0'.repeat(64)}`; assert.equal(validate(unsafeSource), false);
  const openArtifact = clone(); openArtifact.domains[0].artifacts[0].extra = true; assert.equal(validate(openArtifact), false);
});
test('Ajv 2020 accepts ordinary safe paths and rejects dot or empty segments in source property names and artifact paths', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(expectedSchema());
  assert.equal(validate(clone()), true, 'ordinary repository paths must remain accepted');
  for (const [target, path] of ['foo/.', 'foo/..', 'foo/', 'foo//bar'].flatMap((path) => [['source', path], ['artifact', path]])) {
    const candidate = clone();
    if (target === 'source') candidate.sources[path] = `sha256:${'0'.repeat(64)}`;
    else candidate.domains[0].artifacts[0].path = path;
    assert.equal(validate(candidate), false, `${target} path ${path} must be rejected`);
  }
});
test('strict JSON rejects duplicate members and malformed UTF-8', () => {
  assert.throws(() => parseStrictJson('{"schema_version":"1.0","schema_version":"2.0"}', INDEX_PATH), /duplicate member/);
  assert.throws(() => parseStrictJson(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), INDEX_PATH), /malformed UTF-8/);
});
test('closed runtime schema rejects unexpected fields, domains, statuses, missing gaps, and unsupported assurance language', () => {
  const options = { testOnlySkipGitIndex: true };
  const unexpected = clone(); unexpected.extra = true; assert.throws(() => validateIndex(unexpected, repo, options), /fields changed/);
  const domain = clone(); domain.domains[0].id = 'operations'; assert.throws(() => validateIndex(domain, repo, options), /domain inventory/);
  const status = clone(); status.domains[0].artifacts[0].review_status = 'certified'; assert.throws(() => validateIndex(status, repo, options), /unknown status/);
  const gaps = clone(); for (const d of gaps.domains) for (const a of d.artifacts) a.review_status = 'verified_static'; assert.throws(() => validateIndex(gaps, repo, options), /retain conservative/);
});
test('proves_narrowly rejects every prohibited assurance category and accepts bounded factual wording', () => {
  const options = { testOnlySkipGitIndex: true };
  const prohibited = [
    ['certification/certify', ['This artifact is a certification of the documented process.', 'This artifact will certify the documented process.', 'This artifact certifies the documented process.', 'This artifact certified the documented process.', 'This artifact is certifying the documented process.']],
    ['conformance/conformant', ['This artifact records conformance with the documented process.', 'This artifact is conformant with the documented process.', 'This artifact will conform to the documented process.', 'This artifact conforms to the documented process.', 'This artifact conformed to the documented process.', 'This artifact is conforming to the documented process.']],
    ['compliance/comply/complies/compliant', ['This artifact establishes GDPR compliance for the documented process.', 'This artifact declares the release compliant with the documented process.', 'This artifact will comply with GDPR.', 'This artifact complies with GDPR.', 'This artifact complied with GDPR.', 'This artifact is complying with GDPR.']],
    ['security assessment/security assessed', ['This artifact is a security assessment of the documented process.', 'This artifact records two security assessments of the documented process.', 'This artifact proves the documented process was security assessed.']],
    ['audited/audit opinion', ['This artifact records an audit opinion about the documented release process.', 'This artifact proves the documented release process was audited.']],
    ['legal advice/legal opinion', ['This artifact is legal advice about the documented process.', 'This artifact is a legal opinion about the documented process.']],
    ['assurance/assured', ['This artifact provides assurance about the documented process.', 'This artifact declares the documented process assured.', 'This artifact assures users about the documented process.', 'This artifact will assure users about the documented process.', 'This artifact is assuring users about the documented process.']],
    ['guarantee', ['This artifact guarantees the documented release process will always succeed.', 'This artifact is guaranteeing the documented release process will always succeed.']],
    ['uptime', ['This artifact establishes uptime for the documented service.']],
    ['availability/available', ['This artifact establishes availability of the documented service.', 'This artifact proves the documented service is available to every user.']],
    ['sales artifact/sales-ready', ['This artifact is a sales artifact for the documented release.', 'These are sales artifacts for the documented release.', 'This artifact proves the documented release is sales-ready for every user.']],
    ['production-ready', ['This artifact proves the documented release is production-ready for every user.']],
  ];
  for (const [category, wordings] of prohibited) {
    for (const wording of wordings) {
      const candidate = clone(); candidate.domains[0].artifacts[0].proves_narrowly = wording;
      assert.throws(() => validateIndex(candidate, repo, options), /unsupported assurance language/, `${category}: ${wording}`);
    }
  }
  const accepted = [
    'Records the bound release artifact available for download from the repository fixture.',
    'Records an artifact assessed for finite formatting defects by a repository test.',
    'Records secure cookie syntax as a static source fact without making a security claim.',
    'Records the finite static checks executed by the repository verifier without an operational claim.',
  ];
  for (const wording of accepted) {
    const candidate = clone(); candidate.domains[0].artifacts[0].proves_narrowly = wording;
    assert.doesNotThrow(() => validateIndex(candidate, repo, options), wording);
  }
});
test('source inventory rejects missing, unexpected, duplicate, traversal, and changed source bytes', () => {
  const options = { testOnlySkipGitIndex: true };
  const missing = clone(); delete missing.sources['docs/releases.json']; assert.throws(() => validateIndex(missing, repo, options), /unbound artifact|exact tracked|complete/);
  const unexpected = clone(); unexpected.sources['README.md'] = `sha256:${'0'.repeat(64)}`; assert.throws(() => validateIndex(unexpected, repo, options), /source paths must be sorted|changed/);
  const duplicate = clone(); duplicate.domains[1].artifacts.push(structuredClone(duplicate.domains[0].artifacts[0])); assert.throws(() => validateIndex(duplicate, repo, options), /duplicate artifact/);
  const traversal = clone(); traversal.domains[0].artifacts[0].path = '../docs/releases.json'; assert.throws(() => validateIndex(traversal, repo, options), /non-canonical/);
  const changed = clone(); changed.sources['docs/releases.json'] = `sha256:${'0'.repeat(64)}`; assert.throws(() => validateIndex(changed, repo, options), /exact tracked evidence source bytes changed/);
});
test('finite internal control inventory rejects synchronized removal of every required source and artifact', () => {
  const options = { testOnlySkipGitIndex: true };
  for (const path of REQUIRED_INTERNAL_CONTROL_PATHS) {
    const candidate = clone();
    delete candidate.sources[path];
    const controls = candidate.domains.find(({ id }) => id === 'internal_control_integrity').artifacts;
    controls.splice(controls.findIndex((artifact) => artifact.path === path), 1);
    assert.throws(() => validateIndex(candidate, repo, options), /finite required path inventory/, path);
  }
});
test('finite internal control inventory rejects substitution, addition, and reordering independent of exact source coverage', () => {
  const options = { testOnlySkipGitIndex: true };
  const internal = (candidate) => candidate.domains.find(({ id }) => id === 'internal_control_integrity').artifacts;
  const release = (candidate) => candidate.domains.find(({ id }) => id === 'release_integrity').artifacts;

  const substituted = clone();
  [internal(substituted)[0], release(substituted)[0]] = [release(substituted)[0], internal(substituted)[0]];
  assert.throws(() => validateIndex(substituted, repo, options), /finite required path inventory/);

  const added = clone();
  internal(added).push(release(added).shift());
  assert.throws(() => validateIndex(added, repo, options), /finite required path inventory/);

  const reordered = clone();
  [internal(reordered)[0], internal(reordered)[1]] = [internal(reordered)[1], internal(reordered)[0]];
  assert.throws(() => validateIndex(reordered, repo, options), /finite required path inventory/);
});
test('tracked reader rejects worktree/index drift and symlinked sources', () => {
  const drift = temporaryRoot('weh-dd-drift-'); writeFileSync(resolve(drift, 'source.txt'), 'indexed\n'); execFileSync('git', ['init', '-q', drift]); execFileSync('git', ['-C', drift, 'add', '--', 'source.txt']); writeFileSync(resolve(drift, 'source.txt'), 'working\n'); assert.throws(() => sourceMap(drift, ['source.txt']), /working-tree evidence bytes differ from Git index/);
  const linked = temporaryRoot('weh-dd-link-'); writeFileSync(resolve(linked, 'target.txt'), 'target\n'); symlinkSync('target.txt', resolve(linked, 'source.txt')); execFileSync('git', ['init', '-q', linked]); execFileSync('git', ['-C', linked, 'add', '--', 'source.txt', 'target.txt']); assert.throws(() => sourceMap(linked, ['source.txt']), /symlinked evidence path/);
});
test('tracked reader rejects pathname replacement and whole-index mutation during a read', () => {
  const root = temporaryRoot('weh-dd-race-'); writeFileSync(resolve(root, 'source.txt'), 'source\n'); writeFileSync(resolve(root, 'other.txt'), 'before\n'); execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '--', 'source.txt', 'other.txt']); let replaced = false;
  assert.throws(() => sourceMap(root, ['source.txt'], { afterRead: ({ absolutePath }) => { if (replaced) return; replaced = true; const replacement = resolve(root, 'replacement.txt'); writeFileSync(replacement, 'source\n'); renameSync(replacement, absolutePath); } }), /changed during read/);
  writeFileSync(resolve(root, 'source.txt'), 'source\n'); execFileSync('git', ['-C', root, 'add', '--', 'source.txt']); let staged = false;
  assert.throws(() => sourceMap(root, ['source.txt'], { afterRead: () => { if (staged) return; staged = true; writeFileSync(resolve(root, 'other.txt'), 'after\n'); execFileSync('git', ['-C', root, 'add', '--', 'other.txt']); } }), /Git index changed during evidence operation/);
});
test('complete load rejects index/schema drift, symlinks, path replacement, and whole-index mutation', () => {
  const drift = trackedCopy(); writeFileSync(resolve(drift, INDEX_PATH), `${readFileSync(resolve(drift, INDEX_PATH), 'utf8')} `); assert.throws(() => loadIndex(drift), /working-tree evidence bytes differ from Git index/);
  const linked = trackedCopy(); const schemaTarget = resolve(linked, `${SCHEMA_PATH}.target`); renameSync(resolve(linked, SCHEMA_PATH), schemaTarget); symlinkSync('index.schema.json.target', resolve(linked, SCHEMA_PATH)); assert.throws(() => loadIndex(linked), /symlinked evidence path/);
  const replaced = trackedCopy(); let didReplace = false; assert.throws(() => loadIndex(replaced, { afterRead: ({ path, absolutePath }) => { if (didReplace || path !== INDEX_PATH) return; didReplace = true; const replacement = `${absolutePath}.replacement`; writeFileSync(replacement, readFileSync(absolutePath)); renameSync(replacement, absolutePath); } }), /changed during read/);
  const mutated = trackedCopy(); let didMutate = false; assert.throws(() => loadIndex(mutated, { afterRead: ({ path }) => { if (didMutate || path !== SCHEMA_PATH) return; didMutate = true; const other = resolve(mutated, 'whole-index-sentinel'); writeFileSync(other, 'after\n'); execFileSync('git', ['-C', mutated, 'add', '--', 'whole-index-sentinel']); } }), /Git index changed during evidence operation/);
});
test('nonpublication rejects marker and exact renamed copies', () => {
  const forbidden = forbiddenInternalEvidence(repo); assert.ok(forbidden.markers.includes(INTERNAL_MARKER));
  const dist = temporaryRoot('weh-dd-dist-'); mkdirSync(resolve(dist, 'nested')); writeFileSync(resolve(dist, 'nested/renamed.txt'), readFileSync(resolve(repo, INDEX_PATH))); assert.throws(() => assertInternalNonpublication(dist, repo), /internal review-pack marker|exact copy/);
  writeFileSync(resolve(dist, 'nested/renamed.txt'), `prefix ${INTERNAL_MARKER} suffix`); assert.throws(() => assertInternalNonpublication(dist, repo), /internal review-pack marker/);
});
