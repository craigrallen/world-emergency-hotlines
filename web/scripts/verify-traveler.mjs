import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertTravelerCardDownloadSupport, createLatestGenerationGate, createTravelerDownloadController, createTravelerPrintReadinessController, createTravelerSelectionSnapshot, decompressTravelerCardBundle, getTravelerCountryChoices, getTravelerReleaseContext, loadTravelerCountryCard, loadTravelerData,
  reconstructTravelerCountries, resolveTravelerHelp, safeTravelerUrl, scrollTravelerOutputBestEffort, selectTravelerContacts,
  serializeTravelerCountryCard,
  supportsTravelerCardDownload, TRAVELER_CARD_BROWSER_COMPATIBILITY_MESSAGE, TRAVELER_CARD_CONTACT_LIMIT,
  TRAVELER_CARD_BUNDLE_MAX_BYTES, TRAVELER_CARD_BUNDLE_MAX_DECOMPRESSED_BYTES, TRAVELER_CARD_BUNDLE_URL, TRAVELER_CARD_MANIFEST_URL,
  TRAVELER_MANIFEST_URL, TRAVELER_RECORDS_API_VERSION, TRAVELER_RECORDS_URL, validateTravelerCardBundleIdentity,
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
assert.match(page, /id="traveler-print-action" class="mt-5 hidden"/);
assert.match(page, /id="traveler-print-button" type="button"/);
assert.match(page, /printButton\.addEventListener\('click', \(\) => window\.print\(\)\)/);
assert.equal((page.match(/window\.print\(\)/g) || []).length, 1, 'print action must only invoke window.print() once');
assert.match(page, /@media print/);
assert.doesNotMatch(page, /visibility:\s*(?:hidden|visible)/);
assert.match(page, /body > a, body > aside, body > header, body > footer,[^\n]*\.traveler-screen-only \{ display: none !important/);
assert.equal((page.match(/traveler-screen-only/g) || []).length, 6, 'Traveler screen-only siblings are not explicitly excluded from print');
assert.match(page, /\.traveler-print-root \{ display: none !important; \}/);
assert.match(page, /\.traveler-print-root\[data-print-ready="true"\] \{ position: static !important; display: block !important/);
assert.match(page, /break-inside: avoid/);
assert.doesNotMatch(page, /\.traveler-print-root > div > div[^}]*break-inside/);
assert.match(page, /a\[href\^="http"\]::after/);
assert.match(page, /#traveler-print-action, \.traveler-screen-limitations \{ display: none !important; \}/);
assert.match(page, /static directory snapshot of the already-loaded result and may become stale/i);
assert.match(page, /does not prove answerability, availability, eligibility, endorsement, or cross-border reach/i);
assert.match(page, /https:\/\/worldhotlines\.org\/traveler/);
assert.match(page, />current Traveler Mode page<\/a>/);
assert.doesNotMatch(page, />https:\/\/worldhotlines\.org\/traveler<\/a>/);
assert.doesNotMatch(page, /generated_at/i);
assert.match(page, /id="traveler-download-form"/);
assert.match(page, /id="traveler-download-country" required/);
assert.match(page, /id="traveler-download-submit" type="submit" aria-describedby="traveler-download-status"/);
assert.match(page, /if \(!supportsTravelerCardDownload\(\)\)/);
assert.match(page, /downloadCountry\.disabled = true/);
assert.match(page, /downloadSubmit\.disabled = true/);
assert.match(page, /downloadForm\.setAttribute\('aria-disabled', 'true'\)/);
assert.match(page, /downloadStatus\.textContent = TRAVELER_CARD_BROWSER_COMPATIBILITY_MESSAGE/);
assert.doesNotMatch(page, /traveler-download-form[\s\S]{0,500}(?:category|channel|locality)/i);
assert.match(page, /No crisis need or selection is placed in a URL, request path, browser history, storage, telemetry, or QR code/i);
assert.match(page, /Source verification does not prove answering or availability; eligibility may vary\. Check current local emergency guidance\./i);
assert.match(page, /new Blob\(\[content\], \{ type: 'text\/plain;charset=utf-8' \}\)/);
assert.match(page, /loadTravelerCountryCard\(\{ fetchImpl: fetch, countryCode \}\)/);
assert.doesNotMatch(page, /loadTravelerData\(\{ fetchImpl: fetch, currentCode: countryCode \}\)/);
assert.match(page, /downloadReadiness\.publish\(generation/);
assert.match(page, /URL\.revokeObjectURL/);
assert.match(page, /setTimeout\(\(\) => \{ if \(downloadReadiness\.release\(generation\)\)/);

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
assert.match(page, /event\.preventDefault\(\);[\s\S]*?printReadiness\.invalidate\(\);[\s\S]*?clearOutput\(\);[\s\S]*?if \(!form\.reportValidity\(\)\) return;/);
assert.match(page, /if \(homeSelect\.value && homeSelect\.value === currentSelect\.value\)[\s\S]*?return; \}[\s\S]*?const channel/);
assert.match(page, /const generation = printReadiness\.begin\(\{[\s\S]*?categoryLabel:[\s\S]*?channelLabel:/);
assert.match(page, /printHeading\.innerHTML =[\s\S]*?printPayload\.categoryLabel[\s\S]*?printPayload\.channelLabel[\s\S]*?printPayload\.selection\.locality/);
assert.match(page, /form\.addEventListener\('input', invalidateTravelerResults\)/);
assert.match(page, /form\.addEventListener\('change', invalidateTravelerResults\)/);
assert.match(page, /function invalidateTravelerResults\(\) \{ printReadiness\.invalidate\(\); clearOutput\(\); \}/);
assert.match(page, /function clearPrintReadinessArtifacts\(\) \{ output\.removeAttribute\('data-print-ready'\); printAction\.classList\.add\('hidden'\); printHeading\.innerHTML = ''; printLimitations\.innerHTML = ''; \}/);
assert.doesNotMatch(page, /id="traveler-output"[^>]*data-print-ready/, 'print readiness must not exist before submission');
assert.match(page, /printReadiness\.publish\(generation, releaseContext\)[\s\S]*?output\.setAttribute\('data-print-ready', 'true'\)/);
assert.match(page, /function clearOutput\(\)[\s\S]*?clearPrintReadinessArtifacts\(\)/);
assert.match(page, /homeSelect\.addEventListener\('change',[\s\S]*?clearHomeError\(\)/);
assert.match(page, /currentSelect\.addEventListener\('change',[\s\S]*?clearHomeError\(\)/);
assert.match(page, /currentCode: selection\.currentCode, homeCode: selection\.homeCode/);
assert.match(page, /category: selection\.category, channel: selection\.channel, locality: selection\.locality/);
assert.doesNotMatch(page, /resolveTravelerHelp\(\{[^}]*category: categorySelect\.value/);
assert.match(page, /onManifest: \(country(?:: Country)?\) => printReadiness\.run\(generation/);
const submitHandlerStart = page.indexOf("form.addEventListener('submit'");
const dataRenderTryStart = page.indexOf('    try {', submitHandlerStart);
const dataRenderCatchStart = page.indexOf('    } catch (error)', dataRenderTryStart);
const dataRenderTry = page.slice(dataRenderTryStart, dataRenderCatchStart);
assert.doesNotMatch(dataRenderTry, /scrollIntoView/, 'non-critical scrolling is still classified as data/render work');
assert.match(page, /catch \(error\)[\s\S]*?printReadiness\.fail\(generation\);[\s\S]*?clearPrintReadinessArtifacts\(\);[\s\S]*?primary\.innerHTML = '';[\s\S]*?homeOutput\.innerHTML = '';[\s\S]*?return;[\s\S]*?scrollTravelerOutputBestEffort\(\(\) => output\.scrollIntoView/);
assert.doesNotMatch(page, /canonical evidence/i);
assert.equal(TRAVELER_MANIFEST_URL, '/data/manifest.json');
assert.equal(TRAVELER_RECORDS_URL, '/api/v1/records.json');
assert.equal(TRAVELER_RECORDS_API_VERSION, '1.0');
assert.equal(TRAVELER_CARD_MANIFEST_URL, '/api/v1/manifest.json');
assert.equal(TRAVELER_CARD_BUNDLE_URL, '/api/v1/traveler-cards.json');
assert.equal(TRAVELER_CARD_BUNDLE_MAX_BYTES, 1024 * 1024);
assert.equal(TRAVELER_CARD_BUNDLE_MAX_DECOMPRESSED_BYTES, 1024 * 1024);
assert.match(TRAVELER_CARD_BROWSER_COMPATIBILITY_MESSAGE, /standard JSON and streaming response support/i);
assert.equal(supportsTravelerCardDownload(), true);
assert.doesNotThrow(() => assertTravelerCardDownloadSupport());

let scrollAttempts = 0;
assert.equal(scrollTravelerOutputBestEffort(() => { scrollAttempts += 1; throw new Error('scroll unavailable'); }), false);
assert.equal(scrollAttempts, 1, 'best-effort scroll did not make exactly one attempt');
assert.equal(scrollTravelerOutputBestEffort(() => { scrollAttempts += 1; }), true);

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
const manifest = {
  schema_version: '2.0',
  dataset_version: `sha256:${'a'.repeat(64)}`,
  source_last_updated: '2026-01-02',
  generated_at: '2099-12-31T23:59:59.999Z',
  countries: [
  { alpha2: 'AA', name: 'Currentland', general_emergency: ['112'] },
  { alpha2: 'BB', name: 'Homeland', general_emergency: ['911'] },
  { alpha2: 'CC', name: 'Foreignland', general_emergency: ['999'] },
] };
const expectedReleaseContext = { datasetVersion: `sha256:${'a'.repeat(64)}`, sourceLastUpdated: '2026-01-02', schemaVersion: '2.0', generatedAt: '2099-12-31T23:59:59.999Z' };
assert.deepEqual(getTravelerReleaseContext(manifest), expectedReleaseContext);
assert.equal(Object.isFrozen(getTravelerReleaseContext(manifest)), true);
const unknownDateContext = getTravelerReleaseContext({ ...manifest, source_last_updated: null });
assert.deepEqual(unknownDateContext, { ...expectedReleaseContext, sourceLastUpdated: null });
assert.equal(Object.isFrozen(unknownDateContext), true);
for (const badManifest of [
  {},
  { ...manifest, dataset_version: '' },
  { ...manifest, dataset_version: 'sha256:abc' },
  { ...manifest, source_last_updated: '' },
  { ...manifest, source_last_updated: '2026-02-30' },
  { ...manifest, schema_version: '' },
  { ...manifest, schema_version: 'version two' },
  { ...manifest, generated_at: '' },
  { ...manifest, generated_at: 'not-a-date' },
]) assert.throws(() => getTravelerReleaseContext(badManifest), /static manifest/i);
const recordsArtifact = { api_version: '1.0', dataset_version: manifest.dataset_version, records: {
  current: hotline('current', 'mental_health'),
  old: hotline('old', 'mental_health', { verification_status: 'deprecated' }),
  localText: hotline('local-text', 'mental_health', { geography: 'Exact City', voice_numbers: [], sms_numbers: ['123'] }),
  nationalText: hotline('national-text', 'mental_health', { geography: 'nationwide', voice_numbers: [], sms_numbers: ['456'] }),
  home: hotline('home', 'mental_health', { country_code: 'BB' }),
  foreign: hotline('foreign', 'mental_health', { country_code: 'CC' }),
} };

const serializedCard = serializeTravelerCountryCard({
  country: {
    country: 'Currentland\u202e', alpha2: 'AA', general_emergency: ['112', '13HEALTH', 'bad\u0000number', '12) 34'],
    hotlines: [
      hotline('z-record', 'mental_health', { name: 'Zulu\nservice', voice_numbers: ['100'], sms_numbers: ['123', '450-HELP'], text_numbers: ['123', '12) 34'], sources: ['javascript:unsafe'] }),
      hotline('punctuation_record', 'mental_health', { name: 'Underscore service' }),
      hotline('a-record', 'mental_health', { name: '<Alpha>', voice_numbers: ['450-HELP'], text_numbers: ['456'] }),
      hotline('punctuation-record', 'mental_health', { name: 'Hyphen service' }),
      hotline('old-record', 'mental_health', { verification_status: 'deprecated' }),
    ],
  },
  releaseContext: expectedReleaseContext,
});
assert.equal(serializedCard.indexOf('EMERGENCY'), 0, 'downloaded card does not put emergency information first');
assert.deepEqual(
  [...serializedCard.matchAll(/\[record ([^;]+);/g)].map((match) => match[1]),
  ['a-record', 'punctuation-record', 'punctuation_record', 'z-record'],
  'downloaded records are not in exact locale-independent UTF-16 code-unit order',
);
assert.doesNotMatch(serializedCard, /old-record|javascript:|\u202e|\u0000/);
assert.match(serializedCard, /^EMERGENCY[^\n]*\nRecorded general emergency contacts: Call 112, Phone 13HEALTH \(not callable\), Phone badnumber \(not callable\), Phone 12\) 34 \(not callable\)/);
assert.match(serializedCard, /<Alpha> — Phone 450-HELP \(not callable\); Text 456/);
assert.match(serializedCard, /Zulu service — Call 100; SMS\/text 123; SMS 450-HELP \(not messageable\); Text 12\) 34 \(not messageable\)/);
assert.match(serializedCard, /Canonical dataset version: sha256:[a-f0-9]{64}/);
assert.match(serializedCard, /Static API version: 1\.0/);
assert.match(serializedCard, /Artifact generation date: 2099-12-31T23:59:59\.999Z/);
assert.match(serializedCard, /Canonical source date: 2026-01-02/);
assert.match(serializedCard, /Provenance: generated static artifacts derived from the project canonical dataset/);
assert.match(serializedCard, /this is a snapshot, not live information, and it may become stale/i);
assert.match(serializedCard, /Source verification does not prove answering or availability\. Eligibility may vary\. Check current local emergency guidance\./);
assert.doesNotMatch(serializedCard, /https?:\/\//, 'low-bandwidth card unexpectedly serialized a URL');
assert.throws(() => serializeTravelerCountryCard({ country: null, releaseContext: expectedReleaseContext }), /validated country/);

const createdUrls = [];
const revokedUrls = [];
const downloadController = createTravelerDownloadController({
  createObjectURL(blob) { const url = `blob:test-${createdUrls.length + 1}`; createdUrls.push({ url, size: blob.size }); return url; },
  revokeObjectURL(url) { revokedUrls.push(url); },
});
const firstDownload = downloadController.begin();
assert.equal(downloadController.publish(firstDownload, new Blob([])), null, 'blank download became ready');
const secondDownload = downloadController.begin();
assert.equal(downloadController.publish(firstDownload, new Blob(['stale'])), null, 'stale download became ready');
assert.equal(downloadController.publish(secondDownload, new Blob(['ready'])), 'blob:test-1');
const thirdDownload = downloadController.begin();
assert.deepEqual(revokedUrls, ['blob:test-1'], 'superseded object URL was not revoked');
assert.equal(downloadController.publish(thirdDownload, new Blob(['new'])), 'blob:test-2');
assert.equal(downloadController.release(thirdDownload), true);
assert.deepEqual(revokedUrls, ['blob:test-1', 'blob:test-2'], 'consumed object URL was not revoked');
assert.equal(downloadController.release(secondDownload), false, 'stale release affected current readiness');

const generatedManifest = JSON.parse(readFileSync(resolve(WEB_ROOT, 'public/data/manifest.json'), 'utf8'));
const generatedApiManifest = JSON.parse(readFileSync(resolve(WEB_ROOT, 'public/api/v1/manifest.json'), 'utf8'));
const generatedRecords = JSON.parse(readFileSync(resolve(WEB_ROOT, 'public/api/v1/records.json'), 'utf8'));
const generatedCardBytes = readFileSync(resolve(WEB_ROOT, 'public/api/v1/traveler-cards.json'));
const generatedCardBundle = JSON.parse(generatedCardBytes);
assert.ok(generatedCardBytes.byteLength <= TRAVELER_CARD_BUNDLE_MAX_BYTES);
assert.ok(generatedCardBytes.byteLength <= TRAVELER_CARD_BUNDLE_MAX_DECOMPRESSED_BYTES);
assert.equal(generatedApiManifest.endpoints.traveler_cards, 'traveler-cards.json');
assert.equal(generatedApiManifest.traveler_card_build_version, generatedApiManifest.build_versions.integration_generator);
assert.equal(generatedCardBundle.traveler_card_build_version, generatedApiManifest.traveler_card_build_version);
assert.deepEqual(getTravelerReleaseContext(generatedApiManifest), getTravelerReleaseContext(generatedCardBundle));
validateTravelerCardBundleIdentity(generatedCardBundle, generatedApiManifest);
for (const mismatch of [
  { bundle: { ...generatedCardBundle, traveler_card_build_version: `sha256:${'0'.repeat(64)}` }, manifest: generatedApiManifest },
  { bundle: generatedCardBundle, manifest: { ...generatedApiManifest, traveler_card_build_version: `sha256:${'0'.repeat(64)}` } },
]) assert.throws(() => validateTravelerCardBundleIdentity(mismatch.bundle, mismatch.manifest), /build version/);
assert.throws(() => validateTravelerCardBundleIdentity(
  { ...generatedCardBundle, traveler_card_build_version: undefined },
  { ...generatedApiManifest, traveler_card_build_version: undefined },
), /invalid country-card build version/);
assert.deepEqual(Object.keys(generatedCardBundle.cards).sort(), generatedApiManifest.countries.map(({ alpha2 }) => alpha2).sort());
const dockerVerifier = readFileSync(resolve(WEB_ROOT, 'scripts/verify-docker-image.sh'), 'utf8');
assert.match(dockerVerifier, /const cardBundle = JSON\.parse\(cardBytes\);/, 'deployment smoke test must parse the bounded raw traveler-card JSON bytes');
assert.doesNotMatch(dockerVerifier, /gunzip|node:zlib|traveler-cards\.json\.gz/, 'deployment smoke test retained a compressed traveler-card assumption');
for (const assertion of ['1048576-byte ceiling', 'application/json', 'Cache-Control', 'cardEntry?.bytes === cardBytes.length', 'cardEntry.sha256 === digest(cardBytes)']) {
  assert.ok(dockerVerifier.includes(assertion), `deployment smoke test lost its ${assertion} assertion`);
}
for (const content of Object.values(generatedCardBundle.cards)) {
  assert.equal(content.indexOf('EMERGENCY'), 0);
  assert.doesNotMatch(content, /https?:\/\//);
  for (const expected of [`Canonical dataset version: ${generatedApiManifest.dataset_version}`, `Static API version: ${generatedApiManifest.api_version}`, `Schema version: ${generatedApiManifest.schema_version}`, `Artifact generation date: ${generatedApiManifest.generated_at}`, `Canonical source date: ${generatedApiManifest.source_last_updated}`]) assert.ok(content.includes(expected));
}
const cardCalls = [];
const cardBody = (chunks, onCancel = () => {}) => new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  cancel(reason) { onCancel(reason); },
});
const mockCardResponse = { ok: true, headers: { get: () => String(generatedCardBytes.byteLength) }, body: cardBody([generatedCardBytes]) };
let unsupportedCardRequests = 0;
await assert.rejects(loadTravelerCountryCard({
  countryCode: 'US',
  fetchImpl: async () => { unsupportedCardRequests += 1; throw new Error('unsupported browser made a request'); },
  requireSupport: () => { throw new Error(TRAVELER_CARD_BROWSER_COMPATIBILITY_MESSAGE); },
}), /streaming response support/i);
assert.equal(unsupportedCardRequests, 0, 'unsupported browser requested a fixed artifact before capability failure');
const loadedCard = await loadTravelerCountryCard({
  countryCode: 'US',
  fetchImpl: async (url, options) => { cardCalls.push({ url, options }); return url === TRAVELER_CARD_MANIFEST_URL ? { ok: true, json: async () => structuredClone(generatedApiManifest) } : mockCardResponse; },
  decodeBundle: async (bytes) => { assert.equal(Buffer.from(bytes).equals(generatedCardBytes), true); return structuredClone(generatedCardBundle); },
});
assert.deepEqual(cardCalls.map(({ url }) => url), [TRAVELER_CARD_MANIFEST_URL, TRAVELER_CARD_BUNDLE_URL]);
assert.ok(cardCalls.every(({ options }) => options.credentials === 'omit' && options.referrerPolicy === 'no-referrer'));
assert.doesNotMatch(JSON.stringify(cardCalls), /(?:US|us)/);
assert.equal(loadedCard.content, generatedCardBundle.cards.US);
await assert.rejects(loadTravelerCountryCard({ countryCode: 'CA', fetchImpl: async (url) => url === TRAVELER_CARD_MANIFEST_URL ? { ok: true, json: async () => generatedApiManifest } : { ...mockCardResponse, body: cardBody([generatedCardBytes]) }, decodeBundle: async () => ({ ...generatedCardBundle, dataset_version: `sha256:${'0'.repeat(64)}` }) }), /do not match/);
await assert.rejects(loadTravelerCountryCard({ countryCode: 'CA', fetchImpl: async (url) => url === TRAVELER_CARD_MANIFEST_URL ? { ok: true, json: async () => generatedApiManifest } : { ...mockCardResponse, headers: { get: () => String(TRAVELER_CARD_BUNDLE_MAX_BYTES + 1) } }, decodeBundle: async () => generatedCardBundle }), /byte-size ceiling/);
const noLengthLoaded = await loadTravelerCountryCard({
  countryCode: 'CA',
  fetchImpl: async (url) => url === TRAVELER_CARD_MANIFEST_URL ? { ok: true, json: async () => generatedApiManifest } : { ok: true, headers: { get: () => null }, body: cardBody([generatedCardBytes.subarray(0, 7), generatedCardBytes.subarray(7)]) },
  decodeBundle: async (bytes) => { assert.equal(Buffer.from(bytes).equals(generatedCardBytes), true); return structuredClone(generatedCardBundle); },
});
assert.equal(noLengthLoaded.content, generatedCardBundle.cards.CA, 'missing Content-Length rejected a bounded body');
let oversizedBodyCancelled = false;
const oversizedChunks = [new Uint8Array(TRAVELER_CARD_BUNDLE_MAX_BYTES), new Uint8Array(1)];
let oversizedChunkIndex = 0;
const oversizedBody = { getReader: () => ({
  read: async () => oversizedChunkIndex < oversizedChunks.length ? { done: false, value: oversizedChunks[oversizedChunkIndex++] } : { done: true },
  cancel: async () => { oversizedBodyCancelled = true; },
}) };
await assert.rejects(loadTravelerCountryCard({
  countryCode: 'CA',
  fetchImpl: async (url) => url === TRAVELER_CARD_MANIFEST_URL ? { ok: true, json: async () => generatedApiManifest } : { ok: true, headers: { get: () => null }, body: oversizedBody },
  decodeBundle: async () => { throw new Error('oversized bytes reached decoder'); },
}), /byte-size ceiling/);
assert.equal(oversizedBodyCancelled, true, 'oversized chunked body was not cancelled');
const encoder = new TextEncoder();
const boundedJson = encoder.encode(JSON.stringify({ ok: true }));
assert.deepEqual(await decompressTravelerCardBundle(new Uint8Array(), () => cardBody([boundedJson])), { ok: true }, 'bounded decompression stream did not parse');
let decompressionCancelled = false;
let parseCalled = false;
const oversizedDecompressedChunks = [
  new Uint8Array(TRAVELER_CARD_BUNDLE_MAX_DECOMPRESSED_BYTES),
  new Uint8Array(1),
];
let oversizedDecompressedChunkIndex = 0;
const oversizedDecompressionStream = { getReader: () => ({
  read: async () => oversizedDecompressedChunkIndex < oversizedDecompressedChunks.length
    ? { done: false, value: oversizedDecompressedChunks[oversizedDecompressedChunkIndex++] }
    : { done: true },
  cancel: async () => { decompressionCancelled = true; },
}) };
const originalParse = JSON.parse;
JSON.parse = (...args) => { parseCalled = true; return originalParse(...args); };
try {
  await assert.rejects(
    decompressTravelerCardBundle(new Uint8Array(), () => oversizedDecompressionStream),
    /could not be parsed/,
  );
} finally {
  JSON.parse = originalParse;
}
assert.equal(decompressionCancelled, true, 'oversized decompression stream was not cancelled');
assert.equal(parseCalled, false, 'oversized decompressed bytes reached JSON parsing');
await assert.rejects(
  decompressTravelerCardBundle(new Uint8Array(), () => cardBody([encoder.encode('{malformed')])),
  /could not be parsed/,
);
await assert.rejects(loadTravelerCountryCard({ countryCode: 'CA', fetchImpl: async (url) => url === TRAVELER_CARD_MANIFEST_URL ? { ok: true, json: async () => generatedApiManifest } : { ok: true, headers: { get: () => null }, body: null } }), /no readable bounded body/);
await assert.rejects(loadTravelerCountryCard({ countryCode: 'CA', fetchImpl: async (url) => url === TRAVELER_CARD_MANIFEST_URL ? { ok: true, json: async () => generatedApiManifest } : { ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: false, value: 'not bytes' }), cancel: async () => {} }) } } }), /body could not be read/);
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
assert.deepEqual(loaded.releaseContext, expectedReleaseContext, 'loaded manifest release context was not preserved');
assert.deepEqual(calls.map(({ url }) => url), [TRAVELER_MANIFEST_URL, TRAVELER_RECORDS_URL]);
assert.ok(calls.every(({ options }) => options.credentials === 'omit' && options.referrerPolicy === 'no-referrer'));
assert.deepEqual(loaded.currentCountry.hotlines.map(({ id }) => id), ['current', 'old', 'local-text', 'national-text']);
assert.deepEqual(loaded.homeCountry.hotlines.map(({ id }) => id), ['home']);
assert.ok(!loaded.currentCountry.hotlines.some(({ id }) => id === 'foreign'), 'foreign record entered current-country reconstruction');

for (const [label, artifact] of [
  ['stale records', { ...recordsArtifact, dataset_version: `sha256:${'b'.repeat(64)}` }],
  ['newer records', { ...recordsArtifact, dataset_version: `sha256:${'c'.repeat(64)}` }],
  ['missing records identity', { api_version: '1.0', records: recordsArtifact.records }],
  ['malformed records identity', { ...recordsArtifact, dataset_version: 'sha256:bad' }],
  ['wrong static API version', { ...recordsArtifact, api_version: '1.1' }],
]) {
  let emergencyFromHybrid = null;
  let mismatchedResult;
  await assert.rejects(async () => {
    mismatchedResult = await loadTravelerData({
      currentCode: 'AA',
      onManifest(country) { emergencyFromHybrid = [...country.general_emergency]; },
      fetchImpl: async (url) => ({ ok: true, json: async () => structuredClone(url === TRAVELER_MANIFEST_URL ? manifest : artifact) }),
    });
  }, /support-record artifact|dataset versions do not match/i, `${label} did not fail closed`);
  assert.equal(mismatchedResult, undefined, `${label} returned a reconstructed result`);
  assert.deepEqual(emergencyFromHybrid, ['112'], `${label} removed already-published emergency metadata`);
}

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

for (const badSourceLastUpdated of ['', '2026-02-30']) {
  const malformedCalls = [];
  let emergencyFromMalformedContext = null;
  await assert.rejects(loadTravelerData({
    currentCode: 'AA',
    onManifest(country) { emergencyFromMalformedContext = [...country.general_emergency]; },
    fetchImpl: async (url) => {
      malformedCalls.push(url);
      return { ok: true, json: async () => ({ ...manifest, source_last_updated: badSourceLastUpdated }) };
    },
  }), /invalid source-update date/i);
  assert.deepEqual(emergencyFromMalformedContext, ['112'], 'print-context validation suppressed valid emergency metadata');
  assert.deepEqual(malformedCalls, [TRAVELER_MANIFEST_URL], 'records were requested after fail-closed print-context validation');
}

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

const readiness = createTravelerPrintReadinessController();
assert.deepEqual(readiness.getState(), { generation: 0, ready: false, payload: null });
const submitted = { selection: capturedSelection, categoryLabel: 'Mental health', channelLabel: 'Text / SMS' };
const readinessGeneration = readiness.begin(submitted);
submitted.categoryLabel = 'Mutated label';
mutableSelection.locality = 'Mutated again';
assert.equal(readiness.getState().ready, false);
const published = readiness.publish(readinessGeneration, unknownDateContext);
assert.equal(published.ready, true, 'successful current generation did not enable print readiness');
assert.equal(published.payload.categoryLabel, 'Mental health', 'submitted label was not captured immutably');
assert.equal(published.payload.selection.locality, 'Exact City', 'submitted selection was not captured immutably');
assert.equal(published.payload.releaseContext.sourceLastUpdated, null);
assert.equal(Object.isFrozen(published.payload), true);
assert.equal(Object.isFrozen(published.payload.selection), true);
assert.equal(Object.isFrozen(published.payload.releaseContext), true);
readiness.invalidate();
assert.deepEqual(readiness.getState().ready, false, 'input mutation did not clear print readiness');
assert.equal(readiness.getState().payload, null);
const validationGeneration = readiness.begin(submitted);
readiness.fail(validationGeneration);
assert.equal(readiness.getState().ready, false, 'validation/error failure did not clear print readiness');
assert.equal(readiness.getState().payload, null);
const staleGeneration = readiness.begin(submitted);
const currentGeneration = readiness.begin({ ...submitted, categoryLabel: 'Current label' });
assert.equal(readiness.publish(staleGeneration, expectedReleaseContext), false, 'stale completion published print readiness');
assert.equal(readiness.getState().ready, false);
assert.equal(readiness.publish(currentGeneration, expectedReleaseContext).ready, true, 'latest completion did not publish readiness');

const deferredReadiness = createTravelerPrintReadinessController();
const olderPrintable = deferred();
const newerPrintable = deferred();
async function completePrintable(generation, pendingContext) {
  try {
    return deferredReadiness.publish(generation, await pendingContext.promise);
  } catch {
    deferredReadiness.fail(generation);
    return false;
  }
}
const olderPrintGeneration = deferredReadiness.begin(submitted);
const olderPrintCompletion = completePrintable(olderPrintGeneration, olderPrintable);
const newerPrintGeneration = deferredReadiness.begin({ ...submitted, categoryLabel: 'Newest label' });
const newerPrintCompletion = completePrintable(newerPrintGeneration, newerPrintable);
newerPrintable.resolve(expectedReleaseContext);
assert.equal((await newerPrintCompletion).ready, true, 'deferred latest success did not enable readiness');
olderPrintable.resolve(unknownDateContext);
assert.equal(await olderPrintCompletion, false, 'deferred stale completion re-enabled readiness');
assert.equal(deferredReadiness.getState().payload.categoryLabel, 'Newest label');

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
