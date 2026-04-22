const QUERY_STOPWORDS = new Set([
  'a',
  'an',
  'find',
  'for',
  'help',
  'helpline',
  'hotline',
  'i',
  'im',
  'in',
  'line',
  'me',
  'need',
  'please',
  'service',
  'services',
  'show',
  'support',
  'the',
]);

const CATEGORY_ALIASES = {
  child_protection: ['child protection', 'childline', 'youth'],
  domestic_violence: ['domestic violence', 'domestic abuse', 'dv'],
  suicide_crisis: ['suicide crisis', 'suicide', 'suicidal'],
  mental_health: ['mental health'],
  gambling: ['gambling', 'gambling help'],
};

const CATEGORY_LABELS = {
  child_protection: 'Child protection',
  domestic_violence: 'Domestic violence',
  suicide_crisis: 'Suicide crisis',
  mental_health: 'Mental health',
  gambling: 'Gambling',
};

const COUNTRY_ALIASES = {
  'united kingdom': ['uk'],
  'united states': ['usa', 'united states', 'us'],
  'united arab emirates': ['uae'],
};

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniqueNormalizedValues(values) {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function includesToken(text, token) {
  return new RegExp(`(?:^| )${escapeRegExp(token)}(?: |$)`).test(text);
}

function includesPhrase(text, phrase) {
  return new RegExp(`(?:^| )${escapeRegExp(phrase)}(?: |$)`).test(text);
}

function buildCountryMatchers(docs = []) {
  const seen = new Set();
  const matchers = [];

  for (const doc of docs) {
    const country = normalizeText(doc.country_name);
    if (!country) continue;

    const aliases = uniqueNormalizedValues([country, ...(COUNTRY_ALIASES[country] ?? [])]);
    for (const term of aliases) {
      const key = `${country}:${term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matchers.push({
        country,
        label: doc.country_name,
        term,
        exact: term === country,
      });
    }
  }

  return matchers.sort((a, b) => b.term.length - a.term.length || Number(b.exact) - Number(a.exact));
}

function detectCountryIntent(normalizedQuery, docs = []) {
  for (const matcher of buildCountryMatchers(docs)) {
    if (includesPhrase(normalizedQuery, matcher.term)) {
      return {
        value: matcher.country,
        label: matcher.label,
        source: matcher.exact ? 'exact' : 'alias',
        matched: matcher.term,
      };
    }
  }

  return null;
}

function detectCategoryIntent(normalizedQuery) {
  const matchers = Object.entries(CATEGORY_ALIASES)
    .flatMap(([value, aliases]) => uniqueNormalizedValues([value.replace(/_/g, ' '), ...aliases]).map((term) => ({
      value,
      label: CATEGORY_LABELS[value] ?? value.replace(/_/g, ' '),
      term,
      exact: term === value.replace(/_/g, ' '),
    })))
    .sort((a, b) => b.term.length - a.term.length || Number(b.exact) - Number(a.exact));

  for (const matcher of matchers) {
    if (includesPhrase(normalizedQuery, matcher.term)) {
      return {
        value: matcher.value,
        label: matcher.label,
        source: matcher.exact ? 'exact' : 'alias',
        matched: matcher.term,
      };
    }
  }

  return null;
}

export function inferSearchIntent(queryOrParsed, docs = []) {
  const normalized = typeof queryOrParsed === 'string' ? normalizeText(queryOrParsed) : queryOrParsed.normalized;
  const country = detectCountryIntent(normalized, docs);
  const category = detectCategoryIntent(normalized);
  const channels = [];

  if (includesPhrase(normalized, 'chat')) channels.push('chat');
  if (includesPhrase(normalized, 'sms') || includesPhrase(normalized, 'text')) channels.push('sms');

  return {
    country,
    category,
    channels,
  };
}

function extractIntentFilters(normalizedQuery, informativeTokens, docs = []) {
  const filters = [];
  const padded = ` ${normalizedQuery} `;
  const intent = inferSearchIntent(normalizedQuery, docs);

  if (/\bchat\b/.test(padded)) {
    filters.push('chat');
  }

  if (/\bsms\b/.test(padded) || (/\btext\b/.test(padded) && /\b(help|helpline|hotline|line|support)\b/.test(padded))) {
    filters.push('sms');
  }

  if (informativeTokens.includes('us') && informativeTokens.some((token) => token !== 'us')) {
    filters.push('country:united states');
  }

  if (intent.country) {
    filters.push(`country:${intent.country.value}`);
  }

  if (intent.category) {
    filters.push(`category:${intent.category.value}`);
  }

  return [...new Set(filters)];
}

export function parseSearchQuery(query, docs = []) {
  const normalized = normalizeText(query);
  const informativeTokens = normalized
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !QUERY_STOPWORDS.has(token))
    .filter((token) => token.length > 1 || /\d/.test(token));
  const intent = inferSearchIntent(normalized, docs);

  return {
    normalized,
    tokens: informativeTokens.filter((token) => token !== 'chat' && token !== 'sms' && token !== 'text'),
    filters: extractIntentFilters(normalized, informativeTokens, docs),
    intent,
  };
}

export function tokenizeQuery(query) {
  return parseSearchQuery(query).tokens;
}

function buildAliasTerms(doc) {
  return uniqueNormalizedValues([
    ...(CATEGORY_ALIASES[doc.category] ?? []),
    ...(COUNTRY_ALIASES[normalizeText(doc.country_name)] ?? []),
    doc.has_chat ? 'chat online chat' : '',
    doc.has_sms ? 'sms text text message' : '',
  ]);
}

function buildHaystack(doc) {
  return normalizeText([
    doc.country_name,
    doc.name,
    doc.organization,
    doc.category,
    doc.numbers?.join(' '),
    doc.languages?.join(' '),
    buildAliasTerms(doc).join(' '),
  ].join(' '));
}

function getParsedQuery(queryOrParsed) {
  if (typeof queryOrParsed === 'string') return parseSearchQuery(queryOrParsed);
  return queryOrParsed;
}

export function docMatchesQueryFilters(doc, queryOrParsed) {
  const { filters } = getParsedQuery(queryOrParsed);

  for (const filter of filters) {
    if (filter === 'chat' && !doc.has_chat) return false;
    if (filter === 'sms' && !doc.has_sms) return false;
    if (filter === `country:${normalizeText(doc.country_name)}`) continue;
    if (filter.startsWith('country:') && normalizeText(doc.country_name) !== filter.slice(8)) return false;
    if (filter === `category:${doc.category}`) continue;
    if (filter.startsWith('category:') && doc.category !== filter.slice(9)) return false;
  }

  return true;
}

export function scoreDoc(doc, queryOrParsed) {
  const parsed = getParsedQuery(queryOrParsed);
  const { tokens, intent } = parsed;
  if (tokens.length === 0) return 0;

  const haystack = buildHaystack(doc);
  const countryName = normalizeText(doc.country_name);
  const name = normalizeText(doc.name);
  const category = normalizeText(doc.category);
  const organization = normalizeText(doc.organization);
  let score = 0;

  for (const token of tokens) {
    if (!includesToken(haystack, token)) return 0;
    if (includesToken(countryName, token)) score += 4;
    if (includesToken(name, token)) score += 3;
    if (includesToken(category, token)) score += 2;
    if (includesToken(organization, token)) score += 1;
    score += 1;
  }

  if (intent?.country?.value === countryName) {
    score += intent.country.source === 'exact' ? 18 : 12;
  }

  if (intent?.category?.value === doc.category) {
    score += intent.category.source === 'exact' ? 8 : 6;
  }

  if (parsed.filters.includes('chat') && doc.has_chat) score += 2;
  if (parsed.filters.includes('sms') && doc.has_sms) score += 2;
  if (doc.verified) score += 1;
  return score;
}

export function hasMeaningfulQuery(query) {
  return parseSearchQuery(query).tokens.length > 0;
}

/** @param {number} count @param {string} singular @param {string} [plural] */
function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** @param {string} value */
function titleCaseCategory(value) {
  return CATEGORY_LABELS[value] ?? value.replace(/_/g, ' ');
}

/** @param {string[]} [parts] */
function joinParts(parts = []) {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

/** @param {string[]} [filters] */
export function describeActiveFilters(filters = []) {
  const descriptions = [];

  if (filters.includes('verified')) descriptions.push('verified');
  if (filters.includes('chat')) descriptions.push('chat-based');
  if (filters.includes('sms')) descriptions.push('text-based');

  const categoryFilters = filters
    .filter((filter) => filter.startsWith('cat:'))
    .map((filter) => titleCaseCategory(filter.slice(4)).toLowerCase());

  descriptions.push(...categoryFilters);
  return descriptions;
}

/** @param {{ intent?: { country?: { label: string } | null, category?: { label: string } | null } | null, filters: string[], normalized?: string }} parsedQuery @param {string[]} [uiFilters] */
function describeIntent(parsedQuery, uiFilters = []) {
  const country = parsedQuery.intent?.country?.label;
  const category = parsedQuery.intent?.category?.label;
  const qualifiers = [];

  if (uiFilters.includes('verified')) qualifiers.push('verified');
  if (parsedQuery.filters.includes('chat') || uiFilters.includes('chat')) qualifiers.push('chat-based');
  if (parsedQuery.filters.includes('sms') || uiFilters.includes('sms')) qualifiers.push('text-based');

  const base = category ? `${category.toLowerCase()} support` : 'support options';
  const subject = qualifiers.length > 0 ? `${qualifiers.join(' ')} ${base}` : base;
  return country ? `${subject} in ${country}` : subject;
}

/** @param {Array<unknown>} results @param {{ intent?: { country?: { label: string } | null, category?: { label: string } | null } | null, filters: string[], normalized?: string }} parsedQuery @param {string[]} [uiFilters] */
export function buildResultSummary(results, parsedQuery, uiFilters = []) {
  const total = results.length;
  const subject = describeIntent(parsedQuery, uiFilters);
  const queryText = parsedQuery.normalized;

  if (total === 0) {
    if (parsedQuery.intent?.country || parsedQuery.intent?.category || parsedQuery.filters.length > 0 || uiFilters.length > 0) {
      return `I couldn't find any ${subject}.`;
    }
    if (queryText) return `I couldn't find a match for “${queryText}.”`;
    return 'Start typing to search for support options.';
  }

  if (parsedQuery.intent?.country || parsedQuery.intent?.category || parsedQuery.filters.length > 0 || uiFilters.length > 0) {
    return `I found ${pluralize(total, 'result')} for ${subject}.`;
  }

  if (queryText) return `I found ${pluralize(total, 'result')} for “${queryText}.”`;
  return `Showing ${pluralize(total, 'result')}.`;
}

/** @param {number} hiddenCount @param {{ intent?: { country?: { label: string } | null, category?: { label: string } | null } | null, filters: string[] }} parsedQuery @param {string[]} [uiFilters] */
export function buildOverflowSummary(hiddenCount, parsedQuery, uiFilters = []) {
  if (hiddenCount <= 0) return '';
  const subject = describeIntent(parsedQuery, uiFilters);
  return `${pluralize(hiddenCount, 'more option')} available for ${subject} — refine your search to narrow them down.`;
}

/** @param {{ parsedQuery: { intent?: { country?: { label: string } | null, category?: { label: string } | null } | null, filters: string[] }, uiFilters?: string[], relaxedCount?: number, relaxedSummary?: string }} params */
export function buildNoResultsGuidance({ parsedQuery, uiFilters = [], relaxedCount = 0, relaxedSummary = '' }) {
  const subject = describeIntent(parsedQuery, uiFilters);
  const channelRequests = [];

  if (parsedQuery.filters.includes('chat') || uiFilters.includes('chat')) channelRequests.push('chat-based');
  if (parsedQuery.filters.includes('sms') || uiFilters.includes('sms')) channelRequests.push('text-based');

  const filterHints = [];
  if (channelRequests.length > 0) filterHints.push(`removing the ${joinParts(channelRequests)} filter`);
  if (uiFilters.includes('verified')) filterHints.push('broadening beyond verified-only results');

  const suggestions = filterHints.length > 0
    ? `Try ${joinParts(filterHints)}, checking the spelling, or searching by country name.`
    : 'Try checking the spelling, searching by country name, or browsing a broader category.';

  if (relaxedCount > 0 && relaxedSummary) {
    return {
      title: `I couldn't find ${subject}.`,
      detail: `I did find ${pluralize(relaxedCount, 'alternative')} ${relaxedSummary}. ${suggestions}`,
    };
  }

  return {
    title: `I couldn't find ${subject}.`,
    detail: suggestions,
  };
}
