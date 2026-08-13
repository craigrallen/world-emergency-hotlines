import { createHash } from 'node:crypto';

export const DATASET_DIFF_SCHEMA = '2.0';
export const SNAPSHOT_SCHEMA = '2.0';
export const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
};
const closed = (value, required, optional, label) => {
  object(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label} has unknown field: ${key}`);
  for (const key of required) if (!own(value, key)) throw new TypeError(`${label} is missing field: ${key}`);
  return value;
};
const string = (value, label) => {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be a non-empty control-free string`);
  return value;
};
const hash = (value, label) => {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new TypeError(`${label} must be a lowercase sha256 identity`);
  return value;
};
const assertSortedUnique = (values, label) => {
  for (let index = 1; index < values.length; index++) if (utf16Compare(values[index - 1], values[index]) >= 0) throw new TypeError(`${label} must be strictly JavaScript UTF-16 code-unit sorted and unique`);
};

// JavaScript's relational string comparison is lexicographic UTF-16 code-unit order.
export function utf16Compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(utf16Compare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('undefined is not valid canonical JSON');
  return encoded;
}

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function valueIdentity(value) { return `sha256:${sha256(Buffer.from(canonicalJson(value)))}`; }
export const canonicalFile = (value) => Buffer.from(`${canonicalJson(value)}\n`);
export const byteIdentity = (bytes) => `sha256:${sha256(bytes)}`;

const fieldHashes = (value, excluded = new Set()) => Object.fromEntries(Object.keys(value).filter((field) => !excluded.has(field)).sort(utf16Compare).map((field) => [field, valueIdentity(value[field])]));

export function snapshotDataset(dataset, datasetVersion) {
  object(dataset, 'dataset');
  if (!Array.isArray(dataset.countries)) throw new TypeError('dataset.countries must be an array');
  hash(datasetVersion, 'dataset_version');
  const ids = new Set();
  const codes = new Set();
  const countries = dataset.countries.map((country, countryIndex) => {
    object(country, `countries[${countryIndex}]`);
    if (!Array.isArray(country.hotlines)) throw new TypeError(`countries[${countryIndex}].hotlines must be an array`);
    const countryCode = string(country['alpha-2'], `countries[${countryIndex}].alpha-2`);
    const countryName = string(country.country, `countries[${countryIndex}].country`);
    if (codes.has(countryCode)) throw new TypeError(`duplicate country code: ${countryCode}`);
    codes.add(countryCode);
    const countryFields = fieldHashes(country, new Set(['hotlines']));
    const records = country.hotlines.map((record, recordIndex) => {
      object(record, `${countryCode}.hotlines[${recordIndex}]`);
      const id = string(record.id, `${countryCode}.hotlines[${recordIndex}].id`);
      if (ids.has(id)) throw new TypeError(`duplicate hotline ID: ${id}`);
      ids.add(id);
      return { id, record_hash: valueIdentity(record), fields: fieldHashes(record) };
    }).sort((a, b) => utf16Compare(a.id, b.id));
    return { country_code: countryCode, country_name: countryName, fields: countryFields, records };
  }).sort((a, b) => utf16Compare(a.country_code, b.country_code));
  return { schema_version: SNAPSHOT_SCHEMA, dataset_version: datasetVersion, countries };
}

function validateFields(fields, label) {
  object(fields, label);
  const names = Object.keys(fields);
  if (names.length === 0) throw new TypeError(`${label} must be non-empty`);
  assertSortedUnique(names, label);
  for (const field of names) { string(field, `${label} field`); hash(fields[field], `${label}.${field}`); }
  return names;
}

export function validateSnapshot(snapshot) {
  closed(snapshot, ['schema_version', 'dataset_version', 'countries'], [], 'snapshot');
  if (snapshot.schema_version !== SNAPSHOT_SCHEMA) throw new TypeError('unsupported snapshot schema_version');
  hash(snapshot.dataset_version, 'snapshot.dataset_version');
  if (!Array.isArray(snapshot.countries)) throw new TypeError('snapshot.countries must be an array');
  const ids = new Set(); const codes = [];
  for (const [countryIndex, country] of snapshot.countries.entries()) {
    closed(country, ['country_code', 'country_name', 'fields', 'records'], [], `snapshot.countries[${countryIndex}]`);
    const code = string(country.country_code, `snapshot.countries[${countryIndex}].country_code`);
    const name = string(country.country_name, `snapshot ${code}.country_name`);
    codes.push(code);
    const countryFields = validateFields(country.fields, `snapshot ${code} country fields`);
    if (!countryFields.includes('alpha-2') || country.fields['alpha-2'] !== valueIdentity(code)) throw new TypeError(`snapshot ${code} country fields must exactly hash country_code`);
    if (!countryFields.includes('country') || country.fields.country !== valueIdentity(name)) throw new TypeError(`snapshot ${code} country fields must exactly hash country_name`);
    if (countryFields.includes('hotlines')) throw new TypeError(`snapshot ${code} country fields must omit hotlines`);
    if (!Array.isArray(country.records)) throw new TypeError(`snapshot ${code}.records must be an array`);
    const recordIds = [];
    for (const [recordIndex, record] of country.records.entries()) {
      closed(record, ['id', 'record_hash', 'fields'], [], `snapshot ${code}.records[${recordIndex}]`);
      const id = string(record.id, `snapshot ${code}.records[${recordIndex}].id`);
      hash(record.record_hash, `snapshot record ${id}.record_hash`);
      const fields = validateFields(record.fields, `snapshot record ${id} fields`);
      if (!fields.includes('id')) throw new TypeError(`snapshot record ${id} fields must include id`);
      if (record.fields.id !== valueIdentity(id)) throw new TypeError(`snapshot record ${id} fields.id must exactly hash record id`);
      if (ids.has(id)) throw new TypeError(`duplicate hotline ID: ${id}`);
      ids.add(id); recordIds.push(id);
    }
    assertSortedUnique(recordIds, `snapshot ${code} record IDs`);
  }
  assertSortedUnique(codes, 'snapshot country codes');
  return snapshot;
}

