import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { assertCanonicalPackBytes, encodeSchema, generateCanonicalReviewPackSchema, generateReviewPack, reviewPackSafetyErrors } from './multilingual-review-pack.mjs';

const repo = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(repo, path), 'utf8');
const rawPack = readFileSync(resolve(repo, 'reviews/multilingual-ui/v1/review-pack.json'));
const schema = JSON.parse(read('reviews/multilingual-ui/v1/review-pack.schema.json'));
const i18nSource = read('web/src/lib/i18n.ts');
const expectedSchema = generateCanonicalReviewPackSchema(i18nSource);
if (encodeSchema(schema) !== encodeSchema(expectedSchema)) throw new Error('review pack schema is stale or differs from the canonical key inventory');
const expected = generateReviewPack({
  i18nSource,
  manifest: JSON.parse(read('web/src/lib/locale-status.json')),
  classificationPolicy: JSON.parse(read('reviews/multilingual-ui/v1/safety-classification.json')),
});
assertCanonicalPackBytes(rawPack, expected);
const pack = JSON.parse(rawPack.toString('utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
if (!validate(pack)) throw new Error(`review pack schema failure: ${JSON.stringify(validate.errors)}`);
const safetyErrors = reviewPackSafetyErrors(pack);
if (safetyErrors.length) throw new Error(`review pack safety failure: ${safetyErrors.join(', ')}`);
console.log(`Multilingual UI review pack OK: ${pack.keyCount} keys x ${pack.localeCount} locales; internal, pending, and non-qualifying`);
