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
  'number',
  'numbers',
  'please',
  'service',
  'services',
  'show',
  'support',
  'the',
]);

const CATEGORY_ALIASES = {
  emergency: ['emergency', 'emergency number', 'emergency services', 'police', 'policia', 'polizia', 'ambulance', 'fire', 'vigili del fuoco', 'bomberos', 'pompiers', 'urgence', 'numero urgence', '112', '911', '999', '000', 'emergencia', 'numero emergencia', 'emergenza', 'numero emergenza', 'bombeiros', 'polizei', 'feuerwehr', 'notruf', 'politie', 'brandweer', 'noodnummer', 'noodgeval', 'polis', 'ambulans', 'brandkår', 'nödnummer', 'politi', 'brandvaesen', 'brandvæsen', 'brannvesen', 'alarm 112', 'nodnummer', 'nødnummer', 'poliisi', 'palokunta', 'hätänumero', 'hatanumero', 'policja', 'straz pozarna', 'straż pożarna', 'numer alarmowy', 'pogotowie'],
  child_protection: ['child protection', 'childline', 'youth', 'protection enfance', 'enfance danger', 'protecao infantil', 'protecao crianca', 'kinderschutz', 'protezione minori', 'protezione bambini', 'kinderbescherming', 'barnskydd', 'bornebeskyttelse', 'børnebeskyttelse', 'barnevern', 'alarmtelefonen', 'lastensuojelu', 'ochrona dzieci', 'pomoc dzieciom'],
  domestic_violence: ['domestic violence', 'domestic abuse', 'violencia domestica', 'violence domestique', 'violences conjugales', 'dv', 'haeusliche gewalt', 'häusliche gewalt', 'violenza domestica', 'huiselijk geweld', 'våld i hemmet', 'vold i hjemmet', 'perheväkivalta', 'perhevakivalta', 'przemoc domowa'],
  suicide_crisis: ['suicide crisis', 'suicide', 'suicidal', 'suicidaire', 'suicidio', 'suicida', 'suizid', 'suizidal', 'zelfmoord', 'suicidaal', 'självmord', 'selvmord', 'itsemurha', 'samobojstwo', 'samobójstwo'],
  mental_health: ['mental health', 'salud mental', 'sante mentale', 'saude mental', 'psychische gesundheit', 'salute mentale', 'mentale gezondheid', 'geestelijke gezondheid', 'psykisk hälsa', 'psykisk sundhed', 'psykisk helse', 'mielenterveys', 'zdrowie psychiczne'],
  gambling: ['gambling', 'gambling help'],
  sexual_violence: ['sexual violence', 'sexual assault', 'rape crisis', 'rape support'],
  human_trafficking: ['human trafficking', 'trafficking'],
  stalking: ['stalking', 'stalker'],
  male_victims: ['male victims', "men's helpline", 'mens helpline', 'men abuse', 'male abuse'],
  elder_abuse: ['elder abuse', 'older people abuse', 'senior abuse'],
  substance_use: ['substance use', 'addiction', 'drug help', 'alcohol help'],
  eating_disorders: ['eating disorder', 'eating disorders'],
  refugee_migrant: ['refugee', 'migrant', 'asylum'],
  lgbtqia: ['lgbt', 'lgbtq', 'lgbtqia'],
  veterans: ['veteran', 'veterans'],
};

const CATEGORY_LABELS = {
  emergency: 'Emergency',
  child_protection: 'Child protection',
  domestic_violence: 'Domestic violence',
  suicide_crisis: 'Suicide crisis',
  mental_health: 'Mental health',
  gambling: 'Gambling',
  sexual_violence: 'Sexual violence',
  human_trafficking: 'Human trafficking',
  stalking: 'Stalking',
  male_victims: 'Male victims',
  elder_abuse: 'Elder abuse',
  substance_use: 'Substance use',
  eating_disorders: 'Eating disorders',
  refugee_migrant: 'Refugee and migrant',
  lgbtqia: 'LGBTQIA+',
  veterans: 'Veterans',
};