function indexed(snapshot) {
  const countries = new Map(); const records = new Map();
  for (const country of validateSnapshot(snapshot).countries) {
    countries.set(country.country_code, country);
    for (const record of country.records) records.set(record.id, { ...record, country_code: country.country_code, country_name: country.country_name });
  }
  return { countries, records };
}

const changedFields = (before, after) => [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((field) => before?.[field] !== after?.[field]).sort(utf16Compare);

export function diffSnapshots(fromSnapshot, toSnapshot) {
  const from = indexed(fromSnapshot); const to = indexed(toSnapshot);
  const changes = [];
  for (const id of [...new Set([...from.records.keys(), ...to.records.keys()])].sort(utf16Compare)) {
    const before = from.records.get(id); const after = to.records.get(id);
    if (!before) changes.push({ id, change_type: 'added', country_code: after.country_code, country_name: after.country_name });
    else if (!after) changes.push({ id, change_type: 'removed', country_code: before.country_code, country_name: before.country_name });
    else {
      const fields = changedFields(before.fields, after.fields);
      if (before.country_code !== after.country_code) {
        const change = { id, change_type: 'modified', country_code: after.country_code, country_name: after.country_name, country_changed_fields: ['country_code', ...(before.country_name !== after.country_name ? ['country_name'] : [])], moved_from: { country_code: before.country_code, country_name: before.country_name } };
        if (fields.length) change.changed_fields = fields;
        changes.push(change);
      } else if (fields.length || before.record_hash !== after.record_hash) changes.push({ id, change_type: 'modified', country_code: after.country_code, country_name: after.country_name, changed_fields: fields });
    }
  }
  const country_metadata_changes = [];
  for (const code of [...new Set([...from.countries.keys(), ...to.countries.keys()])].sort(utf16Compare)) {
    const before = from.countries.get(code); const after = to.countries.get(code);
    if (!before) country_metadata_changes.push({ country_code: code, country_name: after.country_name, change_type: 'added', changed_fields: Object.keys(after.fields) });
    else if (!after) country_metadata_changes.push({ country_code: code, country_name: before.country_name, change_type: 'removed', changed_fields: Object.keys(before.fields) });
    else {
      const fields = changedFields(before.fields, after.fields);
      if (fields.length) country_metadata_changes.push({ country_code: code, country_name: after.country_name, change_type: 'modified', changed_fields: fields });
    }
  }
  const summaries = new Map();
  const row = (code, name) => { const current = summaries.get(code) ?? { country_code: code, country_name: name, added: 0, removed: 0, modified: 0, moved_in: 0, moved_out: 0, metadata_added: 0, metadata_removed: 0, metadata_modified: 0 }; summaries.set(code, current); return current; };
  for (const change of changes) {
    if (change.moved_from) { row(change.country_code, change.country_name).moved_in++; row(change.moved_from.country_code, change.moved_from.country_name).moved_out++; }
    else row(change.country_code, change.country_name)[change.change_type]++;
  }
  for (const change of country_metadata_changes) row(change.country_code, change.country_name)[`metadata_${change.change_type}`]++;
  const counts = { added: 0, removed: 0, modified: 0, country_metadata_added: 0, country_metadata_removed: 0, country_metadata_modified: 0 };
  for (const change of changes) counts[change.change_type]++;
  for (const change of country_metadata_changes) counts[`country_metadata_${change.change_type}`]++;
  const countryMetadataTotal = counts.country_metadata_added + counts.country_metadata_removed + counts.country_metadata_modified;
  return { schema_version: DATASET_DIFF_SCHEMA, from_dataset_version: fromSnapshot.dataset_version, to_dataset_version: toSnapshot.dataset_version, counts: { ...counts, country_metadata_changed: countryMetadataTotal, total_changes: changes.length + countryMetadataTotal }, countries: [...summaries.values()].sort((a, b) => utf16Compare(a.country_code, b.country_code)), changes, country_metadata_changes, value_policy: 'Only field names and cryptographic identities are compared; no before/after field values are published.' };
}

export function diffDatasets(fromDataset, toDataset, versions) {
  return diffSnapshots(snapshotDataset(fromDataset, versions.fromDatasetVersion), snapshotDataset(toDataset, versions.toDatasetVersion));
}
