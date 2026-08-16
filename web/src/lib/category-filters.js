import { dedupeMessageContacts, isSafeHttpUrl, phoneContacts } from './contact.ts';

export const SOURCE_CHECKED_STATUSES = new Set([
  'verified_web',
  'verified_authority',
  'verified_knowledge',
]);

export const EVIDENCE_FILTERS = ['source_checked', 'cross_referenced', 'other_evidence'];
export const CHANNEL_FILTERS = ['phone', 'text', 'chat', 'website'];
export const CHANNEL_LABELS = {
  phone: 'Phone',
  text: 'SMS/text',
  chat: 'Online chat',
  website: 'Website',
};

export function evidenceClass(status) {
  if (SOURCE_CHECKED_STATUSES.has(status)) return 'source_checked';
  if (status === 'cross_referenced') return 'cross_referenced';
  return 'other_evidence';
}

export function getUsableContactChannels(hotline) {
  return {
    phone: phoneContacts(hotline?.voice_numbers ?? [], hotline?.short_codes ?? []).some(({ uri }) => Boolean(uri)),
    text: dedupeMessageContacts(hotline?.sms_numbers ?? [], hotline?.text_numbers ?? []).some(({ uri }) => Boolean(uri)),
    chat: isSafeHttpUrl(hotline?.chat_url),
    website: isSafeHttpUrl(hotline?.website),
  };
}

export function categoryFilterRecord(hotline) {
  const channels = getUsableContactChannels(hotline);
  return {
    id: String(hotline?.id ?? ''),
    evidence: evidenceClass(hotline?.verification_status),
    channels: CHANNEL_FILTERS.filter((channel) => channels[channel]),
  };
}

export function filterCategoryRecords(records, filters = {}) {
  const evidence = new Set(filters.evidence ?? []);
  const channels = new Set(filters.channels ?? []);
  return records.filter((record) => (
    (evidence.size === 0 || evidence.has(record.evidence))
    && (channels.size === 0 || record.channels.some((channel) => channels.has(channel)))
  ));
}

export function categoryFilterSummary(id, hotlines) {
  return { id: String(id), records: hotlines.map(categoryFilterRecord) };
}

/** Derive aggregate display labels from the same safe per-record metadata used by filters. */
export function categorySummaryChannelLabels(summary) {
  const available = new Set(summary.records.flatMap((record) => record.channels));
  return CHANNEL_FILTERS.filter((channel) => available.has(channel)).map((channel) => CHANNEL_LABELS[channel]);
}

export function filterCategorySummaries(summaries, filters = {}) {
  return summaries.filter((summary) => filterCategoryRecords(summary.records, filters).length > 0);
}

export function availableCategoryFilterValues(
  summaries,
  { evidence = EVIDENCE_FILTERS, channels = CHANNEL_FILTERS } = {},
) {
  return {
    evidence: evidence.filter((value) => filterCategorySummaries(summaries, { evidence: [value] }).length > 0),
    channels: channels.filter((value) => filterCategorySummaries(summaries, { channels: [value] }).length > 0),
  };
}
