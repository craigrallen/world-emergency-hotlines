import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLocaleQualification } from './locale-qualification.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const errors = verifyLocaleQualification({
  manifest: JSON.parse(read('src/lib/locale-status.json')),
  i18nSource: read('src/lib/i18n.ts'),
  languageSwitcherSource: read('src/components/LanguageSwitcher.astro'),
  footerSource: read('src/components/Footer.astro'),
  statusPageSource: read('src/pages/language-status.astro'),
  sitemapSource: read('src/pages/sitemap.xml.ts'),
  providerSources: [read('src/components/HotlineCard.astro'), read('src/pages/country/[code].astro')],
});

if (errors.length) {
  console.error(`Locale qualification verification failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('Locale qualification OK: scope, review status, fallback, disclosure, discovery, and provider-data boundaries are aligned');
