import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const required = ['/release/v1/changes.json', '/release/v1/changes/latest.json', '/feeds/releases.json', '/feeds/releases.rss', '/feeds/releases.atom'];
const index = JSON.parse(readFileSync(resolve(root, 'public/release/v1/artifacts.json'), 'utf8')); const paths = new Set(index.artifacts.map((entry) => entry.path));
const descriptor = JSON.parse(readFileSync(resolve(root, 'public/release/v1/release.json'), 'utf8'));
for (const path of required) { assert.ok(readFileSync(resolve(root, `public${path}`)).length, `missing generated ${path}`); assert.ok(paths.has(path), `artifact index omits ${path}`); assert.ok(descriptor.relationships[path], `descriptor omits ${path}`); }
console.log('Release feed generated artifact integration OK');
