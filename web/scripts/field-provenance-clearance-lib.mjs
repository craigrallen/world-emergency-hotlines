import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseStrictJson, readTrackedRegularFile, sha256, withStableGitIndex } from './security-privacy-evidence-lib.mjs';

export const LEDGER_PATH = 'reviews/field-provenance-clearance/v1/ledger.json';
export const EXAMPLE_PATH = 'reviews/field-provenance-clearance/v1/example.synthetic.json';
export const SCHEMA_PATH = 'reviews/field-provenance-clearance/v1/ledger.schema.json';
export const README_PATH = 'reviews/field-provenance-clearance/v1/README.md';
export const HANDOFF_PATH = 'reviews/licensing-legal-review/v1/index.json';
export const INTERNAL_MARKER = 'internal-field-provenance-clearance-ledger-only/v1';
export const HOTLINES_SHA256 = 'sha256:e893c9f6b0afcc57832054547002c826e80b5387e544b4cf6909afc9424dde3a';
export const HANDOFF_SHA256 = 'sha256:7c10e0daded51751eb4df36df7ce7075596a5f67a88c4f3fedcb476ca412b126';
export const POPULATION_IDS = Object.freeze(['unknown_information_json', 'helplines_world', 'find_a_helpline', 'psc_app', 'vibbrancy_naga', 'web_verified_directory']);
export const FIELD_GROUP_IDS = Object.freeze(['identity_naming', 'contact_channels', 'geography_scope', 'service_classifications', 'eligibility_audience', 'hours_languages_accessibility', 'provenance_evidence', 'lifecycle_replacement', 'record_relationships']);
export const FIELD_INVENTORY = Object.freeze([
  { field_group_id: 'identity_naming', paths: ['countries[].country', 'countries[].alpha-2', 'countries[].alpha-3', 'countries[].hotlines[].id', 'countries[].hotlines[].name', 'countries[].hotlines[].organization'] },
  { field_group_id: 'contact_channels', paths: ['countries[].general_emergency[]', 'countries[].hotlines[].voice_numbers[]', 'countries[].hotlines[].sms_numbers[]', 'countries[].hotlines[].text_numbers[]', 'countries[].hotlines[].short_codes[]', 'countries[].hotlines[].email', 'countries[].hotlines[].website', 'countries[].hotlines[].chat_url'] },
  { field_group_id: 'geography_scope', paths: ['countries[].region', 'countries[].subregion', 'countries[].hotlines[].geography'] },
  { field_group_id: 'service_classifications', paths: ['countries[].notes', 'countries[].hotlines[].category', 'countries[].hotlines[].notes'] },
  { field_group_id: 'eligibility_audience', paths: ['countries[].hotlines[].target'] },
  { field_group_id: 'hours_languages_accessibility', paths: ['countries[].hotlines[].hours', 'countries[].hotlines[].languages[]', 'countries[].hotlines[].cost'] },
  { field_group_id: 'provenance_evidence', paths: ['countries[].hotlines[].sources[]', 'countries[].hotlines[].provenance'] },
  { field_group_id: 'lifecycle_replacement', paths: ['countries[].hotlines[].last_verified', 'countries[].hotlines[].verification_status'] },
  { field_group_id: 'record_relationships', paths: ['countries[].hotlines[]._legacy.name', 'countries[].hotlines[]._legacy.numbers[]', 'countries[].hotlines[]._legacy.phone', 'countries[].hotlines[]._legacy.sms[]', 'countries[].hotlines[]._legacy.source', 'countries[].hotlines[]._legacy.tags[]', 'countries[].hotlines[]._legacy.voice[]'] },
]);
export const EXCLUDED_PATHS = Object.freeze([
  { path: '$schema_version', classification: 'repository_metadata', status: 'held_outside_field_clearance', notes: 'Excluded from field clearance only as repository schema metadata; no permission, license, rights, publication, or record-change conclusion is made.' },
  { path: 'categories_reference', classification: 'repository_metadata', status: 'held_outside_field_clearance', notes: 'Excluded from field clearance only as the repository category-reference map; its values and rights remain unresolved and no permission or publication conclusion is made.' },
  { path: 'contributors', classification: 'repository_metadata', status: 'held_outside_field_clearance', notes: 'Excluded from field clearance only as repository contributor metadata; identity, attribution, and rights remain unresolved.' },
  { path: 'last_updated', classification: 'repository_metadata', status: 'held_outside_field_clearance', notes: 'Excluded from field clearance only as repository update metadata; no permission, license, rights, publication, or record-change conclusion is made.' },
  { path: 'methodology', classification: 'repository_metadata', status: 'held_outside_field_clearance', notes: 'Excluded from field clearance only as repository methodology metadata; its content and rights remain unresolved.' },
  { path: 'countries', classification: 'structural_container', status: 'held_outside_field_clearance', notes: 'Excluded only as a structural container; every observed scalar country and hotline field path beneath it is assigned exactly once above.' },
  { path: 'countries[]', classification: 'structural_container', status: 'held_outside_field_clearance', notes: 'Excluded only as a structural array item; every observed scalar country and hotline field path beneath it is assigned exactly once above.' },
  { path: 'countries[].general_emergency', classification: 'structural_container', status: 'held_outside_field_clearance', notes: 'Excluded only as a structural array container; its scalar item path is assigned exactly once above.' },
  { path: 'countries[].hotlines', classification: 'structural_container', status: 'held_outside_field_clearance', notes: 'Excluded only as a structural array container; every observed scalar hotline field path beneath it is assigned exactly once above.' },
  { path: 'countries[].hotlines[]', classification: 'structural_container', status: 'held_outside_field_clearance', notes: 'Excluded only as a structural array item; every observed scalar hotline field path beneath it is assigned exactly once above.' },
  { path: 'countries[].hotlines[]._legacy', classification: 'structural_container', status: 'held_outside_field_clearance', notes: 'Excluded only as a structural legacy-record container; every observed scalar field path beneath it is assigned exactly once above.' },
  ...['languages', 'short_codes', 'sms_numbers', 'sources', 'text_numbers', 'voice_numbers'].map((name) => ({ path: `countries[].hotlines[].${name}`, classification: 'structural_container', status: 'held_outside_field_clearance', notes: 'Excluded only as a structural array container; its scalar item path is assigned exactly once above.' })),
  ...['numbers', 'sms', 'tags', 'voice'].map((name) => ({ path: `countries[].hotlines[]._legacy.${name}`, classification: 'structural_container', status: 'held_outside_field_clearance', notes: 'Excluded only as a structural array container; its scalar item path is assigned exactly once above.' })),
]);
export const SYNTHETIC_POPULATION_ID = 'synthetic_example_population';
export const REAL_HELD_NOTES = 'Unresolved; requires separately authorized review by qualified counsel.';
export const SYNTHETIC_HELD_NOTES = 'CONSPICUOUSLY SYNTHETIC HELD EXAMPLE: Synthetic Example Registry at registry.invalid; no real contact, provider, or crisis data.';
const ROOT_KEYS = ['schema_version', 'internal_only_marker', 'purpose', 'publication', 'dataset_binding', 'handoff_binding', 'populations', 'field_groups', 'field_inventory', 'excluded_paths', 'evidence_catalog', 'entries'];
const ENTRY_KEYS = ['population_id', 'field_group_id', 'status', 'permission_assertion', 'evidence_references', 'reviewer', 'legal_decision', 'restrictions', 'notes'];
const REAL_EVIDENCE_KEYS = ['id', 'population_id', 'handoff_pointer', 'repository_evidence'];
const SYNTHETIC_EVIDENCE_KEYS = ['id', 'population_id', 'synthetic_basis'];
const exactKeys = (value, keys, label) => assert.deepEqual(Object.keys(value), keys, `${label}: fields/order changed`);
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function observedCanonicalPaths(canonical) {
  const observed = new Set();
  const visit = (value, path = '') => {
    if (Array.isArray(value)) { observed.add(`${path}[]`); for (const item of value) visit(item, `${path}[]`); }
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { const childPath = path ? `${path}.${key}` : key; observed.add(childPath); visit(child, childPath); }
  };
  visit(canonical);
  return [...observed].sort();
}
export function assertCanonicalInventory(canonical, ledger) {
  const assigned = ledger.field_inventory.flatMap(({ paths }) => paths);
  const covered = [...assigned, ...ledger.excluded_paths.map(({ path }) => path), ...Object.keys(canonical.categories_reference).map((key) => `categories_reference.${key}`), 'contributors[]'];
  assert.deepEqual(observedCanonicalPaths(canonical), [...covered].sort(), 'observed canonical field/path inventory changed or is not covered exactly once');
}

