import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { encodePack, encodeSchema, evaluateCanonicalRuntime, generateCanonicalReviewPackSchema, generateReviewPack, parseCanonicalDictionaries, reviewPackSafetyErrors } from './multilingual-review-pack.mjs';

const repo = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(repo, path), 'utf8');
const input = {
  i18nSource: read('web/src/lib/i18n.ts'),
  manifest: JSON.parse(read('web/src/lib/locale-status.json')),
  classificationPolicy: JSON.parse(read('reviews/multilingual-ui/v1/safety-classification.json')),
};
const schema = JSON.parse(read('reviews/multilingual-ui/v1/review-pack.schema.json'));
const committed = JSON.parse(read('reviews/multilingual-ui/v1/review-pack.json'));
const generate = (change = {}) => generateReviewPack({ ...input, ...change });
const mutate = (value, fn) => { const copy = structuredClone(value); fn(copy); return copy; };

test('generated pack is schema-valid, exact, ordered, and reproducible', () => {
  const actual = generate();
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(actual), true, JSON.stringify(validate.errors));
  assert.equal(encodePack(actual), read('reviews/multilingual-ui/v1/review-pack.json'));
  assert.equal(encodePack(actual), encodePack(generate()));
  assert.deepEqual(actual.entries.map(({ key }) => key), Object.keys(parseCanonicalDictionaries(input.i18nSource).english));
  for (const entry of actual.entries) assert.deepEqual(entry.locales.map(({ locale }) => locale), actual.locales);
});

test('schema key prefix is exactly regenerated from the canonical finite inventory', () => {
  const expected = generateCanonicalReviewPackSchema(input.i18nSource);
  assert.equal(encodeSchema(schema), encodeSchema(expected));
  assert.deepEqual(schema.properties.entries.prefixItems.map((item) => item.properties.key.const), Object.keys(parseCanonicalDictionaries(input.i18nSource).english));
});

test('records source parity and actual override/fallback truth for every cell', () => {
  const actual = generate();
  const parsed = parseCanonicalDictionaries(input.i18nSource);
  for (const entry of actual.entries) {
    assert.equal(entry.sourceEnglish, parsed.english[entry.key]);
    for (const cell of entry.locales) {
      const overridden = cell.locale === 'en' || Object.hasOwn(parsed.overrides[cell.locale], entry.key);
      assert.equal(cell.value, overridden ? parsed.overrides[cell.locale][entry.key] : parsed.english[entry.key]);
      assert.equal(cell.valueState, cell.locale === 'en' ? 'source_master' : overridden ? 'locale_override' : 'english_fallback');
    }
  }
  assert.ok(actual.entries.some(({ locales }) => locales.some(({ valueState }) => valueState === 'english_fallback')));
});

test('independent transpiled runtime oracle matches parser values and override presence', () => {
  const parsed = parseCanonicalDictionaries(input.i18nSource);
  const runtime = evaluateCanonicalRuntime(input.i18nSource, input.manifest);
  assert.deepEqual(Array.from(runtime.LOCALES), parsed.locales);
  for (const locale of parsed.locales) {
    assert.deepEqual(Object.fromEntries(Object.entries(runtime.DICTIONARIES[locale])), {
      ...parsed.english, ...parsed.overrides[locale],
    });
    assert.deepEqual(Array.from(runtime.__RUNTIME_OVERRIDE_KEYS__[locale]), Object.keys(parsed.overrides[locale]));
  }
});

test('runtime oracle tolerates benign internal dictionary identifier renames', () => {
  const renamed = input.i18nSource.replace(/\bES\b/g, 'SPANISH_OVERRIDES');
  const runtime = evaluateCanonicalRuntime(renamed, input.manifest);
  assert.deepEqual(Array.from(runtime.LOCALES), input.manifest.locales.map(({ locale }) => locale));
  assert.deepEqual(Array.from(runtime.__RUNTIME_OVERRIDE_KEYS__.es), Object.keys(parseCanonicalDictionaries(renamed).overrides.es));
});

test('rejects TypeScript parse and transpile diagnostics explicitly', () => {
  assert.throws(() => parseCanonicalDictionaries('const EN = {'), /TypeScript parse diagnostics/);
  assert.throws(() => evaluateCanonicalRuntime('const EN = {'), /TypeScript transpile diagnostics/);
});

test('fails closed on key, locale, override, and classification-policy drift', () => {
  assert.throws(() => generate({ i18nSource: input.i18nSource.replace("  'meta.siteTitle':", "  'new.key': 'x',\n  'meta.siteTitle':") }), /exact canonical key inventory/);
  assert.throws(() => generate({ manifest: mutate(input.manifest, (x) => x.locales.pop()) }), /manifest locales/);
  assert.notEqual(encodePack(generate({ i18nSource: input.i18nSource.replace("const ES: Partial<Dict> = {", "const ES: Partial<Dict> = {\n  'meta.siteTitle': 'Synthetic title',") })), encodePack(committed));
  assert.throws(() => generate({ classificationPolicy: mutate(input.classificationPolicy, (x) => x.canonicalKeySha256 = '0'.repeat(64)) }), /exact canonical key inventory/);
  assert.throws(() => generate({ classificationPolicy: mutate(input.classificationPolicy, (x) => x.ordinaryUiKeys.pop()) }), /missing canonical key/);
  assert.throws(() => generate({ classificationPolicy: mutate(input.classificationPolicy, (x) => x.ordinaryUiKeys.push(x.ordinaryUiKeys[0])) }), /unique arrays/);
  assert.throws(() => generate({ classificationPolicy: mutate(input.classificationPolicy, (x) => x.legalSensitiveKeys.push('banner.body')) }), /overlaps/);
  assert.throws(() => generate({ classificationPolicy: mutate(input.classificationPolicy, (x) => x.ordinaryUiKeys.push('unknown.key')) }), /unknown key/);
});

