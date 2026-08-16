const EXPECTED_SCOPE = 'selected_static_ui_keys_only';
const NON_ENGLISH_STATUS = 'not_independently_human_reviewed';

function quotedValues(block) {
  return [...block.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

export function verifyLocaleQualification({ manifest, i18nSource, languageSwitcherSource, footerSource, statusPageSource, sitemapSource, providerSources }) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!manifest || manifest.schemaVersion !== 1) fail('locale status schemaVersion must be 1');
  if (manifest?.sourceLocale !== 'en' || manifest?.fallbackLocale !== 'en') fail('English must remain the explicit source and fallback locale');
  if (manifest?.translatedScope !== EXPECTED_SCOPE) fail(`translatedScope must be ${EXPECTED_SCOPE}`);
  if (manifest?.canonicalProviderDataTranslated !== false) fail('canonical provider data must be explicitly marked not translated');
  if (manifest?.localVerificationRequired !== true) fail('local verification requirement must remain explicit');

  const localeBlock = i18nSource.match(/export const LOCALES\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? '';
  const dictionaryBlock = i18nSource.match(/export const DICTIONARIES[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
  const supported = quotedValues(localeBlock);
  const dictionaries = [...dictionaryBlock.matchAll(/^\s*(?:['"]([^'"]+)['"]|([A-Za-z][\w-]*))\s*:/gm)].map((match) => match[1] ?? match[2]);
  const entries = Array.isArray(manifest?.locales) ? manifest.locales : [];
  const statusLocales = entries.map((entry) => entry?.locale);

  for (const [label, values] of [['supported locales', supported], ['dictionary locales', dictionaries], ['status locales', statusLocales]]) {
    if (values.length === 0) fail(`${label} must not be empty`);
    if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
  }
  if (JSON.stringify(supported) !== JSON.stringify(dictionaries) || JSON.stringify(supported) !== JSON.stringify(statusLocales)) {
    fail('locale, dictionary, and status locale order must match exactly');
  }

  for (const entry of entries) {
    const allowedKeys = ['locale', 'role', 'reviewStatus'];
    if (!entry || Object.keys(entry).sort().join(',') !== allowedKeys.sort().join(',')) fail(`status entry ${entry?.locale ?? '(unknown)'} has unsupported fields`);
    if (entry?.locale === 'en') {
      if (entry.role !== 'source_master' || entry.reviewStatus !== 'source_master_not_formally_certified') fail('English status must identify an uncertified source/master locale');
    } else if (entry?.role !== 'ui_translation' || entry?.reviewStatus !== NON_ENGLISH_STATUS) {
      fail(`${entry?.locale ?? '(unknown)'} must remain explicitly not independently human-reviewed`);
    }
  }

  if (!/data-translation-status-link[^>]*href="\/language-status"/.test(languageSwitcherSource)) fail('language selector must directly discover the translation status route');
  if (!/href="\/language-status"[^>]*data-translation-status-link|data-translation-status-link[^>]*href="\/language-status"/.test(footerSource)) fail('shared footer must discover the translation status route');
  if (!/data-translation-disclosure/.test(statusPageSource) || !/data-canonical-provider-data-translated="false"/.test(statusPageSource)) fail('status route must expose a machine-checkable disclosure boundary');
  if (/<\/?main(?:\s|>)/i.test(statusPageSource)) fail('status route must not define a main landmark because Base already provides one');
  for (const phrase of ['selected site chrome', 'source-record language', 'falls back to English', 'not been independently human-reviewed or qualified', 'verify the number']) {
    if (!statusPageSource.includes(phrase)) fail(`status route missing required disclosure: ${phrase}`);
  }
  const disclosureWithoutNegativeStatus = statusPageSource
    .replaceAll('not been independently human-reviewed or qualified', '')
    .replaceAll('not independently human-reviewed or qualified', '');
  if (/\b(?:independently human-reviewed|qualified translation|professionally translated|certified translation)\b/i.test(disclosureWithoutNegativeStatus)) {
    fail('status route contains an unsupported affirmative translation-review claim');
  }
  if (!/['"]\/language-status['"]/.test(sitemapSource)) fail('language status route must be listed in sitemap source');

  const providerText = providerSources.join('\n');
  if (/data-(?:provider|canonical)-(?:content-)?translated\s*=\s*["'{]?(?:true|yes|qualified)/i.test(providerText)) fail('provider rendering must never label canonical content as translated');
  if (/translateProvider|translateCanonical|providerTranslation|canonicalTranslation/.test(providerText)) fail('provider rendering contains a prohibited translation hook');
  return errors;
}
