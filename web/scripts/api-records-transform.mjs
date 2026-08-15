import { classifyScope, getHotlineChannels } from '../src/lib/finder.js';

export const API_VERSION = '1.0';

export function canonicalHotline(h) {
  return {
    id: h.id ?? null,
    name: h.name ?? h.organization ?? 'Hotline',
    organization: h.organization ?? null,
    category: h.category ?? 'general_support',
    voice_numbers: h.voice_numbers ?? [],
    sms_numbers: h.sms_numbers ?? [],
    text_numbers: h.text_numbers ?? [],
    short_codes: h.short_codes ?? [],
    chat_url: h.chat_url ?? null,
    email: h.email ?? null,
    website: h.website ?? null,
    hours: h.hours ?? null,
    languages: h.languages ?? [],
    cost: h.cost ?? 'unknown',
    target: h.target ?? null,
    geography: h.geography ?? null,
    notes: h.notes ?? null,
    verification_status: h.verification_status ?? 'legacy_unverified',
    last_verified: h.last_verified ?? null,
    sources: h.sources ?? [],
    ...(h.replaced_by ? { replaced_by: h.replaced_by } : {}),
    ...(h.service_scope ? { service_scope: h.service_scope } : {}),
    ...(h.provenance ? { provenance: h.provenance } : {}),
  };
}

export function buildRecordsArtifact(canonical, datasetVersion) {
  const records = {};
  for (const country of canonical.countries) {
    for (const raw of country.hotlines ?? []) {
      const hotline = canonicalHotline(raw);
      records[hotline.id] = {
        api_version: API_VERSION,
        dataset_version: datasetVersion,
        country_code: country['alpha-2'],
        country_name: country.country,
        ...hotline,
        scope: classifyScope(hotline, country.country),
        channels: getHotlineChannels(hotline),
      };
    }
  }
  return { api_version: API_VERSION, dataset_version: datasetVersion, records };
}
