import { createHash } from 'node:crypto';

export const DATASET_DIFF_SCHEMA = '1.0';
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
  for (let index = 1; index < values.length; index++) if (codePointCompare(values[index - 1], values[index]) >= 0) throw new TypeError(`${label} must be strictly Unicode code-point sorted and unique`);
};

// Portable scalar-value ordering, independent of UTF-16 encoding and locale collation.
export function codePointCompare(left, right) {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftPoint = leftPoints.next();
    const rightPoint = rightPoints.next();
    if (leftPoint.done || rightPoint.done) return leftPoint.done ? (rightPoint.done ? 0 : -1) : 1;
    const difference = leftPoint.value.codePointAt(0) - rightPoint.value.codePointAt(0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(codePointCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('undefined is not valid canonical JSON');
  return encoded;
}

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function valueIdentity(value) { return `sha256:${sha256(Buffer.from(canonicalJson(value)))}`; }
export const canonicalFile = (value) => Buffer.from(`${canonicalJson(value)}\n`);
export const byteIdentity = (bytes) => `sha256:${sha256(bytes)}`;

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
    const records = country.hotlines.map((record, recordIndex) => {
      object(record, `${countryCode}.hotlines[${recordIndex}]`);
      const id = string(record.id, `${countryCode}.hotlines[${recordIndex}].id`);
      if (ids.has(id)) throw new TypeError(`duplicate hotline ID: ${id}`);
      ids.add(id);
      const fields = Object.fromEntries(Object.keys(record).sort(codePointCompare).map((field) => [field, valueIdentity(record[field])]));
      return { id, record_hash: valueIdentity(record), fields };
    }).sort((a, b) => codePointCompare(a.id, b.id));
    return { country_code: countryCode, country_name: countryName, records };
  }).sort((a, b) => codePointCompare(a.country_code, b.country_code));
  return { schema_version: '1.0', dataset_version: datasetVersion, countries };
}

export function validateSnapshot(snapshot) {
  closed(snapshot, ['schema_version', 'dataset_version', 'countries'], [], 'snapshot');
  if (snapshot.schema_version !== '1.0') throw new TypeError('unsupported snapshot schema_version');
  hash(snapshot.dataset_version, 'snapshot.dataset_version');
  if (!Array.isArray(snapshot.countries)) throw new TypeError('snapshot.countries must be an array');
  const ids = new Set();
  const codes = [];
  for (const [countryIndex, country] of snapshot.countries.entries()) {
    closed(country, ['country_code', 'country_name', 'records'], [], `snapshot.countries[${countryIndex}]`);
    const code = string(country.country_code, `snapshot.countries[${countryIndex}].country_code`);
    string(country.country_name, `snapshot ${code}.country_name`);
    codes.push(code);
    if (!Array.isArray(country.records)) throw new TypeError(`snapshot ${code}.records must be an array`);
    const recordIds = [];
    for (const [recordIndex, record] of country.records.entries()) {
      closed(record, ['id', 'record_hash', 'fields'], [], `snapshot ${code}.records[${recordIndex}]`);
      const id = string(record.id, `snapshot ${code}.records[${recordIndex}].id`);
      hash(record.record_hash, `snapshot record ${id}.record_hash`);
      object(record.fields, `snapshot record ${id}.fields`);
      if (ids.has(id)) throw new TypeError(`duplicate hotline ID: ${id}`);
      ids.add(id); recordIds.push(id);
      const fields = Object.keys(record.fields);
      assertSortedUnique(fields, `snapshot record ${id} fields`);
      for (const field of fields) { string(field, `snapshot record ${id} field`); hash(record.fields[field], `snapshot record ${id}.${field}`); }
      if (valueIdentity(Object.fromEntries(fields.map((field) => [field, null]))) === record.record_hash) throw new TypeError(`snapshot record ${id} has invalid record hash`);
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

export function diffSnapshots(fromSnapshot, toSnapshot) {
  const from = indexed(fromSnapshot); const to = indexed(toSnapshot);
  const changes = [];
  for (const id of [...new Set([...from.records.keys(), ...to.records.keys()])].sort(codePointCompare)) {
    const before = from.records.get(id); const after = to.records.get(id);
    if (!before) changes.push({ id, change_type: 'added', country_code: after.country_code, country_name: after.country_name });
    else if (!after) changes.push({ id, change_type: 'removed', country_code: before.country_code, country_name: before.country_name });
    else {
      const fields = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])].filter((field) => before.fields[field] !== after.fields[field]).sort(codePointCompare);
      if (before.country_code !== after.country_code) {
        const change = { id, change_type: 'modified', country_code: after.country_code, country_name: after.country_name, country_changed_fields: ['country_code', ...(before.country_name !== after.country_name ? ['country_name'] : [])], moved_from: { country_code: before.country_code, country_name: before.country_name } };
        if (fields.length) change.changed_fields = fields;
        changes.push(change);
      } else if (fields.length || before.record_hash !== after.record_hash) changes.push({ id, change_type: 'modified', country_code: after.country_code, country_name: after.country_name, changed_fields: fields });
    }
  }
  const country_metadata_changes = [];
  for (const code of [...new Set([...from.countries.keys(), ...to.countries.keys()])].sort(codePointCompare)) {
    const before = from.countries.get(code); const after = to.countries.get(code);
    if (before && after && before.country_name !== after.country_name) country_metadata_changes.push({ country_code: code, country_name: after.country_name, previous_country_name: before.country_name, changed_fields: ['country_name'] });
  }
  const summaries = new Map();
  const row = (code, name) => { const current = summaries.get(code) ?? { country_code: code, country_name: name, added: 0, removed: 0, modified: 0, moved_in: 0, moved_out: 0, metadata_changed: 0 }; summaries.set(code, current); return current; };
  for (const change of changes) {
    if (change.moved_from) { row(change.country_code, change.country_name).moved_in++; row(change.moved_from.country_code, change.moved_from.country_name).moved_out++; }
    else row(change.country_code, change.country_name)[change.change_type]++;
  }
  for (const change of country_metadata_changes) row(change.country_code, change.country_name).metadata_changed++;
  const counts = { added: 0, removed: 0, modified: 0, country_metadata_changed: country_metadata_changes.length };
  for (const change of changes) counts[change.change_type]++;
  return { schema_version: DATASET_DIFF_SCHEMA, from_dataset_version: fromSnapshot.dataset_version, to_dataset_version: toSnapshot.dataset_version, counts: { ...counts, total_changes: changes.length + country_metadata_changes.length }, countries: [...summaries.values()].sort((a, b) => codePointCompare(a.country_code, b.country_code)), changes, country_metadata_changes, value_policy: 'No before/after hotline values are published.' };
}

export function diffDatasets(fromDataset, toDataset, versions) {
  return diffSnapshots(snapshotDataset(fromDataset, versions.fromDatasetVersion), snapshotDataset(toDataset, versions.toDatasetVersion));
}
