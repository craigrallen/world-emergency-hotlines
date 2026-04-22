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
  scoreDoc,
} from '../src/lib/search.js';

function search(query, limit = 5) {
  const parsed = parseSearchQuery(query, docs);
  if (parsed.tokens.length === 0 && parsed.filters.length === 0) return [];

  return docs
    .filter((doc) => docMatchesQueryFilters(doc, parsed))
    .map((doc) => ({ doc, score: parsed.tokens.length > 0 ? scoreDoc(doc, parsed) : (doc.verified ? 1 : 0) }))
    .filter((entry) => entry.score > 0 || (parsed.filters.length > 0 && parsed.tokens.length === 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc }) => `${doc.country_name}:${doc.name}`);
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

const summaryParsed = parseSearchQuery('mental health uae', docs);
const summaryResults = docs.filter((doc) => docMatchesQueryFilters(doc, summaryParsed));
assert.equal(
  buildResultSummary(summaryResults, summaryParsed),
  `I found ${summaryResults.length} results for mental health support in United Arab Emirates.`,
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
