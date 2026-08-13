import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  SUPPORTED_CATEGORIES,
  validateConfig,
} from '../../managed-widget-config/model.mjs';
import {
  verifyManagedWidgetConfigContractDrift,
  verifySupportedCategoryDrift,
} from './generate-managed-widget-config-contracts.mjs';

const ROOT = resolve(
  fileURLToPath(new URL('..', import.meta.url)),
  'public/managed-widget-config/v1',
);
const readJson = (name) => JSON.parse(readFileSync(resolve(ROOT, name), 'utf8'));

function runtimeInvariant(_schema, value) {
  try {
    validateConfig(value);
    return true;
  } catch {
    return false;
  }
}

function sorted(_schema, value) {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify([...value].sort());
}

verifyManagedWidgetConfigContractDrift();
verifySupportedCategoryDrift();
const configSchema = readJson('config.schema.json');
const envelopeSchema = readJson('envelope.schema.json');
const portableAjv = new Ajv2020({ strict: false, allErrors: true });
addFormats(portableAjv);
portableAjv.addSchema(configSchema);
const validatePortableConfig = portableAjv.getSchema(configSchema.$id);
const validateEnvelopeSchema = portableAjv.compile(envelopeSchema);

// The custom keywords exist only in this local parity harness. Published schemas
// remain ordinary Draft 2020-12 documents and do not depend on them.
const parityAjv = new Ajv2020({ strict: false, allErrors: true });
addFormats(parityAjv);
parityAjv.addKeyword({ keyword: 'x-runtime-invariants', schemaType: 'boolean', validate: runtimeInvariant });
parityAjv.addKeyword({ keyword: 'x-sorted', schemaType: 'boolean', validate: sorted });
const paritySchema = structuredClone(configSchema);
paritySchema.$id = 'https://contracts.example.invalid/managed-widget-config/v1/runtime-parity.schema.json';
paritySchema['x-runtime-invariants'] = true;
const validateConfigParity = parityAjv.compile(paritySchema);
const fixture = readJson('fixture.synthetic.json');
assert.equal(validateEnvelopeSchema(fixture), true, portableAjv.errorsText(validateEnvelopeSchema.errors));
assert.deepEqual(
  configSchema.properties.filters.properties.categories.items.enum,
  [...SUPPORTED_CATEGORIES],
);

const negativeMutations = [
  (value) => { value.revision = 2 ** 31; },
  (value) => { value.allowed_domains.push(value.allowed_domains[0]); },
  (value) => { value.allowed_domains = [...value.allowed_domains, 'https://aaa.example.invalid'].sort().reverse(); },
  (value) => { value.filters.categories = ['general_support', 'general_support']; },
  (value) => { value.filters.categories = ['nonexistent_category']; },
  (value) => { value.filters.channels = ['email']; },
  (value) => { value.filters.channels = ['text', 'phone']; },
  (value) => { value.safety.fallback_copy = 'This long fallback omits both mandatory concepts entirely.'; },
  (value) => { value.lifecycle.state = 'staged'; value.rollout.percentage = 0; },
  (value) => { value.revision = 1; },
  (value) => { value.rollback.previous_revision = 99; },
  (value) => { value.rollback.target_config_id = value.rollback.previous_config_id; },
];
for (const mutate of negativeMutations) {
  const value = structuredClone(fixture.payload);
  mutate(value);
  let runtimeAccepted = true;
  try {
    validateConfig(value);
  } catch {
    runtimeAccepted = false;
  }
  const schemaAccepted = validateConfigParity(value);
  assert.equal(schemaAccepted, runtimeAccepted, `schema/runtime disagreement for ${JSON.stringify(value)}`);
  assert.equal(runtimeAccepted, false, `negative unexpectedly accepted: ${JSON.stringify(value)}`);
}


const portableNegativeMutations = [
  (value) => { value.revision = 2 ** 31; },
  (value) => { value.allowed_domains.push(value.allowed_domains[0]); },
  (value) => { value.filters.categories = ['general_support', 'general_support']; },
  (value) => { value.filters.categories = ['nonexistent_category']; },
  (value) => { value.filters.channels = ['email']; },
  (value) => { value.safety.fallback_copy = 'This long fallback omits both mandatory concepts entirely.'; },
  (value) => { value.lifecycle.state = 'staged'; value.rollout.percentage = 0; },
  (value) => { value.revision = 1; },
  (value) => { value.rollback.target_config_id = value.rollback.previous_config_id; },
];
assert.equal(validatePortableConfig(fixture.payload), true);
for (const mutate of portableNegativeMutations) {
  const value = structuredClone(fixture.payload);
  mutate(value);
  assert.equal(validatePortableConfig(value), false, `portable schema unexpectedly accepted: ${JSON.stringify(value)}`);
}

for (const hostile of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
  const value = structuredClone(fixture.payload);
  value.revision = hostile;
  assert.equal(validatePortableConfig(value), false);
  assert.throws(() => validateConfig(value));
}
for (const attack of [
  (value) => Object.setPrototypeOf(value, { polluted: true }),
  (value) => { value.filters.categories = new Proxy([], {}); },
  (value) => { value.extra = Symbol('hostile'); },
]) {
  const value = structuredClone(fixture.payload);
  attack(value);
  assert.equal(validateConfigParity(value), false);
  assert.throws(() => validateConfig(value));
}

const api = await SwaggerParser.validate(resolve(ROOT, 'openapi.json'));
assert.equal(api.info['x-world-hotlines-status'], 'design-contract-not-deployed');
assert.match(api.servers[0].url, /\.invalid\//);
console.log('Managed widget configuration static contracts OK');
