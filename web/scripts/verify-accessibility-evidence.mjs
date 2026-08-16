import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INTERNAL_MARKER, SOURCE_BOUNDARY, assertControlInventory, assertDocumentNames, assertExpectedFieldset, assertFormControlInventory, assertNamedLinks, assertWidgetStylesheet, boundaryEvidence, constructWidget, loadBuiltWidget, parseHtmlDocument, parseStrictJson } from './accessibility-evidence-lib.mjs';

const repo = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(repo, 'reviews/accessibility-evidence/v1/baseline.json');
const rawManifest = readFileSync(manifestPath, 'utf8');
const manifest = parseStrictJson(rawManifest, 'accessibility evidence manifest');
const exactKeys = (value, keys, label) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has an open or incomplete schema`);

exactKeys(manifest, ['schema_version', 'internal_only_marker', 'scope', 'review_boundary', 'disclaimer', 'sources', 'surfaces'], 'baseline');
assert.equal(manifest.schema_version, '1.1');
assert.equal(manifest.internal_only_marker, INTERNAL_MARKER);
assert.equal(manifest.scope, 'internal_deterministic_regression_evidence');
assert.deepEqual(manifest.review_boundary, SOURCE_BOUNDARY);
for (const phrase of ['does not claim WCAG conformance', 'certification', 'VPAT or ACR status', 'exhaustive assistive-technology coverage', 'legal compliance', 'external assessor review']) assert.match(manifest.disclaimer, new RegExp(phrase, 'i'));
const currentBoundary = boundaryEvidence(repo);
assert.deepEqual(manifest.sources, { file_count: currentBoundary.paths.length, digest: currentBoundary.digest }, 'finite source/build boundary changed: review claims, then run npm run update:accessibility-evidence-sources and apply the printed inventory/digest intentionally');

const baseShape = ['id', 'route', 'artifact', 'method', 'assertions', 'manual'];
const expected = {
  guided_finder: ['/find-help', 'web/dist/find-help/index.html', ['static_document_language_and_direction', 'static_main_and_skip_link', 'static_form_accessible_name_references', 'native_form_elements_present', 'static_polite_live_region', 'three_theme_choice_buttons']],
  traveler_mode: ['/traveler', 'web/dist/traveler/index.html', ['static_document_language_and_direction', 'static_main_and_skip_link', 'static_form_accessible_name_references', 'native_form_elements_present', 'two_static_polite_live_regions', 'three_theme_choice_buttons']],
  basic_widget: ['/widget', 'web/dist/widget/index.html', ['static_document_language_and_direction', 'static_main_and_skip_link', 'static_embed_element_and_script_reference', 'constructor_requests_open_shadow_root', 'render_shell_constructs_named_section_form_controls_and_first_legend', 'render_shell_constructs_polite_status', 'render_shell_sets_output_negative_tabindex', 'stylesheet_contains_focus_visible_rule', 'stylesheet_contains_dark_preference_rule']],
  language_status: ['/language-status', 'web/dist/language-status/index.html', ['static_document_language_and_direction', 'static_main_and_skip_link', 'static_row_header_cells', 'static_ltr_english_translation_disclosure', 'three_theme_choice_buttons']],
};
const expectedManual = {
  guided_finder: ['keyboard_interaction', 'focus_order_and_visibility', 'screen_reader_output', 'contrast_zoom_and_reflow', 'computed_rtl_behavior'],
  traveler_mode: ['keyboard_interaction', 'focus_order_and_visibility', 'screen_reader_output', 'contrast_zoom_and_reflow', 'computed_rtl_behavior', 'print_dialog_accessibility'],
  basic_widget: ['keyboard_interaction', 'shadow_focus_order_and_visibility', 'screen_reader_shadow_dom_output', 'contrast_zoom_and_reflow', 'computed_styles_and_dark_theme', 'host_page_integration_variants'],
  language_status: ['keyboard_interaction', 'focus_order_and_visibility', 'screen_reader_table_output', 'translated_ui_quality', 'contrast_zoom_and_reflow', 'computed_rtl_behavior'],
};
assert.deepEqual(manifest.surfaces.map(({ id }) => id), Object.keys(expected));
for (const surface of manifest.surfaces) {
  exactKeys(surface, surface.id === 'basic_widget' ? [...baseShape, 'secondary_artifact'] : baseShape, surface.id);
  assert.deepEqual([surface.route, surface.artifact, surface.assertions], expected[surface.id]);
  assert.equal(surface.method, surface.id === 'basic_widget' ? 'parse5_built_html_and_vm_constructed_widget_structure' : 'parse5_built_html_structure');
  exactKeys(surface.manual, expectedManual[surface.id], `${surface.id}.manual`);
  for (const status of Object.values(surface.manual)) assert.ok(['pending', 'not_assessed'].includes(status), `${surface.id} has a non-conservative manual status`);
}
assert.equal(manifest.surfaces[2].secondary_artifact, '/widget/v1/hotlines-widget.js');

function artifact(surface) {
  const path = resolve(repo, surface.artifact); assert.ok(existsSync(path), `${path} is absent; run the build before this verifier`);
  const doc = parseHtmlDocument(readFileSync(path, 'utf8'), surface.route); assertDocumentNames(doc, surface.route); return doc;
}
function common(doc, route) {
  assert.equal(doc.find('html').length, 1); const html = doc.attrs(doc.find('html')[0]);
  assert.match(html.lang, /^[a-z]{2}(?:-[A-Z]{2})?$/); assert.ok(['ltr', 'rtl'].includes(html.dir));
  assert.equal(doc.find('main', { id: 'main' }).length, 1, `${route}: one main`); assertNamedLinks(doc, '#main', route);
  assert.equal(doc.find('h1').length, 1, `${route}: one h1`); assert.equal(doc.find('button').filter((node) => doc.attrs(node)['data-theme-value']).length, 3);
}
const docs = Object.fromEntries(manifest.surfaces.map((surface) => [surface.id, artifact(surface)]));
for (const surface of manifest.surfaces) common(docs[surface.id], surface.route);
assertFormControlInventory(docs.guided_finder, 'guided-finder', [
  { tag: 'select', id: 'finder-country' }, { tag: 'input', id: 'finder-locality', type: 'text' }, { tag: 'select', id: 'finder-category' },
  ...['any', 'phone', 'text', 'chat'].map((value) => ({ tag: 'input', type: 'radio', name: 'finder-channel', value })), { tag: 'button', type: 'submit' },
]);
assertFormControlInventory(docs.traveler_mode, 'traveler-download-form', [
  { tag: 'select', id: 'traveler-download-country' }, { tag: 'button', id: 'traveler-download-submit', type: 'submit' },
]);
assertFormControlInventory(docs.traveler_mode, 'traveler-form', [
  { tag: 'select', id: 'traveler-current' }, { tag: 'select', id: 'traveler-home' }, { tag: 'input', id: 'traveler-locality', type: 'text' }, { tag: 'select', id: 'traveler-category' },
  ...['any', 'phone', 'text', 'chat'].map((value) => ({ tag: 'input', type: 'radio', name: 'traveler-channel', value })), { tag: 'button', type: 'submit' },
]);
assert.equal(docs.guided_finder.find('section', { id: 'finder-output' })[0] && docs.guided_finder.attrs(docs.guided_finder.find('section', { id: 'finder-output' })[0])['aria-live'], 'polite');
for (const id of ['traveler-output', 'traveler-download-status']) assert.equal(docs.traveler_mode.attrs(docs.traveler_mode.nodes.find((node) => docs.traveler_mode.attrs(node).id === id))['aria-live'], 'polite');
assert.ok(docs.language_status.find('th', { scope: 'row' }).length); const disclosure = docs.language_status.nodes.find((node) => 'data-translation-disclosure' in docs.language_status.attrs(node));
assert.equal(docs.language_status.attrs(disclosure).dir, 'ltr'); assert.equal(docs.language_status.attrs(disclosure).lang, 'en');
assert.equal(docs.basic_widget.find('world-emergency-hotlines').length, 1); assert.equal(docs.basic_widget.find('script', { src: '/widget/v1/hotlines-widget.js' }).length, 1);

const widgetSource = loadBuiltWidget(resolve(repo, 'web/public/widget/v1/hotlines-widget.js'), resolve(repo, 'web/dist/widget/v1/hotlines-widget.js'));
const built = constructWidget(widgetSource);
assert.equal(built.widget.shadowOptions?.mode, 'open'); assert.deepEqual(Object.keys(built.widget.shadowOptions), ['mode']); assertDocumentNames(built.doc, 'widget rendered shell');
assert.equal(built.doc.find('section', { 'aria-labelledby': 'weh-title' }).length, 1); assert.equal(built.doc.find('form').length, 1);
const widgetForm = built.doc.find('form')[0];
assertControlInventory(built.doc, widgetForm, [
  { tag: 'select', id: 'weh-country' }, { tag: 'input', id: 'weh-locality' }, { tag: 'select', id: 'weh-need' },
  ...['any', 'phone', 'text', 'chat'].map((value) => ({ tag: 'input', type: 'radio', name: 'weh-channel', value })), { tag: 'button', type: 'submit' },
], 'widget form');
assertExpectedFieldset(built.doc, widgetForm, 'widget form');
assert.equal(built.doc.find('div', { role: 'status', 'aria-live': 'polite' }).length, 1); assert.equal(built.doc.find('div', { tabindex: '-1' }).length, 1);
assertWidgetStylesheet(built.stylesheet);
console.log(`Accessibility evidence OK: ${manifest.surfaces.length} surfaces, complete finite source boundary, parse5 artifacts, and VM-constructed widget structure verified`);
