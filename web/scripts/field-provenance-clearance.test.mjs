import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import { assertCanonicalInventory, EXAMPLE_PATH, EXCLUDED_PATHS, FIELD_GROUP_IDS, FIELD_INVENTORY, HANDOFF_PATH, INTERNAL_MARKER, LEDGER_PATH, loadClearanceArtifacts, observedCanonicalPaths, POPULATION_IDS, README_PATH, REAL_HELD_NOTES, SCHEMA_PATH, SYNTHETIC_HELD_NOTES, validateLedger } from './field-provenance-clearance-lib.mjs';
import { assertInternalNonpublication, forbiddenInternalEvidence } from './verify-internal-nonpublication.mjs';
import { parseStrictJson } from './security-privacy-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const ledger = parseStrictJson(readFileSync(resolve(repo, LEDGER_PATH)), LEDGER_PATH);
const handoff = parseStrictJson(readFileSync(resolve(repo, HANDOFF_PATH)), HANDOFF_PATH);
const example = parseStrictJson(readFileSync(resolve(repo, EXAMPLE_PATH)), EXAMPLE_PATH);
const schema = parseStrictJson(readFileSync(resolve(repo, SCHEMA_PATH)), SCHEMA_PATH);
const roots = []; const temporaryRoot = () => { const root = mkdtempSync(resolve(tmpdir(), 'weh-clearance-')); roots.push(root); return root; };
const paths = [...new Set([LEDGER_PATH, EXAMPLE_PATH, SCHEMA_PATH, README_PATH, HANDOFF_PATH, 'hotlines.json', ...handoff.provenance_populations.flatMap(({ repository_evidence }) => repository_evidence)])];
const trackedCopy = () => { const root = temporaryRoot(); for (const path of paths) { mkdirSync(resolve(root, path, '..'), { recursive: true }); copyFileSync(resolve(repo, path), resolve(root, path)); } execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '--', '.']); return root; };
const clone = () => structuredClone(ledger);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('tracked ledger and synthetic example satisfy closed schema and exact held inventories', () => assert.doesNotThrow(() => loadClearanceArtifacts(trackedCopy())));
test('strict decoding and canonical bytes reject duplicate, malformed, and byte-alias JSON', () => {
  assert.throws(() => parseStrictJson('{"publication":"prohibited","publication":"allowed"}', LEDGER_PATH), /duplicate member/);
  assert.throws(() => parseStrictJson(Buffer.from([0x7b, 0xff, 0x7d]), LEDGER_PATH), /malformed UTF-8/);
  const root = trackedCopy(); const value = JSON.parse(readFileSync(resolve(root, LEDGER_PATH), 'utf8')); writeFileSync(resolve(root, LEDGER_PATH), JSON.stringify(value)); execFileSync('git', ['-C', root, 'add', '--', LEDGER_PATH]);
  assert.throws(() => loadClearanceArtifacts(root), /canonical pretty-printed byte representation/);
});
test('runtime rejects inventory, escalation, self-authorization, and unbound evidence mutations', () => {
  const options = { testOnlySkipGitIndex: true };
  const omitted = clone(); omitted.entries.pop(); assert.throws(() => validateLedger(omitted, handoff, repo, options), /cross-product/);
  const substituted = clone(); substituted.populations[0] = 'replacement'; assert.throws(() => validateLedger(substituted, handoff, repo, options), /inventory/);
  const reordered = clone(); reordered.field_groups.reverse(); assert.throws(() => validateLedger(reordered, handoff, repo, options), /field-group inventory/);
  const escalated = clone(); escalated.entries[0].status = 'cleared'; assert.throws(() => validateLedger(escalated, handoff, repo, options), /status escalation/);
  const permission = clone(); permission.entries[0].permission_assertion = 'granted'; assert.throws(() => validateLedger(permission, handoff, repo, options), /permission/);
  const reviewer = clone(); reviewer.entries[0].reviewer = 'project_owner'; assert.throws(() => validateLedger(reviewer, handoff, repo, options), /reviewer/);
  const decision = clone(); decision.entries[0].legal_decision = 'approved'; assert.throws(() => validateLedger(decision, handoff, repo, options), /legal decision/);
  const evidence = clone(); evidence.entries[0].evidence_references = ['evidence_find_a_helpline']; assert.throws(() => validateLedger(evidence, handoff, repo, options), /bind exactly/);
  assert.equal(ledger.entries.length, POPULATION_IDS.length * FIELD_GROUP_IDS.length);
});
test('runtime rejects field/path deletion, duplication, reassignment, and unexpected inventory members', () => {
  const rejects = (mutate, pattern) => { const value = clone(); mutate(value); assert.throws(() => validateLedger(value, handoff, repo, { testOnlySkipGitIndex: true }), pattern); };
  rejects((v) => { v.field_inventory[0].paths.pop(); }, /group-to-field\/path inventory/);
  rejects((v) => { v.field_inventory[1].paths.push(v.field_inventory[0].paths[0]); }, /group-to-field\/path inventory|duplicated or reassigned/);
  rejects((v) => { const path = v.field_inventory[0].paths.pop(); v.field_inventory[1].paths.push(path); }, /group-to-field\/path inventory/);
  rejects((v) => { v.field_inventory[0].paths.push('countries[].hotlines[].unexpected'); }, /group-to-field\/path inventory/);
  rejects((v) => { v.excluded_paths.push({ path: 'unexpected', classification: 'repository_metadata', status: 'held_outside_field_clearance', notes: 'Unresolved.' }); }, /exclusion inventory/);
  assert.deepEqual(ledger.field_inventory, FIELD_INVENTORY);
  assert.deepEqual(ledger.excluded_paths, EXCLUDED_PATHS);
});
test('observed canonical field/path derivation rejects canonical field addition', () => {
  const canonical = JSON.parse(readFileSync(resolve(repo, 'hotlines.json'), 'utf8'));
  const before = observedCanonicalPaths(canonical);
  canonical.countries[0].hotlines[0].new_canonical_field = 'unexpected';
  assert.notDeepEqual(observedCanonicalPaths(canonical), before);
  assert.throws(() => assertCanonicalInventory(canonical, ledger), /observed canonical field\/path inventory changed/);
});
test('runtime and schema reject top-level version and binding boundary mutations', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const mutations = [
    (v) => { v.schema_version = '1.1'; },
    (v) => { v.dataset_binding.extra = true; },
    (v) => { v.dataset_binding.path = 'other.json'; },
    (v) => { v.dataset_binding = ['hotlines.json']; },
    (v) => { v.handoff_binding.extra = true; },
    (v) => { v.handoff_binding.sha256 = `sha256:${'0'.repeat(64)}`; },
    (v) => { v.handoff_binding = null; },
  ];
  for (const mutate of mutations) {
    const value = clone(); mutate(value);
    assert.throws(() => validateLedger(value, handoff, repo, { testOnlySkipGitIndex: true }));
    assert.equal(validate(value), false, 'top-level boundary mutation unexpectedly passed schema');
  }
});
const affirmativeNoteClaims = [
  'Approved for use.',
  'License and rights granted.',
  'This is the canonical export.',
  'Approved for publication.',
  'Commercial use is permitted.',
  'This contains real data.',
];
const noteMutations = (held) => affirmativeNoteClaims.flatMap((claim) => [claim, `${claim} ${held}`, `${held} ${claim}`]);
test('runtime rejects replacement, prefix, and suffix affirmative note mutations for real and synthetic entries', () => {
  for (const [source, held, synthetic] of [[ledger, REAL_HELD_NOTES, false], [example, SYNTHETIC_HELD_NOTES, true]]) {
    for (const notes of noteMutations(held)) {
      const value = structuredClone(source); value.entries[0].notes = notes;
      assert.throws(() => validateLedger(value, handoff, repo, { synthetic, testOnlySkipGitIndex: true }), /exact conservative held wording/);
    }
  }
});
test('closed schema independently rejects security-relevant runtime mutations', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const rejects = (value) => assert.equal(validate(value), false, 'security-relevant mutation unexpectedly passed schema');
  for (const mutate of [
    (v) => { v.purpose = 'synthetic_contract_example_only'; },
    (v) => { v.populations.reverse(); },
    (v) => { v.field_groups.pop(); },
    (v) => { v.field_inventory[0].paths.pop(); },
    (v) => { v.field_inventory[1].paths.push(v.field_inventory[0].paths[0]); },
    (v) => { const path = v.field_inventory[0].paths.pop(); v.field_inventory[1].paths.push(path); },
    (v) => { v.field_inventory[0].paths.push('countries[].hotlines[].unexpected'); },
    (v) => { v.excluded_paths.pop(); },
    (v) => { v.evidence_catalog.pop(); },
    (v) => { v.evidence_catalog[0].handoff_pointer = 'provenance_populations/helplines_world'; },
    (v) => { v.entries.pop(); },
    (v) => { v.entries[0].field_group_id = 'contact_channels'; },
    (v) => { v.entries[0].status = 'cleared'; },
    (v) => { v.entries[0].permission_assertion = 'granted'; },
    (v) => { v.entries[0].reviewer = 'project_owner'; },
    (v) => { v.entries[0].legal_decision = 'approved'; },
    (v) => { v.entries[0].restrictions = 'none'; },
    (v) => { v.entries[0].evidence_references = ['evidence_helplines_world']; },
  ]) { const value = structuredClone(ledger); mutate(value); rejects(value); }
  const dangling = structuredClone(example); dangling.evidence_catalog[0] = { id: 'evidence_synthetic_example_population', population_id: 'synthetic_example_population', handoff_pointer: 'provenance_populations/synthetic_example_population', repository_evidence: [README_PATH] }; rejects(dangling);
});
test('closed schema rejects replacement, prefix, and suffix affirmative note mutations for real and synthetic entries', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  for (const [source, held] of [[ledger, REAL_HELD_NOTES], [example, SYNTHETIC_HELD_NOTES]]) {
    for (const notes of noteMutations(held)) {
      const value = structuredClone(source); value.entries[0].notes = notes;
      assert.equal(validate(value), false, `affirmative notes mutation unexpectedly passed schema: ${JSON.stringify(notes)}`);
    }
  }
});
test('real evidence bytes are independently checked against handoff source digests', () => {
  const root = trackedCopy(); const path = handoff.provenance_populations[0].repository_evidence[1];
  writeFileSync(resolve(root, path), Buffer.concat([readFileSync(resolve(root, path)), Buffer.from(' ')])); execFileSync('git', ['-C', root, 'add', '--', path]);
  assert.throws(() => loadClearanceArtifacts(root), /real repository evidence digest differs from handoff source/);
});
test('handoff provenance population inventory and order are exact and finite', () => {
  for (const mutate of [(v) => v.provenance_populations.pop(), (v) => v.provenance_populations.reverse(), (v) => v.provenance_populations.push(structuredClone(v.provenance_populations[0]))]) {
    const changed = structuredClone(handoff); mutate(changed);
    assert.throws(() => validateLedger(clone(), changed, repo, { testOnlySkipGitIndex: true }), /handoff provenance population inventory\/order/);
  }
});
test('tracked reads reject drift, symlinks, and replacement during validation', () => {
  const drift = trackedCopy(); writeFileSync(resolve(drift, EXAMPLE_PATH), `${readFileSync(resolve(drift, EXAMPLE_PATH), 'utf8')} `); assert.throws(() => loadClearanceArtifacts(drift), /working-tree evidence bytes differ from Git index/);
  const linked = trackedCopy(); rmSync(resolve(linked, SCHEMA_PATH)); symlinkSync('ledger.json', resolve(linked, SCHEMA_PATH)); assert.throws(() => loadClearanceArtifacts(linked), /symlinked evidence path/);
  const replaced = trackedCopy(); let done = false; assert.throws(() => loadClearanceArtifacts(replaced, { afterRead: ({ path, absolutePath }) => { if (done || path !== LEDGER_PATH) return; done = true; const next = `${absolutePath}.new`; writeFileSync(next, readFileSync(absolutePath)); renameSync(next, absolutePath); } }), /changed during read/);
});
test('nonpublication rejects exact, transformed, and partial production leaks', () => {
  const forbidden = forbiddenInternalEvidence(repo); assert.ok(forbidden.markers.includes(INTERNAL_MARKER));
  const dist = temporaryRoot(); writeFileSync(resolve(dist, 'renamed.bin'), readFileSync(resolve(repo, LEDGER_PATH))); assert.throws(() => assertInternalNonpublication(dist, repo), /marker|exact copy/);
  rmSync(dist, { recursive: true, force: true }); mkdirSync(dist); writeFileSync(resolve(dist, 'transformed.json'), JSON.stringify({ entries: ledger.entries })); assert.throws(() => assertInternalNonpublication(dist, repo), /semantic section|scalar fingerprint|row fingerprint/);
  rmSync(dist, { recursive: true, force: true }); mkdirSync(dist); writeFileSync(resolve(dist, 'partial.js'), JSON.stringify(ledger.evidence_catalog[0].handoff_pointer)); assert.throws(() => assertInternalNonpublication(dist, repo), /scalar fingerprint/);
});
test('nonpublication rejects delimiter, renamed-key, and split-field clearance rows without broad scalar matches', () => {
  const cases = [];
  for (const source of [ledger, example]) {
    const row = source.entries[0];
    cases.push(Object.values(row).flat().map(String).join(','));
    cases.push(Object.values(row).flat().map(String).join('\t'));
    cases.push(JSON.stringify(Object.fromEntries(Object.values(row).map((value, index) => [`renamed_${index}`, value]))));
    cases.push(`<article>${Object.values(row).flat().map((value) => `<span>${value}</span>`).join('')}</article>`);
  }
  for (const [index, content] of cases.entries()) {
    const dist = temporaryRoot(); writeFileSync(resolve(dist, `row-${index}.${content.startsWith('<article>') ? 'html' : 'txt'}`), content);
    assert.throws(() => assertInternalNonpublication(dist, repo), /row fingerprint/);
  }
  const dist = temporaryRoot();
  writeFileSync(resolve(dist, 'ordinary.txt'), 'Public contact channels and geography scope information. No permission assertion is made.');
  assert.doesNotThrow(() => assertInternalNonpublication(dist, repo));
});
const rowScalars = (row) => Object.values(row).flat().filter((value) => typeof value === 'string');
const assertLeakRejected = (content, label, extension = 'txt') => {
  const dist = temporaryRoot(); writeFileSync(resolve(dist, `${label}.${extension}`), content);
  assert.throws(() => assertInternalNonpublication(dist, repo), /row fingerprint/, label);
};
test('nonpublication rejects review probes and every single-field removal for real and synthetic rows', () => {
  for (const [kind, source] of [['real', ledger], ['synthetic', example]]) {
    const row = source.entries[0];
    const probes = [
      [row.population_id, row.field_group_id],
      [row.population_id, ...row.evidence_references],
      [row.status, row.permission_assertion, row.restrictions],
    ];
    probes.forEach((probe, index) => assertLeakRejected(probe.join(' | '), `${kind}-accepted-probe-${index}`));
    for (const omitted of Object.keys(row)) {
      const partial = Object.fromEntries(Object.entries(row).filter(([key]) => key !== omitted));
      assertLeakRejected(JSON.stringify(partial), `${kind}-without-${omitted}`);
    }
  }
});
test('nonpublication normalizes case, separators, JSON Unicode escapes, and split or entity-encoded HTML', () => {
  for (const [kind, source] of [['real', ledger], ['synthetic', example]]) {
    const values = [source.entries[0].population_id, source.entries[0].field_group_id];
    assertLeakRejected(values.map((value) => value.toUpperCase()).join('\t/\n'), `${kind}-uppercase`);
    assertLeakRejected(values.map((value) => value.replaceAll('_', ' \t- / ')).join(' :: '), `${kind}-separators`);
    assertLeakRejected(values.map((value) => [...value].map((character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`).join('')).join(','), `${kind}-json-escaped`);
    assertLeakRejected(values.map((value) => [...value].map((character) => `&#x${character.codePointAt(0).toString(16)};`).join('')).join(' &NewLine; '), `${kind}-html-entities`);
    assertLeakRejected(values.map((value) => value.replaceAll('_', '&lowbar;')).join('&Tab;'), `${kind}-named-html-entities`);
    assertLeakRejected(`<article>${values.map((value) => `<span>${value.replaceAll('_', '</span> <span>')}</span>`).join('</article><article>')}</article>`, `${kind}-split-html`, 'html');
  }
});
const tupleClasses = (row) => [
  [row.population_id, row.field_group_id],
  [row.population_id, ...row.evidence_references],
  [row.status, row.permission_assertion, row.restrictions],
];
const encodePercent = (value) => [...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
const encodeJsX = (value) => [...Buffer.from(value)].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('');
const encodeJsU = (value) => [...value].map((character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`).join('');
const encodeJsCodePoint = (value) => [...value].map((character) => `\\u{${character.codePointAt(0).toString(16)}}`).join('');
const encodeHtml = (value) => [...value].map((character) => `&#x${character.codePointAt(0).toString(16)};`).join('');
const encodeNamedHtml = (value) => [...value].map((character) => ({
  '-': '&hyphen;', '_': '&UnderBar;', '/': '&sol;', ':': '&colon;', '.': '&period;', ' ': '&emsp;',
}[character] ?? character)).join('');
const interiorPositions = (value) => [...new Set([1, Math.floor(value.length / 2), value.length - 1])].filter((position) => position > 0 && position < value.length);
const insertInlineTag = (value, position) => `${value.slice(0, position)}<span></span>${value.slice(position)}`;
const splitWithQuotedGreaterThanTag = (value, position) => `${value.slice(0, position)}<span title=">">${value[position]}</span>${value.slice(position + 1)}`;
test('nonpublication fixed-point decoding rejects nested and mixed encodings for every tuple class', () => {
  for (const [kind, source] of [['real', ledger], ['synthetic', example]]) {
    tupleClasses(source.entries[0]).forEach((tuple, tupleIndex) => {
      const joined = tuple.join(' | ');
      assertLeakRejected(encodeHtml(encodePercent(joined)), `${kind}-tuple-${tupleIndex}-html-percent`);
      assertLeakRejected(encodePercent(encodeJsX(joined)), `${kind}-tuple-${tupleIndex}-percent-jsx`);
      assertLeakRejected(encodeJsU(encodeHtml(encodePercent(joined))), `${kind}-tuple-${tupleIndex}-jsu-html-percent`);
      assertLeakRejected(encodeHtml(encodePercent(encodeJsX(joined))), `${kind}-tuple-${tupleIndex}-html-percent-jsx`);
    });
  }
});
test('nonpublication rejects inline tags at multiple interior positions of every tuple component', () => {
  for (const [kind, source] of [['real', ledger], ['synthetic', example]]) {
    tupleClasses(source.entries[0]).forEach((tuple, tupleIndex) => {
      tuple.forEach((component, componentIndex) => {
        for (const position of interiorPositions(component)) {
          const splitTuple = tuple.map((value, index) => index === componentIndex ? insertInlineTag(value, position) : value);
          assertLeakRejected(splitTuple.join(' | '), `${kind}-tuple-${tupleIndex}-component-${componentIndex}-position-${position}`, 'html');
        }
      });
    });
  }
  assertLeakRejected('psc_<span>a</span>pp identity_naming', 'exact-psc-app-inline-span', 'html');
});
test('nonpublication rejects noscript markup splits in both parse5 scripting modes', () => {
  for (const [kind, source] of [['real', ledger], ['synthetic', example]]) {
    tupleClasses(source.entries[0]).forEach((tuple, tupleIndex) => {
      tuple.forEach((component, componentIndex) => {
        for (const position of interiorPositions(component)) {
          const splitTuple = tuple.map((value, index) => index === componentIndex ? insertInlineTag(value, position) : value);
          assertLeakRejected(`<noscript>${splitTuple.join(' | ')}</noscript>`, `${kind}-noscript-tuple-${tupleIndex}-component-${componentIndex}-position-${position}`, 'html');
        }
      });
    });
  }
  assertLeakRejected('<noscript>psc_<span>a</span>pp identity_naming</noscript>', 'exact-noscript-psc-app-inline-span', 'html');
});
test('nonpublication HTML parser rejects quoted-attribute greater-than splits across every tuple component', () => {
  for (const [kind, source] of [['real', ledger], ['synthetic', example]]) {
    tupleClasses(source.entries[0]).forEach((tuple, tupleIndex) => {
      tuple.forEach((component, componentIndex) => {
        for (const position of interiorPositions(component)) {
          const splitTuple = tuple.map((value, index) => index === componentIndex ? splitWithQuotedGreaterThanTag(value, position) : value);
          assertLeakRejected(splitTuple.join(' | '), `${kind}-quoted-gt-tuple-${tupleIndex}-component-${componentIndex}-position-${position}`, 'html');
        }
      });
    });
  }
  assertLeakRejected('psc_a<span title=">">p</span>p identity_naming', 'exact-quoted-gt-adversarial', 'html');
});
test('nonpublication decoder negative controls remain literal and bounded', () => {
  for (const [index, content] of ['%zz %5', '\\xGG \\u0ZZZ', '\\u{} \\u{0zz} \\u{1234567} \\u{110000} \\u{d800} \\u{DFFF} \\u{10ffff', '&unknown; &NotARealReference; &#x; &#x110000;', 'ordinary &hyphen; public support &CounterClockwiseContourIntegral; text', 'ordinary \\u{1f642} public support text', 'ordinary compressed or encrypted data is not claimed detectable'].entries()) {
    const dist = temporaryRoot(); writeFileSync(resolve(dist, `decoder-control-${index}.txt`), content);
    assert.doesNotThrow(() => assertInternalNonpublication(dist, repo));
  }
  let overNested = '&lowbar;'; for (let i = 0; i < 9; i += 1) overNested = overNested.replaceAll('&', '&amp;');
  const dist = temporaryRoot(); writeFileSync(resolve(dist, 'iteration-bound.txt'), overNested);
  assert.throws(() => assertInternalNonpublication(dist, repo), /normalization iterations/);
});
test('complete named references expose every internal marker class in HTML representations', () => {
  const forbidden = forbiddenInternalEvidence(repo);
  const markerClasses = [
    'reviews/licensed-delivery',
    'internal-licensed-delivery-counsel-draft-only/v1',
    'SYNTHETIC-TEST-KEY-NEVER-PUBLISH-OR-USE-IN-PRODUCTION',
    'internal_deterministic_regression_evidence',
  ];
  const contexts = [
    ['text', (value) => `<p>${value}</p>`],
    ['attribute', (value) => `<div data-note="${value}"></div>`],
    ['comment', (value) => `<!--${value}-->`],
    ['comment-parser-text', (value) => `<!--<p>${value}</p>-->`],
    ['doctype', (value) => `<!DOCTYPE html SYSTEM "${value}"><html></html>`],
    ['decoded-parser-attribute', (value) => encodePercent(`<div data-note="${value}"></div>`)],
  ];
  for (const marker of markerClasses) {
    assert.ok(forbidden.markers.includes(marker));
    for (const [context, wrap] of contexts) {
      const dist = temporaryRoot();
      writeFileSync(resolve(dist, `${context}.html`), wrap(encodeNamedHtml(marker)));
      assert.throws(() => assertInternalNonpublication(dist, repo), /normalized internal review-pack marker|internal review-pack marker|licensed-delivery .* fingerprint/, `${marker} in ${context}`);
    }
  }
});
test('complete named references expose licensed schema, fixture, and counsel fingerprints through mixed nesting', () => {
  const forbidden = forbiddenInternalEvidence(repo);
  const probes = [
    ['contract', forbidden.licensedContractFingerprints[0].raw],
    ['fixture', forbidden.licensedFixtureFingerprints.find(({ raw }) => /^[a-z][a-z0-9_/-]+$/u.test(raw)).raw],
    ['counsel', forbidden.licensedDraftFingerprints[0].raw],
  ];
  const contexts = [
    ['text', (value) => `<p>${value}</p>`],
    ['attribute', (value) => `<div title="${value}"></div>`],
    ['comment', (value) => `<!--${value}-->`],
    ['comment-attribute', (value) => `<!--<div title="${value}"></div>-->`],
    ['decoded-parser-text', (value) => encodeJsU(encodePercent(`<p>${value}</p>`))],
  ];
  for (const [probeClass, raw] of probes) {
    for (const [context, wrap] of contexts) {
      const dist = temporaryRoot();
      const named = encodeNamedHtml(raw);
      const content = context === 'comment' ? wrap(encodePercent(named)) : wrap(named);
      writeFileSync(resolve(dist, `${probeClass}-${context}.html`), content);
      assert.throws(() => assertInternalNonpublication(dist, repo), /licensed-delivery .* fingerprint|review-pack scalar fingerprint/, `${probeClass} in ${context}`);
    }
  }
});
test('legacy semicolonless named references follow text and attribute parsing rules', () => {
  const marker = 'internal-licensed-delivery-counsel-draft-only/v1';
  for (const [label, content] of [
    ['text', `<p>${marker.replaceAll('-', '&shy')}</p>`],
    ['comment', `<!--${marker.replaceAll('-', '&shy')}-->`],
    ['attribute-valid-boundary', `<div title="${marker.replaceAll('-', '&shy ')}"></div>`],
  ]) {
    const dist = temporaryRoot(); writeFileSync(resolve(dist, `${label}.html`), content);
    assert.throws(() => assertInternalNonpublication(dist, repo), /normalized internal review-pack marker|licensed-delivery .* fingerprint/, label);
  }
  const dist = temporaryRoot();
  writeFileSync(resolve(dist, 'attribute-ambiguous.html'), '<div title="Public &copy=directory &notit support"></div>');
  assert.doesNotThrow(() => assertInternalNonpublication(dist, repo));
});
test('nonpublication decodes Unicode code-point escapes across licensed leak classes and HTML surfaces', () => {
  const forbidden = forbiddenInternalEvidence(repo);
  const marker = 'internal-licensed-delivery-counsel-draft-only/v1';
  const schema = forbidden.licensedContractFingerprints[0].raw;
  const fixture = forbidden.licensedFixtureFingerprints.find(({ raw }) => /^[a-z][a-z0-9_/-]+$/u.test(raw)).raw;
  const counsel = forbidden.licensedDraftFingerprints[0].raw;
  const safeName = (value) => value.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '');
  const cases = [
    ['marker-text', encodeJsCodePoint(marker)],
    ['schema-attribute-value', `<div title="${encodeJsCodePoint(schema)}"></div>`],
    ['fixture-tag-name', `<${encodeJsCodePoint(safeName(fixture))}></span>`],
    ['counsel-comment', `<!-- ${encodeJsCodePoint(counsel)} -->`],
    ['fixture-doctype', `<!DOCTYPE html SYSTEM "${encodeJsCodePoint(fixture)}"><html></html>`],
    ['nested-text', encodeHtml(encodePercent(encodeJsCodePoint(fixture)))],
    ['nested-attribute-value', `<div title="${encodeHtml(encodePercent(encodeJsCodePoint(fixture)))}"></div>`],
    ['nested-tag-name', `<${encodeHtml(encodePercent(encodeJsCodePoint(safeName(fixture))))}></span>`],
    ['nested-attribute-name', `<div ${encodeHtml(encodePercent(encodeJsCodePoint(safeName(fixture))))}></div>`],
    ['nested-comment', `<!-- ${encodeHtml(encodePercent(encodeJsCodePoint(fixture)))} -->`],
    ['nested-doctype', `<!DOCTYPE html PUBLIC "${encodeHtml(encodePercent(encodeJsCodePoint(fixture)))}" "about:blank"><html></html>`],
  ];
  for (const [label, content] of cases) {
    const dist = temporaryRoot(); writeFileSync(resolve(dist, `${label}.html`), content);
    assert.throws(() => assertInternalNonpublication(dist, repo), /marker|licensed-delivery .* fingerprint|review-pack scalar fingerprint/, label);
  }
});
test('nonpublication scans decoded HTML tag and attribute names for licensed internal strings', () => {
  const marker = 'SYNTHETIC-TEST-KEY-NEVER-PUBLISH-OR-USE-IN-PRODUCTION';
  const schema = 'Internal licensed-delivery v1 closed schema bundle';
  const fixture = 'synthetic_non_emergency_fixture';
  const name = (value) => value.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '');
  const fragmentedCase = (value) => [...value].map((character, index) => index % 2 ? character.toUpperCase() : character.toLowerCase()).join('');
  const cases = [
    ['raw-tag-fixture', `<${fixture}></${fixture}>`],
    ['raw-tag-schema', `<${name(schema)}></${name(schema)}>`],
    ['raw-attribute-marker', `<div ${marker}></div>`],
    ['entity-tag', `<${encodeHtml(fixture)}></${encodeHtml(fixture)}>`],
    ['percent-attribute', `<div ${encodePercent(marker)}></div>`],
    ['javascript-tag', `<${encodeJsU(name(schema))}></${encodeJsU(name(schema))}>`],
    ['mixed-nested-tag', `<${encodeHtml(encodePercent(encodeJsX(fixture)))}></span>`],
    ['mixed-nested-attribute', `<div ${encodeJsU(encodeHtml(encodePercent(marker)))}></div>`],
    ['case-fragmented-tag', `<${fragmentedCase(fixture)}></${fragmentedCase(fixture)}>`],
    ['case-fragmented-attribute', `<div ${fragmentedCase(marker)}></div>`],
    ['comment-tag', `<!-- <${encodePercent(fixture)}> -->`],
    ['comment-attribute', `<!-- <div ${encodeHtml(marker)}> -->`],
  ];
  for (const [label, content] of cases) {
    const dist = temporaryRoot(); writeFileSync(resolve(dist, `${label}.html`), content);
    assert.throws(() => assertInternalNonpublication(dist, repo), /marker|licensed-delivery .* fingerprint/, label);
  }
});
test('normalized complete marker cores match adjacent letters, digits, and Unicode across encodings and HTML contexts', () => {
  const markerClasses = [
    'reviews/licensed-delivery',
    'internal-licensed-delivery-counsel-draft-only/v1',
    'SYNTHETIC-TEST-KEY-NEVER-PUBLISH-OR-USE-IN-PRODUCTION',
    'internal_deterministic_regression_evidence',
  ];
  const adjacency = [
    ['left-letter', 'x', ''], ['right-letter', '', 'z'], ['both-letters', 'x', 'z'],
    ['left-digit', '7', ''], ['right-digit', '', '9'], ['both-digits', '7', '9'],
    ['left-unicode', 'Ω', ''], ['right-unicode', '', '界'], ['both-unicode', 'Ω', '界'],
  ];
  const encodeCodePoints = (value) => [...value].map((character) => `\\u{${character.codePointAt(0).toString(16)}}`).join('');
  const encodings = [
    ['entity', encodeHtml], ['percent', encodePercent], ['javascript', encodeJsU],
    ['code-point', encodeCodePoints],
    ['mixed', (value) => encodeHtml(encodePercent(encodeJsX(value)))],
    ['nested', (value) => encodeCodePoints(encodeHtml(encodePercent(value)))],
  ];
  const contexts = [
    ['text', (value) => `<p>${value}</p>`],
    ['attribute', (value) => `<div data-note="${value}"></div>`],
    ['tag-name', (value) => `<${value}></${value}>`],
    ['attribute-name', (value) => `<div ${value}="public"></div>`],
    ['comment', (value) => `<!--${value}-->`],
    ['doctype', (value) => `<!DOCTYPE html PUBLIC "${value}" "about:blank"><html></html>`],
  ];
  const count = Math.max(adjacency.length, encodings.length, contexts.length);
  for (const [markerIndex, marker] of markerClasses.entries()) {
    for (let index = 0; index < count; index += 1) {
      const [adjacencyLabel, left, right] = adjacency[index % adjacency.length];
      const [encodingLabel, encode] = encodings[(index + markerIndex) % encodings.length];
      const [contextLabel, context] = contexts[(index + markerIndex * 2) % contexts.length];
      // HTML names cannot contain every source separator, but separator folding
      // makes this spelling exactly equivalent to the inventory marker.
      const core = /-name$/u.test(contextLabel) ? marker.replace(/[^\p{L}\p{N}]+/gu, '-') : marker;
      const value = encode(`${left}${core}${right}`);
      const dist = temporaryRoot();
      const label = `${markerIndex}-${adjacencyLabel}-${encodingLabel}-${contextLabel}`;
      writeFileSync(resolve(dist, `${label}.html`), context(value));
      assert.throws(() => assertInternalNonpublication(dist, repo), /normalized internal review-pack marker|internal review-pack marker/, label);
    }
  }
});
test('normalized marker cores preserve complete-marker semantics and ordinary public negatives', () => {
  const controls = [
    'xinternal-licensed-delivery-counsel-draft-onlyz',
    'internal-licensed-delivery-counsel-draft/v1',
    'licensed-delivery-counsel-draft-only/v1',
    'internal delivery counsel draft only',
    'synthetic test key for public documentation',
    'internal deterministic regression results are not included here',
    '<p>Public licensed application delivery information.</p>',
  ];
  for (const [index, content] of controls.entries()) {
    const dist = temporaryRoot(); writeFileSync(resolve(dist, `marker-near-miss-${index}.html`), content);
    assert.doesNotThrow(() => assertInternalNonpublication(dist, repo), content);
  }
});
test('nonpublication scans every isolated doctype field through bounded fixed-point decoding', () => {
  const fixture = 'synthetic_non_emergency_fixture';
  const encodings = [
    ['raw', fixture],
    ['entity', encodeHtml(fixture)],
    ['percent', encodePercent(fixture)],
    ['javascript', encodeJsU(fixture)],
    ['mixed', encodeHtml(encodePercent(encodeJsX(fixture)))],
    ['nested', encodeJsU(encodeHtml(encodePercent(fixture)))],
    ['case', [...fixture].map((character, index) => index % 2 ? character.toUpperCase() : character).join('')],
  ];
  for (const [encoding, value] of encodings) {
    const cases = [
      [`${encoding}-name`, `<!DOCTYPE ${value}><html></html>`],
      [`${encoding}-public-id`, `<!DOCTYPE html PUBLIC "${value}" "about:blank"><html></html>`],
      [`${encoding}-system-id`, `<!DOCTYPE html SYSTEM "${value}"><html></html>`],
    ];
    for (const [label, content] of cases) {
      const dist = temporaryRoot(); writeFileSync(resolve(dist, `doctype-${label}.html`), content);
      assert.throws(() => assertInternalNonpublication(dist, repo), /licensed-delivery .* fingerprint/, label);
    }
  }
});
test('nonpublication permits harmless standard and custom doctypes', () => {
  const controls = [
    '<!doctype html><html></html>',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><html></html>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><html></html>',
    '<!DOCTYPE public-directory SYSTEM "support-directory.dtd"><html></html>',
  ];
  for (const [index, content] of controls.entries()) {
    const dist = temporaryRoot(); writeFileSync(resolve(dist, `harmless-doctype-${index}.html`), content);
    assert.doesNotThrow(() => assertInternalNonpublication(dist, repo));
  }
});
test('nonpublication HTML name scanning preserves parser safety and harmless public names', () => {
  const controls = [
    '<public-support-card data-region-code="se" aria-label="Support"></public-support-card>',
    '<world-emergency-hotlines data-provider-kind aria-live="polite"></world-emergency-hotlines>',
    '<div data-internal-delivery-note="public" aria-description="Licensed directory"></div>',
    '<broken%zz data-bad%5="literal"><span ordinary=value></broken%zz>',
    '<broken%zz data-bad%5-name="literal"><span ordinary=value></broken%zz>',
  ];
  for (const [index, content] of controls.entries()) {
    const dist = temporaryRoot(); writeFileSync(resolve(dist, `harmless-name-${index}.html`), content);
    assert.doesNotThrow(() => assertInternalNonpublication(dist, repo), `harmless name control ${index}`);
  }
});
test('nonpublication tuple fingerprints permit ordinary public content and isolated common tokens', () => {
  const controls = [
    'Public contact channels and geography scope information for visitors.',
    'No permission assertion is made by this public directory.',
    'This record is held pending review and may change.',
    'Identity naming conventions, eligibility audience, and service classifications.',
    ...rowScalars(ledger.entries[0]).map((scalar) => scalar === ledger.entries[0].notes ? 'Qualified counsel may review public terms.' : scalar.split(/[_\s]+/u)[0]),
    'ps <span>c</span> app identity_naming',
    'psc_ <span>a</span> pp identity_naming',
    'psc_ap <span></span>p identity_naming',
    '<noscript>ps <span>c</span> app identity_naming</noscript>',
    '<noscript>psc_ <span>a</span> pp identity_naming</noscript>',
    '<noscript>psc_ap <span></span>p identity_naming</noscript>',
  ];
  for (const [index, content] of controls.entries()) {
    const dist = temporaryRoot(); writeFileSync(resolve(dist, `ordinary-${index}.txt`), content);
    assert.doesNotThrow(() => assertInternalNonpublication(dist, repo), `ordinary control ${index}`);
  }
});
test('nonpublication preserves raw non-HTML text and ignores HTML attribute values', () => {
  const raw = temporaryRoot();
  writeFileSync(resolve(raw, 'literal.txt'), 'psc_a<span title=">">p</span>p identity_naming');
  assert.doesNotThrow(() => assertInternalNonpublication(raw, repo));
  const html = temporaryRoot();
  writeFileSync(resolve(html, 'attributes.html'), '<noscript data-population="psc_app" title="identity_naming"><span>Ordinary public content.</span></noscript>');
  assert.doesNotThrow(() => assertInternalNonpublication(html, repo));
});
