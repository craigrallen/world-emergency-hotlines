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
  statusPageSource: '<main data-translation-disclosure data-canonical-provider-data-translated="false">selected site chrome source-record language falls back to English not been independently human-reviewed or qualified verify the number</main>',
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
  assert.ok(check({ statusPageSource: `${valid.statusPageSource} Spanish is independently human-reviewed.` }).some((error) => error.includes('unsupported affirmative')));
});
test('fails on locale, dictionary, or status drift', () => {
  assert.ok(check({ i18nSource: valid.i18nSource.replace("  es: ES,", '') }).some((error) => error.includes('must match exactly')));
});
test('fails when disclosure or selector discovery disappears', () => {
  assert.ok(check({ languageSwitcherSource: '<select></select>', statusPageSource: '' }).length >= 2);
});
test('fails on a provider translation label or hook', () => {
  assert.ok(check({ providerSources: ['<article data-provider-translated="true">', 'translateCanonical(record)'] }).some((error) => error.includes('provider rendering')));
});
test('fails when canonical-data translation policy is weakened', () => {
  assert.ok(check({ manifest: { ...valid.manifest, canonicalProviderDataTranslated: true } }).some((error) => error.includes('canonical provider data')));
});
