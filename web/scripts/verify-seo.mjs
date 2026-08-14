import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeJsonLd } from '../src/lib/json-ld.mjs';
import { SITE_NAME, SOCIAL_IMAGE_ALT, SOCIAL_IMAGE_PATH } from '../src/lib/seo.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const site = 'https://worldhotlines.org';
const errors = [];
const fail = (message) => errors.push(message);
const read = (path) => readFileSync(path, 'utf8');

function positiveBlanketProvenanceClaims(source) {
  const text = String(source)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:[a-z]+|#\d+|#x[\da-f]+);/gi, ' ')
    .replace(/\s+/g, ' ');
  const candidates = text.split(/(?<=[.!?;])\s+|\s*[\r\n]+\s*/).filter(Boolean);
  const positivePatterns = [
    /\bsource[- ]backed\b/i,
    /\b(?:all|every|each|complete|entire|full)\b.{0,80}\b(?:records?|listings?|directory|dataset|outputs?|results?)\b.{0,80}\b(?:verified|validated|confirmed|source evidence|provenance|authoritative sources?|trusted sources?)\b/i,
    /\b(?:records?|listings?|directory|dataset|outputs?|results?)\b.{0,50}\b(?:are|is|have|has|contain|contains|provide|provides|return|returns)\b.{0,50}\b(?:verified|validated|confirmed|source evidence|visible provenance|authoritative sources?|trusted sources?)\b/i,
  ];
  const negativeOrQualified = /\b(?:not|no|never|without|lack(?:s|ing)?|missing|unavailable|when available|where available|if available|var(?:y|ies))\b.{0,100}\b(?:source[- ]backed|verified|validated|confirmed|source evidence|provenance|sources?|verification)\b|\b(?:source[- ]backed|verified|validated|confirmed|source evidence|provenance|sources?|verification)\b.{0,100}\b(?:not|no proof|cannot|does not|do not|when available|where available|if available|var(?:y|ies))\b/i;
  return candidates.filter((candidate) => positivePatterns.some((pattern) => pattern.test(candidate)) && !negativeOrQualified.test(candidate));
}

function provenanceClaimIsSupported(source, records) {
  return records.every((record) => Array.isArray(record.sources) && record.sources.some((item) => typeof item === 'string' && item.trim()))
    || positiveBlanketProvenanceClaims(source).length === 0;
}

const unsupportedProvenanceFixture = [{ id: 'unsupported', sources: [], website: null }];
assert.equal(provenanceClaimIsSupported('All directory records are source-backed and verified.', unsupportedProvenanceFixture), false, 'provenance guard fixture must reject an unsupported blanket claim');
assert.equal(provenanceClaimIsSupported('Listed records; source and verification status are shown when available.', unsupportedProvenanceFixture), true, 'provenance guard fixture must accept qualified neutral wording');

const jsonLdEscapeFixture = { privateValue: '</script><' };
const serializedFixture = serializeJsonLd(jsonLdEscapeFixture);
if (serializedFixture.toLowerCase().includes('</script>')) fail('JSON-LD serializer must remove literal closing script tags');
if (!serializedFixture.includes('\\u003c/script>\\u003c') || serializedFixture.includes('\\\\u003c')) fail('JSON-LD serializer must use single \\u003c escapes');
if (JSON.stringify(JSON.parse(serializedFixture)) !== JSON.stringify(jsonLdEscapeFixture)) fail('JSON-LD serializer must preserve exact parsed values');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

// A small quote-aware start-tag scanner avoids regex parsing of attributes.
function tags(html) {
  const found = [];
  for (let i = 0; i < html.length; i++) {
    if (html[i] !== '<' || html[i + 1] === '/' || html[i + 1] === '!' || html[i + 1] === '?') continue;
    let j = i + 1, quote = '';
    while (j < html.length) {
      const char = html[j];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      j++;
    }
    const raw = html.slice(i + 1, j);
    const name = raw.match(/^\s*([^\s/>]+)/)?.[1]?.toLowerCase();
    if (!name) continue;
    const attrs = {};
    const rest = raw.slice(raw.indexOf(name) + name.length);
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const match of rest.matchAll(attrRe)) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
    found.push({ name, attrs, start: i, end: j + 1 });
    if (name === 'script') {
      const close = html.toLowerCase().indexOf('</script>', j + 1);
      if (close !== -1) { i = close + 8; continue; }
    }
    i = j;
  }
  return found;
}