export function validateLedger(ledger, handoff, repo, { synthetic = false, ...options } = {}) {
  exactKeys(ledger, ROOT_KEYS, 'ledger');
  assert.equal(ledger.schema_version, '1.0', 'schema version changed');
  assert.equal(ledger.internal_only_marker, INTERNAL_MARKER);
  assert.equal(ledger.publication, 'prohibited', 'publication must remain prohibited');
  assert.deepEqual(ledger.dataset_binding, { path: 'hotlines.json', sha256: HOTLINES_SHA256 }, 'canonical dataset binding changed');
  assert.equal(sha256(readTrackedRegularFile(repo, 'hotlines.json', options).bytes), HOTLINES_SHA256, 'hotlines.json bytes changed');
  assert.deepEqual(ledger.handoff_binding, { path: HANDOFF_PATH, sha256: HANDOFF_SHA256 }, 'canonical legal-review handoff binding changed');
  assert.equal(sha256(readTrackedRegularFile(repo, HANDOFF_PATH, options).bytes), HANDOFF_SHA256, 'legal-review handoff binding changed');
  assert.deepEqual(handoff.provenance_populations.map(({ id }) => id), POPULATION_IDS, 'legal-review handoff provenance population inventory/order changed');
  const populations = synthetic ? [SYNTHETIC_POPULATION_ID] : POPULATION_IDS;
  assert.equal(ledger.purpose, synthetic ? 'synthetic_contract_example_only' : 'qualified_legal_review_preparation_only');
  assert.deepEqual(ledger.populations, populations, 'finite provenance population inventory/order changed');
  assert.deepEqual(ledger.field_groups, FIELD_GROUP_IDS, 'finite field-group inventory/order changed');
  assert.deepEqual(ledger.field_inventory, FIELD_INVENTORY, 'exact group-to-field/path inventory changed');
  assert.deepEqual(ledger.excluded_paths, EXCLUDED_PATHS, 'exact structural/repository exclusion inventory or held wording changed');
  const assigned = ledger.field_inventory.flatMap(({ paths }) => paths);
  assert.equal(new Set(assigned).size, assigned.length, 'canonical field/path is duplicated or reassigned');
  const canonical = parseStrictJson(readTrackedRegularFile(repo, 'hotlines.json', options).bytes, 'hotlines.json');
  assertCanonicalInventory(canonical, ledger);
  const evidenceIds = populations.map((id) => `evidence_${id}`);
  assert.deepEqual(ledger.evidence_catalog.map(({ id }) => id), evidenceIds, 'finite evidence inventory/order changed');
  const evidence = new Map(ledger.evidence_catalog.map((item) => [item.id, item]));
  for (const [i, item] of ledger.evidence_catalog.entries()) {
    exactKeys(item, synthetic ? SYNTHETIC_EVIDENCE_KEYS : REAL_EVIDENCE_KEYS, `evidence ${i}`);
    assert.equal(item.population_id, populations[i], 'evidence population is substituted or reordered');
    if (synthetic) {
      assert.deepEqual(item.synthetic_basis, { kind: 'closed_purpose_specific_synthetic_example', source: README_PATH, resolves_to_real_handoff: false }, 'synthetic evidence basis changed');
    } else {
      assert.equal(item.handoff_pointer, `provenance_populations/${item.population_id}`, 'evidence handoff pointer is unbound');
      const source = handoff.provenance_populations.find(({ id }) => id === item.population_id);
      assert.ok(source, 'evidence population is absent from legal-review handoff');
      assert.deepEqual(item.repository_evidence, source.repository_evidence, 'repository evidence differs from legal-review handoff');
      for (const path of item.repository_evidence) {
        assert.ok(Object.hasOwn(handoff.sources, path), `real repository evidence is absent from handoff sources: ${path}`);
        assert.equal(sha256(readTrackedRegularFile(repo, path, options).bytes), handoff.sources[path], `real repository evidence digest differs from handoff source: ${path}`);
      }
    }
  }
  const expectedPairs = populations.flatMap((population) => FIELD_GROUP_IDS.map((group) => `${population}/${group}`));
  assert.deepEqual(ledger.entries.map(({ population_id, field_group_id }) => `${population_id}/${field_group_id}`), expectedPairs, 'entry coverage/order must be the exact population by field-group cross-product');
  for (const [i, entry] of ledger.entries.entries()) {
    exactKeys(entry, ENTRY_KEYS, `entry ${i}`);
    assert.equal(entry.status, 'held_pending_qualified_legal_review', 'status escalation is prohibited');
    assert.equal(entry.permission_assertion, 'none', 'permission or rights conclusion is prohibited');
    assert.equal(entry.reviewer, null, 'reviewer must remain an unfilled placeholder');
    assert.equal(entry.legal_decision, null, 'legal decision must remain an unfilled placeholder');
    assert.equal(entry.restrictions, 'no_use_for_permission_license_rights_publication_or_record_changes');
    assert.deepEqual(entry.evidence_references, [`evidence_${entry.population_id}`], 'entry evidence must bind exactly its population');
    assert.ok(evidence.has(entry.evidence_references[0]), 'entry evidence reference is unbound');
    assert.equal(entry.notes, synthetic ? SYNTHETIC_HELD_NOTES : REAL_HELD_NOTES, 'notes must remain the exact conservative held wording');
  }
  return ledger;
}

export function loadClearanceArtifacts(repo, options = {}) {
  return withStableGitIndex(repo, options, () => {
    const schemaFile = readTrackedRegularFile(repo, SCHEMA_PATH, options);
    const handoffFile = readTrackedRegularFile(repo, HANDOFF_PATH, options);
    const schema = parseStrictJson(schemaFile.bytes, SCHEMA_PATH);
    const handoff = parseStrictJson(handoffFile.bytes, HANDOFF_PATH);
    assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, ROOT_KEYS);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const loaded = [[LEDGER_PATH, false], [EXAMPLE_PATH, true]].map(([path, synthetic]) => {
      const file = readTrackedRegularFile(repo, path, options); const value = parseStrictJson(file.bytes, path);
      assert.deepEqual(file.bytes, canonicalBytes(value), `${path} must use the one canonical pretty-printed byte representation`);
      assert.ok(validate(value), `${path} fails closed Draft 2020-12 schema: ${new Ajv2020().errorsText(validate.errors)}`);
      return validateLedger(value, handoff, repo, { synthetic, ...options });
    });
    return { ledger: loaded[0], example: loaded[1] };
  });
}
