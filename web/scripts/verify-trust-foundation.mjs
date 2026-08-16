import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHotlineIssueUrl } from '../src/lib/issues.js';
import { DEFAULT_SITE_URL, normalizeSiteUrl } from '../src/lib/site.js';
import { getFreshnessInfo } from '../src/lib/data.ts';
import { dedupeMessageContacts, normalizeMessageContact, normalizePhoneContact, phoneContacts } from '../src/lib/contact.ts';
import { DICTIONARIES, LOCALES } from '../src/lib/i18n.ts';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');

const fixedNow = new Date('2026-08-14T12:00:00.000Z');
const monthMs = 1000 * 60 * 60 * 24 * 30.44;
const isoBefore = (milliseconds) => new Date(fixedNow.getTime() - milliseconds).toISOString();
const freshnessCases = [
  ['future-by-1ms', new Date(fixedNow.getTime() + 1).toISOString(), 'unknown'],
  ['now', fixedNow.toISOString(), 'fresh'],
  ['recent-past', '2026-08-01', 'fresh'],
  ['six-month-boundary', isoBefore(6 * monthMs), 'ok'],
  ['stale-past', '2000-01-01', 'stale'],
  ['invalid-date', '2026-02-30', 'unknown'],
];
for (const [status, expectedPrefix, unavailableLabel] of [
  ['verified_web', 'Verified ', 'Source-check date unavailable'],
  ['cross_referenced', 'Cross-referenced ', 'Date unavailable'],
]) {
  for (const [name, last_verified, level] of freshnessCases) {
    const result = getFreshnessInfo({ verification_status: status, last_verified }, fixedNow);
    assert.equal(result.level, level, `${status} ${name} freshness level`);
    if (level === 'unknown') {
      assert.deepEqual(result, { label: unavailableLabel, level: 'unknown', dateStr: null }, `${status} ${name} fails safely`);
      assert.doesNotMatch(result.label, /Verified|Cross-referenced|fresh|stale|re-check/i, `${status} ${name} must not imply recency`);
    } else if (level === 'stale') {
      assert.match(result.label, status === 'cross_referenced' ? /^Cross-reference may need re-check/ : /^Verified .* may need re-check$/, `${status} ${name} stale wording`);
    } else {
      assert.match(result.label, new RegExp(`^${expectedPrefix}`), `${status} ${name} status-specific evidence wording`);
    }
  }
}
// Phone fixtures are intentionally independent of dataset contents and rendering tests.
const validPhoneFixtures = [
  ['17', '17'],
  ['18', '18'],
  ['839863', '839863'],
  ['+46 123', '+46123'],
  ['12-34', '1234'],
  ['+1 800-123-4567', '+18001234567'],
  ['+1 (905) 688 3711', '+19056883711'],
  ['(905) 688-3711', '9056883711'],
];
for (const [source, expected] of validPhoneFixtures) assert.equal(normalizePhoneContact(source), expected, `safe phone must normalize to one destination: ${source}`);

const invalidPhoneFixtures = [
  '', '   ', '1', '1234567890123456',
  '234) 8062-106-493', '(+58)2127303322',
  '839863)', '(839863)', '(839863', '839(863', '839(863) 123',
  '((905)) 688 3711', '(90(5)) 688 3711', '() 688 3711',
  '(905) (688) 3711', '+1 (905) (688) 3711', '(90+5) 688 3711',
  '+1(905) 688 3711', '1 (905)', '(905)',
  '++46 123', '+46 +123', '46+123',
  '741*71', '123 / 456', '123, 456', '123; 456', '123 & 456',
  'Text HOME to 741741', 'SMS 741741', '+1 555 XXXX', '83986X', '12–34',
  '123-456 or 789-012', '123-456 ext 7', '123...456', '123_456',
  '-123', '123-', '123--456', '123 - 456', '123- 456', '123 -456',
];
for (const source of invalidPhoneFixtures) assert.equal(normalizePhoneContact(source), null, `ambiguous phone must remain non-actionable: ${JSON.stringify(source)}`);
assert.deepEqual(phoneContacts(['234) 8062-106-493', '+1 800-123-4567'], ['(+58)2127303322']), [
  { value: '234) 8062-106-493', uri: null },
  { value: '+1 800-123-4567', uri: '+18001234567' },
  { value: '(+58)2127303322', uri: null },
], 'phone contacts preserve canonical values and never repair malformed Nigeria/Venezuela examples');

const validMessageFixtures = [
  ['839863', '839863'],
  ['+46 123', '+46123'],
  ['+1 800-123-4567', '+18001234567'],
];
for (const [source, expected] of validMessageFixtures) assert.equal(normalizeMessageContact(source), expected, `safe SMS/text destination must normalize: ${source}`);
const invalidMessageFixtures = [
  '', '12', '17', '+1 (905) 688 3711', '(905) 688-3711',
  '123--456', '123 - 456', '741*71', 'Text HOME to 741741',
];
for (const source of invalidMessageFixtures) assert.equal(normalizeMessageContact(source), null, `strict SMS/text destination must remain non-actionable: ${JSON.stringify(source)}`);

const messageFixture = dedupeMessageContacts(
  ['+1 800-123-4567', '+1 800-123-4567', '741*71', '741*71'],
  ['+18001234567', 'Text HOME to 741741', '+44 20 1234 5678'],
);
assert.deepEqual(messageFixture, [
  { kind: 'SMS/text', value: '+1 800-123-4567', uri: '+18001234567' },
  { kind: 'SMS', value: '741*71', uri: null },
  { kind: 'Text', value: 'Text HOME to 741741', uri: null },
  { kind: 'Text', value: '+44 20 1234 5678', uri: '+442012345678' },
], 'message contacts deduplicate within and across arrays while preserving first-seen display values and distinct contacts');

