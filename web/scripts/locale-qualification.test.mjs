import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyLocaleQualification } from './locale-qualification.mjs';

const valid = {
  manifest: {
    schemaVersion: 1, sourceLocale: 'en', fallbackLocale: 'en', translatedScope: 'selected_static_ui_keys_only',
    canonicalProviderDataTranslated: false, localVerificationRequired: true,
    locales: [
      { locale: 'en', role: 'source_master', reviewStatus: 'source_master_not_formally_certified' },
      { locale: 'es', role: 'ui_translation', reviewStatus: 'not_independently_human_reviewed' },
    ],
  },
  i18nSource: `export const LOCALES = ['en', 'es'] as const;\nexport const DICTIONARIES: Record<string, object> = {\n  en: EN,\n  es: ES,\n};`,
  languageSwitcherSource: '<a data-translation-status-link href="/language-status">status</a>',
  footerSource: '<a href="/language-status" data-translation-status-link>status</a>',
  statusPageSource: '<section lang="en" dir="ltr" data-translation-disclosure data-canonical-provider-data-translated="false">selected site chrome source-record language Missing interface keys fall back to English Licensing-sensitive keys deliberately remain English pending qualified translation and legal review Existing non-English UI, including safety-facing chrome, has not been independently human-reviewed or qualified and may contain errors verify the number</section>',
  sitemapSource: `const paths = ['/language-status'];`,
  providerSources: ['<h3>{hotline.name}</h3>'],
};

const check = (change) => verifyLocaleQualification({ ...valid, ...change });
test('accepts the conservative aligned contract', () => assert.deepEqual(check({}), []));
test('fails closed on an unsupported human-review claim', () => {
  const manifest = structuredClone(valid.manifest);
  manifest.locales[1].reviewStatus = 'human_reviewed';
  assert.ok(check({ manifest }).some((error) => error.includes('must remain explicitly')));
});
test('fails closed on a contradictory public qualification claim', () => {
  for (const claim of ['independently human-reviewed', 'independently human-approved', 'professionally translated', 'qualified translation', 'certified translation']) {
    assert.ok(check({ statusPageSource: `${valid.statusPageSource} Spanish is ${claim}.` }).some((error) => error.includes('unsupported affirmative')), claim);
  }
});
test('rejects the old review-gated fallback overclaim', () => {
  assert.ok(check({ statusPageSource: `${valid.statusPageSource} Safety- or licensing-sensitive copy without the required review falls back to English.` }).some((error) => error.includes('review-gated fallback')));
});
test('fails on locale, dictionary, or status drift', () => {
  assert.ok(check({ i18nSource: valid.i18nSource.replace("  es: ES,", '') }).some((error) => error.includes('must match exactly')));
});
test('fails when disclosure or selector discovery disappears', () => {
  assert.ok(check({ languageSwitcherSource: '<select></select>', statusPageSource: '' }).length >= 2);
});
test('fails when the untranslated disclosure loses its English/LTR boundary', () => {
  for (const attribute of ['lang="en"', 'dir="ltr"']) {
    assert.ok(check({ statusPageSource: valid.statusPageSource.replace(attribute, '') }).some((error) => error.includes('English/LTR language boundary')));
  }
});
test('fails when the status route reintroduces Base\'s main landmark', () => {
  assert.ok(check({ statusPageSource: valid.statusPageSource.replaceAll('section', 'main') }).some((error) => error.includes('must not define a main landmark')));
});
test('fails on a provider translation label or hook', () => {
  assert.ok(check({ providerSources: ['<article data-provider-translated="true">', 'translateCanonical(record)'] }).some((error) => error.includes('provider rendering')));
});
test('fails when canonical-data translation policy is weakened', () => {
  assert.ok(check({ manifest: { ...valid.manifest, canonicalProviderDataTranslated: true } }).some((error) => error.includes('canonical provider data')));
});
