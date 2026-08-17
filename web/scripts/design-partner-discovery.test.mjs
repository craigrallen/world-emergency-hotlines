import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import { assertInternalNonpublication, forbiddenInternalEvidence } from './verify-internal-nonpublication.mjs';
import { evaluateSyntheticDemandEvidence, expectedOutcome, INTERNAL_MARKER, loadPack, packAuthorizationOutcome, PACK_PATH, SCHEMA_PATH, SOURCE_PATHS, validatePack } from './design-partner-discovery-lib.mjs';
import { parseStrictJson } from './security-privacy-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const committed = parseStrictJson(readFileSync(resolve(repo, PACK_PATH)), PACK_PATH);
const schema = parseStrictJson(readFileSync(resolve(repo, SCHEMA_PATH)), SCHEMA_PATH);
const clone = () => structuredClone(committed);
const roots = [];
const temporaryRoot = (prefix) => { const root = mkdtempSync(resolve(tmpdir(), prefix)); roots.push(root); return root; };
const trackedCopy = () => { const root = temporaryRoot('weh-design-partner-'); for (const path of [...SOURCE_PATHS, PACK_PATH, SCHEMA_PATH]) { mkdirSync(resolve(root, path, '..'), { recursive: true }); copyFileSync(resolve(repo, path), resolve(root, path)); } execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '--', '.']); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('tracked pack satisfies the closed Draft 2020-12 schema and runtime invariants', () => assert.doesNotThrow(() => loadPack(trackedCopy())));
test('strict JSON rejects duplicate members and malformed UTF-8', () => {
  assert.throws(() => parseStrictJson('{"schema_version":"1.0","schema_version":"2.0"}', PACK_PATH), /duplicate member/);
  assert.throws(() => parseStrictJson(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), PACK_PATH), /malformed UTF-8/);
});
test('schema rejects unknown fields, unsafe paths, unknown outcomes, and mutable fixture prose', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  for (const mutate of [
    (p) => { p.extra = true; }, (p) => { p.sources['../escape'] = `sha256:${'0'.repeat(64)}`; },
    (p) => { p.decision_rubric.rules[0].outcome = 'maybe'; }, (p) => { p.example_records[0].outcome = 'continue'; },
    (p) => { p.example_records[0].real_contact = 'person@example.invalid'; }, (p) => { p.example_records[0].rationale = 'Interview with Real Org at person@example.com https://example.com +1 202 555 0100 about an active crisis.'; },
  ]) { const candidate = clone(); mutate(candidate); assert.equal(validate(candidate), false); }
});
test('runtime rejects every semantic substitution, reordering, evidence reassignment, and source drift', () => {
  const options = { testOnlySkipGitIndex: true };
  const boundary = clone(); boundary.boundaries[0] = 'Outreach is permitted for this preparation artifact.'; assert.throws(() => validatePack(boundary, repo, options), /authoritative boundaries changed/);
  const reversed = clone(); reversed.boundaries[0] = 'No outreach is not prohibited.'; assert.throws(() => validatePack(reversed, repo, options), /authoritative boundaries changed/);
  const missing = clone(); delete missing.sources[SOURCE_PATHS[0]]; assert.throws(() => validatePack(missing, repo, options), /source inventory/);
  const drift = clone(); drift.sources[SOURCE_PATHS[0]] = `sha256:${'0'.repeat(64)}`; assert.throws(() => validatePack(drift, repo, options), /exact tracked evidence source bytes changed/);
  const assurance = clone(); assurance.capability_matrix[0].limitations = 'This production-ready integration guarantees uptime.'; assert.throws(() => validatePack(assurance, repo, options), /capability matrix/);
  const reassigned = clone(); reassigned.capability_matrix[0].evidence.reverse(); assert.throws(() => validatePack(reassigned, repo, options), /capability matrix/);
  const reordered = clone(); reordered.discovery_questions.reverse(); assert.throws(() => validatePack(reordered, repo, options), /discovery questions/);
});
test('demand gate is exact and the checked-in fixture cannot self-report its way to continue', () => {
  const options = { testOnlySkipGitIndex: true };
  for (const mutate of [(p) => { p.demand_gate.minimum_distinct_credible_organizations = 2; }, (p) => { p.demand_gate.general_enthusiasm_counts = true; }, (p) => { p.demand_gate.current_pack_evidence_mechanism = 'authorized'; }, (p) => { p.example_records[0].matching_credible_organization_count = 3; }]) { const candidate = clone(); mutate(candidate); assert.throws(() => validatePack(candidate, repo, options)); }
});
test('derived outcome covers every documented stop predicate and fails closed despite caller-supplied proven flags', () => {
  const base = { ...committed.example_records[0] };
  for (const [key, value] of [['boundary_status', 'fail'], ['real_data_status', 'present'], ['evidence_consistency', 'contradictory'], ['reuse_permission_status', 'assumed']]) assert.equal(expectedOutcome({ ...base, [key]: value }), 'stop', key);
  const proven = { ...base, required_evidence_status: 'complete', future_evidence_mechanism: 'authorized', distinctness_status: 'proven', credibility_status: 'proven', independence_status: 'proven', same_capability_status: 'proven', operational_request_status: 'proven', non_enthusiasm_status: 'proven' };
  assert.equal(expectedOutcome(proven), 'hold', 'untrusted status flags cannot substitute for unavailable evidence');
  for (const [key, value] of [['required_evidence_status', 'incomplete'], ['future_evidence_mechanism', 'unavailable'], ['distinctness_status', 'unestablished'], ['credibility_status', 'unestablished'], ['independence_status', 'unestablished'], ['same_capability_status', 'unestablished'], ['operational_request_status', 'unestablished'], ['non_enthusiasm_status', 'unestablished']]) assert.equal(expectedOutcome({ ...proven, [key]: value }), 'hold', key);
});
test('licensing distinguishes pre-pilot hold from immediate stop after activity starts', () => {
  const base = { ...committed.example_records[0], reuse_permission_status: 'unresolved' };
  assert.equal(packAuthorizationOutcome({ ...base, activity_status: 'not_started' }), 'hold');
  assert.equal(packAuthorizationOutcome({ ...base, activity_status: 'started' }), 'stop');
  const brief = readFileSync(resolve(repo, 'docs/DESIGN_PARTNER_PILOT.md'), 'utf8');
  assert.match(brief, /Before any pilot starts, unresolved reuse permission is a hold: do not start\./);
  assert.match(brief, /already started.*stop it immediately/);
  assert.match(brief, /repository has no license/);
});
const syntheticEvidence = (n, overrides = {}) => ({
  fixture_kind: 'conspicuously_synthetic_in_memory_demand_evidence', organization_evidence_id: `synthetic_organization_${n}`,
  request_evidence_id: `synthetic_request_${n}`, capability_id: 'synthetic_capability_bounded_snapshot_handoff',
  credible_organization: true, independent_request: true, request_provenance: 'independent_synthetic_request',
  operational_request: true, enthusiasm_only: false, ...overrides,
});
test('pure closed evaluator derives a continuation from three qualifying synthetic organizations', () => {
  const result = evaluateSyntheticDemandEvidence([1, 2, 3].map(syntheticEvidence));
  assert.deepEqual(result, { outcome: 'continue', capability_id: 'synthetic_capability_bounded_snapshot_handoff', qualifying_organization_count: 3 });
  assert.equal(packAuthorizationOutcome(committed.example_records[0], result), 'hold', 'pack guard cannot authorize action');
});
test('pure evaluator holds every adversarial evidence class', () => {
  const valid = [1, 2, 3].map(syntheticEvidence);
  const cases = [
    valid.slice(0, 2), [valid[0], syntheticEvidence(2, { organization_evidence_id: valid[0].organization_evidence_id }), valid[2]],
    [valid[0], syntheticEvidence(2, { request_evidence_id: valid[0].request_evidence_id }), valid[2]],
    [valid[0], syntheticEvidence(2, { request_provenance: 'shared_synthetic_request' }), valid[2]],
    [valid[0], syntheticEvidence(2, { independent_request: false }), valid[2]], [valid[0], syntheticEvidence(2, { credible_organization: false }), valid[2]],
    [valid[0], syntheticEvidence(2, { capability_id: 'synthetic_capability_different_request' }), valid[2]],
    [valid[0], syntheticEvidence(2, { operational_request: false }), valid[2]], [valid[0], syntheticEvidence(2, { enthusiasm_only: true }), valid[2]],
    [valid[0], syntheticEvidence(2, { credible_organization: 'unknown' }), valid[2]],
    [valid[0], { ...valid[1], preaggregated_qualifying_count: 3 }, valid[2]], [{ ...valid[0], fixture_kind: 'real_evidence' }, valid[1], valid[2]],
  ];
  for (const evidence of cases) assert.equal(evaluateSyntheticDemandEvidence(evidence).outcome, 'hold');
});
test('tracked reader rejects worktree drift and symlinked pack files', () => {
  const drift = trackedCopy(); writeFileSync(resolve(drift, PACK_PATH), `${readFileSync(resolve(drift, PACK_PATH), 'utf8')} `); assert.throws(() => loadPack(drift), /working-tree evidence bytes differ from Git index/);
  const linked = trackedCopy(); rmSync(resolve(linked, SCHEMA_PATH)); symlinkSync('pack.json', resolve(linked, SCHEMA_PATH)); assert.throws(() => loadPack(linked), /symlinked evidence path/);
});
test('nonpublication rejects the new marker and arbitrarily renamed exact pack copies', () => {
  const forbidden = forbiddenInternalEvidence(repo); assert.ok(forbidden.markers.includes(INTERNAL_MARKER));
  const dist = temporaryRoot('weh-design-partner-dist-'); mkdirSync(resolve(dist, 'nested')); writeFileSync(resolve(dist, 'nested/renamed.bin'), readFileSync(resolve(repo, PACK_PATH))); assert.throws(() => assertInternalNonpublication(dist, repo), /exact copy|marker/);
  writeFileSync(resolve(dist, 'nested/marker.txt'), `prefix ${INTERNAL_MARKER} suffix`); assert.throws(() => assertInternalNonpublication(dist, repo), /marker/);
});
test('nonpublication rejects marker-stripped reformats and every extracted sensitive pack section', () => {
  const dist = temporaryRoot('weh-design-partner-semantic-dist-');
  const writeCandidate = (name, value) => {
    rmSync(dist, { recursive: true, force: true }); mkdirSync(dist);
    writeFileSync(resolve(dist, name), JSON.stringify(value, null, 4));
    assert.throws(() => assertInternalNonpublication(dist, repo), /marker|semantic section|scalar fingerprint/);
  };
  const markerStripped = clone(); delete markerStripped.internal_only_marker;
  writeCandidate('reformatted.json', markerStripped);
  writeCandidate('capabilities.json', committed.capability_matrix);
  writeCandidate('questions.json', committed.discovery_questions);
  writeCandidate('gate.json', committed.demand_gate);
  writeCandidate('rubric.json', committed.decision_rubric);
  writeCandidate('fixture.json', committed.example_records[0]);
});
test('nonpublication rejects altered/reordered containers, extracted entries, and raw HTML/JS scalar embedding', () => {
  const dist = temporaryRoot('weh-design-partner-adversarial-dist-');
  const reject = (name, content) => { rmSync(dist, { recursive: true, force: true }); mkdirSync(dist); writeFileSync(resolve(dist, name), content); assert.throws(() => assertInternalNonpublication(dist, repo), /marker|semantic section|scalar fingerprint/); };
  const altered = clone(); delete altered.internal_only_marker; delete altered.boundaries[0]; altered.extra = 'benign'; reject('altered.json', JSON.stringify(altered));
  reject('reordered.json', JSON.stringify([...committed.capability_matrix].reverse()));
  reject('capability.json', JSON.stringify({ ...committed.capability_matrix[0], extra: 'benign' }));
  reject('question.json', JSON.stringify(committed.discovery_questions[0].questions[0]));
  reject('rule.json', JSON.stringify(committed.decision_rubric.rules[1]));
  reject('fixture-entry.json', JSON.stringify({ ...committed.example_records[0], extra: null }));
  reject('embedded.html', `<script>window.note=${JSON.stringify(committed.discovery_questions[2].questions[1])}</script>`);
  reject('embedded.js', `export const limitation = ${JSON.stringify(committed.capability_matrix[1].limitations)};`);
});
