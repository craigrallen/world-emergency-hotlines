import assert from 'node:assert/strict';

import docs from '../public/data/search-index.json' with { type: 'json' };
import { 
  buildNoResultsGuidance,
  buildNoResultsSuggestions,
  buildOverflowSummary,
  buildResultSummary,
  docMatchesQueryFilters,
  inferSearchIntent,
  parseSearchQuery,
  resolveSearchNavigation,
  scoreDoc,
} from '../src/lib/search.js';

function searchDocs(query, limit = 5) {
  const parsed = parseSearchQuery(query, docs);
  if (parsed.tokens.length === 0 && parsed.filters.length === 0) return [];

  return docs
    .filter((doc) => docMatchesQueryFilters(doc, parsed))
    .map((doc) => ({ doc, score: parsed.tokens.length > 0 ? scoreDoc(doc, parsed) : (doc.verified ? 1 : 0) }))
    .filter((entry) => entry.score > 0 || (parsed.filters.length > 0 && parsed.tokens.length === 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc }) => doc);
}

function search(query, limit = 5) {
  return searchDocs(query, limit).map((doc) => `${doc.country_name}:${doc.name}`);
}

const swedenQueries = ['help sweden', 'sweden help', 'need help in sweden'];

for (const query of swedenQueries) {
  const results = search(query);
  assert.ok(results.length > 0, `Expected results for query: ${query}`);
  assert.ok(
    results.some((entry) => entry.startsWith('Sweden:')),
    `Expected Sweden in top matches for query: ${query}. Got: ${results.join(', ')}`,
  );
}

const specificResults = search('sweden domestic violence', 10);
assert.ok(
  specificResults.some((entry) => entry.startsWith('Sweden:Kvinnofridslinjen')),
  `Expected Sweden domestic violence hotline match. Got: ${specificResults.join(', ')}`,
);

const aliasChecks = [
  {
    query: 'sweden domestic abuse',
    expected: 'Sweden:Kvinnofridslinjen',
  },
  {
    query: 'suicidal sweden',
    expected: 'Sweden:Mind Självmordslinjen',
  },
  {
    query: 'childline sweden',
    expectedPrefix: 'Sweden:',
  },
  {
    query: 'mental health uae',
    expectedPrefix: 'United Arab Emirates:',
  },
  {
    query: 'gambling help sweden',
    expected: 'Sweden:Stödlinjen (problem gambling)',
  },
];

for (const check of aliasChecks) {
  const results = search(check.query, 10);
  assert.ok(results.length > 0, `Expected results for alias query: ${check.query}`);
  if (check.expected) {
    assert.ok(
      results.includes(check.expected),
      `Expected ${check.expected} for query: ${check.query}. Got: ${results.join(', ')}`,
    );
  }
  if (check.expectedPrefix) {
    assert.ok(
      results.some((entry) => entry.startsWith(check.expectedPrefix)),
      `Expected prefix ${check.expectedPrefix} for query: ${check.query}. Got: ${results.join(', ')}`,
    );
  }
}

function firstCountryForCategory(category) {
  const match = docs.find((doc) => doc.category === category);
  assert.ok(match, `Expected search-index.json to contain category ${category}`);
  return match.country_name;
}

const specialistCategoryAliasChecks = [
  { category: 'sexual_violence', aliases: ['sexual violence', 'sexual assault', 'rape crisis', 'rape support'] },
  { category: 'human_trafficking', aliases: ['human trafficking', 'trafficking'] },
  { category: 'stalking', aliases: ['stalking', 'stalker'] },
  { category: 'male_victims', aliases: ['male victims', "men's helpline", 'mens helpline', 'men abuse', 'male abuse'] },
  { category: 'elder_abuse', aliases: ['elder abuse', 'older people abuse', 'senior abuse'] },
  { category: 'substance_use', aliases: ['substance use', 'addiction', 'drug help', 'alcohol help'] },
  { category: 'eating_disorders', aliases: ['eating disorder', 'eating disorders'] },
  { category: 'refugee_migrant', aliases: ['refugee', 'migrant', 'asylum'] },
  { category: 'lgbtqia', aliases: ['lgbt', 'lgbtq', 'lgbtqia'] },
  { category: 'veterans', aliases: ['veteran', 'veterans'] },
];

