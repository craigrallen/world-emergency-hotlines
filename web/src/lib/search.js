const INTENT_STOPWORDS = new Set([
  'a',
  'an',
  'find',
  'for',
  'help',
  'i',
  'im',
  'in',
  'me',
  'need',
  'please',
  'show',
  'the',
]);

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenizeQuery(query) {
  return normalizeText(query)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !INTENT_STOPWORDS.has(token))
    .filter((token) => token.length > 1 || /\d/.test(token));
}

function buildHaystack(doc) {
  return normalizeText([
    doc.country_name,
    doc.region,
    doc.subregion,
    doc.name,
    doc.organization,
    doc.category,
    doc.numbers?.join(' '),
    doc.languages?.join(' '),
  ].join(' '));
}

export function scoreDoc(doc, query) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return 0;

  const haystack = buildHaystack(doc);
  const countryName = normalizeText(doc.country_name);
  const name = normalizeText(doc.name);
  const category = normalizeText(doc.category);
  const organization = normalizeText(doc.organization);
  let score = 0;

  for (const token of tokens) {
    if (!haystack.includes(token)) return 0;
    if (countryName.includes(token)) score += 4;
    if (name.includes(token)) score += 3;
    if (category.includes(token)) score += 2;
    if (organization.includes(token)) score += 1;
    score += 1;
  }

  if (doc.verified) score += 1;
  return score;
}

export function hasMeaningfulQuery(query) {
  return tokenizeQuery(query).length > 0;
}