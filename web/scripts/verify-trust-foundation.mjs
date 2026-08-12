import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHotlineIssueUrl } from '../src/lib/issues.js';
import { DEFAULT_SITE_URL, normalizeSiteUrl } from '../src/lib/site.js';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');

assert.equal(normalizeSiteUrl(undefined), DEFAULT_SITE_URL);
assert.equal(normalizeSiteUrl('not a url'), DEFAULT_SITE_URL);
assert.equal(normalizeSiteUrl('javascript:alert(1)'), DEFAULT_SITE_URL);
assert.equal(normalizeSiteUrl('https://example.org/custom/path?q=1#x'), 'https://example.org');

const issue = new URL(buildHotlineIssueUrl({
  name: 'Example Crisis Service',
  organization: 'Example Authority',
  category: 'mental_health',
  geography: 'Example County, Example State',
  verification_status: 'verified_authority',
  last_verified: '2026-08-12',
}, 'United States'));
assert.equal(issue.origin + issue.pathname, 'https://github.com/craigrallen/world-emergency-hotlines/issues/new');
assert.match(issue.searchParams.get('title') || '', /^Hotline correction: Example Crisis Service$/);
const body = issue.searchParams.get('body') || '';
assert.match(body, /Country: United States/);
assert.match(body, /Geography: Example County, Example State/);
assert.match(body, /Source checked: 2026-08-12/);
assert.match(body, /Do not include sensitive personal or crisis details/);
assert.ok(issue.toString().length < 2000, 'prefilled issue URL should remain bounded');

const hostile = new URL(buildHotlineIssueUrl({
  name: `Bad\nname ${'x'.repeat(1000)}`,
  organization: 'Unsafe\u0000value',
}, 'Test'));
assert.ok(hostile.toString().length < 2000, 'hostile values should remain bounded');
assert.doesNotMatch(hostile.searchParams.get('title') || '', /[\u0000-\u001f\u007f]/);

const currentPublicCopy = [
  readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8'),
  readFileSync(resolve(WEB_ROOT, 'src/layouts/Base.astro'), 'utf8'),
  readFileSync(resolve(WEB_ROOT, 'src/pages/index.astro'), 'utf8'),
  readFileSync(resolve(WEB_ROOT, 'src/pages/about.astro'), 'utf8'),
].join('\n');
assert.doesNotMatch(currentPublicCopy, /\b(definitive|exhaustive)\b/i, 'current public claims must not imply completeness');
assert.match(currentPublicCopy, /source-backed/i);
assert.match(currentPublicCopy, /not (whether|a) .*live|not a live availability check/is);

console.log('Trust foundation OK: conservative claims, safe site URL, and bounded correction links');