for (const check of specialistCategoryAliasChecks) {
  const country = firstCountryForCategory(check.category);
  for (const alias of check.aliases) {
    const query = `${alias} ${country}`;
    const parsed = parseSearchQuery(query, docs);
    assert.equal(
      parsed.intent.category?.value,
      check.category,
      `Expected ${check.category} category intent for ${query}. Got: ${JSON.stringify(parsed.intent.category)}`,
    );
    assert.equal(
      parsed.intent.country?.label,
      country,
      `Expected ${country} country intent for ${query}. Got: ${JSON.stringify(parsed.intent.country)}`,
    );
    assert.ok(
      parsed.filters.includes(`category:${check.category}`),
      `Expected ${check.category} category filter for ${query}. Got: ${parsed.filters.join(', ')}`,
    );
    assert.ok(
      parsed.filters.includes(`country:${parsed.intent.country.value}`),
      `Expected ${country} country filter for ${query}. Got: ${parsed.filters.join(', ')}`,
    );

    const resultDocs = searchDocs(query, 10);
    assert.ok(resultDocs.length > 0, `Expected country-scoped ${check.category} results for ${query}`);
    assert.ok(
      resultDocs.every((doc) => doc.country_name === country),
      `Expected only ${country} results for ${query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.category}`).join(', ')}`,
    );
    assert.ok(
      resultDocs.every((doc) => doc.category === check.category),
      `Expected only ${check.category} results for ${query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.category}`).join(', ')}`,
    );
  }
}

const emergencyIntentChecks = [
  { query: 'police sweden', expectedCountry: 'Sweden' },
  { query: 'ambulance france', expectedCountry: 'France' },
  { query: 'fire canada', expectedCountry: 'Canada' },
  { query: 'emergency number uk', expectedCountry: 'United Kingdom' },
  { query: '112 sweden', expectedCountry: 'Sweden' },
  { query: '911 usa', expectedCountry: 'United States' },
  { query: '999 uk', expectedCountry: 'United Kingdom' },
  { query: '000 australia', expectedCountry: 'Australia' },
];

