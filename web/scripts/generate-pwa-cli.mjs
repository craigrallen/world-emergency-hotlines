import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePwaAssets } from './generate-pwa-assets.mjs';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalBytes = readFileSync(resolve(webRoot, '..', 'hotlines.json'));
const canonical = JSON.parse(canonicalBytes.toString('utf8'));
generatePwaAssets({
  webRoot,
  datasetVersion: `sha256:${createHash('sha256').update(canonicalBytes).digest('hex')}`,
  sourceLastUpdated: canonical.last_updated,
});
console.log('Generated exact PWA artifacts; review and commit all five public outputs.');
