import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertControlInventory, assertDescendantControlInventory, assertDocumentNames, assertExpectedFieldset, assertFormControlInventory, assertNamedLinks, assertTableBodyRowHeaders, assertThemeChoices, assertUniqueElementAttributes, assertWidgetStylesheet, boundaryPaths, constructWidget, loadBuiltWidget, parseHtmlDocument, rejectDuplicateJsonMembers } from './accessibility-evidence-lib.mjs';
import { assertInternalNonpublication } from './verify-internal-nonpublication.mjs';

const repo = resolve(import.meta.dirname, '../..');
const html = (body) => `<!doctype html><html lang="en"><head><title>x</title></head><body>${body}</body></html>`;
const validate = (body) => assertDocumentNames(parseHtmlDocument(html(body), 'fixture'), 'fixture');

test('parse5 handles script markup text and quoted greater-than without inventing controls', () => {
  const doc = parseHtmlDocument(html(`<script>const x = '<input id="fake">'</script><label for="real">A > B</label><input id="real">`));
  assert.equal(doc.find('input').length, 1); validate(`<label for="real">A > B</label><input id="real">`);
});
for (const [name, fixture, pattern] of [
  ['unrelated label', '<label for="other">Other</label><input id="target"><input id="other">', /unnamed input#target/],
  ['empty aria IDREF', '<input aria-labelledby="   ">', /empty aria-labelledby/],
  ['unresolved aria IDREF', '<input aria-labelledby="missing">', /unresolved aria-labelledby/],
  ['empty aria target', '<span id="name"></span><button aria-labelledby="name"></button>', /empty aria-labelledby target/],
  ['duplicate IDs', '<label for="x">X</label><input id="x"><div id="x"></div>', /duplicate id/],
  ['non-first legend', '<fieldset><div>wrong</div><legend>Name</legend></fieldset>', /first effective child/],
  ['empty wrapping label', '<label><input></label>', /unnamed input/],
  ['empty button', '<button aria-label=""></button>', /empty accessible name/],
]) test(`accessible-name structure rejects ${name}`, () => assert.throws(() => validate(fixture), pattern));
test('parse5 reports malformed HTML instead of accepting repaired structure silently', () => assert.throws(() => parseHtmlDocument(html('<div a="unterminated></div>'), 'bad'), /malformed HTML/));
test('an expected form with no native controls cannot satisfy its control inventory', () => {
  const doc = parseHtmlDocument(html('<form id="guided-finder"><p>Placeholder</p></form>'));
  assert.throws(() => assertFormControlInventory(doc, 'guided-finder', [{ tag: 'select', id: 'finder-country' }]), /native control inventory changed/);
});
test('an empty widget form and fieldset cannot satisfy the expected structure', () => {
  const doc = parseHtmlDocument(html('<form><fieldset></fieldset></form>')); const form = doc.find('form')[0];
  assert.throws(() => assertControlInventory(doc, form, [{ tag: 'select', id: 'weh-country' }], 'widget form'), /native control inventory changed/);
  assert.throws(() => assertExpectedFieldset(doc, form, 'widget form'), /direct legend/);
});
test('fieldset helper accepts one expected fieldset with a direct first nonempty legend', () => {
  const doc = parseHtmlDocument(html('<form><fieldset>\n<legend>Preferred channel</legend><div></div></fieldset></form>'));
  assert.doesNotThrow(() => assertExpectedFieldset(doc, doc.find('form')[0], 'widget form'));
});
test('widget channel radios outside the validated fieldset are rejected', () => {
  const radios = ['any', 'phone', 'text', 'chat'].map((value) => `<label>${value}<input type="radio" name="weh-channel" value="${value}"></label>`).join('');
  const doc = parseHtmlDocument(html(`<form><fieldset><legend>Preferred channel</legend></fieldset>${radios}</form>`));
  const fieldset = assertExpectedFieldset(doc, doc.find('form')[0], 'widget form');
  assert.throws(() => assertDescendantControlInventory(doc, fieldset, ['any', 'phone', 'text', 'chat'].map((value) => ({ tag: 'input', type: 'radio', name: 'weh-channel', value })), 'widget channel fieldset'), /descendant native control inventory changed/);
});
test('widget output semantics are bound to exactly one #weh-output node', () => {
  const doc = parseHtmlDocument(html('<div id="weh-output"></div><div tabindex="-1"></div>'));
  assert.throws(() => assertUniqueElementAttributes(doc, 'div', 'weh-output', { tabindex: '-1' }, 'widget output'), /tabindex changed/);
});
test('widget live status semantics are bound to exactly one #weh-status node', () => {
  const doc = parseHtmlDocument(html('<div id="weh-status"></div><div role="status" aria-live="polite"></div>'));
  assert.throws(() => assertUniqueElementAttributes(doc, 'div', 'weh-status', { role: 'status', 'aria-live': 'polite' }, 'widget status'), /role changed/);
});
test('skip links matching #main must all have nonempty accessible names', () => {
  const doc = parseHtmlDocument(html('<a href="#main">Skip</a><a href="#main" aria-label=" "></a><main id="main"></main>'));
  assert.throws(() => assertNamedLinks(doc, '#main', 'fixture'), /empty accessible name/);
});
test('named skip-link helper accepts text and explicit accessible names', () => {
  const doc = parseHtmlDocument(html('<a href="#main">Skip</a><a href="#main" aria-label="Skip navigation"></a>'));
  assert.doesNotThrow(() => assertNamedLinks(doc, '#main', 'fixture'));
});
test('theme choices reject duplicate or invalid values even when three buttons are rendered', () => {
  const doc = parseHtmlDocument(html('<button data-theme-value="light">Light</button><button data-theme-value="light">Dark</button><button data-theme-value="invalid">System</button>'));
  assert.throws(() => assertThemeChoices(doc, 'fixture'), /exactly light, dark, system/);
});
test('theme choices require the exact rendered light, dark, system order', () => {
  const doc = parseHtmlDocument(html('<button data-theme-value="light">Light</button><button data-theme-value="dark">Dark</button><button data-theme-value="system">System</button>'));
  assert.doesNotThrow(() => assertThemeChoices(doc, 'fixture'));
});
test('every table-body row must have exactly one nonempty scoped row header', () => {
  const missing = parseHtmlDocument(html('<table><tbody><tr><th scope="row">English</th><td>Ready</td></tr><tr><td>French</td><td>Ready</td></tr></tbody></table>'));
  assert.throws(() => assertTableBodyRowHeaders(missing, 'fixture'), /row 2 must contain exactly one/);
  const empty = parseHtmlDocument(html('<table><tbody><tr><th scope="row"> </th><td>Ready</td></tr></tbody></table>'));
  assert.throws(() => assertTableBodyRowHeaders(empty, 'fixture'), /empty th/);
});
test('CSS assertion rejects focus-visible and dark preference strings found only in comments', () => {
  assert.throws(() => assertWidgetStylesheet('/* button:focus-visible{outline:1px solid} @media(prefers-color-scheme:dark){:host{color:white}} */'), /focus-visible/);
});
test('CSS assertion requires each real rule even when the other string appears in a comment', () => {
  assert.throws(() => assertWidgetStylesheet('button:focus-visible{outline:1px solid} /* @media(prefers-color-scheme:dark){:host{color:white}} */'), /dark preference/);
});
test('CSS assertion accepts nonempty focus-visible and dark preference rules', () => {
  assert.doesNotThrow(() => assertWidgetStylesheet('button:focus-visible { outline: 2px solid } @media ( prefers-color-scheme : dark ) { :host { color: white } }'));
});

test('duplicate JSON members are rejected at every manifest nesting level', () => {
  const fixtures = ['{"scope":1,"scope":2}', '{"sources":{"x":1,"x":2}}', '{"surfaces":[{"route":1,"route":2}]}', '{"surfaces":[{"manual":{"keyboard":1,"keyboard":2}}]}'];
  for (const fixture of fixtures) assert.throws(() => rejectDuplicateJsonMembers(fixture, 'fixture'), /duplicate member/);
});

test('source boundary is finite, sorted, and covers named transitive and build inputs', () => {
  const paths = boundaryPaths(repo); assert.deepEqual(paths, [...paths].sort()); assert.equal(new Set(paths).size, paths.length);
  for (const path of ['hotlines.json', 'web/src/components/Header.astro', 'web/src/components/Footer.astro', 'web/src/components/EmergencyBanner.astro', 'web/src/components/Icon.astro', 'web/src/lib/i18n.ts', 'web/src/lib/seo.ts', 'web/src/lib/site.js', 'web/src/lib/data.ts', 'web/src/lib/types.ts', 'web/src/lib/finder.js', 'web/src/lib/contact.ts', 'web/src/lib/traveler.js', 'web/scripts/build-static-data.mjs', 'web/scripts/api-records-transform.mjs', 'web/scripts/centroids.json', 'web/package-lock.json', 'web/astro.config.mjs']) assert.ok(paths.includes(path), path);
});

test('dead/comment widget strings cannot substitute for constructed structure', () => {
  assert.throws(() => constructWidget(`/* attachShadow({mode:'open'}); element('form'); element('legend') */`), /must register exactly one/);
  const source = `class X extends HTMLElement { constructor(){super();this.attachShadow({mode:'closed'})} renderShell(){} } customElements.define('world-emergency-hotlines',X)`;
  assert.notDeepEqual(constructWidget(source).widget.shadowOptions, { mode: 'open' });
});
test('VM registry rejects wrong and duplicate custom-element registrations', () => {
  assert.throws(() => constructWidget(`class X extends HTMLElement { renderShell(){} } customElements.define('wrong-widget',X)`), /exactly one world-emergency-hotlines/);
  assert.throws(() => constructWidget(`class X extends HTMLElement {} customElements.define('world-emergency-hotlines',X); customElements.define('world-emergency-hotlines',X)`), /duplicate custom element registration/);
});
test('widget construction and renderShell execution fail within the bounded VM timeout', () => {
  const nonterminatingConstructor = `class X extends HTMLElement { constructor(){ super(); while (true) {} } renderShell(){} } customElements.define('world-emergency-hotlines',X)`;
  assert.throws(() => constructWidget(nonterminatingConstructor, { timeout: 20 }), /Script execution timed out after 20ms/);
  const nonterminatingRender = `class X extends HTMLElement { renderShell(){ while (true) {} } } customElements.define('world-emergency-hotlines',X)`;
  assert.throws(() => constructWidget(nonterminatingRender, { timeout: 20 }), /Script execution timed out after 20ms/);
});

function widgetCopyFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'weh-widget-copy-'));
  const publicPath = resolve(root, 'public.js'); const builtPath = resolve(root, 'dist.js');
  writeFileSync(publicPath, 'source bytes');
  return { publicPath, builtPath };
}
test('built widget helper rejects a missing built artifact in isolation', () => {
  const { publicPath, builtPath } = widgetCopyFixture();
  assert.throws(() => loadBuiltWidget(publicPath, builtPath), /is absent/);
});
test('built widget helper rejects a stale built artifact in isolation', () => {
  const { publicPath, builtPath } = widgetCopyFixture(); writeFileSync(builtPath, 'older source bytes');
  assert.throws(() => loadBuiltWidget(publicPath, builtPath), /differ from the public source/);
});
test('built widget helper rejects tampered built bytes in isolation', () => {
  const { publicPath, builtPath } = widgetCopyFixture(); writeFileSync(builtPath, 'source bytes\n/* tampered */');
  assert.throws(() => loadBuiltWidget(publicPath, builtPath), /differ from the public source/);
});

test('each accessibility evidence artifact copied alone into an isolated dist is rejected', () => {
  for (const name of ['baseline.json', 'README.md']) {
    const root = mkdtempSync(resolve(tmpdir(), 'weh-nonpub-')); const dist = resolve(root, 'dist'); mkdirSync(dist);
    copyFileSync(resolve(repo, 'reviews/accessibility-evidence/v1', name), resolve(dist, name));
    assert.throws(() => assertInternalNonpublication(dist, repo), /internal accessibility-evidence artifact|internal review-pack marker/);
  }
});
test('nonpublication fixture does not depend on or mutate actual dist', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'weh-nonpub-clean-')); mkdirSync(resolve(root, 'dist')); writeFileSync(resolve(root, 'dist/index.html'), '<p>public</p>');
  assert.doesNotThrow(() => assertInternalNonpublication(resolve(root, 'dist'), repo));
});
