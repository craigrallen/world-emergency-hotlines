import assert from 'node:assert/strict';

import {
  classifyScope,
  getHotlineChannels,
  matchesChannel,
  resolveGuidedHelp,
} from '../src/lib/finder.js';

function hotline(id, name, geography, category = 'mental_health', extra = {}) {
  return {
    id,
    name,
    geography,
    category,
    verification_status: 'verified_authority',
    voice_numbers: ['100'],
    short_codes: [],
    sms_numbers: [],
    text_numbers: [],
    chat_url: null,
    ...extra,
  };
}

const country = {
  country: 'Testland',
  hotlines: [
    hotline('weh_000000000000000000000001', 'Metro service', 'Metro City'),
    hotline('weh_000000000000000000000002', 'County service', 'Example County'),
    hotline('weh_000000000000000000000003', 'National service', null, 'mental_health', { chat_url: 'https://example.org/chat' }),
    hotline('weh_000000000000000000000004', 'Safety service', 'Nationwide', 'domestic_violence'),
    hotline('weh_000000000000000000000005', 'Old service', 'Metro City', 'mental_health', { verification_status: 'deprecated' }),
  ],
};

assert.equal(classifyScope(country.hotlines[0], country.country), 'local');
assert.equal(classifyScope(country.hotlines[1], country.country), 'county');
assert.equal(classifyScope(country.hotlines[2], country.country), 'national');
assert.deepEqual(getHotlineChannels(country.hotlines[2]), { phone: true, text: false, chat: true });
assert.equal(matchesChannel(country.hotlines[2], 'chat'), true);
assert.equal(matchesChannel(country.hotlines[0], 'chat'), false);

const city = resolveGuidedHelp({ country, category: 'mental_health', channel: 'phone', locality: 'Metro City' });
assert.equal(city.fallback, false);
assert.equal(city.scope, 'local');
assert.deepEqual(city.results.map((result) => result.name), ['Metro service']);
assert.match(city.reason, /recorded coverage mentions/);

const partialLocality = resolveGuidedHelp({ country, category: 'mental_health', channel: 'phone', locality: 'City' });
assert.equal(partialLocality.fallback, true);
assert.deepEqual(partialLocality.results.map((result) => result.name), ['National service']);

const national = resolveGuidedHelp({ country, category: 'mental_health', channel: 'chat', locality: 'Missing Place' });
assert.equal(national.fallback, true);
assert.equal(national.scope, 'national');
assert.deepEqual(national.results.map((result) => result.name), ['National service']);
assert.match(national.reason, /No need-matched service with recorded coverage/);

const relaxedChannel = resolveGuidedHelp({ country, category: 'mental_health', channel: 'chat', locality: 'Metro City' });
assert.equal(relaxedChannel.fallback, true);
assert.equal(relaxedChannel.scope, 'national');
assert.deepEqual(relaxedChannel.results.map((result) => result.name), ['National service']);
assert.match(relaxedChannel.reason, /local services.*do not offer chat/i);

const otherChannelsCountry = {
  country: 'Phone-only land',
  hotlines: [hotline('weh_000000000000000000000010', 'National phone', null)],
};
const otherChannels = resolveGuidedHelp({ country: otherChannelsCountry, category: 'mental_health', channel: 'chat', locality: '' });
assert.equal(otherChannels.fallback, true);
assert.match(otherChannels.reason, /other channels/);

const categoryFallback = resolveGuidedHelp({ country, category: 'child_protection', channel: 'any', locality: '' });
assert.equal(categoryFallback.fallback, true);
assert.equal(categoryFallback.scope, 'country');
assert.match(categoryFallback.reason, /No service in the/);
assert.ok(categoryFallback.results.every((result) => result.verification_status !== 'deprecated'));

console.log('Guided finder OK: explicit local, national, channel, and category fallback semantics');
