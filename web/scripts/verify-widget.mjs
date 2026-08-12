import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const widgetPath = resolve(WEB_ROOT, 'public', 'widget', 'v1', 'hotlines-widget.js');
const pagePath = resolve(WEB_ROOT, 'src', 'pages', 'widget.astro');
const docsPath = resolve(WEB_ROOT, '..', 'docs', 'WIDGET.md');
const distWidget = resolve(WEB_ROOT, 'dist', 'widget', 'v1', 'hotlines-widget.js');
const distPage = resolve(WEB_ROOT, 'dist', 'widget', 'index.html');
const errors = [];
const fail = (message) => errors.push(message);

for (const path of [widgetPath, pagePath, docsPath]) if (!existsSync(path)) fail(`missing ${path}`);

if (existsSync(widgetPath)) {
  const source = readFileSync(widgetPath, 'utf8');
  const requirements = [
    [/customElements\.define\(TAG/, 'registers a custom element'],
    [/attachShadow\(\{ mode: 'open' \}\)/, 'uses Shadow DOM'],
    [/aria-labelledby/, 'labels the widget region'],
    [/setAttribute\('role', 'status'\)/, 'provides status semantics'],
    [/setAttribute\('aria-live', 'polite'\)/, 'provides a polite live region'],
    [/element\('fieldset'\)/, 'uses fieldset for channels'],
    [/element\('legend'/, 'uses a channel legend'],
    [/form\.reportValidity\(\)/, 'uses native validation'],
    [/output\.focus\(/, 'moves focus to resolved output'],
    [/verification_status !== 'deprecated'/, 'excludes deprecated records from category controls'],
    [/resolveGuidedHelp/, 'uses the shared resolver'],
    [/new URL\('resolver\.js', this\.apiBase\)/, 'loads the versioned resolver from the API base'],
    [/safeHttpUrl/, 'validates external URLs'],
    [/\['http:', 'https:'\]/, 'restricts API base protocols'],
    [/textContent =/, 'renders dynamic text with textContent'],
    [/rel = 'noopener noreferrer'/, 'protects external tabs'],
    [/maxLength = 100/, 'bounds locality input'],
    [/resultIds: result\.results\.map/, 'emits stable result IDs'],
    [/not live availability checks/, 'states availability limitation'],
    [/not.*medical advice|medical advice/, 'states medical-advice limitation'],
  ];
  for (const [pattern, label] of requirements) if (!pattern.test(source)) fail(`widget ${label}`);
  for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function(', 'document.write']) {
    if (source.includes(forbidden)) fail(`widget contains forbidden DOM/code sink: ${forbidden}`);
  }
  const eventMatch = source.match(/new CustomEvent\('weh-results',[\s\S]*?\}\s*\}\)/);
  if (!eventMatch) fail('widget results event contract is missing');
  else if (/locality/i.test(eventMatch[0])) fail('widget results event leaks locality');
}

if (existsSync(pagePath)) {
  const source = readFileSync(pagePath, 'utf8');
  if (!/<world-emergency-hotlines/.test(source)) fail('demo page does not render the widget');
  if (!/\/widget\/v1\/hotlines-widget\.js/.test(source)) fail('demo page does not pin widget v1');
  if (!/does not collect or submit/.test(source)) fail('demo page lacks privacy wording');
}

if (existsSync(docsPath)) {
  const source = readFileSync(docsPath, 'utf8');
  for (const text of ['/widget/v1/hotlines-widget.js', 'api-base', 'CSP', 'Accessibility', 'not live availability']) {
    if (!source.includes(text)) fail(`widget docs missing ${text}`);
  }
}

if (existsSync(distPage) || existsSync(distWidget)) {
  if (!existsSync(distPage)) fail('built widget demo page is missing');
  if (!existsSync(distWidget)) fail('built widget v1 script is missing');
  if (existsSync(distPage)) {
    const html = readFileSync(distPage, 'utf8');
    if (!html.includes('<world-emergency-hotlines')) fail('built demo lacks custom element');
    if (!html.includes('/widget/v1/hotlines-widget.js')) fail('built demo lacks widget script');
  }
}

if (errors.length) {
  console.error(`Widget verification failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('Widget v1 OK: versioned custom element, privacy/safety/accessibility contract, demo and docs');