test('fails closed on every locale-status semantic invariant', () => {
  for (const [change, error] of [
    [(x) => x.schemaVersion = 2, /schemaVersion/],
    [(x) => x.sourceLocale = 'es', /source and fallback/],
    [(x) => x.fallbackLocale = 'es', /source and fallback/],
    [(x) => x.translatedScope = 'all', /translatedScope/],
    [(x) => x.canonicalProviderDataTranslated = true, /exclude canonical provider/],
    [(x) => x.localVerificationRequired = false, /local verification/],
    [(x) => x.locales[0].role = 'ui_translation', /English locale/],
    [(x) => x.locales[0].reviewStatus = 'not_independently_human_reviewed', /English locale/],
    [(x) => x.locales[1].role = 'source_master', /non-English locale/],
    [(x) => x.locales[1].reviewStatus = 'source_master_not_formally_certified', /non-English locale/],
    [(x) => x.locales[1].extra = true, /exactly locale/],
    [(x) => x.locales[1].locale = 'en', /exactly one English|English locale/],
    [(x) => x.locales[2].locale = x.locales[1].locale, /unique/],
    [(x) => x.futureQualification = true, /must contain exactly/],
    [(x) => delete x.localVerificationRequired, /must contain exactly/],
  ]) assert.throws(() => generate({ manifest: mutate(input.manifest, change) }), error);
});

test('schema rejects qualification-like decisions, reviewer identity, timestamps, notes, and extra fields', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  for (const change of [
    (x) => x.entries[0].locales[1].reviewerDecision.status = 'approved',
    (x) => x.entries[0].locales[1].reviewerDecision.reviewerIdentity = 'reviewer.example.invalid',
    (x) => x.entries[0].locales[1].reviewerDecision.reviewedAt = '2026-08-16T00:00:00Z',
    (x) => x.entries[0].locales[1].reviewerDecision.notes = 'looks good',
    (x) => x.entries[0].locales[1].qualified = true,
  ]) assert.equal(validate(mutate(committed, change)), false);
});

test('schema alone rejects forged counts, locale inventories, order, and duplicate cells', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  for (const change of [
    (x) => x.localeCount = 11,
    (x) => x.keyCount = 146,
    (x) => x.locales[1] = 'xx',
    (x) => x.locales.reverse(),
    (x) => x.entries.pop(),
    (x) => x.entries.reverse(),
    (x) => x.entries[0].key = 'replacement.key',
    (x) => x.entries[1].key = x.entries[0].key,
    (x) => x.entries[0].locales.pop(),
    (x) => x.entries[0].locales[1] = structuredClone(x.entries[0].locales[2]),
    (x) => x.entries[0].locales.reverse(),
    (x) => x.entries[0].locales[1].manifestReviewStatus = 'source_master_not_formally_certified',
  ]) assert.equal(validate(mutate(committed, change)), false, change.toString());
});

test('contains only static UI inventory and no forbidden claims or contact-shaped leakage', () => {
  assert.deepEqual(reviewPackSafetyErrors(committed), []);
  for (const [change, error] of [
    [(x) => x.entries[0].locales[1].value = 'professionally translated', 'affirmative human-review claim'],
    [(x) => x.entries[0].locales[1].reviewerDecision.notes = 'reviewer@example.invalid', 'email leakage'],
    [(x) => x.entries[0].locales[1].value = 'https：//provider.example.invalid', 'URI leakage'],
    [(x) => x.entries[0].locales[1].value = '+1 555 123 4567', 'phone-shaped leakage'],
    [(x) => x.entries[0].locales[1].value = 'Contact: ＋４６ ８ １２３ ４５ ６７', 'phone-shaped leakage'],
    [(x) => x.entries[0].locales[1].value = 'Call ９１１', 'phone-shaped leakage'],
    [(x) => x.entries[0].locales[1].value = 'SMS: 112', 'phone-shaped leakage'],
    [(x) => x.entries[0].locales[1].value = 'provider id: abc-123', 'provider-identifying data'],
    [(x) => x.canonicalProviderDataIncluded = true, 'canonical provider data inclusion'],
    [(x) => x.valueSource = 'mixed', 'source provenance contract'],
    [(x) => x.qualificationEffect = true, 'qualification or authority effect'],
  ]) assert.ok(reviewPackSafetyErrors(mutate(committed, change)).includes(error));
  for (const value of ['Copyright 2026', 'Version 2.0.1', 'Showing 12 results', 'Updated 2026-08-16']) {
    assert.deepEqual(reviewPackSafetyErrors(mutate(committed, (x) => x.entries[0].locales[1].value = value)), []);
  }
});

test('exact parity rejects adversarial source, state, classification, and ordering mutations', () => {
  const expected = encodePack(generate());
  for (const change of [
    (x) => x.entries[0].sourceEnglish = 'tampered',
    (x) => x.entries[0].locales[1].valueState = 'locale_override',
    (x) => x.entries[0].classification = 'safety_facing',
    (x) => x.entries.reverse(),
    (x) => x.entries[0].locales.reverse(),
  ]) assert.notEqual(encodePack(mutate(committed, change)), expected);
});
