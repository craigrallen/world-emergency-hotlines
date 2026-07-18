import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import docs from '../public/data/search-index.json' with { type: 'json' };
import { 
  buildNoResultsGuidance,
  buildNoResultsSuggestions,
  buildOverflowSummary,
  buildResultSummary,
  docMatchesQueryFilters,
  inferSearchIntent,
  normalizeText,
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

const frenchAliasIntentChecks = [
  { query: 'sante mentale allemagne', expectedCountry: 'Germany', expectedCategory: 'mental_health' },
  { query: 'santé mentale allemagne', expectedCountry: 'Germany', expectedCategory: 'mental_health' },
  { query: 'violence domestique canada', expectedCountry: 'Canada', expectedCategory: 'domestic_violence' },
  { query: 'violences conjugales france', expectedCountry: 'France', expectedCategory: 'domestic_violence' },
  { query: 'pompiers royaume uni', expectedCountry: 'United Kingdom', expectedCategory: 'emergency' },
  { query: 'urgence espagne', expectedCountry: 'Spain', expectedCategory: 'emergency' },
  { query: 'suicidaire etats unis', expectedCountry: 'United States', expectedCategory: 'suicide_crisis' },
  { query: 'protection enfance france', expectedCountry: 'France', expectedCategory: 'child_protection' },
];

for (const check of frenchAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for French query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for French query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for French query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for French query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for French query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const portugueseAliasIntentChecks = [
  { query: 'saude mental brasil', expectedCountry: 'Brazil', expectedCategory: 'mental_health' },
  { query: 'violencia domestica brasil', expectedCountry: 'Brazil', expectedCategory: 'domestic_violence' },
  { query: 'suicidio brasil', expectedCountry: 'Brazil', expectedCategory: 'suicide_crisis' },
  { query: 'protecao infantil brasil', expectedCountry: 'Brazil', expectedCategory: 'child_protection' },
  { query: 'bombeiros brasil', expectedCountry: 'Brazil', expectedCategory: 'emergency' },
  { query: 'emergencia alemanha', expectedCountry: 'Germany', expectedCategory: 'emergency' },
];

for (const check of portugueseAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Portuguese query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Portuguese query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Portuguese query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Portuguese query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Portuguese query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const germanAliasIntentChecks = [
  { query: 'psychische gesundheit deutschland', expectedCountry: 'Germany', expectedCategory: 'mental_health' },
  { query: 'häusliche gewalt frankreich', expectedCountry: 'France', expectedCategory: 'domestic_violence' },
  { query: 'haeusliche gewalt frankreich', expectedCountry: 'France', expectedCategory: 'domestic_violence' },
  { query: 'polizei spanien', expectedCountry: 'Spain', expectedCategory: 'emergency' },
  { query: 'feuerwehr vereinigtes königreich', expectedCountry: 'United Kingdom', expectedCategory: 'emergency' },
  { query: 'notruf vereinigtes koenigreich', expectedCountry: 'United Kingdom', expectedCategory: 'emergency' },
  { query: 'suizidal vereinigte staaten', expectedCountry: 'United States', expectedCategory: 'suicide_crisis' },
  { query: 'kinderschutz deutschland', expectedCountry: 'Germany', expectedCategory: 'child_protection' },
];

for (const check of germanAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for German query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for German query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for German query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for German query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for German query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const italianAliasIntentChecks = [
  { query: 'salute mentale spagna', expectedCountry: 'Spain', expectedCategory: 'mental_health' },
  { query: 'violenza domestica francia', expectedCountry: 'France', expectedCategory: 'domestic_violence' },
  { query: 'polizia spagna', expectedCountry: 'Spain', expectedCategory: 'emergency' },
  { query: 'vigili del fuoco regno unito', expectedCountry: 'United Kingdom', expectedCategory: 'emergency' },
  { query: 'numero emergenza germania', expectedCountry: 'Germany', expectedCategory: 'emergency' },
  { query: 'suicida stati uniti', expectedCountry: 'United States', expectedCategory: 'suicide_crisis' },
  { query: 'protezione minori italia', expectedCountry: 'Italy', expectedCategory: 'child_protection' },
];

for (const check of italianAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Italian query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Italian query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Italian query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Italian query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Italian query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const dutchAliasIntentChecks = [
  { query: 'mentale gezondheid nederland', expectedCountry: 'Netherlands', expectedCategory: 'mental_health' },
  { query: 'huiselijk geweld belgie', expectedCountry: 'Belgium', expectedCategory: 'domestic_violence' },
  { query: 'huiselijk geweld belgië', expectedCountry: 'Belgium', expectedCategory: 'domestic_violence' },
  { query: 'politie spanje', expectedCountry: 'Spain', expectedCategory: 'emergency' },
  { query: 'brandweer verenigd koninkrijk', expectedCountry: 'United Kingdom', expectedCategory: 'emergency' },
  { query: 'noodnummer duitsland', expectedCountry: 'Germany', expectedCategory: 'emergency' },
  { query: 'suicidaal verenigde staten', expectedCountry: 'United States', expectedCategory: 'suicide_crisis' },
  { query: 'kinderbescherming nederland', expectedCountry: 'Netherlands', expectedCategory: 'child_protection' },
];

for (const check of dutchAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Dutch query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Dutch query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Dutch query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Dutch query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Dutch query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const swedishAliasIntentChecks = [
  { query: 'psykisk hälsa danmark', expectedCountry: 'Denmark', expectedCategory: 'mental_health' },
  { query: 'våld i hemmet sverige', expectedCountry: 'Sweden', expectedCategory: 'domestic_violence' },
  { query: 'vald i hemmet sverige', expectedCountry: 'Sweden', expectedCategory: 'domestic_violence' },
  { query: 'polis frankrike', expectedCountry: 'France', expectedCategory: 'emergency' },
  { query: 'brandkår storbritannien', expectedCountry: 'United Kingdom', expectedCategory: 'emergency' },
  { query: 'nödnummer norge', expectedCountry: 'Norway', expectedCategory: 'emergency' },
  { query: 'sjalvmord forenta staterna', expectedCountry: 'United States', expectedCategory: 'suicide_crisis' },
  { query: 'barnskydd sverige', expectedCountry: 'Sweden', expectedCategory: 'child_protection' },
];

for (const check of swedishAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Swedish query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Swedish query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Swedish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Swedish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Swedish query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const danishAliasIntentChecks = [
  { query: 'psykisk sundhed danmark', expectedCountry: 'Denmark', expectedCategory: 'mental_health' },
  { query: 'vold i hjemmet danmark', expectedCountry: 'Denmark', expectedCategory: 'domestic_violence' },
  { query: 'politi danmark', expectedCountry: 'Denmark', expectedCategory: 'emergency' },
  { query: 'brandvæsen danmark', expectedCountry: 'Denmark', expectedCategory: 'emergency' },
  { query: 'alarm 112 danmark', expectedCountry: 'Denmark', expectedCategory: 'emergency' },
  { query: 'nødnummer danmark', expectedCountry: 'Denmark', expectedCategory: 'emergency' },
  { query: 'selvmord forenede stater', expectedCountry: 'United States', expectedCategory: 'suicide_crisis' },
  { query: 'børnebeskyttelse danmark', expectedCountry: 'Denmark', expectedCategory: 'child_protection' },
];

for (const check of danishAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Danish query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Danish query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Danish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Danish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Danish query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const norwegianAliasIntentChecks = [
  { query: 'psykisk helse norge', expectedCountry: 'Norway', expectedCategory: 'mental_health' },
  { query: 'vold i hjemmet norge', expectedCountry: 'Norway', expectedCategory: 'domestic_violence' },
  { query: 'politi norge', expectedCountry: 'Norway', expectedCategory: 'emergency' },
  { query: 'brannvesen norge', expectedCountry: 'Norway', expectedCategory: 'emergency' },
  { query: 'nødnummer norge', expectedCountry: 'Norway', expectedCategory: 'emergency' },
  { query: 'selvmord storbritannia', expectedCountry: 'United Kingdom', expectedCategory: 'suicide_crisis' },
  { query: 'barnevern norge', expectedCountry: 'Norway', expectedCategory: 'child_protection' },
];

for (const check of norwegianAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Norwegian query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Norwegian query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Norwegian query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Norwegian query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Norwegian query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const finnishAliasIntentChecks = [
  { query: 'mielenterveys norja', expectedCountry: 'Norway', expectedCategory: 'mental_health' },
  { query: 'perheväkivalta ruotsi', expectedCountry: 'Sweden', expectedCategory: 'domestic_violence' },
  { query: 'perhevakivalta tanska', expectedCountry: 'Denmark', expectedCategory: 'domestic_violence' },
  { query: 'poliisi saksa', expectedCountry: 'Germany', expectedCategory: 'emergency' },
  { query: 'palokunta ranska', expectedCountry: 'France', expectedCategory: 'emergency' },
  { query: 'hätänumero espanja', expectedCountry: 'Spain', expectedCategory: 'emergency' },
  { query: 'hatanumero yhdistynyt kuningaskunta', expectedCountry: 'United Kingdom', expectedCategory: 'emergency' },
  { query: 'itsemurha yhdysvallat', expectedCountry: 'United States', expectedCategory: 'suicide_crisis' },
  { query: 'lastensuojelu suomi', expectedCountry: 'Finland', expectedCategory: 'child_protection' },
];

for (const check of finnishAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Finnish query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Finnish query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Finnish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Finnish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Finnish query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const polishAliasIntentChecks = [
  { query: 'zdrowie psychiczne norwegia', expectedCountry: 'Norway', expectedCategory: 'mental_health' },
  { query: 'przemoc domowa szwecja', expectedCountry: 'Sweden', expectedCategory: 'domestic_violence' },
  { query: 'przemoc domowa dania', expectedCountry: 'Denmark', expectedCategory: 'domestic_violence' },
  { query: 'policja niemcy', expectedCountry: 'Germany', expectedCategory: 'emergency' },
  { query: 'straz pozarna francja', expectedCountry: 'France', expectedCategory: 'emergency' },
  { query: 'numer alarmowy hiszpania', expectedCountry: 'Spain', expectedCategory: 'emergency' },
  { query: 'numer alarmowy wielka brytania', expectedCountry: 'United Kingdom', expectedCategory: 'emergency' },
  { query: 'samobojstwo stany zjednoczone', expectedCountry: 'United States', expectedCategory: 'suicide_crisis' },
  { query: 'ochrona dzieci polska', expectedCountry: 'Poland', expectedCategory: 'child_protection' },
];

for (const check of polishAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Polish query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Polish query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Polish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Polish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Polish query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const turkishAliasIntentChecks = [
  { query: 'ruh sagligi almanya', expectedCountry: 'Germany', expectedCategory: 'mental_health' },
  { query: 'ev ici siddet isvec', expectedCountry: 'Sweden', expectedCategory: 'domestic_violence' },
  { query: 'aile ici siddet danimarka', expectedCountry: 'Denmark', expectedCategory: 'domestic_violence' },
  { query: 'itfaiye fransa', expectedCountry: 'France', expectedCategory: 'emergency' },
  { query: 'acil numara ispanya', expectedCountry: 'Spain', expectedCategory: 'emergency' },
  { query: 'acil durum birlesik krallik', expectedCountry: 'United Kingdom', expectedCategory: 'emergency' },
  { query: 'intihar amerika birlesik devletleri', expectedCountry: 'United States', expectedCategory: 'suicide_crisis' },
  { query: 'cocuk koruma almanya', expectedCountry: 'Germany', expectedCategory: 'child_protection' },
  { query: 'acil turkiye', expectedCountry: 'Turkey', expectedCategory: 'emergency' },
];

for (const check of turkishAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Turkish query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Turkish query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Turkish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Turkish query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Turkish query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const arabicAliasIntentChecks = [
  { query: 'الصحة النفسية الإمارات', expectedCountry: 'United Arab Emirates', expectedCategory: 'mental_health' },
  { query: 'العنف المنزلي مصر', expectedCountry: 'Egypt', expectedCategory: 'domestic_violence' },
  { query: 'شرطة السعودية', expectedCountry: 'Saudi Arabia', expectedCategory: 'emergency' },
  { query: 'رقم الطوارئ المغرب', expectedCountry: 'Morocco', expectedCategory: 'emergency' },
  // Jordan's directory has no suicide_crisis entries yet, so only intent/filter parsing is asserted here.
  { query: 'انتحار الأردن', expectedCountry: 'Jordan', expectedCategory: 'suicide_crisis', intentOnly: true },
  { query: 'حماية الطفل لبنان', expectedCountry: 'Lebanon', expectedCategory: 'child_protection' },
  { query: 'اسعاف فرنسا', expectedCountry: 'France', expectedCategory: 'emergency' },
  // Sweden's directory has no mental_health entries yet, so only intent/filter parsing is asserted here.
  { query: 'الصحة النفسية السويد', expectedCountry: 'Sweden', expectedCategory: 'mental_health', intentOnly: true },
];

for (const check of arabicAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Arabic query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Arabic query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Arabic query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Arabic query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  if (check.intentOnly) continue;

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Arabic query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const hindiAliasIntentChecks = [
  { query: 'मानसिक स्वास्थ्य भारत', expectedCountry: 'India', expectedCategory: 'mental_health' },
  { query: 'घरेलू हिंसा भारत', expectedCountry: 'India', expectedCategory: 'domestic_violence' },
  { query: 'आपातकाल भारत', expectedCountry: 'India', expectedCategory: 'emergency' },
  { query: 'आत्महत्या भारत', expectedCountry: 'India', expectedCategory: 'suicide_crisis' },
  { query: 'बाल संरक्षण भारत', expectedCountry: 'India', expectedCategory: 'child_protection' },
  { query: 'पुलिस फ्रांस', expectedCountry: 'France', expectedCategory: 'emergency' },
  { query: 'मानसिक स्वास्थ्य जर्मनी', expectedCountry: 'Germany', expectedCategory: 'mental_health' },
  { query: 'घरेलू हिंसा स्वीडन', expectedCountry: 'Sweden', expectedCategory: 'domestic_violence' },
  { query: 'आत्महत्या अमेरिका', expectedCountry: 'United States', expectedCategory: 'suicide_crisis' },
];

for (const check of hindiAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Hindi query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Hindi query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Hindi query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Hindi query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  if (check.intentOnly) continue;

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Hindi query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const chineseAliasIntentChecks = [
  { query: '心理健康 法国', expectedCountry: 'France', expectedCategory: 'mental_health' },
  { query: '家庭暴力 德国', expectedCountry: 'Germany', expectedCategory: 'domestic_violence' },
  { query: '紧急 西班牙', expectedCountry: 'Spain', expectedCategory: 'emergency' },
  { query: '自杀 英国', expectedCountry: 'United Kingdom', expectedCategory: 'suicide_crisis' },
  { query: '儿童保护 美国', expectedCountry: 'United States', expectedCategory: 'child_protection' },
  { query: '警察 加拿大', expectedCountry: 'Canada', expectedCategory: 'emergency' },
  { query: '心理健康 印度', expectedCountry: 'India', expectedCategory: 'mental_health' },
  { query: '家暴 澳大利亚', expectedCountry: 'Australia', expectedCategory: 'domestic_violence' },
  // Sweden's directory has no mental_health entries yet, so only intent/filter parsing is asserted here.
  { query: '心理健康 瑞典', expectedCountry: 'Sweden', expectedCategory: 'mental_health', intentOnly: true },
  // The UAE's directory has no suicide_crisis entries yet, so only intent/filter parsing is asserted here.
  { query: '自杀 阿联酋', expectedCountry: 'United Arab Emirates', expectedCategory: 'suicide_crisis', intentOnly: true },
  // China's directory has no child_protection entries yet, so only intent/filter parsing is asserted here.
  { query: '儿童保护 中国', expectedCountry: 'China', expectedCategory: 'child_protection', intentOnly: true },
];

for (const check of chineseAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Chinese query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Chinese query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Chinese query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Chinese query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  if (check.intentOnly) continue;

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Chinese query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

const japaneseAliasIntentChecks = [
  { query: 'メンタルヘルス フランス', expectedCountry: 'France', expectedCategory: 'mental_health' },
  { query: 'ドメスティックバイオレンス ドイツ', expectedCountry: 'Germany', expectedCategory: 'domestic_violence' },
  { query: '緊急 スペイン', expectedCountry: 'Spain', expectedCategory: 'emergency' },
  { query: '自殺 イギリス', expectedCountry: 'United Kingdom', expectedCategory: 'suicide_crisis' },
  { query: '児童虐待 アメリカ', expectedCountry: 'United States', expectedCategory: 'child_protection' },
  { query: '警察 カナダ', expectedCountry: 'Canada', expectedCategory: 'emergency' },
  { query: 'メンタルヘルス インド', expectedCountry: 'India', expectedCategory: 'mental_health' },
  { query: '家庭内暴力 オーストラリア', expectedCountry: 'Australia', expectedCategory: 'domestic_violence' },
  { query: '緊急 日本', expectedCountry: 'Japan', expectedCategory: 'emergency' },
  { query: 'メンタルヘルス 日本', expectedCountry: 'Japan', expectedCategory: 'mental_health' },
  { query: 'ドメスティックバイオレンス 日本', expectedCountry: 'Japan', expectedCategory: 'domestic_violence' },
  { query: '自殺 日本', expectedCountry: 'Japan', expectedCategory: 'suicide_crisis' },
  { query: '児童虐待 日本', expectedCountry: 'Japan', expectedCategory: 'child_protection' },
  // Sweden's directory has no mental_health entries yet, so only intent/filter parsing is asserted here.
  { query: 'メンタルヘルス スウェーデン', expectedCountry: 'Sweden', expectedCategory: 'mental_health', intentOnly: true },
  // China's directory has no child_protection entries yet, so only intent/filter parsing is asserted here.
  { query: '児童虐待 中国', expectedCountry: 'China', expectedCategory: 'child_protection', intentOnly: true },
];

for (const check of japaneseAliasIntentChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for Japanese query ${check.query}. Got: ${JSON.stringify(parsed.intent.country)}`,
  );
  assert.equal(
    parsed.intent.category?.value,
    check.expectedCategory,
    `Expected ${check.expectedCategory} category intent for Japanese query ${check.query}. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.ok(
    parsed.filters.includes(`country:${check.expectedCountry.toLowerCase()}`),
    `Expected ${check.expectedCountry} country filter for Japanese query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );
  assert.ok(
    parsed.filters.includes(`category:${check.expectedCategory}`),
    `Expected ${check.expectedCategory} category filter for Japanese query ${check.query}. Got: ${parsed.filters.join(', ')}`,
  );

  if (check.intentOnly) continue;

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(resultDocs.length > 0, `Expected results for Japanese query ${check.query}`);
  assert.ok(
    resultDocs.every((doc) => doc.country_name === check.expectedCountry),
    `Expected only ${check.expectedCountry} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
  assert.ok(
    resultDocs.every((doc) => doc.category === check.expectedCategory),
    `Expected only ${check.expectedCategory} results for ${check.query}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
  );
}

// Regression matrix for issue #46: normalizeText() must strip combining marks left over
// from NFKD decomposition for scripts where they are decorative (Latin accents, Arabic
// tashkeel), but must preserve them for scripts where they are load-bearing (Japanese
// dakuten/handakuten, Devanagari matras/anusvara) — otherwise unrelated words collapse.

// Japanese voiced/unvoiced minimal pairs must stay distinct after normalization.
const japaneseMinimalPairChecks = [
  ['は', 'ば'],
  ['は', 'ぱ'],
  ['ば', 'ぱ'],
  ['か', 'が'],
  ['さ', 'ざ'],
  ['た', 'だ'],
  ['ホ', 'ボ'],
  ['ホ', 'ポ'],
];

for (const [unvoiced, voiced] of japaneseMinimalPairChecks) {
  assert.notEqual(
    normalizeText(unvoiced),
    normalizeText(voiced),
    `Expected "${unvoiced}" and "${voiced}" to remain distinct after normalization`,
  );
}

// The exact alias strings called out in issue #46 must normalize to themselves, not to an
// unvoiced/handakuten-stripped form.
const japaneseAliasNormalizationChecks = [
  ['ドイツ', 'トイツ'],
  ['スペイン', 'スヘイン'],
  ['イギリス', 'イキリス'],
  ['カナダ', 'カナタ'],
  ['スウェーデン', 'スウェーテン'],
];

for (const [original, wronglyStripped] of japaneseAliasNormalizationChecks) {
  // normalizeText() leaves preserved marks in NFKD (decomposed) form, so compare the
  // canonical (NFC) forms rather than raw code points — both render as the same voiced kana.
  assert.equal(
    normalizeText(original).normalize('NFC'),
    original.normalize('NFC'),
    `Expected "${original}" to normalize to itself (voicing marks preserved). Got: ${normalizeText(original)}`,
  );
  assert.notEqual(
    normalizeText(original),
    normalizeText(wronglyStripped),
    `Expected "${original}" not to collapse onto the unvoiced form "${wronglyStripped}"`,
  );
}

// Latin diacritics must still be accent-insensitive.
const latinAccentInsensitiveChecks = [
  ['café', 'cafe'],
  ['résumé', 'resume'],
  ['naïve', 'naive'],
  ['Ratgeber für Notfälle', 'ratgeber fur notfalle'],
];

for (const [accented, plain] of latinAccentInsensitiveChecks) {
  assert.equal(
    normalizeText(accented),
    normalizeText(plain),
    `Expected "${accented}" to normalize the same as "${plain}" (accent-insensitive). Got: ${normalizeText(accented)} vs ${normalizeText(plain)}`,
  );
}

// Arabic tashkeel (harakat) are decorative pronunciation marks, not distinct letters —
// diacritized and undiacritized forms of the same word must still match each other.
const arabicDiacriticInsensitiveChecks = [
  ['مُحَمَّد', 'محمد'],
  ['السُّعُودِيَّة', 'السعودية'],
];

for (const [diacritized, plain] of arabicDiacriticInsensitiveChecks) {
  assert.equal(
    normalizeText(diacritized),
    normalizeText(plain),
    `Expected "${diacritized}" to normalize the same as "${plain}" (diacritic-insensitive). Got: ${normalizeText(diacritized)} vs ${normalizeText(plain)}`,
  );
}

// Existing Arabic aliases used in the search index must still normalize to themselves
// (no unexpected mark stripping of base letters). Aliases are picked without hamza-carrying
// alef forms (إ/أ/آ), since those legitimately fold to bare alef — both before and after
// this fix — matching common lenient Arabic search practice.
for (const alias of ['الصحة النفسية', 'شرطة', 'العنف المنزلي', 'انتحار', 'حماية الطفل']) {
  assert.equal(
    normalizeText(alias),
    alias,
    `Expected Arabic alias "${alias}" to normalize to itself. Got: ${normalizeText(alias)}`,
  );
}

// Devanagari (Indic) matras/anusvara are load-bearing vowel signs, not decorative marks —
// words differing only by a matra must remain distinct after normalization.
const devanagariMinimalPairChecks = [
  ['क', 'का'],
  ['क', 'कि'],
  ['का', 'कि'],
  ['दमकल', 'दमकला'],
];

for (const [first, second] of devanagariMinimalPairChecks) {
  assert.notEqual(
    normalizeText(first),
    normalizeText(second),
    `Expected "${first}" and "${second}" to remain distinct after normalization`,
  );
}

// Existing Devanagari aliases used in the search index must still normalize to themselves.
for (const alias of ['भारत', 'आपातकाल', 'पुलिस', 'एम्बुलेंस']) {
  assert.equal(
    normalizeText(alias),
    alias,
    `Expected Devanagari alias "${alias}" to normalize to itself. Got: ${normalizeText(alias)}`,
  );
}

// A mark-preserving script character following one that isn't (e.g. Latin then Japanese, or a
// mark run right at the start of the string with no preceding base) is a boundary condition the
// forward-scan replacement for the old lookbehind regex must still get right.
assert.equal(normalizeText('café は'), normalizeText('cafe は'), 'Expected a mixed Latin/Japanese string to stay accent-insensitive on the Latin side only');
assert.equal(normalizeText(''), '', 'Expected an empty string to normalize to an empty string');
assert.equal(normalizeText('́'), '', 'Expected a leading combining mark with no base character to be stripped');

// search.js must not use regex lookbehind assertions ((?<=...) / (?<!...)) — they fail to parse
// on Safari/iOS Safari before 16.4, which throws at module load and breaks search entirely.
const searchSource = readFileSync(fileURLToPath(new URL('../src/lib/search.js', import.meta.url)), 'utf8');
assert.ok(
  !/\(\?<[=!]/.test(searchSource),
  'Expected src/lib/search.js to contain no regex lookbehind assertions (Safari < 16.4 compatibility)',
);

const alarmtelefonenNorwayParsed = parseSearchQuery('alarmtelefonen norge', docs);
assert.equal(
  alarmtelefonenNorwayParsed.intent.category?.value,
  'child_protection',
  `Expected "alarmtelefonen norge" to infer child_protection category. Got: ${JSON.stringify(alarmtelefonenNorwayParsed.intent.category)}`,
);
assert.equal(
  alarmtelefonenNorwayParsed.intent.country?.label,
  'Norway',
  `Expected Norway country intent for "alarmtelefonen norge". Got: ${JSON.stringify(alarmtelefonenNorwayParsed.intent.country)}`,
);

const alarmtelefonenNorwayResults = searchDocs('alarmtelefonen norge', 10);
assert.ok(
  alarmtelefonenNorwayResults.some((doc) => doc.country_name === 'Norway' && doc.name === 'Alarmtelefonen for barn og unge'),
  `Expected "alarmtelefonen norge" to surface Norway's Alarmtelefonen for barn og unge. Got: ${alarmtelefonenNorwayResults.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
);

const alarmNoCategoryInferenceChecks = [
  { query: 'alarm danmark', expectedCountry: 'Denmark', expectedDocName: 'Alarm 112' },
  { query: 'alarm sverige', expectedCountry: 'Sweden', expectedDocName: 'SOS Alarm (112)' },
];

for (const check of alarmNoCategoryInferenceChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.notEqual(
    parsed.intent.category?.value,
    'child_protection',
    `Expected "${check.query}" not to infer child_protection category. Got: ${JSON.stringify(parsed.intent.category)}`,
  );
  assert.equal(
    parsed.intent.country?.label,
    check.expectedCountry,
    `Expected ${check.expectedCountry} country intent for "${check.query}". Got: ${JSON.stringify(parsed.intent.country)}`,
  );

  const resultDocs = searchDocs(check.query, 10);
  assert.ok(
    resultDocs.some((doc) => doc.country_name === check.expectedCountry && doc.name === check.expectedDocName),
    `Expected "${check.query}" to surface ${check.expectedCountry}'s ${check.expectedDocName}. Got: ${resultDocs.map((doc) => `${doc.country_name}:${doc.name}:${doc.category}`).join(', ')}`,
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

const ambiguousIsoCodeChecks = [
  { word: 'am', country: 'Armenia', query: 'i am feeling unsafe' },
  { word: 'as', country: 'American Samoa', query: 'as soon as possible' },
  { word: 'at', country: 'Austria', query: 'help at home' },
  { word: 'be', country: 'Belgium', query: 'please be kind' },
  { word: 'by', country: 'Belarus', query: 'support by phone' },
  { word: 'do', country: 'Dominican Republic', query: 'what do i do' },
  { word: 'im', country: 'Isle of Man', query: 'im feeling unsafe' },
  { word: 'in', country: 'India', query: 'help in an emergency' },
  { word: 'it', country: 'Italy', query: 'it feels urgent' },
  { word: 'me', country: 'Montenegro', query: 'please help me' },
  { word: 'my', country: 'Malaysia', query: 'help my family' },
  { word: 'no', country: 'Norway', query: 'no emergency here' },
  { word: 'so', country: 'Somalia', query: 'so worried right now' },
  { word: 'to', country: 'Tonga', query: 'need to talk' },
];

for (const check of ambiguousIsoCodeChecks) {
  const parsed = parseSearchQuery(check.query, docs);
  assert.equal(
    parsed.intent.country,
    null,
    `Expected ordinary word "${check.word}" not to become ${check.country} country intent for "${check.query}". Got: ${JSON.stringify(parsed.intent.country)}`,
  );
}

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
