import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = readFileSync(resolve(webRoot, 'public/widget/v1/hotlines-widget.js'), 'utf8');
let Widget;
class HTMLElementStub {}
const context = {
  URL, Error, console, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  window: { location: { origin: 'https://example.test' } },
  document: { currentScript: { src: 'https://example.test/widget/v1/hotlines-widget.js' }, baseURI: 'https://example.test/' },
  HTMLElement: HTMLElementStub,
  customElements: { get: () => undefined, define: (_tag, constructor) => { Widget = constructor; } },
  Option: class Option { constructor(text, value) { this.text = text; this.value = value; } },
};
vm.runInNewContext(source, context, { filename: 'hotlines-widget.js' });

function selectStub() {
  return { children: [], value: '', replaceChildren(...items) { this.children = items; }, append(item) { this.children.push(item); }, get options() { return this.children; } };
}
function widgetStub() {
  const widget = Object.create(Widget.prototype);
  widget.getAttribute = () => null;
  widget.dispatchEvent = () => true;
  widget.shadowRoot = { querySelector: () => ({ value: 'any' }) };
  widget.ui = {
    country: selectStub(), need: selectStub(), locality: { value: '' }, submit: { disabled: false },
    status: { className: '', textContent: '' }, output: { hidden: false, replaceChildren() { this.cleared = true; } },
  };
  return widget;
}

// loadManifest resolves fetch from its VM global.
context.fetch = async () => ({ ok: true, json: async () => ({ api_version: '1.0', compatibility: { api_major: 1 }, countries: [{ name: 'Test', alpha2: 'TT' }] }) });
let widget = widgetStub();
await widget.loadManifest();
assert.equal(widget.ui.country.children.length, 2, 'compatible API must populate countries');

context.fetch = async () => ({ ok: true, json: async () => ({ api_version: '2.0', compatibility: { api_major: 2 }, countries: [{ name: 'Test', alpha2: 'TT' }] }) });
widget = widgetStub();
await widget.loadManifest();
assert.match(widget.ui.status.textContent, /incompatible/);
assert.equal(widget.ui.output.hidden, true);

context.fetch = async () => ({ ok: true, json: async () => ({ api_version: '2.0', country: 'Test', alpha2: 'TT', hotlines: [] }) });
widget = widgetStub(); widget.ui.country.value = 'tt';
await widget.loadCountry();
assert.match(widget.ui.status.textContent, /Country API.*incompatible/);
assert.equal(widget.ui.output.hidden, true);

const result = { scope: 'country', reason: 'ok', fallback: false, results: [{ id: 'weh_test' }] };
widget = widgetStub(); widget.country = { alpha2: 'TT' }; widget.ui.need.value = 'mental_health'; widget.renderResult = (value) => { widget.rendered = value; };
widget.resolver = { API_MAJOR_VERSION: 1, RESOLVER_MAJOR_VERSION: 1, resolveGuidedHelp: () => result };
await widget.resolve();
assert.equal(widget.rendered, result, 'compatible resolver must render results');

widget = widgetStub(); widget.country = { alpha2: 'TT' }; widget.ui.need.value = 'mental_health'; widget.renderResult = (value) => { widget.rendered = value; };
widget.resolver = { API_MAJOR_VERSION: 1, RESOLVER_MAJOR_VERSION: 2, resolveGuidedHelp: () => result };
await widget.resolve();
assert.equal(widget.rendered, undefined, 'incompatible resolver must not render results');
assert.equal(widget.ui.output.hidden, true);
assert.match(widget.ui.status.textContent, /incompatible/);

widget = widgetStub(); widget.country = { alpha2: 'TT' }; widget.ui.need.value = 'mental_health';
widget.resolver = { API_MAJOR_VERSION: 1, RESOLVER_MAJOR_VERSION: 1, resolveGuidedHelp: () => result };
widget.renderResult = () => { widget.ui.output.hidden = false; widget.ui.output.cleared = false; };
await widget.resolve();
assert.equal(widget.ui.output.hidden, false, 'successful render fixture did not expose prior results');
widget.country = { alpha2: 'TT' };
widget.resolver.resolveGuidedHelp = () => { throw new Error('resolver failed after success'); };
await widget.resolve();
assert.equal(widget.ui.output.hidden, true, 'failure after success retained old hotline results');
assert.equal(widget.ui.output.cleared, true, 'failure after success did not clear rendered nodes');
assert.equal(widget.country, null, 'failure after success retained old country state');
assert.match(widget.ui.status.textContent, /resolver failed after success/);

console.log('Widget runtime compatibility OK: v1 success, API/country/resolver mismatch rejection, post-success failure clears old results');
