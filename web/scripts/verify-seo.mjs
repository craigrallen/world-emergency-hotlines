import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeJsonLd } from '../src/lib/json-ld.mjs';
import { generalEmergencyContact } from '../src/lib/general-emergency.mjs';
import { SITE_NAME, SOCIAL_IMAGE_ALT, SOCIAL_IMAGE_PATH } from '../src/lib/seo.ts';
import { dedupeMessageContacts, normalizeMessageContact, phoneContacts } from '../src/lib/contact.ts';
import { categoryFilterSummary, categorySummaryChannelLabels } from '../src/lib/category-filters.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const site = 'https://worldhotlines.org';
const errors = [];
const fail = (message) => errors.push(message);
const read = (path) => readFileSync(path, 'utf8');
const SENSITIVE_ATTRIBUTES = new Set(['href', 'data-phone-contact', 'data-message-contact', 'data-general-emergency-contact',
  'data-record-id', 'data-prioritized-record-id', 'data-country-code', 'data-hotline-card', 'data-prioritized-listing',
  'data-general-emergency-listing', 'data-category-country-summary']);
const MAX_SCANNED_TAGS = 100_000;
const MAX_START_TAG_CHARS = 16_384;

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
function tags(html, report = fail) {
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
    if (j - i > MAX_START_TAG_CHARS) { report('generated output contains an oversized start tag'); break; }
    const raw = html.slice(i + 1, j);
    const name = raw.match(/^\s*([^\s/>]+)/)?.[1]?.toLowerCase();
    if (!name) continue;
    const attrs = {};
    const rest = raw.slice(raw.indexOf(name) + name.length);
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const duplicates = [];
    for (const match of rest.matchAll(attrRe)) {
      const attribute = match[1].toLowerCase();
      if (SENSITIVE_ATTRIBUTES.has(attribute) && Object.hasOwn(attrs, attribute)) duplicates.push(attribute);
      else attrs[attribute] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    if (duplicates.length) report(`generated output contains duplicate security-sensitive attribute(s): ${[...new Set(duplicates)].join(', ')}`);
    found.push({ name, attrs, start: i, end: j + 1 });
    if (found.length >= MAX_SCANNED_TAGS) { report('generated output exceeds the deterministic tag scan bound'); break; }
    if (name === 'script') {
      const close = html.toLowerCase().indexOf('</script>', j + 1);
      if (close !== -1) { i = close + 8; continue; }
    }
    i = j;
  }
  return found;
}

for (const fixture of [
  '<a href="tel:911" HREF="tel:911">911</a>',
  '<a href="tel:911" href="tel:112">911</a>',
  '<a data-phone-contact="911" DATA-PHONE-CONTACT="&#57;&#49;&#49;">911</a>',
  '<div data-country-code="US" data-country-code="CA"></div>',
  '<div data-general-emergency-listing DATA-GENERAL-EMERGENCY-LISTING></div>',
  '<article data-hotline-card data-hotline-card data-record-id="one" DATA-RECORD-ID="two"></article>',
  '<div data-prioritized-listing data-prioritized-listing data-prioritized-record-id="one" data-prioritized-record-id="one"></div>',
]) {
  const fixtureErrors = [];
  tags(fixture, (message) => fixtureErrors.push(message));
  assert.ok(fixtureErrors.length, `duplicate-sensitive-attribute scanner must reject ${fixture}`);
}
const uniqueSensitiveFixtureErrors = [];
tags('<article data-hotline-card data-record-id="one"><a href="tel:911" data-phone-contact="911">911</a></article>', (message) => uniqueSensitiveFixtureErrors.push(message));
assert.deepEqual(uniqueSensitiveFixtureErrors, [], 'duplicate-sensitive-attribute scanner must accept unique attributes');

function markedDivHtml(html, marker) {
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) return '';
  const start = html.lastIndexOf('<div', markerAt);
  if (start < 0) return '';
  const divTags = /<\/?div\b[^>]*>/gi;
  let depth = 0;
  for (const match of html.slice(start).matchAll(divTags)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, start + match.index + match[0].length);
  }
  return '';
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const OPTIONAL_END_ELEMENTS = new Set(['li', 'dt', 'dd', 'p', 'rt', 'rp', 'optgroup', 'option', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
const P_CLOSING_STARTS = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p',
  'pre', 'search', 'section', 'table', 'ul']);
