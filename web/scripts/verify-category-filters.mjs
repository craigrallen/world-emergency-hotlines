import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  availableCategoryFilterValues,
  categoryFilterRecord,
  categoryFilterSummary,
  categorySummaryChannelLabels,
  filterCategoryRecords,
  filterCategorySummaries,
  getUsableContactChannels,
} from '../src/lib/category-filters.js';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pageSource = readFileSync(resolve(WEB_ROOT, 'src/pages/category/[slug].astro'), 'utf8');

const hotline = (id, verification_status, extra = {}) => ({
  id,
  verification_status,
  voice_numbers: [],
  short_codes: [],
  sms_numbers: [],
  text_numbers: [],
  chat_url: null,
  website: null,
  ...extra,
});

const canonicalOrder = [
  hotline('first', 'legacy_unverified', { voice_numbers: ['not a safe number'], website: 'javascript:alert(1)' }),
  hotline('second', 'verified_authority', { voice_numbers: ['+46 123 456'], chat_url: 'https://example.org/chat' }),
  hotline('third', 'cross_referenced', { sms_numbers: ['741741'], website: 'http://example.org/help' }),
  hotline('fourth', 'verified_web', { voice_numbers: ['112'], text_numbers: ['words only'] }),
];
const records = canonicalOrder.map(categoryFilterRecord);

assert.deepEqual(filterCategoryRecords(records).map(({ id }) => id), ['first', 'second', 'third', 'fourth'], 'default must show every record in canonical render order');
assert.deepEqual(filterCategoryRecords(records, { evidence: [], channels: [] }).map(({ id }) => id), ['first', 'second', 'third', 'fourth'], 'reset filters must restore every record');
assert.deepEqual(filterCategoryRecords(records, { evidence: ['source_checked'] }).map(({ id }) => id), ['second', 'fourth'], 'evidence filtering must preserve order');
assert.deepEqual(filterCategoryRecords(records, { channels: ['phone', 'website'] }).map(({ id }) => id), ['second', 'third', 'fourth'], 'channel choices are OR within their group');
assert.deepEqual(filterCategoryRecords(records, { evidence: ['cross_referenced'], channels: ['website'] }).map(({ id }) => id), ['third'], 'evidence and channel filters must combine with AND');
assert.deepEqual(filterCategoryRecords(records, { evidence: ['other_evidence'], channels: ['chat'] }), [], 'a combined filter may deterministically produce zero results');
assert.deepEqual(getUsableContactChannels(canonicalOrder[0]), { phone: false, text: false, chat: false, website: false }, 'unsafe/display-only contacts must not count as usable');
assert.deepEqual(getUsableContactChannels(canonicalOrder[1]), { phone: true, text: false, chat: true, website: false });

const aggregateChannelHotlines = [
  hotline('website-only', 'legacy_unverified', { website: 'https://example.org/help' }),
  hotline('safe-phone-text-chat', 'verified_web', {
    voice_numbers: ['112'],
    sms_numbers: ['741741'],
    chat_url: 'https://example.org/chat',
  }),
  hotline('malformed-values', 'cross_referenced', {
    voice_numbers: ['not callable'],
    short_codes: ['call 911'],
    sms_numbers: ['text HELP'],
    text_numbers: ['javascript:alert(1)'],
    chat_url: 'javascript:alert(1)',
    website: ' example.org ',
  }),
];
assert.deepEqual(
  categorySummaryChannelLabels(categoryFilterSummary('aggregate-channels', aggregateChannelHotlines)),
  ['Phone', 'SMS/text', 'Online chat', 'Website'],
  'aggregate channel labels must use safe record metadata in deterministic canonical order',
);
assert.deepEqual(
  categorySummaryChannelLabels(categoryFilterSummary('website-only', [aggregateChannelHotlines[0]])),
  ['Website'],
  'a safe website-only record must display Website rather than None listed',
);
assert.deepEqual(
  categorySummaryChannelLabels(categoryFilterSummary('malformed-only', [aggregateChannelHotlines[2]])),
  [],
  'malformed website, chat, phone, and text values must not appear in aggregate labels',
);

const summaries = [
  categoryFilterSummary('alpha', [canonicalOrder[0], canonicalOrder[1]]),
  categoryFilterSummary('split', [
    hotline('split-evidence', 'verified_web'),
    hotline('split-channel', 'legacy_unverified', { website: 'https://example.org/help' }),
  ]),
  categoryFilterSummary('charlie', [canonicalOrder[2]]),
  categoryFilterSummary('delta', [canonicalOrder[3]]),
];
assert.deepEqual(filterCategorySummaries(summaries).map(({ id }) => id), ['alpha', 'split', 'charlie', 'delta'], 'default must show every country summary in canonical order');
assert.deepEqual(filterCategorySummaries(summaries, { evidence: [], channels: [] }).map(({ id }) => id), ['alpha', 'split', 'charlie', 'delta'], 'reset must restore every summary');
assert.deepEqual(filterCategorySummaries(summaries, { evidence: ['source_checked'], channels: ['website'] }).map(({ id }) => id), [], 'evidence and channel must match the same hotline, never a split-record join');
assert.deepEqual(filterCategorySummaries(summaries, { evidence: ['cross_referenced'], channels: ['website'] }).map(({ id }) => id), ['charlie'], 'combined summary predicate must preserve canonical order');
assert.deepEqual(filterCategorySummaries(summaries, { evidence: ['other_evidence'], channels: ['chat'] }), [], 'summary filtering must support a deterministic zero state');

