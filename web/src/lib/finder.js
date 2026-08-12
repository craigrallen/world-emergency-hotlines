const NATIONAL_TERMS = [
  'nationwide', 'national', 'all areas', 'countrywide', 'across the country',
];
const COUNTY_TERMS = ['county', 'parish', 'borough', 'census area', 'municipality'];
const STATE_TERMS = ['statewide', 'state of ', 'province', 'territory', 'region'];

export function normalizeFinderText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function getHotlineChannels(hotline) {
  return {
    phone: Boolean(hotline?.voice_numbers?.length || hotline?.short_codes?.length),
    text: Boolean(hotline?.sms_numbers?.length || hotline?.text_numbers?.length),
    chat: Boolean(hotline?.chat_url),
  };
}

export function matchesChannel(hotline, channel) {
  if (!channel || channel === 'any') return true;
  return Boolean(getHotlineChannels(hotline)[channel]);
}

export function classifyScope(hotline, countryName = '') {
  const geography = normalizeFinderText(hotline?.geography);
  const country = normalizeFinderText(countryName);

  if (!geography || geography === country || NATIONAL_TERMS.some((term) => geography.includes(term))) {
    return 'national';
  }
  if (COUNTY_TERMS.some((term) => geography.includes(term))) return 'county';
  if (STATE_TERMS.some((term) => geography.includes(term))) return 'state';
  return 'local';
}

function localityMatches(hotline, locality) {
  const query = normalizeFinderText(locality);
  if (!query) return false;
  return String(hotline?.geography ?? '')
    .split(/[,;/|()]+/)
    .map((part) => normalizeFinderText(part))
    .filter(Boolean)
    .some((part) => part === query);
}

function verificationRank(status) {
  return {
    verified_authority: 0,
    verified_web: 1,
    verified_knowledge: 2,
    cross_referenced: 3,
    legacy_unverified: 4,
    disputed: 5,
    deprecated: 6,
  }[status] ?? 7;
}

function sortHotlines(hotlines) {
  return [...hotlines].sort((a, b) => (
    verificationRank(a.verification_status) - verificationRank(b.verification_status)
    || String(a.name).localeCompare(String(b.name))
    || String(a.id).localeCompare(String(b.id))
  ));
}

export function resolveGuidedHelp({ country, category, channel = 'any', locality = '' }) {
  const active = (country?.hotlines ?? []).filter((hotline) => hotline.verification_status !== 'deprecated');
  const needMatches = category ? active.filter((hotline) => hotline.category === category) : active;
  const localityMatchesForNeed = locality
    ? needMatches.filter((hotline) => localityMatches(hotline, locality))
    : [];
  const localChannelMatches = localityMatchesForNeed.filter((hotline) => matchesChannel(hotline, channel));

  if (localChannelMatches.length) {
    return {
      scope: classifyScope(localChannelMatches[0], country?.country),
      reason: `Found ${localChannelMatches.length} ${category ? 'need-matched ' : ''}service${localChannelMatches.length === 1 ? '' : 's'} whose recorded coverage mentions “${locality}”${channel !== 'any' ? ` and offers ${channel}` : ''}.`,
      results: sortHotlines(localChannelMatches),
      fallback: false,
    };
  }

  const nationalNeedMatches = needMatches.filter((hotline) => classifyScope(hotline, country?.country) === 'national');
  const nationalChannelMatches = nationalNeedMatches.filter((hotline) => matchesChannel(hotline, channel));
  if (nationalChannelMatches.length) {
    let reason;
    if (locality && localityMatchesForNeed.length && channel !== 'any') {
      reason = `Recorded local services for “${locality}” do not offer ${channel}. Showing national ${category ? 'need-matched ' : ''}services that do.`;
    } else if (locality) {
      reason = `No ${category ? 'need-matched ' : ''}service with recorded coverage mentioning “${locality}” was found. Showing national services${channel !== 'any' ? ` offering ${channel}` : ''}.`;
    } else {
      reason = `Showing national ${category ? 'need-matched ' : ''}services${channel !== 'any' ? ` offering ${channel}` : ''}.`;
    }
    return { scope: 'national', reason, results: sortHotlines(nationalChannelMatches), fallback: Boolean(locality) };
  }

  const needMatchesAnyChannel = localityMatchesForNeed.length
    ? localityMatchesForNeed
    : nationalNeedMatches.length
      ? nationalNeedMatches
      : needMatches;
  if (channel !== 'any' && needMatchesAnyChannel.length) {
    return {
      scope: localityMatchesForNeed.length ? classifyScope(localityMatchesForNeed[0], country?.country) : 'national',
      reason: `No ${category ? 'need-matched ' : ''}service offering ${channel} was found for this location. Showing services available through other channels.`,
      results: sortHotlines(needMatchesAnyChannel),
      fallback: true,
    };
  }

  const generalSupport = active.filter((hotline) => ['general_support', 'mental_health', 'suicide_crisis'].includes(hotline.category));
  return {
    scope: 'country',
    reason: category
      ? `No service in the “${category.replace(/_/g, ' ')}” category was found for this country. Showing broader crisis and support options instead.`
      : 'Showing the broadest crisis and support options recorded for this country.',
    results: sortHotlines(generalSupport.length ? generalSupport : active),
    fallback: true,
  };
}