const IMPLIED_END_ON_START = new Map([
  ['li', new Set(['li'])],
  ['dt', new Set(['dt', 'dd'])], ['dd', new Set(['dt', 'dd'])],
  ['rt', new Set(['rt', 'rp'])], ['rp', new Set(['rt', 'rp'])],
  ['optgroup', new Set(['option', 'optgroup'])], ['option', new Set(['option'])],
  ['thead', new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'])],
  ['tbody', new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'])],
  ['tfoot', new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'])],
  ['tr', new Set(['td', 'th', 'tr'])],
  ['td', new Set(['td', 'th'])], ['th', new Set(['td', 'th'])],
]);
const IMPLIED_END_ON_END = new Map([
  ['ul', new Set(['li'])], ['ol', new Set(['li'])], ['menu', new Set(['li'])],
  ['dl', new Set(['dt', 'dd'])],
  ['ruby', new Set(['rt', 'rp'])],
  ['optgroup', new Set(['option'])], ['select', new Set(['option', 'optgroup'])],
  ['tr', new Set(['td', 'th'])],
  ['thead', new Set(['td', 'th', 'tr'])], ['tbody', new Set(['td', 'th', 'tr'])], ['tfoot', new Set(['td', 'th', 'tr'])],
  ['table', new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'])],
]);
const P_CLOSING_ENDS = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'details', 'dialog', 'div', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'header', 'hgroup', 'main', 'nav', 'section']);
const ATTRIBUTION_MARKERS = [
  ['hotline', 'data-hotline-card', 'data-record-id'],
  ['prioritized', 'data-prioritized-listing', 'data-prioritized-record-id'],
  ['general', 'data-general-emergency-listing', 'data-country-code'],
];

// Independently retain attribution-container identity and ancestry. This scan is
// bounded by tags(), and deliberately does not alter legacy subtree extraction.
function attributionHierarchy(html, report = fail) {
  const scanned = tags(html, report);
  const stack = [], containers = [], contactElements = [];
  const starts = new Map(scanned.map((tag) => [tag.start, tag]));
  for (let i = 0; i < html.length;) {
    const open = html.indexOf('<', i);
    if (open < 0) break;
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      if (close < 0) { report('generated output contains an unterminated comment'); break; }
      i = close + 3; continue;
    }
    let end = open + 1, quote = '';
    while (end < html.length) {
      const char = html[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      end++;
    }
    if (end >= html.length) { report('generated output contains an unterminated tag'); break; }
    const raw = html.slice(open + 1, end);
    if (/^\s*[!?]/.test(raw)) { i = end + 1; continue; }
    const closing = /^\s*\//.test(raw);
    const name = raw.match(/^\s*\/?\s*([^\s/>]+)/)?.[1]?.toLowerCase();
    if (!name) { i = end + 1; continue; }
    const impliedNames = closing
      ? new Set([...(IMPLIED_END_ON_END.get(name) ?? []), ...(P_CLOSING_ENDS.has(name) ? ['p'] : [])])
      : new Set([...(IMPLIED_END_ON_START.get(name) ?? []), ...(P_CLOSING_STARTS.has(name) ? ['p'] : [])]);
    while (stack.length && impliedNames.has(stack.at(-1).name)) {
      if (stack.at(-1).critical) {
        report(`generated output cannot implicitly close attribution-critical <${stack.at(-1).name}> at <${closing ? '/' : ''}${name}>`);
        break;
      }
      stack.pop();
    }
    if (closing) {
      if (!stack.length || stack.at(-1).name !== name) report(`generated output contains malformed overlapping element structure at </${name}>`);
      else stack.pop();
    } else {
      const tag = starts.get(open);
      if (!tag) { i = end + 1; continue; }
      const markers = ATTRIBUTION_MARKERS.filter(([, marker]) => Object.hasOwn(tag.attrs, marker));
      if (markers.length > 1) report(`generated output attribution element has multiple container markers: ${markers.map(([, marker]) => marker).join(', ')}`);
      const ancestors = stack.map((entry) => entry.container).filter(Boolean);
      let container = null;
      if (markers.length === 1) {
        const [kind, marker, identityAttribute] = markers[0];
        container = { kind, marker, identity: decodeHtml(tag.attrs[identityAttribute] ?? ''), tag, ancestors };
        containers.push(container);
      }
      const href = decodeHtml(tag.attrs.href ?? '');
      const contactMarked = ['data-phone-contact', 'data-message-contact', 'data-general-emergency-contact'].some((marker) => Object.hasOwn(tag.attrs, marker));
      const contactCritical = (tag.name === 'a' && /^(?:tel|sms):/i.test(href)) || contactMarked;
      if (contactCritical) {
        contactElements.push({ tag, ancestors: container ? [...ancestors, container] : ancestors });
      }
      if (!VOID_ELEMENTS.has(name) && !/\/\s*$/.test(raw)) stack.push({ name, container, critical: Boolean(container || contactCritical) });
      if (name === 'script') {
        const close = html.toLowerCase().indexOf('</script>', end + 1);
        if (close < 0) { report('generated output contains an unclosed script element'); break; }
        stack.pop(); i = close + 9; continue;
      }
    }
    i = end + 1;
  }
  while (stack.length && OPTIONAL_END_ELEMENTS.has(stack.at(-1).name) && !stack.at(-1).critical) stack.pop();
  if (stack.length) report('generated output contains unclosed element structure');
  return { containers, contactElements };
}

for (const [label, fixture] of [
  ['list-items', '<ul><li>one<li>two</ul>'],
  ['definition-list', '<dl><dt>term<dd>definition<dt>next<dd>next definition</dl>'],
  ['paragraph-before-block', '<main><p>intro<section>details</section></main>'],
  ['select-options', '<select><optgroup label="one"><option>1<option>2<optgroup label="two"><option>3</select>'],
  ['table-cells', '<table><thead><tr><th>A<th>B<tbody><tr><td>1<td>2<tfoot><tr><td>F<td>G</table>'],
  ['ruby-annotations', '<ruby>base<rt>reading<rp>(<rt>next<rp>)</ruby>'],
]) {
  const fixtureErrors = [];
  attributionHierarchy(fixture, (message) => fixtureErrors.push(message));
  assert.deepEqual(fixtureErrors, [], `hierarchy scanner must accept valid omitted end tags in ${label}`);
}
for (const [label, fixture] of [
  ['hotline-list-crossing', '<ul><li data-hotline-card data-record-id="one">one<li>two</ul>'],
  ['prioritized-definition-crossing', '<dl><dt data-prioritized-listing data-prioritized-record-id="one">term<dd>definition</dl>'],
  ['general-paragraph-crossing', '<div><p data-general-emergency-listing data-country-code="us">911<section>details</section></div>'],
  ['contact-option-crossing', '<select><option data-phone-contact="911">911<option>112</select>'],
  ['hotline-table-crossing', '<table><tbody><tr><td data-hotline-card data-record-id="one">911<td>112</table>'],
  ['general-ruby-crossing', '<ruby><rt data-general-emergency-listing data-country-code="us">911<rp>(</ruby>'],
]) {
  const fixtureErrors = [];
  attributionHierarchy(fixture, (message) => fixtureErrors.push(message));
  assert.ok(fixtureErrors.length, `hierarchy scanner must reject attribution-critical omitted-end crossing in ${label}`);
}

function verifyGeneralEmergencyHierarchy(html, countryCode, report = fail) {
  const hierarchyErrors = [];
  const hierarchy = attributionHierarchy(html, (message) => hierarchyErrors.push(message));
  for (const message of hierarchyErrors) report(message);
  const panels = hierarchy.containers.filter(({ kind }) => kind === 'general');
  if (panels.length > 1) report('general-emergency attribution marker/ID must be unique per country page');
  const panel = panels.length === 1 ? panels[0] : null;
  if (panel && (panel.identity.toLowerCase() !== countryCode || panel.ancestors.length)) report('general-emergency panel must exactly identify its country and have no attributed ancestor');
  if (panel && hierarchy.containers.some((container) => container !== panel && container.ancestors.includes(panel))) report('no attribution container may be nested inside the general-emergency panel');
  for (const contact of hierarchy.contactElements) {
    const inPanel = panel && contact.ancestors.length === 1 && contact.ancestors[0] === panel;
    const hasGeneralMarker = Object.hasOwn(contact.tag.attrs, 'data-general-emergency-contact');
    if (hasGeneralMarker && !inPanel) report('general-emergency contact marker must have the exact country panel as its sole attributed ancestor');
    if (inPanel && !hasGeneralMarker) report('every actionable or generic-marked contact in the general-emergency panel needs its exact general-emergency marker');
    if (hasGeneralMarker && contact.tag.name === 'a') {
      const href = decodeHtml(contact.tag.attrs.href ?? '');
      const general = decodeHtml(contact.tag.attrs['data-general-emergency-contact']);
      const phone = decodeHtml(contact.tag.attrs['data-phone-contact'] ?? '');
      if (href !== `tel:${general}` || phone !== general) report('actionable general-emergency contact must exactly match its tel destination and phone marker');
    }
  }
  return hierarchy;
}

function generalEmergencyCandidates(html, report = fail) {
  return tags(html, report).filter((tag) => {
    const href = decodeHtml(tag.attrs.href ?? '');
    return /^(?:tel|sms):/i.test(href)
      || ['data-phone-contact', 'data-message-contact', 'data-general-emergency-contact'].some((marker) => Object.hasOwn(tag.attrs, marker));
  });
}

const generalFixture = (inner) => `<main><div data-general-emergency-listing data-country-code="us">${inner}</div></main>`;
const generalLinkFixture = '<a href="tel:911" data-general-emergency-contact="911" data-phone-contact="911">911</a>';
const validGeneralFixtureErrors = [];
verifyGeneralEmergencyHierarchy(generalFixture(generalLinkFixture), 'us', (message) => validGeneralFixtureErrors.push(message));
assert.deepEqual(validGeneralFixtureErrors, [], 'general-emergency hierarchy scanner must accept exact panel ancestry');
for (const [label, fixture] of [
  ['panel-inside-card', `<article data-hotline-card data-record-id="r">${generalFixture(generalLinkFixture)}</article>`],
  ['panel-inside-prioritized', `<div data-prioritized-listing data-prioritized-record-id="r">${generalFixture(generalLinkFixture)}</div>`],
  ['card-inside-panel', generalFixture(`<article data-hotline-card data-record-id="r">${generalLinkFixture}</article>`)],
  ['prioritized-inside-panel', generalFixture(`<div data-prioritized-listing data-prioritized-record-id="r">${generalLinkFixture}</div>`)],
  ['nested-general-panel', generalFixture(generalFixture(generalLinkFixture))],
  ['multiple-panels', `${generalFixture(generalLinkFixture)}${generalFixture('')}`],
  ['multiple-markers', `<div data-general-emergency-listing data-country-code="us" data-hotline-card data-record-id="r">${generalLinkFixture}</div>`],
  ['sibling-overlap', `<div data-general-emergency-listing data-country-code="us"><article data-hotline-card data-record-id="r">${generalLinkFixture}</div></article>`],
  ['extra-generic-tel', generalFixture(`${generalLinkFixture}<a href="tel:112" data-phone-contact="112">112</a>`) ],
  ['missing-marker', generalFixture('<a href="tel:911" data-phone-contact="911">911</a>')],
  ['mismatched-marker', generalFixture('<a href="tel:911" data-phone-contact="911" data-general-emergency-contact="112">911</a>')],
  ['marker-outside-panel', `${generalFixture(generalLinkFixture)}<span data-general-emergency-contact="112">112</span>`],
  ['marker-in-card', `${generalFixture(generalLinkFixture)}<article data-hotline-card data-record-id="r"><span data-general-emergency-contact="112">112</span></article>`],
]) {
  const fixtureErrors = [];
  verifyGeneralEmergencyHierarchy(fixture, 'us', (message) => fixtureErrors.push(message));
  assert.ok(fixtureErrors.length, `general-emergency hierarchy scanner must reject ${label}`);
}
assert.equal(generalEmergencyCandidates(generalFixture(`${generalLinkFixture}<span data-general-emergency-contact="112">112</span>`)).length, 2,
  'general-emergency source verifier must enumerate an extra marker span');

// Capture complete marked element subtrees with an element stack, so assertions cannot cross sibling boundaries.
function markedElementSubtrees(html, elementName, markerAttribute) {
  const subtrees = [];
  const stack = [];
  for (let i = 0; i < html.length; i++) {
    if (html[i] !== '<') continue;
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      i = close === -1 ? html.length : close + 2;
      continue;
    }
    let j = i + 1, quote = '';
    while (j < html.length) {
      const char = html[j];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      j++;
    }
    if (j >= html.length) break;
    const raw = html.slice(i + 1, j);
    if (/^\s*[!?]/.test(raw)) { i = j; continue; }
    const closing = /^\s*\//.test(raw);
    const name = raw.match(/^\s*\/?\s*([^\s/>]+)/)?.[1]?.toLowerCase();
    if (!name) { i = j; continue; }
    if (closing) {
      let entry;
      while ((entry = stack.pop())) {
        if (entry.marked && entry.name === name) {
          subtrees.push({ attrs: entry.attrs, html: html.slice(entry.contentStart, i) });
        }
        if (entry.name === name) break;
      }
    } else {
      const parsed = tags(html.slice(i, j + 1))[0];
      const marked = name === elementName && parsed && Object.hasOwn(parsed.attrs, markerAttribute);
      if (!VOID_ELEMENTS.has(name) && !/\/\s*$/.test(raw)) {
        stack.push({ name, marked, attrs: parsed?.attrs ?? {}, contentStart: j + 1 });
      }
    }
    i = j;
  }
  return subtrees;
}

const hotlineCardDescendants = (html) => markedElementSubtrees(html, 'article', 'data-hotline-card');

function verifyCategorySummaryLinks(html, categorySlug, expectedCodes, report = fail) {
  const summaries = markedElementSubtrees(html, 'article', 'data-category-country-summary');
  const expectedHrefs = new Set([...expectedCodes].map((code) => `/country/${code}#category-${categorySlug}`));
  const pageHrefs = attrs(tags(html), 'a').map((anchor) => decodeHtml(anchor.href ?? ''));
  for (const code of expectedCodes) {
    const href = `/country/${code}#category-${categorySlug}`;
    const summary = summaries.find((item) => item.attrs['data-country-code'] === code);
    const ownCount = summary ? attrs(tags(summary.html), 'a').filter((anchor) => decodeHtml(anchor.href ?? '') === href).length : 0;
    const pageCount = pageHrefs.filter((candidate) => candidate === href).length;
    if (ownCount !== 1 || pageCount !== 1) report(`${code} summary must contain exactly one link to ${href}, with no copy outside its summary (found ${ownCount} inside, ${pageCount} page-wide)`);
  }
  for (const summary of summaries) {
    const code = summary.attrs['data-country-code'];
    for (const anchor of attrs(tags(summary.html), 'a')) {
      const href = decodeHtml(anchor.href ?? '');
      if (expectedHrefs.has(href) && href !== `/country/${code}#category-${categorySlug}`) report(`${code} summary contains another country's category destination ${href}`);
    }
  }
  return summaries;
}

const categoryLinkFixtureCodes = new Set(['aa', 'bb']);
const categoryLinkFixture = (firstLinks, secondLinks, outside = '') => `<main>${outside}<article data-category-country-summary data-country-code="aa">${firstLinks}</article><article data-category-country-summary data-country-code="bb">${secondLinks}</article></main>`;
const fixtureLink = (code) => `<a href="/country/${code}#category-crisis">View</a>`;
for (const [label, html] of [
  ['swapped', categoryLinkFixture(fixtureLink('bb'), fixtureLink('aa'))],
  ['missing', categoryLinkFixture('', fixtureLink('bb'))],
  ['duplicate', categoryLinkFixture(`${fixtureLink('aa')}${fixtureLink('aa')}`, fixtureLink('bb'))],
  ['outside', categoryLinkFixture(fixtureLink('aa'), fixtureLink('bb'), fixtureLink('aa'))],
]) {
  const fixtureErrors = [];
  verifyCategorySummaryLinks(html, 'crisis', categoryLinkFixtureCodes, (message) => fixtureErrors.push(message));
  assert.ok(fixtureErrors.length > 0, `category summary deep-link guard must reject the ${label} fixture`);
}
const validCategoryLinkFixtureErrors = [];
verifyCategorySummaryLinks(categoryLinkFixture(fixtureLink('aa'), fixtureLink('bb')), 'crisis', categoryLinkFixtureCodes, (message) => validCategoryLinkFixtureErrors.push(message));
assert.deepEqual(validCategoryLinkFixtureErrors, [], 'category summary deep-link guard must accept correctly attributed links');

function verifyRecordCard(record, card, route, report = fail) {
  const all = tags(card.html);
  const hrefs = attrs(all, 'a').map((a) => decodeHtml(a.href ?? ''));
  const visibleText = decodeHtml(card.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
  const expectedPhones = phoneContacts(record.voice_numbers ?? [], record.short_codes ?? []);
  const renderedPhones = all.filter((tag) => Object.hasOwn(tag.attrs, 'data-phone-contact')).map((tag) => decodeHtml(tag.attrs['data-phone-contact']));
  const expectedRenderedPhones = expectedPhones.map((contact) => contact.uri ?? contact.value);
  if (JSON.stringify(renderedPhones) !== JSON.stringify(expectedRenderedPhones)) report(`${route}: ${record.id} descendant phone controls do not exactly match its source record`);
  const telHrefs = hrefs.filter((href) => href.startsWith('tel:'));
  const expectedTelHrefs = expectedPhones.filter((contact) => contact.uri).map((contact) => `tel:${contact.uri}`);
  if (JSON.stringify(telHrefs) !== JSON.stringify(expectedTelHrefs)) report(`${route}: ${record.id} descendant tel: hrefs do not exactly match its strict safe phone contacts`);
  for (const { value } of expectedPhones) {
    if (!visibleText.includes(value)) report(`${route}: ${record.id} canonical phone value is absent from its card: ${JSON.stringify(value)}`);
  }
  const expectedContacts = dedupeMessageContacts(record.sms_numbers ?? [], record.text_numbers ?? []);
  const renderedContacts = all.filter((tag) => Object.hasOwn(tag.attrs, 'data-message-contact')).map((tag) => decodeHtml(tag.attrs['data-message-contact']));
  const expectedRenderedContacts = expectedContacts.map((contact) => contact.uri ?? contact.value);
  if (JSON.stringify(renderedContacts.toSorted()) !== JSON.stringify(expectedRenderedContacts.toSorted())) report(`${route}: ${record.id} descendant SMS/text controls do not match its source record`);
  const smsHrefs = hrefs.filter((href) => href.startsWith('sms:'));
  const expectedSmsHrefs = expectedContacts.filter((contact) => contact.uri).map((contact) => `sms:${contact.uri}`);
  if (JSON.stringify(smsHrefs.toSorted()) !== JSON.stringify(expectedSmsHrefs.toSorted())) report(`${route}: ${record.id} descendant sms: hrefs do not exactly match its strict safe contacts`);
  for (const { value, uri } of expectedContacts) {
    if (!visibleText.includes(value)) report(`${route}: ${record.id} canonical SMS/text value is absent from its card: ${JSON.stringify(value)}`);
    if (!uri && smsHrefs.some((href) => href.slice(4).includes(value))) report(`${route}: ${record.id} unsafe SMS/text value was placed in an href`);
  }
  const chatControls = all.filter((tag) => Object.hasOwn(tag.attrs, 'data-chat-contact'));
  const renderedChatContacts = chatControls.map((tag) => decodeHtml(tag.attrs['data-chat-contact']));
  const renderedChatHrefs = chatControls.map((tag) => decodeHtml(tag.attrs.href ?? ''));
  const expectedChats = record.chat_url ? [record.chat_url] : [];
  if (JSON.stringify(renderedChatContacts) !== JSON.stringify(expectedChats) || JSON.stringify(renderedChatHrefs) !== JSON.stringify(expectedChats)) report(`${route}: ${record.id} descendant chat link does not exactly match its source record`);
}

const attributionFixtureRecords = [
  { id: 'fixture-a', sms_numbers: ['+1 202 555 0101'], text_numbers: [], chat_url: 'https://example.invalid/a' },
  { id: 'fixture-b', sms_numbers: ['+1 202 555 0102'], text_numbers: [], chat_url: 'https://example.invalid/b' },
];
const swappedAttributionFixture = attributionFixtureRecords.map((record, index) => {
  const other = attributionFixtureRecords[1 - index];
  const uri = normalizeMessageContact(other.sms_numbers[0]);
  return `<article data-hotline-card data-record-id="${record.id}"><a data-message-contact="${uri}" href="sms:${uri}">${other.sms_numbers[0]}</a><a data-chat-contact="${other.chat_url}" href="${other.chat_url}">Online chat</a></article>`;
}).join('');
const swappedAttributionErrors = [];
const swappedAttributionCards = new Map(hotlineCardDescendants(swappedAttributionFixture).map((card) => [card.attrs['data-record-id'], card]));
for (const record of attributionFixtureRecords) verifyRecordCard(record, swappedAttributionCards.get(record.id), 'attribution fixture', (message) => swappedAttributionErrors.push(message));
assert.ok(swappedAttributionErrors.length >= attributionFixtureRecords.length, 'per-record attribution guard fixture must reject contacts swapped between cards');

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
function strictGeneralEmergencyContact(value) {
  if (typeof value !== 'string') return { value, uri: null };
  let offset = 0;
  if (value[0] === '+') offset = 1;
  const digitCount = value.length - offset;
  if (digitCount < 2 || digitCount > 15) return { value, uri: null };
  for (let index = offset; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return { value, uri: null };
  }
  return { value, uri: value };
}
for (const [value, uri] of [
  ['1', null], ['+1', null], ['12', '12'], ['+12', '+12'],
  ['123456789012345', '123456789012345'], ['+123456789012345', '+123456789012345'],
  ['1234567890123456', null], ['+1234567890123456', null],
  ['911', '911'], ['+112', '+112'], ['351 351', null], ['320-2223', null],
  ['911 or 112', null], ['call 911', null], ['***', null], ['', null],
]) {
  assert.deepEqual(generalEmergencyContact(value), { value, uri }, `production general-emergency predicate fixture ${JSON.stringify(value)}`);
  assert.deepEqual(strictGeneralEmergencyContact(value), { value, uri }, `independent general-emergency predicate fixture ${JSON.stringify(value)}`);
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
  const ids = all.map((tag) => tag.attrs.id).filter(Boolean);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length) fail(`${route}: duplicate IDs found: ${duplicateIds.join(', ')}`);
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
const countryMetadata = new Map();
const allRecords = [];
for (const country of manifestCountries) {
  const code = country.alpha2.toLowerCase();
  const shardPath = join(dist, `data/countries/${code}.json`);
  if (!existsSync(shardPath)) { fail(`country shard missing for ${country.alpha2}`); continue; }
  const shard = JSON.parse(read(shardPath));
  const records = Array.isArray(shard.hotlines) ? shard.hotlines : [];
  countryShards.set(code, records);
  countryMetadata.set(code, shard);
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

const SOURCE_CHECKED_STATUSES = new Set(['verified_web', 'verified_authority', 'verified_knowledge']);
for (const page of pages.values()) {
  const categorySlug = page.route.match(/^\/category\/([a-z0-9_]+)$/)?.[1];
  if (!categorySlug) continue;
  if (Buffer.byteLength(page.html) >= 500_000) fail(`${page.route}: category HTML is ${Buffer.byteLength(page.html)} bytes; expected below 500000`);
  if (!page.html.includes('Category pages summarize availability by country. Detailed records and source status are on each country page.')) fail(`${page.route}: exact country-summary handoff explanation is missing`);
  const all = tags(page.html);
  const expected = new Map();
  for (const [code, records] of countryShards) {
    const matches = records.filter((record) => record.category === categorySlug);
    if (matches.length) expected.set(code, matches);
  }
  const summarySubtrees = verifyCategorySummaryLinks(page.html, categorySlug, expected.keys(), (message) => fail(`${page.route}: ${message}`));
  const summaries = summarySubtrees.map((summary) => summary.attrs);
  if (summaries.length !== expected.size) fail(`${page.route}: rendered ${summaries.length} summaries; expected ${expected.size}`);
  const categoryRecordCount = [...expected.values()].reduce((sum, records) => sum + records.length, 0);
  const categorySourceCheckedCount = [...expected.values()].flat().filter((record) => SOURCE_CHECKED_STATUSES.has(record.verification_status)).length;
  const ariaLabels = all.filter((tag) => Object.hasOwn(tag.attrs, 'aria-label')).map((tag) => decodeHtml(tag.attrs['aria-label']));
  if (!ariaLabels.includes(`${categorySourceCheckedCount} source checked`)) fail(`${page.route}: source-checked summary accessible label is missing`);
  if (categorySourceCheckedCount < categoryRecordCount && !ariaLabels.includes(`${categoryRecordCount - categorySourceCheckedCount} not source checked`)) fail(`${page.route}: not-source-checked summary accessible label is missing`);
  const seenCodes = new Set();
  for (const summary of summaries) {
    const code = summary['data-country-code'];
    const records = expected.get(code);
    if (!records || seenCodes.has(code)) { fail(`${page.route}: unexpected or duplicate country summary ${code}`); continue; }
    seenCodes.add(code);
    const sourceChecked = records.filter((record) => SOURCE_CHECKED_STATUSES.has(record.verification_status)).length;
    const expectedChannels = categorySummaryChannelLabels(categoryFilterSummary(code, records));
    if (Number(summary['data-record-count']) !== records.length) fail(`${page.route}: ${code} record count does not match generated records`);
    if (Number(summary['data-source-checked-count']) !== sourceChecked) fail(`${page.route}: ${code} source-checked count does not match generated records`);
    if (summary['data-channels'] !== expectedChannels.join('|')) fail(`${page.route}: ${code} channel set does not match generated records`);
    const href = `/country/${code}#category-${categorySlug}`;
    const target = pages.get(`/country/${code}`);
    if (!target || !tags(target.html).some((tag) => tag.attrs.id === `category-${categorySlug}`)) fail(`${page.route}: ${href} has no matching country section`);
  }
  if (/(?:href=["'](?:tel:|sms:|mailto:)|data-hotline-card|data-card-cat=)/i.test(page.html)) fail(`${page.route}: category HTML exposes full contact details or hotline-card markup`);
}

for (const [code, records] of countryShards) {
  const page = pages.get(`/country/${code}`);
  if (!page) continue;
  const all = tags(page.html);
  verifyGeneralEmergencyHierarchy(page.html, code, (message) => fail(`/country/${code}: ${message}`));
  const generalPanels = markedElementSubtrees(page.html, 'div', 'data-general-emergency-listing');
  const generalValues = countryMetadata.get(code)?.general_emergency ?? [];
  if (generalPanels.length !== (generalValues.length ? 1 : 0)) fail(`/country/${code}: general-emergency panel count does not match its country shard`);
  if (generalPanels.length === 1) {
    const panel = generalPanels[0];
    const controls = generalEmergencyCandidates(panel.html, (message) => fail(`/country/${code}: ${message}`));
    const renderedValues = controls.map((tag) => decodeHtml(tag.attrs['data-general-emergency-contact']));
    const expectedContacts = generalValues.map(strictGeneralEmergencyContact);
    if (decodeHtml(panel.attrs['data-country-code'] ?? '').toLowerCase() !== code) fail(`/country/${code}: general-emergency attribution does not exactly identify its route country`);
    if (JSON.stringify(renderedValues) !== JSON.stringify(generalValues)) fail(`/country/${code}: general-emergency controls do not preserve the exact ordered source values`);
    const hrefs = controls.filter((tag) => tag.name === 'a').map((tag) => decodeHtml(tag.attrs.href ?? ''));
    const expectedHrefs = expectedContacts.filter(({ uri }) => uri).map(({ uri }) => `tel:${uri}`);
    if (JSON.stringify(hrefs) !== JSON.stringify(expectedHrefs)) fail(`/country/${code}: general-emergency actionable links do not exactly match strict normalization`);
    for (let index = 0; index < expectedContacts.length; index++) {
      const { value, uri } = expectedContacts[index];
      const control = controls[index];
      const visible = decodeHtml(control ? panel.html.slice(control.end, panel.html.indexOf(`</${control.name}>`, control.end)) : '').replace(/<[^>]+>/g, '').trim();
      if (visible !== value) fail(`/country/${code}: general-emergency control does not show exact source value ${JSON.stringify(value)}`);
      if (uri && (control?.name !== 'a' || decodeHtml(control.attrs['data-phone-contact'] ?? '') !== uri)) fail(`/country/${code}: safe general-emergency contact lacks its exact marker`);
      if (!uri && (control?.name === 'a' || Object.hasOwn(control?.attrs ?? {}, 'data-phone-contact'))) fail(`/country/${code}: unsafe general-emergency value became actionable`);
    }
  }
  const categoryIds = all.map((tag) => tag.attrs.id).filter((id) => id?.startsWith('category-'));
  const expectedIds = [...new Set(records.map((record) => `category-${record.category}`))];
  if (categoryIds.some((id) => !/^category-[a-z0-9_]+$/.test(id)) || categoryIds.length !== expectedIds.length || expectedIds.some((id) => !categoryIds.includes(id))) fail(`/country/${code}: category section IDs are unsafe, missing, or duplicated`);
  const categoryTargets = all.filter((tag) => tag.attrs.id?.startsWith('category-'));
  if (categoryTargets.some((tag) => !(tag.attrs.class ?? '').split(/\s+/).includes('scroll-mt-48'))) fail(`/country/${code}: every category fragment target must retain the 12rem sticky-surface scroll offset`);
  const cards = hotlineCardDescendants(page.html);
  const cardsById = new Map(cards.map((card) => [card.attrs['data-record-id'], card]));
  if (cards.length !== records.length || cardsById.size !== records.length) fail(`/country/${code}: detailed hotline cards are missing or duplicated in initial HTML`);
  const sourceCheckedCount = records.filter((record) => SOURCE_CHECKED_STATUSES.has(record.verification_status)).length;
  const countryText = decodeHtml(page.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  if (sourceCheckedCount > 0 && !countryText.includes(`${sourceCheckedCount} source checked`)) fail(`/country/${code}: source-checked count label is missing or semantically inconsistent`);
  if (sourceCheckedCount === 0 && records.length > 0 && !countryText.includes('No source-checked records')) fail(`/country/${code}: zero source-checked label is missing or semantically inconsistent`);
  const prioritizedPanel = markedDivHtml(page.html, 'data-prioritized-listing');
  if (prioritizedPanel) {
    const panelTags = tags(prioritizedPanel);
    const panel = panelTags.find((tag) => Object.hasOwn(tag.attrs, 'data-prioritized-listing'));
    const status = decodeHtml(panel?.attrs['data-prioritized-status'] ?? '');
    const panelText = decodeHtml(prioritizedPanel.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    const prioritizedRecord = records.find((record) => record.id === decodeHtml(panel?.attrs['data-prioritized-record-id'] ?? ''));
    if (!prioritizedRecord) fail(`/country/${code}: prioritized listing does not identify exactly one source record`);
    else {
      const expectedPhones = phoneContacts(prioritizedRecord.voice_numbers ?? [], prioritizedRecord.short_codes ?? []).slice(0, 2);
      const renderedPhones = panelTags.filter((tag) => Object.hasOwn(tag.attrs, 'data-phone-contact')).map((tag) => decodeHtml(tag.attrs['data-phone-contact']));
      const expectedRendered = expectedPhones.map((contact) => contact.uri ?? contact.value);
      const telHrefs = attrs(panelTags, 'a').map((anchor) => decodeHtml(anchor.href ?? '')).filter((href) => href.startsWith('tel:'));
      const expectedHrefs = expectedPhones.filter((contact) => contact.uri).map((contact) => `tel:${contact.uri}`);
      if (JSON.stringify(renderedPhones) !== JSON.stringify(expectedRendered) || JSON.stringify(telHrefs) !== JSON.stringify(expectedHrefs)) fail(`/country/${code}: prioritized phone controls do not map exactly to their identified source record`);
      for (const { value } of expectedPhones) {
        if (!panelText.includes(value.replace(/\s+/g, ' '))) fail(`/country/${code}: prioritized listing hides canonical phone value ${JSON.stringify(value)}`);
      }
    }
    if (!['source checked', 'cross-referenced', 'not source checked'].includes(status) || !panelText.includes(`Status: ${status}`)) fail(`/country/${code}: prioritized listing needs exact explicit neutral status text`);
    const hasEndorsementClass = /\b(?:border|bg|text|ring)-(?:success|green|emerald|lime)(?:\b|\/)/i.test(prioritizedPanel);
    const hasCheckmark = /[✅✓✔]/.test(panelText);
    if (hasEndorsementClass || hasCheckmark) fail(`/country/${code}: prioritized listing contains success/green/checkmark endorsement styling (${hasEndorsementClass ? 'class' : 'checkmark'})`);
    const icon = panelTags.find((tag) => Object.hasOwn(tag.attrs, 'data-prioritized-icon'));
    if (!icon || !/\bborder-border\b/.test(icon.attrs.class ?? '') || !/\btext-fg-muted\b/.test(icon.attrs.class ?? '') || !panelTags.some((tag) => tag.name === 'svg' && /\bh-4\b/.test(tag.attrs.class ?? ''))) fail(`/country/${code}: prioritized listing must retain its neutral information/document icon treatment`);
  }
  for (const record of records) {
    const card = cardsById.get(record.id);
    if (!card) continue;
    const hasPhone = Boolean(record.voice_numbers?.length || record.short_codes?.length);
    const hasSms = Boolean(record.sms_numbers?.length || record.text_numbers?.length);
    const hasChat = Boolean(record.chat_url);
    if (card.attrs['data-has-phone'] !== String(hasPhone) || card.attrs['data-has-sms'] !== String(hasSms) || card.attrs['data-has-chat'] !== String(hasChat)) fail(`/country/${code}: ${record.id} detailed channel state does not match its generated record`);
    verifyRecordCard(record, card, `/country/${code}`);
  }
}

for (const page of pages.values()) {
  for (const anchor of attrs(tags(page.html), 'a')) {
    const href = decodeHtml(anchor.href ?? '');
    if (/^tel:/i.test(href) && !/^tel:\+?[0-9]{2,15}$/.test(href)) fail(`${page.route}: generated output exposes unsafe telephone URI ${JSON.stringify(href)}`);
    if (/^sms:/i.test(href) && !/^sms:\+?[0-9]{3,15}$/.test(href)) fail(`${page.route}: generated output exposes unsafe SMS URI ${JSON.stringify(href)}`);
  }
}

for (const fixture of [
  { code: 'us', safe: ['911'], unsafe: [] },
  { code: 'dj', safe: [], unsafe: ['351 351'] },
  { code: 'fm', safe: [], unsafe: ['320-2223'] },
  { code: 'mh', safe: [], unsafe: ['625-8666'] },
]) {
  const source = countryMetadata.get(fixture.code)?.general_emergency ?? [];
  for (const value of [...fixture.safe, ...fixture.unsafe]) assert.ok(source.includes(value), `${fixture.code} general-emergency fixture must retain ${JSON.stringify(value)} in canonical-derived output`);
  const panel = markedElementSubtrees(pages.get(`/country/${fixture.code}`)?.html ?? '', 'div', 'data-general-emergency-listing')[0];
  const controls = tags(panel?.html ?? '').filter((tag) => Object.hasOwn(tag.attrs, 'data-general-emergency-contact'));
  for (const value of fixture.safe) assert.ok(controls.some((tag) => decodeHtml(tag.attrs['data-general-emergency-contact']) === value && tag.attrs.href === `tel:${value}`), `${fixture.code} safe general-emergency fixture must be actionable`);
  for (const value of fixture.unsafe) assert.ok(controls.some((tag) => decodeHtml(tag.attrs['data-general-emergency-contact']) === value && tag.name !== 'a' && !tag.attrs.href), `${fixture.code} compound general-emergency fixture must remain exact plain text`);
}

// Literal source/output contracts catch regressions independently of the
// normalizers used by the general card verifier above.
for (const fixture of [
  { code: 'bf', id: 'weh_2afbbca79ef6584f87b56a99', source: ['17', '18'], hrefs: ['tel:17', 'tel:18'] },
  { code: 'ca', id: 'weh_7823d8cbe434550fa4bcba72', source: ['+1 (905) 688 3711'], hrefs: ['tel:+19056883711'] },
]) {
  const record = (countryShards.get(fixture.code) ?? []).find((entry) => entry.id === fixture.id);
  assert.ok(record, `${fixture.code} representative phone fixture must remain in its source shard`);
  const sourcePhones = [...(record?.voice_numbers ?? []), ...(record?.short_codes ?? [])];
  for (const value of fixture.source) assert.ok(sourcePhones.includes(value), `${fixture.code} source record must retain ${JSON.stringify(value)}`);
  const page = pages.get(`/country/${fixture.code}`);
  const card = hotlineCardDescendants(page?.html ?? '').find((entry) => entry.attrs['data-record-id'] === fixture.id);
  assert.ok(card, `${fixture.code} representative phone fixture must render in its own card`);
  const hrefs = attrs(tags(card?.html ?? ''), 'a').map((anchor) => decodeHtml(anchor.href ?? ''));
  for (const href of fixture.hrefs) assert.ok(hrefs.includes(href), `${fixture.code} representative phone must retain literal one-tap link ${href}`);
}

const nigeriaMalformed = { code: 'ng', id: 'weh_4ee09502e9005f48a648caf5', value: '234) 8062-106-493' };
const nigeriaRecord = (countryShards.get(nigeriaMalformed.code) ?? []).find((entry) => entry.id === nigeriaMalformed.id);
assert.ok(nigeriaRecord?.voice_numbers?.includes(nigeriaMalformed.value), 'Nigeria source record must retain its malformed canonical value for display');
const nigeriaPage = pages.get('/country/ng');
const nigeriaCard = hotlineCardDescendants(nigeriaPage?.html ?? '').find((entry) => entry.attrs['data-record-id'] === nigeriaMalformed.id);
assert.ok(nigeriaCard, 'Nigeria malformed phone fixture must render in its own card');
assert.ok(decodeHtml(nigeriaCard?.html ?? '').includes(nigeriaMalformed.value), 'Nigeria malformed canonical value must remain visible');
assert.doesNotMatch(nigeriaCard?.html ?? '', /href=["']tel:/i, 'Nigeria malformed phone must remain non-actionable');
for (const page of pages.values()) {
  assert.doesNotMatch(page.html, /href=["']tel:(?:234\)|\(\+58|%28%2b58)/i, `${page.route}: known Nigeria/Venezuela malformed shapes must never become tel links`);
}

const norfolkRecords = countryShards.get('nf') ?? [];
const norfolkStatuses = new Set(norfolkRecords.map((record) => record.verification_status));
const norfolkHtml = pages.get('/country/nf')?.html ?? '';
if (!norfolkStatuses.has('cross_referenced') || !norfolkStatuses.has('legacy_unverified')) fail('/country/nf: regression fixture must retain mixed cross-referenced and legacy records');
if (!norfolkHtml.includes('No records have a source-checked status.') || !norfolkHtml.includes('Evidence and verification statuses vary by record.')) fail('/country/nf: mixed-status zero-source-checked notice is missing exact neutral semantics');
if (/These records come from legacy sources/i.test(norfolkHtml)) fail('/country/nf: mixed-status notice incorrectly claims all records are legacy');

for (const category of stats.categories) {
  const categoryRecords = [...countryShards.values()].flat().filter((record) => record.category === category.slug);
  const hasSourceChecked = categoryRecords.some((record) => SOURCE_CHECKED_STATUSES.has(record.verification_status));
  const hasCrossReferenced = categoryRecords.some((record) => record.verification_status === 'cross_referenced');
  if (!hasSourceChecked && hasCrossReferenced) {
    const html = pages.get(`/category/${category.slug}`)?.html ?? '';
    if (!html.includes('No records in this category have a source-checked status.')) fail(`/category/${category.slug}: zero-source-checked cross-referenced category needs exact neutral status copy`);
    if (/All records in this category are unverified|These come from legacy sources/i.test(html)) fail(`/category/${category.slug}: zero-source-checked cross-referenced category misstates provenance`);
  }
}

const criticalContrastSources = [
  read(resolve(root, 'src/components/HotlineCard.astro')),
  read(resolve(root, 'src/pages/country/[code].astro')),
];
for (const source of criticalContrastSources) {
  for (const forbidden of ['text-fg-muted/70', 'text-[10px]', 'text-success/70']) {
    if (source.includes(forbidden)) fail(`critical contrast surface reintroduced forbidden low-contrast class ${forbidden}`);
  }
}
if (!read(resolve(root, 'src/pages/index.astro')).match(/text-xs text-fg["'][^>]*data-i18n=["']home\.tip/)) fail('home.tip must retain a sufficient opaque foreground');

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

const rootTypes = new Set(['WebSite', 'Organization', 'BreadcrumbList', 'Dataset', 'Article']);
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
for (const route of [
  '/countries', '/categories', '/about', '/data', '/guides',
  '/guides/emergency-numbers-vs-crisis-hotlines',
  '/guides/find-crisis-support-while-travelling-abroad',
  '/guides/what-hotline-verification-labels-mean',
]) requireBreadcrumb(route);
for (const page of pages.values()) if (page.indexable && (/^\/country\/[^/]+$/.test(page.route) || /^\/category\/[^/]+$/.test(page.route))) requireBreadcrumb(page.route);

const guideArticles = new Map([
  ['/guides/emergency-numbers-vs-crisis-hotlines', 'Emergency numbers and crisis hotlines: what’s the difference?'],
  ['/guides/find-crisis-support-while-travelling-abroad', 'How to find crisis support while travelling abroad'],
  ['/guides/what-hotline-verification-labels-mean', 'What hotline verification labels do—and do not—mean'],
]);
for (const [route, headline] of guideArticles) {
  const page = pages.get(route);
  const articles = page?.jsonLd.map(({ value }) => value).filter((value) => value['@type'] === 'Article') ?? [];
  const article = articles[0];
  if (articles.length !== 1) { fail(`${route}: expected exactly one Article`); continue; }
  const visibleHeadline = page.html.match(/<h1\b[^>]*>([^<]+)<\/h1>/i)?.[1];
  if (article.headline !== headline || article.headline !== visibleHeadline) fail(`${route}: Article.headline must equal the visible H1`);
  if (article.description !== page.description) fail(`${route}: Article.description must equal the meta description`);
  if (article.datePublished !== '2026-08-15' || article.dateModified !== '2026-08-15') fail(`${route}: Article dates must equal 2026-08-15`);
  if (article.url !== canonicalPath(route)) fail(`${route}: Article.url must equal the page canonical`);
  if (JSON.stringify(article.isPartOf) !== JSON.stringify({ '@type': 'WebSite', name: SITE_NAME, url: canonicalPath('/') })) fail(`${route}: Article.isPartOf must identify the canonical WebSite`);
  if ('author' in article || 'publisher' in article) fail(`${route}: Article must not claim an author or publisher`);
}

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
const usHtml = pages.get('/country/us')?.html ?? '';
if (!usHtml.includes('839863)')) fail('/country/us: malformed canonical SMS value must remain visible as escaped text');
if (/href=["']sms:839863(?:["'])/i.test(usHtml)) fail('/country/us: malformed canonical SMS value 839863) must not produce an sms: link');
for (const phrase of ['works in most countries', 'even without a SIM', 'will always have up-to-date', '112 / 911']) if (corpus.toLowerCase().includes(phrase.toLowerCase())) fail(`forbidden universal YMYL claim found: ${phrase}`);
for (const phrase of ['best verified help available', 'best available help', 'best-available routing']) if (corpus.toLowerCase().includes(phrase)) fail(`forbidden routing overstatement found: ${phrase}`);
if (!corpus.includes('This does not determine suitability, eligibility, live availability, or provide medical advice.')) fail('prioritized listing caveat is missing from rendered country pages');
const hotlineCardSource = read(join(root, 'src/components/HotlineCard.astro'));
if (!hotlineCardSource.includes('Date when source information was checked; it is not a live availability check') || /title="[^"]*authoritative source/i.test(hotlineCardSource)) fail('HotlineCard freshness tooltip must use the exact neutral source-check methodology');
const emergencyBannerSource = read(join(root, 'src/components/EmergencyBanner.astro'));
const globalCssSource = read(join(root, 'src/styles/global.css'));
const relativeLuminance = ([red, green, blue]) => [red, green, blue]
  .map((channel) => channel / 255)
  .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
const contrastRatio = (first, second) => {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};
const bannerPalettes = [
  ['light', [185, 28, 28], [255, 255, 255]],
  ['dark', [153, 27, 27], [255, 255, 255]],
  ['CTA', [255, 255, 255], [153, 27, 27]],
];
for (const [theme, background, foreground] of bannerPalettes) if (contrastRatio(background, foreground) < 4.5) fail(`Emergency banner ${theme} palette must meet 4.5:1 contrast`);
if (/data-i18n="banner\.body"[^>]*opacity-/i.test(emergencyBannerSource)
  || !/data-contrast-surface="opaque-danger"/.test(emergencyBannerSource)
  || !/href="\/countries"[^>]*\bbg-white\b[^>]*\btext-red-800\b[^>]*\bfocus-visible:ring-white\b/.test(emergencyBannerSource)
  || !/\.emergency-strip\s*\{[^}]*background-color:\s*rgb\(185 28 28\);[^}]*color:\s*rgb\(255 255 255\);/s.test(globalCssSource)
  || !/:root\[data-theme='dark'\] \.emergency-strip\s*\{[^}]*background-color:\s*rgb\(153 27 27\);[^}]*color:\s*rgb\(255 255 255\);/s.test(globalCssSource)
  || /\.emergency-strip\s*\{[^}]*\bbg-danger\b/s.test(globalCssSource)) fail('Emergency banner opaque light/dark contrast treatment regressed');
for (const [route, page] of pages) {
  if (route === '/404') continue;
  const banner = tags(page.html).find((tag) => tag.attrs.id === 'emergency-banner');
  if (banner && banner.attrs['data-contrast-surface'] !== 'opaque-danger') fail(`${route}: rendered emergency banner lacks the dark-theme contrast marker`);
}
const searchBoxSource = read(join(root, 'src/components/SearchBox.astro'));
for (const key of ['search.openWorldMap', 'search.browseByCategory']) if (!new RegExp(`class="[^"]*\\btext-fg\\b[^"]*\\bunderline\\b[^"]*"[^>]*data-i18n="${key}"`).test(searchBoxSource)) fail(`homepage fallback link contrast/underline guard failed for ${key}`);
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