for (const check of emergencyIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.category?.value,
    'emergency',
    `Expected emergency category intent for ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.ok(
    parsed.filters.includes('category:emergency'),
    `Expected emergency category filter for ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  const resultNames = resultDocs.map((doc) => `${doc.country_name}:${doc.name}`);
  assert.ok(resultDocs.length > 0, `Expected emergency-service results for ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected country-scoped emergency results for ${check.query}. Got: ${resultNames.join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === 'emergency'),
    `Expected only emergency category results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const spanishAliasIntentChecks = [
  { query: 'salud mental españa', expectedCountry: 'Spain', expectedCategory: 'mental_health' },
  { query: 'salud mental espana', expectedCountry: 'Spain', expectedCategory: 'mental_health' },
  { query: 'violencia domestica mexico', expectedCountry: 'Mexico', expectedCategory: 'domestic_violence' },
  { query: 'policia francia', expectedCountry: 'France', expectedCategory: 'emergency' },
  { query: 'bomberos canada', expectedCountry: 'Canada', expectedCategory: 'emergency' },
];

for (const check of spanishAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Spanish query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Spanish query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Spanish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Spanish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Spanish query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const ukEmergencyNumberResults = searchDocs('999 uk', 10);
assert.ok(
  ukEmergencyNumberResults.every((doc) => doc.country_name === 'United Kingdom' && doc.category === 'emergency'),
  `Expected 999 uk not to rank non-emergency UK entries. Got: ${ukEmergencyNumberResults.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
);

const alpha2CountryIntentChecks = [
  { query: 'emergency se', expectedCountry: 'Sweden', expectedMatched: 'se', expectedCategory: 'emergency' },
  { query: '112 se', expectedCountry: 'Sweden', expectedMatched: 'se', expectedCategory: 'emergency' },
  { query: 'suicide gb', expectedCountry: 'United Kingdom', expectedMatched: 'gb', expectedCategory: 'suicide_crisis' },
  { query: '988 us', expectedCountry: 'United States', expectedMatched: 'us' },
];

for (const check of alpha2CountryIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for alpha-2 query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.country?.matched,
    check.expectedMatched,
    `Expected alpha-2 match ${check.expectedMatched} for ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  if (check.expectedCategory) {
    assert.equal(
      parsed.intent.category?.value,
      check.expectedCategory,
      `Expected ${check.expectedCategory} category intent for ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
    );
    assert.ok(
      parsed.filters.includes(`category:${check.expectedCategory}`),
      `Expected ${check.expectedCategory} category filter for ${check.query}. Got: ${parsed.filters.join(', ')}`,
    );
  }

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for alpha-2 query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  if (check.expectedCategory) {
    assert.ok(
      resultDocs.every((doc) => doc.category === check.expectedCategory),
      `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
    );
  }
}

const us988Results = searchDocs('988 us', 10);
assert.ok(
  us988Results.some((doc) => doc.country_name === 'United States' && /988/.test(`${doc.name} ${doc.numbers?.join(' ')}`)),
  `Expected 988 us to find a United States 988 result. Got: ${us988Results.map((doc) => `${doc.country_name}:${doc.name}`).join(', ')}`,
);

const channelChecks = [
  {
    query: 'chat support sweden',
    country: 'Sweden:',
    predicate: (entry) => entry === 'Sweden:Mind Självmordslinjen' || entry === 'Sweden:BRIS Barnens hjälptelefon',
  },
  {
    query: 'text helpline canada',
    country: 'Canada:',
    predicate: (entry) => entry === 'Canada:9-8-8 Suicide Crisis Helpline' || entry === 'Canada:Kids Help Phone',
  },
  {
    query: 'sms support australia',
    country: 'Australia:',
    predicate: (entry) => entry === 'Australia:Lifeline Australia' || entry === 'Australia:Triple Zero (000)',
  },
];

for (const check of channelChecks) {
  const results = search(check.query, 10);
  assert.ok(results.length > 0, `Expected results for channel query: ${check.query}`);
  assert.ok(
    results.every((entry) => entry.startsWith(check.country)),
    `Expected country-scoped channel matches for ${check.query}. Got: ${results.join(', ')}`,
  );
  assert.ok(
    results.some(check.predicate),
    `Expected a channel-capable result for ${check.query}. Got: ${results.join(', ')}`,
  );
}

const parsedCountryAliases = [
  ['uk suicide hotline', 'uk'],
  ['usa mental health', 'usa'],
  ['us suicide help', 'country:united states'],
  ['uae mental health', 'uae'],
  ['emergency se', 'country:sweden'],
  ['112 se', 'country:sweden'],
  ['suicide gb', 'country:united kingdom'],
  ['988 us', 'country:united states'],
];

for (const [query, expectedTokenOrFilter] of parsedCountryAliases) {
  const parsed = parseSearchQuery(query, docs);
  assert.ok(
    parsed.tokens.includes(expectedTokenOrFilter) || parsed.filters.includes(expectedTokenOrFilter),
    `Expected parsed query ${query} to preserve country synonym signal. Got tokens=${parsed.tokens.join(',')} filters=${parsed.filters.join(',')}`,
  );
}

const parsedIntent = parseSearchQuery('chat support sweden domestic violence', docs);
assert.equal(parsedIntent.intent.country?.label, 'Sweden');
assert.equal(parsedIntent.intent.category?.value, 'domestic_violence');
assert.ok(parsedIntent.filters.includes('chat'), `Expected chat filter. Got: ${parsedIntent.filters.join(', ')}`);
assert.ok(parsedIntent.filters.includes('country:sweden'), `Expected Sweden filter. Got: ${parsedIntent.filters.join(', ')}`);
assert.ok(parsedIntent.filters.includes('category:domestic_violence'), `Expected domestic violence filter. Got: ${parsedIntent.filters.join(', ')}`);

const mockCountryDocs = [
  {
    country_name: 'Sweden',
    name: 'SafeLine',
    organization: 'Official Service',
    category: 'general_support',
    numbers: [],
    languages: [],
    verified: true,
    has_chat: false,
    has_sms: false,
  },
  {
    country_name: 'Norway',
    name: 'Sweden Support Service',
    organization: 'Regional Network',
    category: 'general_support',
    numbers: [],
    languages: [],
    verified: true,
    has_chat: false,
    has_sms: false,
  },
];

const exactCountryParsed = parseSearchQuery('sweden support', mockCountryDocs);
assert.ok(
  scoreDoc(mockCountryDocs[0], exactCountryParsed) > scoreDoc(mockCountryDocs[1], exactCountryParsed),
  'Expected exact country match to outrank broader alias/name matches for "sweden support".',
);

const inferredAliasIntent = inferSearchIntent('mental health uae', docs);
assert.equal(inferredAliasIntent.country?.label, 'United Arab Emirates');
assert.equal(inferredAliasIntent.category?.value, 'mental_health');

const fillerOnlyResults = search('please help me', 5);
assert.equal(fillerOnlyResults.length, 0, `Expected filler-only query to stay quiet. Got: ${fillerOnlyResults.join(', ')}`);

const ambiguousIsoCodeParsed = parseSearchQuery('please help me', docs);
assert.equal(
  ambiguousIsoCodeParsed.intent.country,
  null,
  `Expected filler pronoun "me" not to become Montenegro country intent. Got: ${JSON.stringify(ambiguousIsoCodeParsed.intent.country)}`,
);

const summaryParsed = parseSearchQuery('mental health uae', docs);
const summaryResults = docs.filter((doc) => docMatchesQueryFilters(doc, summaryParsed));
assert.equal(
  buildResultSummary(summaryResults, summaryParsed),
  `I found ${summaryResults.length} results for mental health support in United Arab Emirates.`,
);

const navigationCountryParsed = parseSearchQuery('i am in sweden', docs);
assert.equal(
  resolveSearchNavigation({ parsedQuery: navigationCountryParsed, docs }),
  '/country/se',
  'Expected clear country intent to navigate to the country page.',
);

const navigationCategoryParsed = parseSearchQuery('mental health', docs);
assert.equal(
  resolveSearchNavigation({ parsedQuery: navigationCategoryParsed, docs }),
  '/category/mental_health',
  'Expected category-only intent to navigate to the category page.',
);

const navigationTopResultParsed = parseSearchQuery('mind', docs);
const navigationTopResultDocs = docs
  .filter((doc) => docMatchesQueryFilters(doc, navigationTopResultParsed))
  .map((doc) => ({ doc, score: scoreDoc(doc, navigationTopResultParsed) }))
  .filter((entry) => entry.score > 0)
  .sort((a, b) => b.score - a.score)
  .map(({ doc }) => doc);
assert.equal(
  resolveSearchNavigation({ parsedQuery: navigationTopResultParsed, results: navigationTopResultDocs, docs }),
  `/country/${navigationTopResultDocs[0].country_code.toLowerCase()}`,
  'Expected fallback navigation to use the top-ranked country result.',
);

assert.equal(
  resolveSearchNavigation({ parsedQuery: parseSearchQuery('qzxw nonexistent', docs), docs }),
  null,
  'Expected no navigation target when there is no clear intent or ranked result.',
);

const noResultParsed = parseSearchQuery('chat support sweden domestic violence', docs);
const noResultGuidance = buildNoResultsGuidance({
  parsedQuery: noResultParsed,
  docs,
  relaxedCount: 1,
  relaxedSummary: 'in Sweden without that channel requirement',
});
assert.equal(noResultGuidance.title, "I couldn't find chat-based domestic violence support in Sweden.");
assert.match(noResultGuidance.detail, /I did find 1 alternative in Sweden without that channel requirement\./);
assert.ok(
  noResultGuidance.suggestions.some((item) => item.includes('without the chat/text requirement')),
  `Expected channel relaxation suggestion. Got: ${noResultGuidance.suggestions.join(' | ')}`,
);
assert.ok(
  noResultGuidance.suggestions.some((item) => item.includes('Sweden with')),
  `Expected country/category suggestion. Got: ${noResultGuidance.suggestions.join(' | ')}`,
);

const typoParsed = parseSearchQuery('swedn', docs);
const typoSuggestions = buildNoResultsSuggestions({ parsedQuery: typoParsed, docs });
assert.ok(
  typoSuggestions.some((item) => item.includes('Sweden')),
  `Expected spelling suggestion for Sweden typo. Got: ${typoSuggestions.join(' | ')}`,
);

const categoryOnlyParsed = parseSearchQuery('mental health', docs);
const categorySuggestions = buildNoResultsSuggestions({ parsedQuery: categoryOnlyParsed, docs });
assert.ok(
  categorySuggestions.some((item) => item.includes('mental health in')),
  `Expected actionable country suggestions for category-only intent. Got: ${categorySuggestions.join(' | ')}`,
);

assert.equal(
  buildOverflowSummary(3, summaryParsed),
  '3 more options available for mental health support in United Arab Emirates — refine your search to narrow them down.',
);

console.log('search verification passed');