const COUNTRY_ALIASES = {
  brazil: ['brasil'],
  belgium: ['belgie', 'belgië'],
  netherlands: ['nederland'],
  finland: ['suomi', 'finlandia'],
  france: ['francia', 'franca', 'frankreich', 'frankrijk', 'frankrike', 'ranska', 'francja'],
  spain: ['espana', 'espagne', 'espanha', 'spanien', 'spagna', 'spanje', 'espanja', 'hiszpania'],
  germany: ['allemagne', 'alemanha', 'deutschland', 'germania', 'duitsland', 'tyskland', 'saksa', 'niemcy'],
  italy: ['italia', 'italie', 'italië'],
  'united kingdom': ['uk', 'royaume uni', 'reino unido', 'vereinigtes koenigreich', 'vereinigtes königreich', 'regno unito', 'verenigd koninkrijk', 'storbritannien', 'storbritannia', 'yhdistynyt kuningaskunta', 'wielka brytania'],
  'united states': ['usa', 'united states', 'us', 'etats unis', 'estados unidos', 'vereinigte staaten', 'stati uniti', 'verenigde staten', 'förenta staterna', 'forenede stater', 'forente stater', 'yhdysvallat', 'stany zjednoczone'],
  'united arab emirates': ['uae'],
  sweden: ['sverige', 'ruotsi', 'szwecja'],
  denmark: ['danmark', 'tanska', 'dania'],
  norway: ['norge', 'norja', 'norwegia'],
  poland: ['polska'],
};

const AMBIGUOUS_COUNTRY_CODE_ALIASES = new Set([
  ...QUERY_STOPWORDS,
  'am',
  'as',
  'at',
  'be',
  'by',
  'do',
  'it',
  'my',
  'no',
  'so',
  'to',
]);

function getCountryAliasTerms(doc) {
  const country = normalizeText(doc.country_name);
  const alpha2 = normalizeText(doc.country_code);
  return uniqueNormalizedValues([
    country,
    ...(COUNTRY_ALIASES[country] ?? []),
    /^[a-z]{2}$/.test(alpha2) && !AMBIGUOUS_COUNTRY_CODE_ALIASES.has(alpha2) ? alpha2 : '',
  ]);
}

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

    const aliases = getCountryAliasTerms(doc);
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
    ...getCountryAliasTerms(doc).filter((term) => term !== normalizeText(doc.country_name)),
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

