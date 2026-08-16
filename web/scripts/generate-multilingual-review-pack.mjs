import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePack, encodeSchema, generateCanonicalReviewPackSchema, generateReviewPack } from './multilingual-review-pack.mjs';

const webRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(webRoot, '..');
const read = (path) => readFileSync(resolve(repoRoot, path), 'utf8');
const i18nSource = read('web/src/lib/i18n.ts');
const pack = generateReviewPack({
  i18nSource,
  manifest: JSON.parse(read('web/src/lib/locale-status.json')),
  classificationPolicy: JSON.parse(read('reviews/multilingual-ui/v1/safety-classification.json')),
});
writeFileSync(resolve(repoRoot, 'reviews/multilingual-ui/v1/review-pack.json'), encodePack(pack));
writeFileSync(resolve(repoRoot, 'reviews/multilingual-ui/v1/review-pack.schema.json'), encodeSchema(generateCanonicalReviewPackSchema(i18nSource)));