const bereavementSummaries = [
  categoryFilterSummary('bereavement-chat', [hotline('bereavement-chat-record', 'legacy_unverified', { chat_url: 'https://example.org/chat' })]),
  categoryFilterSummary('bereavement-phone', [hotline('bereavement-phone-record', 'legacy_unverified', { voice_numbers: ['112'] })]),
];
const bereavementValues = availableCategoryFilterValues(bereavementSummaries);
assert.ok(bereavementValues.evidence.includes('other_evidence'), 'an evidence value matching every summary alone must remain available for same-record combinations');
assert.deepEqual(filterCategorySummaries(bereavementSummaries, { evidence: ['other_evidence'], channels: ['chat'] }).map(({ id }) => id), ['bereavement-chat'], 'universal-alone evidence must still narrow a combined same-record state');

const generalSupportSummaries = [
  categoryFilterSummary('general-cross-referenced', [hotline('general-cross-record', 'cross_referenced', { voice_numbers: ['112'] })]),
  categoryFilterSummary('general-source-checked', [hotline('general-source-record', 'verified_web', { voice_numbers: ['911'] })]),
];
const generalSupportValues = availableCategoryFilterValues(generalSupportSummaries);
assert.ok(generalSupportValues.channels.includes('phone'), 'a channel matching every summary alone must remain available for same-record combinations');
assert.deepEqual(filterCategorySummaries(generalSupportSummaries, { evidence: ['cross_referenced'], channels: ['phone'] }).map(({ id }) => id), ['general-cross-referenced'], 'universal-alone channel must still narrow a combined same-record state');

const zeroMatchValues = availableCategoryFilterValues(summaries, {
  evidence: ['source_checked', 'missing_evidence'],
  channels: ['website', 'missing_channel'],
});
assert.deepEqual(zeroMatchValues, { evidence: ['source_checked'], channels: ['website'] }, 'only filter values matching zero summaries may be hidden');

for (const contract of [
  'data-category-filters',
  'data-category-country-summary',
  'data-record-count=',
  'data-source-checked-count=',
  'data-filter-records=',
  'aria-live="polite"',
  'data-category-filter-reset',
  'filterCategorySummaries',
  'availableCategoryFilterValues',
  'categorySummaryChannelLabels',
  'Filters describe indexed evidence and usable contact fields only.',
  'A weaker evidence status does not mean a service is unsafe.',
]) assert.ok(pageSource.includes(contract), `category page is missing contract: ${contract}`);

for (const prohibited of [
  "import HotlineCard",
  '<HotlineCard',
  'data-hotline-card',
  'data-phone-contact',
  'data-message-contact',
  'data-chat-contact',
]) assert.equal(pageSource.includes(prohibited), false, `category summary page must not contain HotlineCard/contact contract: ${prohibited}`);

assert.match(pageSource, /const resetFilters = \(\) =>/);
assert.match(pageSource, /input\.checked = false/);
assert.match(pageSource, /activeRegion = 'all'/);
assert.match(pageSource, /container\.classList\.toggle\('hidden', visibleCount === 0\)/);
assert.match(pageSource, /empty\.classList\.toggle\('hidden', visibleCount !== 0\)/);

assert.match(pageSource, /<aside[^>]*data-category-filters hidden>/, 'server-rendered filter controls must be hidden without successful client startup');
assert.match(pageSource, /<article class="card p-5" data-category-country-summary/, 'country summaries must render without a hidden default');
assert.doesNotMatch(pageSource, /<article[^>]*data-category-country-summary[^>]*\shidden(?:\s|>)/, 'country summaries must remain visible when client startup fails');

const metadataParse = pageSource.indexOf("JSON.parse(card.dataset.filterRecords ?? '[]')");
const changeHandler = pageSource.indexOf("filters.addEventListener('change', applyFilters)");
const resetHandler = pageSource.indexOf("reset.addEventListener('click', resetFilters)");
const emptyResetHandler = pageSource.indexOf("empty.querySelector('[data-category-filter-reset]')?.addEventListener('click', resetFilters)");
const regionHandler = pageSource.indexOf("regionFilter?.addEventListener('click'");
const reveal = pageSource.indexOf('filters.hidden = false');
for (const [name, position] of Object.entries({ metadataParse, changeHandler, resetHandler, emptyResetHandler, regionHandler, reveal })) {
  assert.notEqual(position, -1, `category filter startup contract is missing: ${name}`);
}
assert.ok(metadataParse < changeHandler, 'all card metadata must parse before client handlers are initialized');
assert.ok(changeHandler < resetHandler && resetHandler < emptyResetHandler && emptyResetHandler < regionHandler, 'client handlers must initialize in the verified order');
assert.ok(regionHandler < reveal, 'filter controls must only be revealed after every client handler is initialized');
assert.equal(pageSource.indexOf('filters.hidden = false', reveal + 1), -1, 'filter controls must have one explicit post-init reveal');

for (const forbidden of [
  'URLSearchParams',
  'window.location.search',
  'history.pushState',
  'history.replaceState',
  'localStorage',
  'sessionStorage',
  'navigator.geolocation',
  'document.cookie',
  'fetch(',
  'XMLHttpRequest',
  'sendBeacon',
]) assert.equal(pageSource.includes(forbidden), false, `category filter must not use ${forbidden}`);

assert.equal(pageSource.includes('hotlines.sort('), false, 'hotline records must never be reranked');
assert.ok(pageSource.indexOf('entries.map') < pageSource.indexOf('data-category-country-summary'), 'summaries must retain the existing country render order');

console.log('Category filters OK: aggregate country summaries, safe metadata, stable order, same-record combined/default/zero/reset behavior, SEO marker, no HotlineCard details, and private fail-open client contracts');