function jsonLdBlocks(html, route) {
  const blocks = [];
  for (const tag of tags(html).filter((entry) => entry.name === 'script' && entry.attrs.type?.trim().toLowerCase() === 'application/ld+json')) {
    const close = html.toLowerCase().indexOf('</script>', tag.end);
    if (close === -1) { fail(`${route}: unterminated JSON-LD script`); continue; }
    const source = html.slice(tag.end, close);
    try {
      const value = JSON.parse(source);
      if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${route}: JSON-LD root must be an object`);
      else blocks.push({ value, source });
    } catch (error) { fail(`${route}: invalid JSON-LD (${error.message})`); }
  }
  return blocks;
}

function routeFor(path) {
  const rel = relative(dist, path).replaceAll('\\', '/');
  if (rel === 'index.html') return '/';
  if (rel === '404.html') return '/404';
  return `/${rel.replace(/\/index\.html$/, '').replace(/\.html$/, '')}`;
}
function decodeHtml(value) {
  return String(value ?? '').replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal, hex, named) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' }[named.toLowerCase()] ?? entity;
  });
}
function textContent(html, tag) {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((m) => decodeHtml(m[1].replace(/<[^>]+>/g, '')).trim());
}
function attrs(all, name, predicate = () => true) { return all.filter((tag) => tag.name === name && predicate(tag.attrs)).map((tag) => tag.attrs); }
function canonicalPath(route) { return route === '/' ? `${site}/` : `${site}${route}`; }
function localExists(pathname) {
  const clean = decodeURIComponent(pathname).replace(/\/$/, '') || '/';
  const candidates = clean === '/' ? [join(dist, 'index.html')] : [join(dist, `${clean}.html`), join(dist, clean, 'index.html'), join(dist, clean)];
  return candidates.some(existsSync);
}

if (!existsSync(dist)) fail('dist is missing; run npm run build first');
const htmlFiles = existsSync(dist) ? files(dist).filter((path) => extname(path) === '.html') : [];
const pages = new Map();
for (const path of htmlFiles) {
  const html = read(path), route = routeFor(path), all = tags(html);
  const robotsTags = attrs(all, 'meta', (a) => a.name?.trim().toLowerCase() === 'robots');
  const robots = robotsTags.length === 1 ? robotsTags[0].content?.trim().toLowerCase() : undefined;
  const supportedRobots = ['index,follow', 'noindex,follow'];
  const validRobots = robotsTags.length === 1 && supportedRobots.includes(robots);
  const indexable = validRobots && robots === 'index,follow';
  const titles = textContent(html, 'title').filter(Boolean);
  const descriptionTags = attrs(all, 'meta', (a) => a.name?.trim().toLowerCase() === 'description');
  const descriptions = descriptionTags.map((a) => decodeHtml(a.content).trim()).filter(Boolean);
  const canonicalTags = attrs(all, 'link', (a) => a.rel?.trim().toLowerCase() === 'canonical');
  const canonicals = canonicalTags.map((a) => a.href?.trim()).filter(Boolean);
  const h1s = textContent(html, 'h1').filter(Boolean);
  if (robotsTags.length !== 1) fail(`${route}: expected exactly one meta[name=robots], found ${robotsTags.length}`);
  else if (!validRobots) fail(`${route}: unsupported robots meta content ${JSON.stringify(robotsTags[0].content)}`);
  if (titles.length !== 1 || descriptions.length !== 1 || h1s.length !== 1) fail(`${route}: expected exactly one non-empty title, description, and H1`);
  if (descriptionTags.length !== 1 || descriptions.length !== 1) fail(`${route}: expected exactly one non-empty meta description`);
  if (indexable && (canonicalTags.length !== 1 || canonicals.length !== 1)) fail(`${route}: indexable page needs exactly one non-empty canonical`);
  if (!indexable && canonicalTags.length) fail(`${route}: noindex page must omit canonical`);
  if (canonicals.length && canonicals[0] !== canonicalPath(route)) fail(`${route}: invalid canonical ${canonicals[0]}`);
  const metadata = (attribute, key) => {
    const matches = attrs(all, 'meta', (a) => a[attribute]?.trim().toLowerCase() === key).map((a) => decodeHtml(a.content).trim());
    if (matches.length !== 1 || !matches[0]) fail(`${route}: expected exactly one non-empty ${key}`);
    return matches[0];
  };
  const socialImage = `${site}${SOCIAL_IMAGE_PATH}`;
  const social = {
    siteName: metadata('property', 'og:site_name'), title: metadata('property', 'og:title'),
    description: metadata('property', 'og:description'), type: metadata('property', 'og:type'),
    image: metadata('property', 'og:image'), width: metadata('property', 'og:image:width'),
    height: metadata('property', 'og:image:height'), imageType: metadata('property', 'og:image:type'),
    imageAlt: metadata('property', 'og:image:alt'), card: metadata('name', 'twitter:card'),
    twitterTitle: metadata('name', 'twitter:title'), twitterDescription: metadata('name', 'twitter:description'),
    twitterImage: metadata('name', 'twitter:image'), twitterAlt: metadata('name', 'twitter:image:alt'),
  };
  if (social.siteName !== SITE_NAME) fail(`${route}: og:site_name must equal the shared site name`);
  if (social.title !== titles[0] || social.twitterTitle !== titles[0]) fail(`${route}: social titles must exactly match title`);
  if (social.description !== descriptions[0] || social.twitterDescription !== descriptions[0]) fail(`${route}: social descriptions must exactly match meta description`);
  if (social.type !== 'website') fail(`${route}: og:type must be website`);
  if (social.card !== 'summary_large_image') fail(`${route}: twitter:card must be summary_large_image`);
  if (social.image !== socialImage || social.twitterImage !== socialImage) fail(`${route}: social image URLs must equal ${socialImage}`);
  if (social.width !== '1200' || social.height !== '630' || social.imageType !== 'image/png') fail(`${route}: social image declarations must match the checked 1200x630 PNG`);
  if (social.imageAlt !== SOCIAL_IMAGE_ALT || social.twitterAlt !== SOCIAL_IMAGE_ALT) fail(`${route}: social image alt text must equal the shared non-empty value`);
  const ogUrlTags = attrs(all, 'meta', (a) => a.property?.trim().toLowerCase() === 'og:url');
  const ogUrls = ogUrlTags.map((a) => a.content?.trim()).filter(Boolean);
  if (indexable && (ogUrlTags.length !== 1 || ogUrls.length !== 1 || ogUrls[0] !== canonicals[0])) fail(`${route}: indexable page needs exactly one non-empty og:url equal to canonical`);
  if (!indexable && ogUrlTags.length) fail(`${route}: noindex page must omit og:url`);
  const jsonLd = jsonLdBlocks(html, route);
  for (const anchor of attrs(all, 'a')) {
    const href = anchor.href;
    if (!href || /^(?:https?:|mailto:|tel:|sms:|#)/i.test(href)) continue;
    const url = new URL(href, site);
    if (url.origin === site && !localExists(url.pathname)) fail(`${route}: unresolved internal link ${href}`);
  }
  pages.set(route, { route, html, indexable, title: titles[0], description: descriptions[0], canonical: canonicals[0], jsonLd });
}

const sitemap = read(join(dist, 'sitemap.xml'));
const sitemapRoutes = new Set([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => new URL(m[1]).pathname.replace(/\/$/, '') || '/'));
for (const page of pages.values()) {
  if (page.indexable && !sitemapRoutes.has(page.route)) fail(`${page.route}: indexable page absent from sitemap`);
  if (!page.indexable && sitemapRoutes.has(page.route)) fail(`${page.route}: noindex page present in sitemap`);
}
for (const route of sitemapRoutes) if (!pages.get(route)?.indexable) fail(`${route}: sitemap target is missing or noindex`);
for (const field of ['title', 'description', 'canonical']) {
  const seen = new Map();
  for (const page of [...pages.values()].filter((p) => p.indexable)) {
    if (seen.has(page[field])) fail(`${page.route}: duplicate ${field} with ${seen.get(page[field])}`);
    seen.set(page[field], page.route);
  }
}

const manifest = JSON.parse(read(join(dist, 'data/manifest.json')));
const stats = JSON.parse(read(join(dist, 'data/categories-stats.json')));
const manifestCountries = manifest.countries;
const eligibleCountries = manifestCountries.filter((country) => country.hotline_count > 0);
const eligibleCountryRoutes = new Set(eligibleCountries.map((country) => `/country/${country.alpha2.toLowerCase()}`));
if (manifest.total_countries !== manifestCountries.length) fail(`manifest total_countries ${manifest.total_countries} does not match its ${manifestCountries.length} country records`);
const countryShards = new Map();
const allRecords = [];
for (const country of manifestCountries) {
  const code = country.alpha2.toLowerCase();
  const shardPath = join(dist, `data/countries/${code}.json`);
  if (!existsSync(shardPath)) { fail(`country shard missing for ${country.alpha2}`); continue; }
  const shard = JSON.parse(read(shardPath));
  const records = Array.isArray(shard.hotlines) ? shard.hotlines : [];
  countryShards.set(code, records);
  allRecords.push(...records);
  if (shard.alpha2 !== country.alpha2 || records.length !== country.hotline_count) fail(`${country.alpha2}: country shard identity/count does not match manifest (${records.length} records versus ${country.hotline_count})`);
}
const recordsWithSources = allRecords.filter((record) => Array.isArray(record.sources) && record.sources.some((item) => typeof item === 'string' && item.trim())).length;
const recordsWithoutSources = allRecords.length - recordsWithSources;
const recordsWithNeitherSourceNorWebsite = allRecords.filter((record) => {
  const hasSource = Array.isArray(record.sources) && record.sources.some((item) => typeof item === 'string' && item.trim());
  const hasWebsite = typeof record.website === 'string' && record.website.trim();
  return !hasSource && !hasWebsite;
}).length;
if (countryShards.size !== manifestCountries.length) fail(`loaded ${countryShards.size} country shards for ${manifestCountries.length} manifest countries`);
if (allRecords.length !== manifest.total_hotlines) fail(`country shards contain ${allRecords.length} records but manifest total_hotlines is ${manifest.total_hotlines}`);

const directoryScopeRoutes = new Set(['/', '/about', '/data', '/countries', '/find-help', '/integrate']);
for (const page of pages.values()) {
  const countryCode = page.route.match(/^\/country\/([a-z]{2})$/)?.[1];
  const records = directoryScopeRoutes.has(page.route) ? allRecords : countryCode ? countryShards.get(countryCode) : undefined;
  if (!records || records.every((record) => Array.isArray(record.sources) && record.sources.some((item) => typeof item === 'string' && item.trim()))) continue;
  const sources = [page.html, page.title, page.description, ...page.jsonLd.map(({ value }) => JSON.stringify(value))];
  const claims = sources.flatMap(positiveBlanketProvenanceClaims);
  for (const claim of [...new Set(claims)]) fail(`${page.route}: positive blanket provenance claim is unsupported by included records without sources: ${JSON.stringify(claim.slice(0, 180))}`);
}
for (const country of manifest.countries) {
  const route = `/country/${country.alpha2.toLowerCase()}`, expected = country.hotline_count > 0;
  if (pages.get(route)?.indexable !== expected || sitemapRoutes.has(route) !== expected) fail(`${route}: country eligibility mismatch`);
}
for (const category of stats.categories) {
  const route = `/category/${category.slug}`, expected = category.countries >= 2 || category.verified_count >= 2;
  if (pages.get(route)?.indexable !== expected || sitemapRoutes.has(route) !== expected) fail(`${route}: category eligibility mismatch`);
}
if (!pages.get('/countries')?.indexable || !sitemapRoutes.has('/countries')) fail('/countries: discovery invariant failed');
const countryIndexLinks = new Set(attrs(tags(pages.get('/countries')?.html ?? ''), 'a')
  .map((anchor) => anchor.href)
  .filter((href) => /^\/country\/[a-z]{2}\/?$/.test(href ?? ''))
  .map((href) => href.replace(/\/$/, '')));
const sitemapCountryRoutes = new Set([...sitemapRoutes].filter((route) => /^\/country\/[a-z]{2}$/.test(route)));
const renderedEligibleCountryRoutes = new Set([...pages.values()]
  .filter((page) => page.indexable && /^\/country\/[a-z]{2}$/.test(page.route))
  .map((page) => page.route));
for (const [label, actual] of [['/countries links', countryIndexLinks], ['sitemap country routes', sitemapCountryRoutes], ['rendered indexable country routes', renderedEligibleCountryRoutes]]) {
  const missing = [...eligibleCountryRoutes].filter((route) => !actual.has(route));
  const extra = [...actual].filter((route) => !eligibleCountryRoutes.has(route));
  if (actual.size !== eligibleCountries.length || missing.length || extra.length) fail(`${label}: expected exactly ${eligibleCountries.length} manifest countries with hotline_count > 0; found ${actual.size} (${missing.length} missing, ${extra.length} extra)`);
}
if (!pages.get('/map')?.html.match(/<h1\b/i)) fail('/map: H1 missing');

const rootTypes = new Set(['WebSite', 'Organization', 'BreadcrumbList', 'Dataset']);
const nestedTypes = new Set(['Organization', 'ListItem', 'DataDownload']);
function schemaTypes(value) { return Array.isArray(value?.['@type']) ? value['@type'] : [value?.['@type']]; }
function validSiteUrl(raw, route, label, { mustEqualCanonical = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { fail(`${route}: ${label} is not an absolute URL`); return false; }
  if (url.origin !== site || url.search || url.hash) { fail(`${route}: ${label} must use the canonical origin without query or fragment`); return false; }
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (url.toString() !== canonicalPath(path)) fail(`${route}: ${label} is not a canonical route URL`);
  if (mustEqualCanonical && url.toString() !== canonicalPath(route)) fail(`${route}: ${label} must equal the page canonical`);
  return true;
}
function validateTypedObject(value, route, root = false) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return;
  const types = schemaTypes(value);
  if (types.some((type) => typeof type !== 'string' || !(root ? rootTypes : new Set([...rootTypes, ...nestedTypes])).has(type))) {
    fail(`${route}: unknown or missing JSON-LD ${root ? 'root ' : ''}type ${JSON.stringify(value['@type'])}`);
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => validateTypedObject(item, route));
    else if (child && typeof child === 'object' && '@type' in child) validateTypedObject(child, route);
  }
}
for (const page of pages.values()) {
  for (const { value } of page.jsonLd) {
    if (value['@context'] !== 'https://schema.org') fail(`${page.route}: JSON-LD root needs the canonical schema.org context`);
    validateTypedObject(value, page.route, true);
    if (['WebSite', 'Organization', 'Dataset'].includes(value['@type'])) validSiteUrl(value.url, page.route, `${value['@type']}.url`, { mustEqualCanonical: true });
  }
}

function requireBreadcrumb(route) {
  const page = pages.get(route);
  const lists = page?.jsonLd.map(({ value }) => value).filter((value) => value['@type'] === 'BreadcrumbList') ?? [];
  if (lists.length !== 1) { fail(`${route}: expected exactly one BreadcrumbList`); return; }
  const items = lists[0].itemListElement;
  if (!Array.isArray(items) || items.length < 2) { fail(`${route}: BreadcrumbList needs at least two items`); return; }
  items.forEach((item, index) => {
    if (item?.['@type'] !== 'ListItem' || item.position !== index + 1 || typeof item.name !== 'string' || !item.name.trim()) fail(`${route}: breadcrumb item ${index + 1} is invalid or non-contiguous`);
    if (validSiteUrl(item?.item, route, `breadcrumb item ${index + 1}`)) {
      const path = new URL(item.item).pathname.replace(/\/$/, '') || '/';
      if (!pages.get(path)?.canonical) fail(`${route}: breadcrumb item ${index + 1} does not identify a canonical HTML route`);
      if (index === items.length - 1 && path !== route) fail(`${route}: final breadcrumb does not identify its page`);
    }
  });
}
for (const route of ['/countries', '/categories', '/about', '/data']) requireBreadcrumb(route);
for (const page of pages.values()) if (page.indexable && (/^\/country\/[^/]+$/.test(page.route) || /^\/category\/[^/]+$/.test(page.route))) requireBreadcrumb(page.route);

const homeValues = pages.get('/')?.jsonLd.map(({ value }) => value) ?? [];
if (homeValues.filter((value) => value['@type'] === 'WebSite').length !== 1 || homeValues.filter((value) => value['@type'] === 'Organization').length !== 1) fail('/: requires exactly one WebSite and one maintainer/publisher Organization');
const maintainer = homeValues.find((value) => value['@type'] === 'Organization');
if (maintainer?.name !== 'World Emergency & Hotlines project maintainers' || JSON.stringify(maintainer?.sameAs) !== JSON.stringify(['https://github.com/craigrallen/world-emergency-hotlines'])) fail('/: maintainer/publisher Organization identity is incomplete or unexpected');

const dataValues = pages.get('/data')?.jsonLd.map(({ value }) => value) ?? [];
const datasets = dataValues.filter((item) => item['@type'] === 'Dataset');
const dataset = datasets[0];
const expectedDistributions = [
  ['Dataset manifest', '/data/manifest.json'],
  ['Category statistics', '/data/categories-stats.json'],
  ['Search index', '/data/search-index.json'],
];
if (datasets.length !== 1 || dataset.name !== 'World Emergency & Hotlines dataset' || dataset.version !== manifest.dataset_version || dataset.dateModified !== manifest.source_last_updated || dataset.isAccessibleForFree !== true || 'license' in dataset || dataset.url !== canonicalPath('/data') || JSON.stringify(dataset.creator) !== JSON.stringify({ '@type': 'Organization', name: 'World Emergency & Hotlines project maintainers', url: 'https://github.com/craigrallen/world-emergency-hotlines' })) fail('/data: Dataset facts do not exactly match manifest, route, creator, or license policy');
if (!Array.isArray(dataset?.distribution) || dataset.distribution.length !== expectedDistributions.length || expectedDistributions.some(([name, path], index) => {
  const item = dataset.distribution[index];
  return item?.['@type'] !== 'DataDownload' || item.name !== name || item.encodingFormat !== 'application/json' || item.contentUrl !== `${site}${path}`;
})) fail('/data: Dataset distributions must exactly identify the three canonical JSON downloads');

function pngSize(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return [];
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
for (const [asset, expected] of [['social-card.png',[1200,630]],['apple-touch-icon.png',[180,180]],['favicon-192x192.png',[192,192]],['favicon-32x32.png',[32,32]]]) {
  const path = join(dist, asset);
  if (!existsSync(path) || pngSize(path).some((n, i) => n !== expected[i])) fail(`${asset}: missing or wrong dimensions`);
}
const corpus = htmlFiles.map(read).join('\n');
for (const phrase of ['works in most countries', 'even without a SIM', 'will always have up-to-date', '112 / 911']) if (corpus.toLowerCase().includes(phrase.toLowerCase())) fail(`forbidden universal YMYL claim found: ${phrase}`);
const i18nSource = read(join(root, 'src/lib/i18n.ts'));
if (!provenanceClaimIsSupported(i18nSource, allRecords)) {
  for (const claim of positiveBlanketProvenanceClaims(i18nSource)) fail(`localized public copy: positive blanket provenance claim is unsupported by records without sources: ${JSON.stringify(claim.slice(0, 180))}`);
}
const bannerBodies = [...i18nSource.matchAll(/'banner\.body':\s*'([^']*)'/g)].map((match) => match[1]);
const travellingBodies = [...i18nSource.matchAll(/'search\.travellingBody':\s*'([^']*)'/g)].map((match) => match[1]);
if (bannerBodies.length !== 10 || bannerBodies.some((body) => /\d|\{\{number\}\}/.test(body))) fail('every localized banner.body must be present, number-free, and have no number interpolation');
if (travellingBodies.length !== 10 || travellingBodies.some((body) => /(?:112|911|999|000|most countries|most of|without a sim)/i.test(body))) fail('every localized search.travellingBody must avoid universal emergency-number claims');

// Coverage claims are checked against generated facts, not just selected English phrases.
// If any manifest country lacks listings, homepage and localized copy must not imply universal access or coverage.
if (eligibleCountries.length < manifestCountries.length) {
  const renderedHomeCoverageCopy = (pages.get('/')?.html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const coverageSources = [
    ['rendered homepage', renderedHomeCoverageCopy],
    ['localized meta.siteDescription copy', [...i18nSource.matchAll(/['"]meta\.siteDescription['"]\s*:\s*(['"])(.*?)\1/g)].map((match) => match[2]).join('\n')],
    ['localized home.heroTitle copy', [...i18nSource.matchAll(/['"]home\.heroTitle['"]\s*:\s*(['"])(.*?)\1/g)].map((match) => match[2]).join('\n')],
    ['localized home.heroBody copy', [...i18nSource.matchAll(/['"]home\.heroBody['"]\s*:\s*(['"])(.*?)\1/g)].map((match) => match[2]).join('\n')],
    ['localized home.stats copy', [...i18nSource.matchAll(/['"]home\.stats['"]\s*:\s*(['"])(.*?)\1/g)].map((match) => match[2]).join('\n')],
  ];
  const unsupportedCoverageClaims = [
    /\b(?:all|every|each)\s+(?:of\s+the\s+)?(?:\d+\s+)?(?:countries|territories)\b/i,
    /\b(?:for|in|cover(?:s|ing)?)\s+(?:all\s+)?(?:the\s+)?(?:\d+|two hundred and fifty|250)\s+(?:countries|territories)\b/i,
    /\b(?:complete|comprehensive|full|universal)\s+(?:global|worldwide|world)?\s*(?:coverage|access|support|directory|listings?)\b/i,
    /\b(?:worldwide|global|universal)\s+(?:access|availability|support)\b/i,
    /\bwherever you are\b/i,
    /\b(?:todos?|todas?)\b.{0,30}\b(?:pa[ií]ses|territ[oó]rios?)\b/iu,
    /\b(?:tous|toutes|chaque)\b.{0,30}\b(?:pays|territoires?)\b/iu,
    /\b(?:alle|jedes?)\b.{0,30}\b(?:l[aä]nder|gebiete?)\b/iu,
    /(?:جميع|كل).{0,30}(?:الدول|البلدان|الأقاليم)/u,
    /(?:सभी|हर).{0,30}(?:देश|क्षेत्र)/u,
    /(?:所有|每个).{0,20}(?:国家|地区)/u,
    /(?:すべて|全て|各).{0,20}(?:国|地域)/u,
    /\b(?:все|кажд(?:ая|ую|ой))\b.{0,30}\b(?:стран[а-я]*|территори[а-я]*)\b/iu,
  ];
  for (const [label, source] of coverageSources) {
    for (const pattern of unsupportedCoverageClaims) if (pattern.test(source)) fail(`${label}: unsupported universal coverage/access claim ${pattern}`);
  }
  const renderedHomeParagraphs = textContent(pages.get('/')?.html ?? '', 'p');
  if (!renderedHomeParagraphs.some((body) => /coverage varies/i.test(body) && /relevant country page/i.test(body))) fail('/: rendered homepage coverage copy must say coverage varies and direct users to the relevant country page');
}
const bannerSource = read(join(root, 'src/components/EmergencyBanner.astro'));
if (/navigator|FALLBACK|pickEmergencyNumber|\{\{number\}\}|data-i18n-template/.test(bannerSource)) fail('EmergencyBanner must not infer, interpolate, or recommend a number from browser language');
if (!/href="\/countries"/.test(bannerSource) || /href="\/countries"[^>]*class="[^"]*\bhidden\b/.test(bannerSource)) fail('EmergencyBanner must expose an always-visible server-rendered /countries action');
if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(corpus)) fail('external Google Fonts request remains');

if (errors.length) { console.error(`SEO verification failed with ${errors.length} error(s):`); errors.forEach((error) => console.error(`  - ${error}`)); process.exit(1); }
console.log(`SEO verification OK: ${pages.size} HTML pages; ${allRecords.length} records across ${countryShards.size} country shards; ${recordsWithSources} records have source evidence, ${recordsWithoutSources} lack sources, and ${recordsWithNeitherSourceNorWebsite} have neither source nor website; ${eligibleCountries.length}/${manifestCountries.length} countries and territories have listings; route, provenance, YMYL, metadata, link, JSON-LD, coverage, and image invariants checked.`);
