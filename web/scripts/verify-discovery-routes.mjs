import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_URL } from '../src/lib/site.js';
import { isCategoryIndexable } from '../src/lib/seo.ts';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = resolve(WEB_ROOT, 'public', 'data');
const DIST_DIR = resolve(WEB_ROOT, 'dist');

const SOURCE_CHECKS = [
  {
    path: 'src/pages/sitemap.xml.ts',
    patterns: [
      [/getManifest\s*\(/, 'loads manifest data'],
      [/getCategoriesStats\s*\(/, 'loads category stats data'],
      [/alpha2\.toLowerCase\s*\(/, 'uses lowercase country route codes'],
      [/\/country\//, 'emits country routes'],
      [/\/category\//, 'emits category routes'],
      [/escapeXml\s*\(/, 'escapes sitemap XML values'],
      [/SITE_URL/, 'uses the shared site URL'],
    ],
  },
  {
    path: 'src/pages/robots.txt.ts',
    patterns: [
      [/User-agent:\s*\*/, 'declares default crawler agent'],
      [/Allow:\s*\//, 'allows crawling'],
      [/Sitemap:/, 'points crawlers at the sitemap'],
      [/SITE_URL/, 'uses the shared site URL'],
    ],
  },
];

const errors = [];

function fail(message) {
  errors.push(message);
}

function readJson(relativePath) {
  const path = resolve(DATA_DIR, relativePath);
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    fail(`${relativePath}: ${err.message}`);
    return null;
  }
}

function readText(path) {
  return readFileSync(path, 'utf-8');
}

function absoluteUrl(path) {
  return new URL(path, SITE_URL).toString().replace(/\/$/, path === '' ? '/' : '');
}

function extractSitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((match) =>
    match[1]
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&'),
  );
}

function compareSets(label, actualValues, expectedValues) {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);

  if (actual.size !== actualValues.length) {
    fail(`${label} contains duplicate entries`);
  }

  const missing = [...expected].filter((value) => !actual.has(value));
  const extra = [...actual].filter((value) => !expected.has(value));

  if (missing.length > 0) {
    fail(`${label} missing ${missing.length} expected URL(s), first: ${missing[0]}`);
  }
  if (extra.length > 0) {
    fail(`${label} contains ${extra.length} unexpected URL(s), first: ${extra[0]}`);
  }
}

const manifest = readJson('manifest.json');
const categoryStats = readJson('categories-stats.json');
const countries = Array.isArray(manifest?.countries) ? manifest.countries : [];
const categories = Array.isArray(categoryStats?.categories) ? categoryStats.categories : [];

if (countries.length === 0) {
  fail('manifest.countries must be a non-empty array');
}
if (categories.length === 0) {
  fail('categories-stats.categories must be a non-empty array');
}

for (const country of countries) {
  if (!/^[A-Z]{2}$/.test(country?.alpha2 ?? '')) {
    fail(`manifest country has invalid alpha2: ${country?.alpha2}`);
  }
}
for (const category of categories) {
  if (!/^[a-z0-9_]+$/.test(category?.slug ?? '')) {
    fail(`categories-stats entry has invalid slug: ${category?.slug}`);
  }
}

for (const check of SOURCE_CHECKS) {
  const sourcePath = resolve(WEB_ROOT, check.path);
  if (!existsSync(sourcePath)) {
    fail(`missing endpoint source: ${check.path}`);
    continue;
  }

  const source = readText(sourcePath);
  for (const [pattern, label] of check.patterns) {
    if (!pattern.test(source)) {
      fail(`${check.path} does not include expected pattern: ${label}`);
    }
  }
}

const expectedUrls = [
  '',
  '/about',
  '/find-help',
  '/integrate',
  '/map',
  '/data',
  '/categories',
  '/countries',
  ...countries.filter((country) => country.hotline_count > 0).map((country) => `/country/${country.alpha2.toLowerCase()}`).sort(),
  ...categories.filter(isCategoryIndexable).map((category) => `/category/${category.slug}`).sort(),
].map(absoluteUrl);

const sitemapPath = resolve(DIST_DIR, 'sitemap.xml');
const robotsPath = resolve(DIST_DIR, 'robots.txt');
const hasBuiltSitemap = existsSync(sitemapPath);
const hasBuiltRobots = existsSync(robotsPath);

if (hasBuiltSitemap || hasBuiltRobots) {
  if (!hasBuiltSitemap) {
    fail('dist/robots.txt exists but dist/sitemap.xml is missing');
  }
  if (!hasBuiltRobots) {
    fail('dist/sitemap.xml exists but dist/robots.txt is missing');
  }

  if (hasBuiltSitemap) {
    const locs = extractSitemapLocs(readText(sitemapPath));
    compareSets('dist/sitemap.xml', locs, expectedUrls);
  }

  if (hasBuiltRobots) {
    const robots = readText(robotsPath);
    const sitemapUrl = absoluteUrl('/sitemap.xml');
    if (!/^User-agent:\s*\*/m.test(robots)) {
      fail('dist/robots.txt is missing User-agent: *');
    }
    if (!/^Allow:\s*\//m.test(robots)) {
      fail('dist/robots.txt is missing Allow: /');
    }
    if (!robots.includes(`Sitemap: ${sitemapUrl}`)) {
      fail(`dist/robots.txt is missing sitemap pointer: ${sitemapUrl}`);
    }
    for (const path of ['/api/', '/gateway/', '/feeds/']) {
      if (!robots.includes(`Disallow: ${path}`)) fail(`dist/robots.txt is missing Disallow: ${path}`);
    }
    if (robots.includes('Disallow: /data/')) fail('dist/robots.txt must allow crawling Dataset JSON distributions under /data/');
    if (hasBuiltSitemap && extractSitemapLocs(readText(sitemapPath)).some((url) => new URL(url).pathname.startsWith('/data/'))) fail('dist/sitemap.xml must not include non-HTML /data/ artifacts');
  }
}

if (errors.length > 0) {
  console.error(`Discovery route verification failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

const builtStatus = hasBuiltSitemap && hasBuiltRobots ? 'built outputs checked' : 'built outputs not present; source checks only';
console.log(
  `Discovery routes OK: ${expectedUrls.length} sitemap URLs expected (${countries.length} countries, ${categories.length} categories); ${builtStatus}`,
);
