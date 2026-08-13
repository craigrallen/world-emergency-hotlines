import { utf16Compare } from './dataset-diff.mjs';

const SOURCE_BACKED = new Set(['verified_web', 'verified_authority']);
const FIELDS = ['hours', 'languages', 'target', 'geography'];
const STRUCTURED_SECTIONS = ['geography', 'eligibility', 'availability', 'languages'];
export const LEGACY_COVERAGE_AS_OF = '1970-01-01';

function present(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function normalizedText(value) {
  // Shared modest normalization: NFKC, locale-independent lowercasing, then
  // explicit sharp-s/final-sigma substitutions. This is not full casefolding.
  return String(value).trim().normalize('NFKC').toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ');
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const [, year, month, day] = match;
  if (Number(year) === 0) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  const timestamp = date.getTime();
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return null;
  return timestamp;
}

function metric(count, total) {
  if (!total) return { records: count, percent: 0 };
  const tenths = Math.floor((2 * count * 1000 + total) / (2 * total));
  return { records: count, percent: tenths / 10 };
}

export function coverageAsOf(sourceLastUpdated) {
  // Legacy information.json has no dataset date. A fixed epoch default keeps
  // fallback artifacts reproducible and makes their unknown freshness obvious.
  return parseIsoDate(sourceLastUpdated) === null ? LEGACY_COVERAGE_AS_OF : sourceLastUpdated;
}

export function buildMetadataCoverage(data, asOf, currentDays = 365, datasetVersion = null) {
  const asOfMs = parseIsoDate(asOf);
  if (asOfMs === null) throw new Error('asOf must be a real ISO calendar date (YYYY-MM-DD)');
  if (!Number.isInteger(currentDays) || currentDays < 1) throw new Error('currentDays must be a positive integer');
  const rows = (data.countries ?? []).flatMap((country) => (country.hotlines ?? []).filter((record) => record && typeof record === 'object' && !Array.isArray(record)).map((record) => [country.country ?? '', record]));
  const total = rows.length;
  const presence = Object.fromEntries(FIELDS.map((field) => [field, 0]));
  const evidenced = Object.fromEntries(FIELDS.map((field) => [field, 0]));
  const structured = Object.fromEntries(STRUCTURED_SECTIONS.map((section) => [section, 0]));
  const statuses = {};
  let specific = 0, sourceBacked = 0, dated = 0, current = 0;
  for (const [countryName, record] of rows) {
    const evidence = new Set(Array.isArray(record.provenance?.evidence) ? record.provenance.evidence.map((item) => item?.field).filter((field) => typeof field === 'string' && field.trim()) : []);
    for (const field of FIELDS) {
      if (present(record[field])) presence[field]++;
      if (evidence.has(field)) evidenced[field]++;
    }
    if (typeof record.geography === 'string' && normalizedText(record.geography) !== normalizedText(countryName)) specific++;
    const status = record.verification_status || 'missing';
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (SOURCE_BACKED.has(status)) sourceBacked++;
    if (typeof record.last_verified === 'string') {
      const checkedMs = parseIsoDate(record.last_verified);
      if (checkedMs !== null) {
        dated++;
        const age = Math.floor((asOfMs - checkedMs) / 86400000);
        if (age >= 0 && age <= currentDays) current++;
      }
    }
    if (record.service_scope && typeof record.service_scope === 'object' && !Array.isArray(record.service_scope)) {
      for (const section of STRUCTURED_SECTIONS) if (section in record.service_scope) structured[section]++;
    }
  }
  return {
    schema_version: '1.0', dataset_schema_version: data.$schema_version, dataset_version: datasetVersion,
    as_of: asOf, current_within_days: currentDays, total_records: total,
    field_presence: Object.fromEntries(FIELDS.map((field) => [field, metric(presence[field], total)])),
    geography_specificity: { more_specific_than_country_label: metric(specific, total), country_label_or_equivalent: metric(total - specific, total) },
    field_level_evidence: Object.fromEntries(FIELDS.map((field) => [field, metric(evidenced[field], total)])),
    source_backed_status: metric(sourceBacked, total), dated_verification: metric(dated, total), current_dated_verification: metric(current, total),
    structured_scope_adoption: Object.fromEntries(STRUCTURED_SECTIONS.map((section) => [section, metric(structured[section], total)])),
    verification_statuses: Object.fromEntries(Object.entries(statuses).sort(([a], [b]) => utf16Compare(a, b))),
    interpretation: {
      no_composite_score: true,
      presence: 'A non-empty legacy field is present; this does not prove the claim is current or source-backed.',
      specificity: 'Geography differs from the country label; this does not prove the scope classification is correct.',
      evidence: 'Field-level provenance names the field; consumers must still inspect source type, date, and confidence.',
      structured_scope: 'Optional adoption count for reviewed service_scope sections; zero is valid for legacy records.',
      safety: 'These metrics measure metadata completeness, not service availability, safety, suitability, or eligibility.',
    },
  };
}