const routingTitles = {
  en: 'Prioritized routing',
  es: 'Enrutamiento priorizado',
  fr: 'Acheminement priorisé',
  de: 'Priorisierte Weiterleitung',
  'pt-BR': 'Encaminhamento priorizado',
  ar: 'التوجيه حسب الأولوية',
  hi: 'प्राथमिकता-आधारित मार्गनिर्देशन',
  'zh-CN': '优先级路由',
  ja: '優先順位に基づく案内',
  ru: 'Приоритетная маршрутизация',
};
assert.deepEqual([...LOCALES], Object.keys(routingTitles), 'every supported locale must have a routing-title contract');
for (const locale of LOCALES) assert.equal(DICTIONARIES[locale]['about.routingTitle'], routingTitles[locale], `${locale} routing title must retain neutral semantics`);

assert.equal(normalizeSiteUrl(undefined), DEFAULT_SITE_URL);
assert.equal(normalizeSiteUrl('not a url'), DEFAULT_SITE_URL);
assert.equal(normalizeSiteUrl('javascript:alert(1)'), DEFAULT_SITE_URL);
assert.equal(normalizeSiteUrl('https://example.org/custom/path?q=1#x'), 'https://example.org');

const issue = new URL(buildHotlineIssueUrl({
  id: 'weh_00000000000000000000abcd',
  name: 'Example Crisis Service',
  organization: 'Example Authority',
  category: 'mental_health',
  geography: 'Example County, Example State',
  verification_status: 'verified_authority',
  last_verified: '2026-08-12',
}, 'United States'));
assert.equal(issue.origin + issue.pathname, 'https://github.com/craigrallen/world-emergency-hotlines/issues/new');
assert.equal(issue.searchParams.get('template'), 'hotline-correction.yml');
assert.equal(issue.searchParams.get('record_id'), null);
assert.equal(issue.searchParams.get('country_service'), null);
assert.match(issue.searchParams.get('body'), /weh_00000000000000000000abcd/);
assert.match(issue.searchParams.get('title') || '', /^Hotline correction: Example Crisis Service$/);
const body = issue.searchParams.get('body') || '';
assert.match(body, /Record ID: weh_00000000000000000000abcd/);
assert.match(body, /Country: United States/);
assert.match(body, /Geography: Example County, Example State/);
assert.match(body, /Source checked: 2026-08-12/);
assert.match(body, /Do not include sensitive personal or crisis details/);
assert.ok(issue.toString().length < 2000, 'prefilled issue URL should remain bounded');

const hostile = new URL(buildHotlineIssueUrl({
  name: `Bad\nname ${'x'.repeat(1000)}`,
  organization: 'Unsafe\u0000value',
}, 'Test'));
assert.ok(hostile.toString().length < 2000, 'hostile values should remain bounded');
assert.doesNotMatch(hostile.searchParams.get('title') || '', /[\u0000-\u001f\u007f]/);
assert.equal(hostile.searchParams.get('template'), 'hotline-correction.yml');

const intake = readFileSync(resolve(REPO_ROOT, '.github/ISSUE_TEMPLATE/provider-submission.yml'), 'utf8');
assert.match(intake, /sensitive personal data/i);
assert.match(intake, /review leads/i);

const currentPublicCopy = [
  readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8'),
  readFileSync(resolve(WEB_ROOT, 'src/layouts/Base.astro'), 'utf8'),
  readFileSync(resolve(WEB_ROOT, 'src/pages/index.astro'), 'utf8'),
  readFileSync(resolve(WEB_ROOT, 'src/pages/about.astro'), 'utf8'),
].join('\n');
assert.doesNotMatch(currentPublicCopy, /\b(definitive|exhaustive)\b/i, 'current public claims must not imply completeness');
assert.doesNotMatch(currentPublicCopy, /best verified help available|best available help|best-available routing/i, 'current public copy must use factual prioritized-listing terminology');
assert.match(currentPublicCopy, /does not determine suitability, eligibility, live availability, or provide medical\s+advice/i);
assert.match(currentPublicCopy, /source information.{0,20}verification status.{0,20}vary.{0,20}shown per record/i);
assert.match(currentPublicCopy, /not (whether|a) .*live|not a live availability check/is);

const countryPageSource = readFileSync(resolve(WEB_ROOT, 'src/pages/country/[code].astro'), 'utf8');
assert.match(countryPageSource, /<section id={`category-\$\{cat\}`} class="scroll-mt-48" data-section-cat=\{cat\}>/, 'every generated category target must use the documented 12rem sticky-surface scroll offset');
const prioritizedPanelSource = countryPageSource.match(/<!-- Prioritized listing box -->([\s\S]*?)\{country\.hotlines\.length === 0/)?.[1] ?? '';
assert.ok(prioritizedPanelSource, 'prioritized-listing source panel must remain identifiable');
assert.doesNotMatch(prioritizedPanelSource, /(?:success|green|emerald|lime)|[✅✓✔]/i, 'prioritized-listing source must not use success/green/checkmark endorsement cues');
assert.match(prioritizedPanelSource, /border-border bg-bg-elev\/40/);
assert.match(prioritizedPanelSource, /Icon name="dataset"/);
for (const status of ['source checked', 'cross-referenced', 'not source checked']) assert.match(countryPageSource, new RegExp(`['"]${status}['"]`), `prioritized listing must expose exact neutral status text: ${status}`);

console.log('Trust foundation OK: conservative claims, safe site URL, and bounded correction links');
