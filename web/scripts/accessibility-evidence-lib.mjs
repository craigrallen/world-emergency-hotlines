import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parse } from 'parse5';
import vm from 'node:vm';

export const INTERNAL_MARKER = 'internal-accessibility-evidence-only/v1';
export const SOURCE_BOUNDARY = Object.freeze({
  trees: ['web/src', 'web/scripts'],
  files: ['hotlines.json', 'web/public/widget/v1/hotlines-widget.js', 'web/astro.config.mjs', 'web/postcss.config.mjs', 'web/tailwind.config.mjs', 'web/tsconfig.json', 'web/package.json', 'web/package-lock.json'],
});
export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const walk = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
  const child = resolve(path, entry.name);
  return entry.isDirectory() ? walk(child) : [child];
});
export function boundaryPaths(repo) {
  const paths = SOURCE_BOUNDARY.files.map((path) => resolve(repo, path));
  for (const tree of SOURCE_BOUNDARY.trees) paths.push(...walk(resolve(repo, tree)));
  return paths.filter((path) => statSync(path).isFile() && !path.includes('/__pycache__/')).map((path) => relative(repo, path).replaceAll('\\', '/')).sort();
}
export function sourceHashes(repo) {
  return Object.fromEntries(boundaryPaths(repo).map((path) => [path, sha256(readFileSync(resolve(repo, path)))]));
}
export function boundaryEvidence(repo) {
  const paths = boundaryPaths(repo);
  const chunks = [];
  for (const path of paths) { const bytes = readFileSync(resolve(repo, path)); chunks.push(Buffer.from(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`), bytes); }
  return { paths, digest: sha256(Buffer.concat(chunks)) };
}

// Lex the original bytes before JSON.parse can discard an earlier duplicate member.
export function rejectDuplicateJsonMembers(source, label = 'JSON') {
  let i = 0;
  const ws = () => { while (/\s/.test(source[i] ?? '')) i++; };
  const string = () => {
    const start = i++;
    while (i < source.length) {
      if (source[i] === '\\') i += 2;
      else if (source[i++] === '"') return JSON.parse(source.slice(start, i));
    }
    throw new SyntaxError(`${label}: unterminated string`);
  };
  const value = (path) => {
    ws();
    if (source[i] === '{') {
      i++; ws(); const keys = new Set();
      if (source[i] === '}') { i++; return; }
      while (true) {
        ws(); if (source[i] !== '"') throw new SyntaxError(`${label}: expected object key`);
        const key = string();
        if (keys.has(key)) throw new SyntaxError(`${label}: duplicate member ${[...path, key].join('.')}`);
        keys.add(key); ws(); if (source[i++] !== ':') throw new SyntaxError(`${label}: expected colon`);
        value([...path, key]); ws();
        if (source[i] === '}') { i++; return; }
        if (source[i++] !== ',') throw new SyntaxError(`${label}: expected comma`);
      }
    }
    if (source[i] === '[') {
      i++; ws(); let index = 0;
      if (source[i] === ']') { i++; return; }
      while (true) { value([...path, String(index++)]); ws(); if (source[i] === ']') { i++; return; } if (source[i++] !== ',') throw new SyntaxError(`${label}: expected comma`); }
    }
    if (source[i] === '"') { string(); return; }
    const match = source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new SyntaxError(`${label}: invalid value`);
    i += match[0].length;
  };
  value([]); ws(); if (i !== source.length) throw new SyntaxError(`${label}: trailing input`);
}
export function parseStrictJson(source, label) { rejectDuplicateJsonMembers(source, label); return JSON.parse(source); }

const attrs = (node) => Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
const children = (node) => node.childNodes ?? [];
const text = (node) => node.nodeName === '#text' ? node.value : ['script', 'style', 'template'].includes(node.tagName) ? '' : `${node.textContent ?? ''}${children(node).map(text).join('')}`;
const normalizedText = (node) => text(node).replace(/\s+/g, ' ').trim();
export function parseHtmlDocument(html, label = 'HTML') {
  const errors = [];
  const root = parse(html, { onParseError: (error) => errors.push(error.code) });
  assert.deepEqual(errors, [], `${label}: malformed HTML (${errors.join(', ')})`);
  const nodes = [];
  const visit = (node, parent = null) => { if (node.tagName) { node.parentElement = parent; nodes.push(node); parent = node; } for (const child of children(node)) visit(child, parent); };
  visit(root);
  const find = (tag, expected = {}) => nodes.filter((node) => node.tagName === tag && Object.entries(expected).every(([key, value]) => attrs(node)[key] === value));
  return { html, nodes, find, attrs, text: normalizedText };
}
const ancestor = (node, tag) => { for (let item = node.parentElement; item; item = item.parentElement) if (item.tagName === tag) return item; return null; };
const isDescendantOf = (node, parent) => { for (let item = node.parentElement; item; item = item.parentElement) if (item === parent) return true; return false; };
function assertControlName(doc, control, label) {
  const a = doc.attrs(control); const wrapping = ancestor(control, 'label');
  const explicit = a.id ? doc.find('label', { for: a.id }) : [];
  for (const labelNode of explicit) assert.ok(doc.text(labelNode), `${label}: empty label for ${a.id}`);
  const named = explicit.length === 1 || (wrapping && doc.text(wrapping)) || a['aria-label']?.trim() || a['aria-labelledby']?.trim();
  assert.ok(named, `${label}: unnamed ${control.tagName}#${a.id ?? ''}`);
}
export function assertDocumentNames(doc, label) {
  const ids = new Map();
  for (const node of doc.nodes) {
    const id = doc.attrs(node).id;
    if (id !== undefined) { assert.ok(id.trim(), `${label}: empty id`); assert.ok(!ids.has(id), `${label}: duplicate id ${id}`); ids.set(id, node); }
  }
  for (const labelNode of doc.find('label')) {
    const target = doc.attrs(labelNode).for;
    if (target !== undefined) {
      assert.ok(target.trim(), `${label}: empty label for`);
      assert.ok(ids.has(target), `${label}: label for unresolved id ${target}`);
      assert.ok(['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress'].includes(ids.get(target).tagName), `${label}: label for non-labelable target ${target}`);
    }
  }
  for (const node of doc.nodes) {
    const a = doc.attrs(node);
    if ('aria-labelledby' in a) {
      const refs = a['aria-labelledby'].trim().split(/\s+/).filter(Boolean);
      assert.ok(refs.length, `${label}: empty aria-labelledby`);
      for (const ref of refs) { assert.ok(ids.has(ref), `${label}: unresolved aria-labelledby ${ref}`); assert.ok(doc.text(ids.get(ref)), `${label}: empty aria-labelledby target ${ref}`); }
    }
  }
  for (const control of doc.nodes.filter((node) => ['input', 'select', 'textarea'].includes(node.tagName) && doc.attrs(node).type !== 'hidden')) {
    assertControlName(doc, control, label);
  }
  for (const button of doc.find('button')) {
    const a = doc.attrs(button);
    assert.ok(doc.text(button) || a['aria-label']?.trim() || a['aria-labelledby']?.trim() || a.title?.trim(), `${label}: button has empty accessible name`);
  }
  for (const fieldset of doc.find('fieldset')) {
    const firstElement = children(fieldset).find((node) => node.tagName);
    assert.equal(firstElement?.tagName, 'legend', `${label}: fieldset first effective child is not legend`);
    assert.ok(doc.text(firstElement), `${label}: fieldset legend is empty`);
  }
}
export { ancestor };

export function assertThemeChoices(doc, label = 'document') {
  const values = doc.find('button')
    .filter((node) => doc.attrs(node)['data-theme-value'] !== undefined)
    .map((node) => doc.attrs(node)['data-theme-value']);
  assert.deepEqual(values, ['light', 'dark', 'system'], `${label}: theme choices must be exactly light, dark, system in rendered order`);
}

export function assertTableBodyRowHeaders(doc, label = 'table') {
  const bodies = doc.find('tbody');
  assert.equal(bodies.length, 1, `${label}: expected exactly one table body`);
  const rows = doc.find('tr').filter((node) => isDescendantOf(node, bodies[0]));
  assert.ok(rows.length, `${label}: expected table-body rows`);
  for (const [index, row] of rows.entries()) {
    const headers = doc.find('th', { scope: 'row' }).filter((node) => isDescendantOf(node, row));
    assert.equal(headers.length, 1, `${label}: table-body row ${index + 1} must contain exactly one th[scope="row"]`);
    assert.ok(doc.text(headers[0]), `${label}: table-body row ${index + 1} has an empty th[scope="row"]`);
  }
}

export function assertFormControlInventory(doc, formId, expected) {
  const forms = doc.find('form', { id: formId });
  assert.equal(forms.length, 1, `${formId}: expected exactly one form`);
  assertControlInventory(doc, forms[0], expected, formId);
}
export function assertControlInventory(doc, form, expected, label = 'form') {
  assert.ok(form, `${label}: expected form`);
  const controls = doc.nodes.filter((node) => ['input', 'select', 'textarea', 'button'].includes(node.tagName) && isDescendantOf(node, form));
  const actual = controls.map((node) => {
    const a = doc.attrs(node); const item = { tag: node.tagName };
    for (const key of ['id', 'type', 'name', 'value']) if (a[key] !== undefined) item[key] = a[key];
    return item;
  });
  assert.deepEqual(actual, expected, `${label}: native control inventory changed`);
  for (const control of controls) {
    if (control.tagName === 'button') {
      const a = doc.attrs(control);
      assert.ok(doc.text(control) || a['aria-label']?.trim() || a['aria-labelledby']?.trim() || a.title?.trim(), `${label}: button has empty accessible name`);
    } else assertControlName(doc, control, label);
  }
}

export function assertExpectedFieldset(doc, form, label = 'form') {
  const fieldsets = doc.find('fieldset').filter((node) => isDescendantOf(node, form));
  assert.equal(fieldsets.length, 1, `${label}: expected exactly one fieldset`);
  const firstElement = children(fieldsets[0]).find((node) => node.tagName);
  assert.equal(firstElement?.tagName, 'legend', `${label}: fieldset first effective child is not a direct legend`);
  assert.ok(doc.text(firstElement), `${label}: fieldset legend is empty`);
}

export function assertNamedLinks(doc, href, label = 'document') {
  const links = doc.find('a', { href });
  assert.ok(links.length, `${label}: expected link ${href}`);
  for (const link of links) {
    const a = doc.attrs(link);
    assert.ok(doc.text(link) || a['aria-label']?.trim() || a['aria-labelledby']?.trim() || a.title?.trim(), `${label}: ${href} link has empty accessible name`);
  }
}

export function stripCssComments(css) {
  let result = ''; let quote = null;
  for (let i = 0; i < css.length; i++) {
    const char = css[i]; const next = css[i + 1];
    if (quote) {
      result += char;
      if (char === '\\') result += css[++i] ?? '';
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") { quote = char; result += char; }
    else if (char === '/' && next === '*') {
      const end = css.indexOf('*/', i + 2);
      assert.notEqual(end, -1, 'CSS: unterminated comment'); i = end + 1;
    } else result += char;
  }
  return result;
}
export function assertWidgetStylesheet(css) {
  const rules = stripCssComments(css);
  assert.match(rules, /(?:^|})[^{}]*:focus-visible[^{}]*\{[^{}]+}/, 'widget stylesheet: missing nonempty :focus-visible rule');
  assert.match(rules, /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{\s*[^{}]+\{[^{}]+}\s*}/, 'widget stylesheet: missing nonempty dark preference rule');
}

export function loadBuiltWidget(publicPath, builtPath) {
  assert.ok(existsSync(builtPath), `${builtPath} is absent; run the build before this verifier`);
  const publicBytes = readFileSync(publicPath); const builtBytes = readFileSync(builtPath);
  assert.deepEqual(builtBytes, publicBytes, 'built widget bytes differ from the public source build-copy contract');
  return builtBytes.toString('utf8');
}

export function constructWidget(source, { timeout = 1_000 } = {}) {
  let Widget; const registrations = [];
  class NodeStub {
    constructor(tagName = '#shadow-root', textValue = '') { this.tagName = tagName; this.nodeName = tagName; this.attrs = {}; this._value = textValue; this.textContent = textValue; this.childNodes = []; this.childElementCount = 0; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    append(...items) { for (const item of items) { this.childNodes.push(item); if (item?.tagName && item.tagName !== '#text') this.childElementCount++; } }
    addEventListener() {}
    replaceChildren(...items) { this.childNodes = []; this.childElementCount = 0; this.append(...items); }
    set id(value) { this.attrs.id = String(value); } get id() { return this.attrs.id ?? ''; }
    set htmlFor(value) { this.attrs.for = String(value); }
    set type(value) { this.attrs.type = String(value); }
    set name(value) { this.attrs.name = String(value); } get name() { return this.attrs.name ?? ''; }
    set value(value) { this._value = value; this.attrs.value = String(value); } get value() { return this._value; }
    set tabIndex(value) { this.attrs.tabindex = String(value); }
  }
  class HTMLElementStub extends NodeStub { attachShadow(options) { this.shadowOptions = options; this.shadowRoot = new NodeStub(); return this.shadowRoot; } }
  const document = {
    currentScript: { src: 'https://example.test/widget/v1/hotlines-widget.js' }, baseURI: 'https://example.test/',
    createElement: (name) => new NodeStub(name), createTextNode: (value) => new NodeStub('#text', String(value)),
  };
  const registry = new Map();
  const context = { URL, Error, console, document, window: { location: { origin: 'https://example.test' } }, HTMLElement: HTMLElementStub,
    customElements: {
      get: (name) => registry.get(name),
      define: (name, constructor) => {
        if (registry.has(name)) throw new Error(`duplicate custom element registration: ${name}`);
        registry.set(name, constructor); registrations.push(name);
        if (name === 'world-emergency-hotlines') Widget = constructor;
      },
    },
    Option: class Option extends NodeStub { constructor(label, value) { super('option', label); this.value = value; } },
    CustomEvent: class CustomEvent {}, fetch: async () => new Promise(() => {}),
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(source, sandbox, { filename: 'hotlines-widget.js', timeout });
  assert.deepEqual(registrations, ['world-emergency-hotlines'], 'widget source must register exactly one world-emergency-hotlines custom element');
  assert.ok(Widget, 'widget source did not register its custom element');
  sandbox.__Widget = Widget;
  vm.runInContext(`
    globalThis.__widget = new globalThis.__Widget();
    globalThis.__widget.getAttribute = () => null;
    globalThis.__widget.renderShell();
  `, sandbox, { filename: 'hotlines-widget-construction.js', timeout });
  const widget = sandbox.__widget;
  const nodes = [];
  const visit = (node, parent = null) => { if (node.tagName !== '#text') { node.parentElement = parent; nodes.push(node); parent = node; } for (const child of node.childNodes) visit(child, parent); };
  visit(widget.shadowRoot);
  const find = (tag, expected = {}) => nodes.filter((node) => node.tagName === tag && Object.entries(expected).every(([key, value]) => node.attrs[key] === value));
  const doc = { nodes, find, attrs: (node) => node.attrs, text: normalizedText };
  return { widget, doc, stylesheet: find('style')[0]?.textContent ?? '' };
}
