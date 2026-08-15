import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLatestGenerationGate, createTravelerSelectionSnapshot, getTravelerCountryChoices, loadTravelerData,
  reconstructTravelerCountries, resolveTravelerHelp, safeTravelerUrl, selectTravelerContacts,
  TRAVELER_CARD_CONTACT_LIMIT,
  TRAVELER_MANIFEST_URL, TRAVELER_RECORDS_URL,
} from '../src/lib/traveler.js';
import { dedupeMessageContacts, phoneContacts } from '../src/lib/contact.ts';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const page = readFileSync(resolve(WEB_ROOT, 'src/pages/traveler.astro'), 'utf8');
const helper = readFileSync(resolve(WEB_ROOT, 'src/lib/traveler.js'), 'utf8');
const source = `${page}\n${helper}`;
for (const pattern of [/navigator\.geolocation/i, /localStorage/i, /sessionStorage/i, /document\.cookie/i, /(?:sendBeacon|gtag|analytics\.(?:track|send)|telemetry\.(?:track|send))/i, /URLSearchParams/i, /history\.(?:push|replace)State/i]) assert.doesNotMatch(source, pattern);
assert.doesNotMatch(source, /data\/countries\//);
assert.doesNotMatch(helper, /(?:\.region|\.subregion|fallbackCountries)/);
assert.match(page, /event\.preventDefault\(\)/);
assert.doesNotMatch(page, /method=["']get["']/i);
assert.match(page, /fixed static dataset files/i);
assert.match(page, /not encoded into requested paths or queries/i);
assert.match(page, /Record ID:/);
assert.match(page, /Verification status:/);
assert.match(page, /Source-check date:/);
assert.match(page, /import \{ dedupeMessageContacts, phoneContacts \} from ['"]\.\.\/lib\/contact['"]/);
assert.match(page, /phoneContacts\(country\.general_emergency \|\| \[\], \[\]\)/);
assert.match(page, /phoneContacts\(h\.voice_numbers \|\| \[\], h\.short_codes \|\| \[\]\)/);
assert.match(page, /dedupeMessageContacts\(h\.sms_numbers \|\| \[\], h\.text_numbers \|\| \[\]\)/);
assert.doesNotMatch(page, /cleanTel|replace\(\/\[\^\+\\d\*#\]\//);
assert.match(page, /uri \? `<a class="\$\{classes\}" href="tel:/);
assert.match(page, /uri \? `<a class="\$\{classes\}" href="sms:/);
assert.match(page, /not callable/);
assert.match(page, /not messageable/);
assert.match(page, />Factual source</);
assert.match(page, />Official website</);
assert.match(page, /const website = safeTravelerUrl\(h\.website\)/);
assert.match(page, /website \? `<a[\s\S]*?>Official website<\/a>` : ''/);
assert.doesNotMatch(page, /(?:h\.website|source).*Official website/);

assert.equal(TRAVELER_CARD_CONTACT_LIMIT, 2, 'Traveler card contact limit changed without review');
const malformedBeforeCallable = phoneContacts(
  ['13HEALTH', '450-HELP', 'varies', '---', '3016326701'],
  [],
);
assert.deepEqual(selectTravelerContacts(malformedBeforeCallable), [
  { value: '3016326701', uri: '3016326701' },
  { value: '13HEALTH', uri: null },
], 'a valid active phone destination was hidden behind malformed display values');
assert.deepEqual(selectTravelerContacts([
  { value: 'bad one', uri: null },
  { value: '111', uri: '111' },
  { value: 'bad two', uri: null },
  { value: '222', uri: '222' },
], 4).map(({ value }) => value), ['111', '222', 'bad one', 'bad two'], 'Traveler contact prioritization is not stable within usability groups');
assert.throws(() => selectTravelerContacts([], -1), /non-negative safe integer/);

assert.equal(safeTravelerUrl('https://help.example/path'), 'https://help.example/path');
assert.equal(safeTravelerUrl('http://help.example/path'), 'http://help.example/path');
for (const unsafe of ['javascript:alert(1)', 'data:text/html,unsafe', 'ftp://help.example', '/relative']) {
  assert.equal(safeTravelerUrl(unsafe), null, `unsafe Traveler URL scheme survived: ${unsafe}`);
}
const websiteOnlyCountry = {
  country: 'Webland',
  alpha2: 'WW',
  hotlines: [{
    id: 'website-only', name: 'Website-only service', category: 'mental_health', country_code: 'WW',
    verification_status: 'verified_authority', geography: null, voice_numbers: [], short_codes: [],
    sms_numbers: [], text_numbers: [], chat_url: null, website: 'https://official.example/help', sources: ['https://evidence.example/record'],
  }],
};
const websiteOnlyResult = resolveTravelerHelp({ currentCountry: websiteOnlyCountry, category: 'mental_health', channel: 'any' });
assert.deepEqual(websiteOnlyResult.primary.results.map(({ id }) => id), ['website-only'], 'channel any dropped a website-only Traveler record');
assert.notEqual(safeTravelerUrl(websiteOnlyCountry.hotlines[0].website), safeTravelerUrl(websiteOnlyCountry.hotlines[0].sources[0]), 'contact website and factual source were conflated');

const travelerPhones = phoneContacts(
  ['+1 800-123-4567', '(02) 1234-5678', '13HEALTH', '450-HELP', 'varies', '', '---', '234) 8062-106-493'],
  ['112', '(+58)2127303322'],
);
assert.deepEqual(travelerPhones, [
  { value: '+1 800-123-4567', uri: '+18001234567' },
  { value: '(02) 1234-5678', uri: '0212345678' },
  { value: '13HEALTH', uri: null },
  { value: '450-HELP', uri: null },
  { value: 'varies', uri: null },
  { value: '---', uri: null },
  { value: '234) 8062-106-493', uri: null },
  { value: '112', uri: '112' },
  { value: '(+58)2127303322', uri: null },
], 'Traveler phone/emergency policy changed or canonical display values were altered');
const travelerMessages = dedupeMessageContacts(
  ['+44 7700-900123', '450-HELP', 'varies', '', '---', '(11) 98888-7777'],
  ['12345', '450-HELP', '55 (11) 98888-7777'],
);
assert.deepEqual(travelerMessages, [
  { kind: 'SMS', value: '+44 7700-900123', uri: '+447700900123' },
  { kind: 'SMS/text', value: '450-HELP', uri: null },
  { kind: 'SMS', value: 'varies', uri: null },
  { kind: 'SMS', value: '---', uri: null },
  { kind: 'SMS', value: '(11) 98888-7777', uri: null },
  { kind: 'Text', value: '12345', uri: '12345' },
  { kind: 'Text', value: '55 (11) 98888-7777', uri: null },
], 'Traveler message policy changed or phone/message distinctions were lost');
assert.match(page, /aria-describedby="traveler-home-help traveler-home-error"/);
assert.match(page, /id="traveler-home-error" role="alert"/);
assert.match(page, /setAttribute\('aria-invalid', 'true'\)/);
assert.match(page, /setAttribute\('aria-invalid', 'false'\)/);
assert.match(page, /const selection = createTravelerSelectionSnapshot\([\s\S]*?const generation = requestGate\.begin\(\);[\s\S]*?clearOutput\(\);/);
assert.match(page, /form\.addEventListener\('input', invalidateTravelerResults\)/);
assert.match(page, /form\.addEventListener\('change', invalidateTravelerResults\)/);
assert.match(page, /function invalidateTravelerResults\(\) \{ requestGate\.begin\(\); clearOutput\(\); \}/);
assert.match(page, /homeSelect\.addEventListener\('change',[\s\S]*?clearHomeError\(\)/);
assert.match(page, /currentSelect\.addEventListener\('change',[\s\S]*?clearHomeError\(\)/);
assert.match(page, /currentCode: selection\.currentCode, homeCode: selection\.homeCode/);
assert.match(page, /category: selection\.category, channel: selection\.channel, locality: selection\.locality/);
assert.doesNotMatch(page, /resolveTravelerHelp\(\{[^}]*category: categorySelect\.value/);
assert.match(page, /onManifest: \(country(?:: Country)?\) => requestGate\.run\(generation/);
assert.match(page, /requestGate\.run\(generation, \(\) => output\.scrollIntoView/);
assert.doesNotMatch(page, /canonical evidence/i);
assert.equal(TRAVELER_MANIFEST_URL, '/data/manifest.json');
assert.equal(TRAVELER_RECORDS_URL, '/api/v1/records.json');

const mutableSelection = { currentCode: 'aa', homeCode: 'bb', category: 'mental_health', channel: 'text', locality: ' Exact City ' };
const capturedSelection = createTravelerSelectionSnapshot(mutableSelection);
mutableSelection.currentCode = 'CC';
mutableSelection.homeCode = '';
mutableSelection.category = 'domestic_violence';
mutableSelection.channel = 'chat';
mutableSelection.locality = 'Different City';
assert.deepEqual(capturedSelection, { currentCode: 'AA', homeCode: 'BB', category: 'mental_health', channel: 'text', locality: 'Exact City' });
assert.equal(Object.isFrozen(capturedSelection), true, 'traveler selection snapshot is mutable');
assert.throws(() => { capturedSelection.category = 'general_support'; }, TypeError);

const hotline = (id, category, extra = {}) => ({ id, name: id, organization: null, category, country_code: 'AA', verification_status: 'verified_authority', last_verified: '2026-01-02', geography: null, voice_numbers: ['100'], short_codes: [], sms_numbers: [], text_numbers: [], chat_url: null, sources: ['https://example.test/fact'], ...extra });
const manifest = { schema_version: '2.0', countries: [
  { alpha2: 'AA', name: 'Currentland', general_emergency: ['112'] },
  { alpha2: 'BB', name: 'Homeland', general_emergency: ['911'] },
  { alpha2: 'CC', name: 'Foreignland', general_emergency: ['999'] },
] };
const recordsArtifact = { api_version: '1.0', records: {
  current: hotline('current', 'mental_health'),
  old: hotline('old', 'mental_health', { verification_status: 'deprecated' }),
  localText: hotline('local-text', 'mental_health', { geography: 'Exact City', voice_numbers: [], sms_numbers: ['123'] }),
  nationalText: hotline('national-text', 'mental_health', { geography: 'nationwide', voice_numbers: [], sms_numbers: ['456'] }),
  home: hotline('home', 'mental_health', { country_code: 'BB' }),
  foreign: hotline('foreign', 'mental_health', { country_code: 'CC' }),
} };

const generatedManifest = JSON.parse(readFileSync(resolve(WEB_ROOT, 'public/data/manifest.json'), 'utf8'));
const generatedRecords = JSON.parse(readFileSync(resolve(WEB_ROOT, 'public/api/v1/records.json'), 'utf8'));
assert.equal(generatedManifest.schema_version, '2.0');
assert.ok(Array.isArray(generatedManifest.countries) && generatedManifest.countries.length > 0);
assert.equal(generatedRecords.api_version, '1.0');
assert.ok(generatedRecords.records && !Array.isArray(generatedRecords.records));
const generatedCode = generatedManifest.countries.find(({ hotline_count }) => hotline_count > 0).alpha2;
const generatedCountry = reconstructTravelerCountries(generatedManifest, generatedRecords, generatedCode).currentCountry;
assert.ok(generatedCountry.general_emergency.length >= 0);
assert.ok(generatedCountry.hotlines.length > 0);
assert.ok(generatedCountry.hotlines.every(({ country_code }) => country_code === generatedCode));
const generatedChoices = getTravelerCountryChoices(generatedManifest);
assert.deepEqual(generatedChoices.currentCountries.map(({ alpha2 }) => alpha2).sort(), generatedManifest.countries.map(({ alpha2 }) => alpha2).sort(), 'current-country choices omitted manifest countries');
assert.deepEqual(generatedChoices.homeCountries.map(({ alpha2 }) => alpha2).sort(), generatedManifest.countries.filter(({ hotline_count }) => hotline_count > 0).map(({ alpha2 }) => alpha2).sort(), 'home-country choices were not explicitly filtered to recorded listings');
const zeroHotlineCountries = generatedManifest.countries.filter(({ hotline_count }) => hotline_count === 0);
assert.equal(zeroHotlineCountries.length, 4, 'generated manifest no longer has the reviewed four zero-hotline countries');
for (const { alpha2 } of zeroHotlineCountries) {
  const zeroCountry = reconstructTravelerCountries(generatedManifest, generatedRecords, alpha2).currentCountry;
  assert.deepEqual(zeroCountry.hotlines, [], `${alpha2} unexpectedly reconstructed hotline records`);
  const zeroResult = resolveTravelerHelp({ currentCountry: zeroCountry, category: 'mental_health', channel: 'phone' });
  assert.deepEqual(zeroResult.primary.results, []);
  assert.equal(zeroResult.primary.noSafeCrossBorderFallback, true);
  assert.match(zeroResult.primary.reason, /released data does not establish cross-border access or eligibility/);
}

const calls = [];
let emergencyBeforeRecords = false;
const mockFetch = async (url, options) => {
  calls.push({ url, options });
  if (url === TRAVELER_MANIFEST_URL) return { ok: true, json: async () => structuredClone(manifest) };
  assert.equal(url, TRAVELER_RECORDS_URL);
  return { ok: true, json: async () => structuredClone(recordsArtifact) };
};
const loaded = await loadTravelerData({ fetchImpl: mockFetch, currentCode: 'aa', homeCode: 'bb', onManifest(country) {
  emergencyBeforeRecords = calls.length === 1 && country.country === 'Currentland' && country.general_emergency[0] === '112';
} });
assert.equal(emergencyBeforeRecords, true, 'emergency metadata was not available before the records request');
assert.deepEqual(calls.map(({ url }) => url), [TRAVELER_MANIFEST_URL, TRAVELER_RECORDS_URL]);
assert.ok(calls.every(({ options }) => options.credentials === 'omit' && options.referrerPolicy === 'no-referrer'));
assert.deepEqual(loaded.currentCountry.hotlines.map(({ id }) => id), ['current', 'old', 'local-text', 'national-text']);
assert.deepEqual(loaded.homeCountry.hotlines.map(({ id }) => id), ['home']);
assert.ok(!loaded.currentCountry.hotlines.some(({ id }) => id === 'foreign'), 'foreign record entered current-country reconstruction');

let manifestPublished = false;
const failureCalls = [];
await assert.rejects(loadTravelerData({
  currentCode: 'AA',
  onManifest(country) { manifestPublished = country.general_emergency[0] === '112'; },
  fetchImpl: async (url) => {
    failureCalls.push(url);
    return url === TRAVELER_MANIFEST_URL ? { ok: true, json: async () => manifest } : { ok: false, status: 503 };
  },
}), /Static support records returned 503/);
assert.equal(manifestPublished, true, 'records failure hid manifest emergency metadata');
assert.deepEqual(failureCalls, [TRAVELER_MANIFEST_URL, TRAVELER_RECORDS_URL]);

const same = reconstructTravelerCountries(manifest, recordsArtifact, 'AA', 'AA');
assert.equal(same.homeCountry, null, 'same home/current country was not collapsed');
let result = resolveTravelerHelp({ currentCountry: loaded.currentCountry, homeCountry: loaded.homeCountry, category: 'mental_health', channel: 'phone' });
assert.equal(result.primary.level, 'current-country');
assert.deepEqual(result.primary.results.map(({ id }) => id), ['current']);
assert.deepEqual(result.home.results.map(({ id }) => id), ['home']);
assert.ok(result.primary.results.every(({ verification_status }) => verification_status !== 'deprecated'));

result = resolveTravelerHelp({ currentCountry: loaded.currentCountry, category: 'mental_health', channel: 'text', locality: 'Exact City' });
assert.deepEqual(result.primary.results.map(({ id }) => id), ['local-text'], 'finder locality/channel match semantics changed');
result = resolveTravelerHelp({ currentCountry: loaded.currentCountry, category: 'mental_health', channel: 'chat', locality: 'Missing City' });
assert.ok(result.primary.fallback);
assert.ok(result.primary.results.every(({ country_code }) => country_code === 'AA'), 'finder fallback admitted a foreign record');
assert.ok(result.primary.results.every(({ verification_status }) => verification_status !== 'deprecated'));

const emptyCurrent = { country: 'Currentland', alpha2: 'AA', general_emergency: ['112'], hotlines: [] };
result = resolveTravelerHelp({ currentCountry: emptyCurrent, category: 'mental_health', channel: 'phone' });
assert.deepEqual(result.primary.results, []);
assert.equal(result.primary.noSafeCrossBorderFallback, true);
assert.match(result.primary.reason, /No regional or global hotline is shown because the released data does not establish cross-border access or eligibility\./);
assert.doesNotMatch(result.primary.reason, /same (?:region|continent)/i);

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => { resolvePromise = resolveValue; rejectPromise = rejectValue; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const gate = createLatestGenerationGate();
const firstManifest = deferred();
const firstRecords = deferred();
const secondManifest = deferred();
const secondRecords = deferred();
const pending = [firstManifest, secondManifest, firstRecords, secondRecords];
const rendered = { emergency: [], results: [], errors: [], scrolls: [] };
let fetchIndex = 0;
async function simulatedSubmission(code) {
  const generation = gate.begin();
  try {
    const data = await loadTravelerData({
      currentCode: code,
      fetchImpl: () => pending[fetchIndex++].promise,
      onManifest: (country) => gate.run(generation, () => rendered.emergency.push(country.alpha2)),
    });
    gate.run(generation, () => rendered.results.push(data.currentCountry.alpha2));
    gate.run(generation, () => rendered.scrolls.push(data.currentCountry.alpha2));
  } catch (error) {
    gate.run(generation, () => rendered.errors.push(error.message));
  }
}
const olderSubmission = simulatedSubmission('AA');
const newerSubmission = simulatedSubmission('BB');
secondManifest.resolve({ ok: true, json: async () => manifest });
await Promise.resolve();
await Promise.resolve();
firstRecords.resolve({ ok: true, json: async () => recordsArtifact });
await newerSubmission;
firstManifest.resolve({ ok: true, json: async () => manifest });
await Promise.resolve();
await Promise.resolve();
secondRecords.resolve({ ok: false, status: 503 });
await olderSubmission;
assert.deepEqual(rendered, { emergency: ['BB'], results: ['BB'], errors: [], scrolls: ['BB'] }, 'an older submission crossed an asynchronous render boundary');

const successGate = createLatestGenerationGate();
const delayedOlderRecords = deferred();
const successRendered = { emergency: [], results: [], errors: [], scrolls: [] };
async function simulatedSuccessfulSubmission(code, fetchImpl) {
  const generation = successGate.begin();
  for (const values of Object.values(successRendered)) values.length = 0;
  try {
    const data = await loadTravelerData({
      currentCode: code,
      fetchImpl,
      onManifest: (country) => successGate.run(generation, () => successRendered.emergency.push(country.alpha2)),
    });
    successGate.run(generation, () => successRendered.results.push(data.currentCountry.alpha2));
    successGate.run(generation, () => successRendered.scrolls.push(data.currentCountry.alpha2));
  } catch (error) {
    successGate.run(generation, () => successRendered.errors.push(error.message));
  }
}
const delayedOlderSuccess = simulatedSuccessfulSubmission('AA', async (url) => (
  url === TRAVELER_MANIFEST_URL
    ? { ok: true, json: async () => manifest }
    : delayedOlderRecords.promise
));
await Promise.resolve();
await Promise.resolve();
const immediateNewerSuccess = simulatedSuccessfulSubmission('BB', async (url) => ({
  ok: true,
  json: async () => url === TRAVELER_MANIFEST_URL ? manifest : recordsArtifact,
}));
await immediateNewerSuccess;
delayedOlderRecords.resolve({ ok: true, json: async () => recordsArtifact });
await delayedOlderSuccess;
assert.deepEqual(successRendered, { emergency: ['BB'], results: ['BB'], errors: [], scrolls: ['BB'] }, 'an older successful submission rendered after a newer submission');

const mutationGate = createLatestGenerationGate();
const mutationManifest = deferred();
const mutationRecords = deferred();
const mutationRendered = { emergency: [], results: [], errors: [], scrolls: [] };
const liveControls = { currentCode: 'AA', homeCode: 'BB', category: 'mental_health', channel: 'text', locality: 'Exact City' };
async function submissionInvalidatedByMutation() {
  const selection = createTravelerSelectionSnapshot(liveControls);
  const generation = mutationGate.begin();
  try {
    const data = await loadTravelerData({
      currentCode: selection.currentCode,
      homeCode: selection.homeCode,
      fetchImpl: (url) => url === TRAVELER_MANIFEST_URL ? mutationManifest.promise : mutationRecords.promise,
      onManifest: (country) => mutationGate.run(generation, () => mutationRendered.emergency.push(country.alpha2)),
    });
    const resolved = resolveTravelerHelp({ ...data, category: selection.category, channel: selection.channel, locality: selection.locality });
    mutationGate.run(generation, () => mutationRendered.results.push(resolved.primary.results.map(({ id }) => id)));
    mutationGate.run(generation, () => mutationRendered.scrolls.push(data.currentCountry.alpha2));
  } catch (error) {
    mutationGate.run(generation, () => mutationRendered.errors.push(error.message));
  }
  return selection;
}
const invalidatedSubmission = submissionInvalidatedByMutation();
liveControls.currentCode = 'CC';
liveControls.homeCode = '';
liveControls.category = 'domestic_violence';
liveControls.channel = 'chat';
liveControls.locality = 'Different City';
mutationGate.begin(); // The page's input/change invalidation uses this same operation.
mutationManifest.resolve({ ok: true, json: async () => manifest });
await Promise.resolve();
await Promise.resolve();
mutationRecords.resolve({ ok: true, json: async () => recordsArtifact });
const invalidatedSelection = await invalidatedSubmission;
assert.deepEqual(invalidatedSelection, { currentCode: 'AA', homeCode: 'BB', category: 'mental_health', channel: 'text', locality: 'Exact City' }, 'post-submit form mutation changed captured resolution inputs');
assert.deepEqual(mutationRendered, { emergency: [], results: [], errors: [], scrolls: [] }, 'form mutation did not make every older success render boundary stale');

const mutationErrorGate = createLatestGenerationGate();
const staleErrorGeneration = mutationErrorGate.begin();
mutationErrorGate.begin();
assert.equal(mutationErrorGate.run(staleErrorGeneration, () => mutationRendered.errors.push('stale error')), false, 'form mutation left an older error boundary current');

console.log('Traveler Mode OK: immutable submit snapshots, form-mutation invalidation, latest-generation rendering, distinct manifest/home choices, zero-hotline safety, accessible validation, fixed two-request loading, evidence, and privacy');
