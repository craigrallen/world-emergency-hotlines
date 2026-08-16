const EXPECTED_SCOPE = 'selected_static_ui_keys_only';
const NON_ENGLISH_STATUS = 'not_independently_human_reviewed';

// Conservative shared denylist. Callers must remove the repository's required
// negative disclosures before applying these affirmative-claim patterns.
export const AFFIRMATIVE_TRANSLATION_REVIEW_PATTERNS = Object.freeze([
  /\bindependently[\s_-]+human[\s_-]+(?:reviewed|approved)\b/iu,
  /\bprofessionally[\s_-]+translated\b/iu,
  /\bqualified[\s_-]+translation\b/iu,
  /\bcertified[\s_-]+translation\b/iu,
  /(?<!\p{L})traducci[oó]n[\s_-]+certificada(?!\p{L})/iu,
  /(?<!\p{L})revisad[oa][\s_-]+independientemente[\s_-]+por[\s_-]+humanos(?!\p{L})/iu,
  /(?<!\p{L})traduction[\s_-]+certifi[eé]e(?!\p{L})/iu,
  /(?<!\p{L})r[eé]vis[eé][\s_-]+(?:de[\s_-]+mani[eè]re[\s_-]+)?ind[eé]pendante[\s_-]+par[\s_-]+des[\s_-]+humains(?!\p{L})/iu,
  /(?<!\p{L})zertifizierte[\s_-]+[uü]bersetzung(?!\p{L})/iu,
  /(?<!\p{L})unabh[aä]ngig[\s_-]+von[\s_-]+menschen[\s_-]+[uü]berpr[uü]ft(?!\p{L})/iu,
  /(?<!\p{L})tradu[cç][aã]o[\s_-]+certificada(?!\p{L})/iu,
  /(?<!\p{L})revisad[oa][\s_-]+independentemente[\s_-]+por[\s_-]+humanos(?!\p{L})/iu,
  /(?:ترجمة\s+معتمدة|تمت\s+مراجعته\s+بشكل\s+مستقل\s+من\s+قبل\s+البشر)/u,
  /(?:प्रमाणित\s+अनुवाद|स्वतंत्र\s+रूप\s+से\s+मानव[‐-―-]समीक्षित)/u,
  /(?:认证翻译|经过独立人工审核)/u,
  /(?:認定翻訳|独立した人間によるレビュー済み)/u,
  /(?<!\p{L})сертифицированный[\s_-]+перевод(?!\p{L})/iu,
  /(?<!\p{L})независимо[\s_-]+проверено[\s_-]+человеком(?!\p{L})/iu,
]);

export function containsAffirmativeTranslationReviewClaim(value) {
  const withoutRequiredNegativeClaims = value.normalize('NFKC')
    .replace(/\bnot(?:[\s_-]+been)?[\s_-]+independently[\s_-]+human[\s_-]+reviewed(?:[\s_-]+or[\s_-]+qualified)?\b/giu, '')
    .replace(/\bnot[\s_-]+formally[\s_-]+certified\b/giu, '');
  return AFFIRMATIVE_TRANSLATION_REVIEW_PATTERNS.some((pattern) => pattern.test(withoutRequiredNegativeClaims));
}

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
  const disclosureTag = statusPageSource.match(/<section\b[^>]*\bdata-translation-disclosure\b[^>]*>/i)?.[0] ?? '';
  if (!disclosureTag || !/\bdata-canonical-provider-data-translated="false"/.test(disclosureTag)) fail('status route must expose a machine-checkable disclosure boundary');
  if (!/\blang="en"/.test(disclosureTag) || !/\bdir="ltr"/.test(disclosureTag)) fail('untranslated status disclosure must define an English/LTR language boundary');
  if (/<\/?main(?:\s|>)/i.test(statusPageSource)) fail('status route must not define a main landmark because Base already provides one');
  for (const phrase of ['selected site chrome', 'source-record language', 'Missing interface keys fall back to English', 'Licensing-sensitive keys deliberately remain English pending qualified translation and legal review', 'Existing non-English UI, including safety-facing chrome, has not been independently human-reviewed or qualified and may contain errors', 'verify the number']) {
    if (!statusPageSource.includes(phrase)) fail(`status route missing required disclosure: ${phrase}`);
  }
  if (/safety- or licensing-sensitive copy without the required review[^.]*falls back to English/i.test(statusPageSource)) {
    fail('status route must not claim review-gated fallback that runtime does not implement');
  }
  const disclosureWithoutPolicyDescription = statusPageSource
    .replaceAll('Licensing-sensitive keys deliberately remain English pending qualified translation and legal review', '');
  if (containsAffirmativeTranslationReviewClaim(disclosureWithoutPolicyDescription)) {
    fail('status route contains an unsupported affirmative translation-review claim');
  }
  if (!/['"]\/language-status['"]/.test(sitemapSource)) fail('language status route must be listed in sitemap source');

  const providerText = providerSources.join('\n');
  if (/data-(?:provider|canonical)-(?:content-)?translated\s*=\s*["'{]?(?:true|yes|qualified)/i.test(providerText)) fail('provider rendering must never label canonical content as translated');
  if (/translateProvider|translateCanonical|providerTranslation|canonicalTranslation/.test(providerText)) fail('provider rendering contains a prohibited translation hook');
  return errors;
}
