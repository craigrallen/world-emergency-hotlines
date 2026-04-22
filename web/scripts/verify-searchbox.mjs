import assert from 'node:assert/strict';

import docs from '../public/data/search-index.json' with { type: 'json' };
import { scoreDoc } from '../src/lib/search.js';

function topCountries(query, limit = 5) {
  return docs
    .map((doc) => ({ doc, score: scoreDoc(doc, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc }) => `${doc.country_name}:${doc.name}`);
}

const swedenQueries = ['help sweden', 'sweden help', 'need help in sweden'];

for (const query of swedenQueries) {
  const results = topCountries(query);
  assert.ok(results.length > 0, `Expected results for query: ${query}`);
  assert.ok(
    results.some((entry) => entry.startsWith('Sweden:')),
    `Expected Sweden in top matches for query: ${query}. Got: ${results.join(', ')}`,
  );
}

const specificResults = topCountries('sweden domestic violence', 10);
assert.ok(
  specificResults.some((entry) => entry.startsWith('Sweden:Kvinnofridslinjen')),
  `Expected Sweden domestic violence hotline match. Got: ${specificResults.join(', ')}`,
);

const fillerOnlyResults = topCountries('please help me', 5);
assert.equal(fillerOnlyResults.length, 0, `Expected filler-only query to stay quiet. Got: ${fillerOnlyResults.join(', ')}`);

console.log('search verification passed');