function uniqueDocsByHotline(docs = []) {
  const seen = new Set();
  return docs.filter((doc) => {
    const key = `${doc.country_name}::${doc.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

/**
 * @param {{ parsedQuery: { intent?: { country?: { label: string } | null, category?: { value: string } | null } | null }, results?: Array<any>, docs?: Array<any>, uiFilters?: string[] }} params
 */
export function resolveSearchNavigation({ parsedQuery, results = [], docs = [], uiFilters = [] }) {
  const countryLabel = parsedQuery.intent?.country?.label;
  if (countryLabel) {
    const countryMatch = [...results, ...docs].find(
      (doc) => normalizeText(doc.country_name) === normalizeText(countryLabel),
    );
    if (countryMatch?.country_code) {
      return `/country/${countryMatch.country_code.toLowerCase()}`;
    }
  }

  const categoryIntent = !parsedQuery.intent?.country ? parsedQuery.intent?.category?.value : null;
  if (categoryIntent) {
    return `/category/${categoryIntent}`;
  }

  const categoryUiFilters = uiFilters.filter((filter) => filter.startsWith('cat:'));
  if (!parsedQuery.intent?.country && categoryUiFilters.length === 1) {
    return `/category/${categoryUiFilters[0].slice(4)}`;
  }

  const topResult = results[0];
  if (topResult?.country_code) {
    return `/country/${topResult.country_code.toLowerCase()}`;
  }

  return null;
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index]);
  for (let column = 0; column <= b.length; column += 1) rows[0][column] = column;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
    }
  }

  return rows[a.length][b.length];
}

function findClosestTerm(rawQuery, docs = []) {
  const parsed = getParsedQuery(rawQuery);
  const query = typeof rawQuery === 'string' ? rawQuery : rawQuery.normalized;
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return null;

  const countries = new Map();
  for (const doc of docs) {
    const country = normalizeText(doc.country_name);
    if (!country) continue;
    countries.set(country, doc.country_name);
  }

  const categories = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({
    value,
    label,
    normalized: normalizeText(label),
  }));

  const candidates = [
    ...Array.from(countries.entries()).map(([normalized, label]) => ({
      kind: 'country',
      label,
      normalized,
    })),
    ...categories.map((category) => ({
      kind: 'category',
      label: category.label,
      normalized: category.normalized,
    })),
  ];

  const queryCandidates = [normalizedQuery, ...parsed.tokens].filter(Boolean);
  let best = null;

  for (const source of queryCandidates) {
    for (const candidate of candidates) {
      const distance = levenshteinDistance(source, candidate.normalized);
      const threshold = candidate.normalized.length <= 6 ? 2 : 3;
      if (distance > threshold) continue;
      if (!best || distance < best.distance || (distance === best.distance && candidate.normalized.length > best.normalized.length)) {
        best = { ...candidate, distance };
      }
    }
  }

  return best;
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

/** @param {{ parsedQuery: { intent?: { country?: { label: string } | null, category?: { label: string } | null } | null, filters: string[] }, uiFilters?: string[], docs?: Array<any>, relaxedCount?: number }} params */
export function buildNoResultsSuggestions({ parsedQuery, uiFilters = [], docs = [], relaxedCount = 0 }) {
  const suggestions = [];
  const baseDocs = uniqueDocsByHotline(docs);
  const nonChannelQuery = {
    ...parsedQuery,
    filters: parsedQuery.filters.filter((filter) => filter !== 'chat' && filter !== 'sms'),
  };
  const nonChannelUiFilters = uiFilters.filter((filter) => filter !== 'chat' && filter !== 'sms');

  const countryMatches = parsedQuery.intent?.country
    ? baseDocs.filter((doc) => normalizeText(doc.country_name) === normalizeText(parsedQuery.intent.country.label))
    : [];
  const categoryMatches = parsedQuery.intent?.category
    ? baseDocs.filter((doc) => doc.category === parsedQuery.intent.category.value)
    : [];
  const relaxedMatches = baseDocs
    .filter((doc) => docMatchesQueryFilters(doc, nonChannelQuery))
    .filter((doc) => nonChannelUiFilters.every((filter) => {
      if (filter === 'verified') return doc.verified;
      if (filter.startsWith('cat:')) return doc.category === filter.slice(4);
      return true;
    }));

  if (relaxedCount > 0) {
    suggestions.push('Try the same search without the chat/text requirement.');
  }

  if (uiFilters.includes('verified')) {
    const broaderMatches = baseDocs.filter((doc) => docMatchesQueryFilters(doc, parsedQuery));
    if (broaderMatches.some((doc) => !doc.verified)) {
      suggestions.push('Turn off “Verified only” to include broader directory matches.');
    }
  }

  if (parsedQuery.intent?.country && countryMatches.length > 0) {
    const topCategories = [...new Map(
      countryMatches
        .map((doc) => doc.category)
        .sort()
        .map((category) => [category, category]),
    ).values()].slice(0, 3).map((category) => titleCaseCategory(category));
    if (topCategories.length > 0) {
      suggestions.push(`Try ${parsedQuery.intent.country.label} with ${joinParts(topCategories.map((label) => label.toLowerCase()))}.`);
    }
  }

  if (!parsedQuery.intent?.country && parsedQuery.intent?.category && categoryMatches.length > 0) {
    const topCountries = [...new Map(
      categoryMatches
        .map((doc) => [normalizeText(doc.country_name), doc.country_name])
        .sort((a, b) => a[1].localeCompare(b[1])),
    ).values()].slice(0, 3);
    if (topCountries.length > 0) {
      suggestions.push(`Try ${parsedQuery.intent.category.label.toLowerCase()} in ${joinParts(topCountries)}.`);
    }
  }

  if (!parsedQuery.intent?.country && !parsedQuery.intent?.category) {
    const correction = findClosestTerm(parsedQuery, baseDocs);
    if (correction) {
      suggestions.push(`Did you mean ${correction.label}?`);
    }
  }

  if (suggestions.length === 0 && relaxedMatches.length > 0) {
    const sample = relaxedMatches.slice(0, 3).map((doc) => `${doc.country_name} (${titleCaseCategory(doc.category).toLowerCase()})`);
    suggestions.push(`Try ${joinParts(sample)} instead.`);
  }

  return suggestions.slice(0, 3);
}

/** @param {{ parsedQuery: { intent?: { country?: { label: string } | null, category?: { label: string } | null } | null, filters: string[] }, uiFilters?: string[], docs?: Array<any>, relaxedCount?: number, relaxedSummary?: string }} params */
export function buildNoResultsGuidance({ parsedQuery, uiFilters = [], docs = [], relaxedCount = 0, relaxedSummary = '' }) {
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
  const suggestionItems = buildNoResultsSuggestions({ parsedQuery, uiFilters, docs, relaxedCount });

  if (relaxedCount > 0 && relaxedSummary) {
    return {
      title: `I couldn't find ${subject}.`,
      detail: `I did find ${pluralize(relaxedCount, 'alternative')} ${relaxedSummary}. ${suggestions}`,
      suggestions: suggestionItems,
    };
  }

  return {
    title: `I couldn't find ${subject}.`,
    detail: suggestions,
    suggestions: suggestionItems,
  };
}
