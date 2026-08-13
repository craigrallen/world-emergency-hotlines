import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
import { generateSubscriptionContractsForTest } from './generate-subscription-contracts.mjs';
import { ARTIFACT_CLASSES, buildEvent, canonicalBytes, EVENT_TYPES, latestRelease, MAX_BODY_BYTES, MAX_SECRET_OVERLAP_SECONDS, signature, verifySignature } from './subscription-events.mjs';
import { utf16Compare } from './dataset-diff.mjs';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONTRACT_ROOT = resolve(WEB_ROOT, 'contracts/subscriptions/v1');
const ROOT = resolve(WEB_ROOT, 'public/subscriptions/v1');
const SCHEMAS = ['common.schema.json', 'event.schema.json', 'subscription-request.schema.json', 'subscription-response.schema.json', 'error.schema.json'];
const FIXTURES = ['fixture-baseline.json', 'fixture-no-change.json', 'fixture-added.json', 'fixture-modified.json', 'fixture-country-metadata.json'];
const required = [...SCHEMAS, 'webhook-contract.json', 'openapi.json', 'README.md', ...FIXTURES];
const json = (name, root = ROOT) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));

for (const name of required) assert.ok(readdirSync(ROOT).includes(name), `missing ${name}`);
for (const name of required.filter((name) => name.endsWith('.json'))) assert.doesNotThrow(() => json(name), `invalid JSON ${name}`);

const publishedReadme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const publishedRotation = json('webhook-contract.json').secret_handling.rotation_overlap;
for (const [name, text] of [['README.md', publishedReadme], ['webhook-contract.json', publishedRotation]]) {
  assert.match(text, /activated_at\s*<=\s*now\s*<=\s*expires_at/, `${name} omits the inclusive previous-secret activation and expiry bounds`);
  assert.match(text, /finite safe(?:-| )integer/i, `${name} omits finite safe-integer rotation metadata`);
  assert.match(text, /expires_at\s*-\s*activated_at[^\n]*<=\s*86400/, `${name} omits the maximum previous-secret overlap`);
  assert.match(text, /outside that interval[^\n]*not eligible/i, `${name} does not exclude the previous secret outside its interval`);
  assert.match(text, /current secret[^\n]*remains usable[^\n]*(?:before, during, and after|interval)/i, `${name} does not preserve current-secret usability`);
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
addFormats(ajv);
for (const name of SCHEMAS) ajv.addSchema(json(name));
for (const name of SCHEMAS) assert.ok(ajv.getSchema(json(name).$id), `schema did not compile: ${name}`);
const validateEvent = ajv.getSchema(json('event.schema.json').$id);
const validateRequest = ajv.getSchema(json('subscription-request.schema.json').$id);

function assertValid(validate, instance, label) { assert.equal(validate(instance), true, `${label}: ${ajv.errorsText(validate.errors)}`); }
function assertInvalid(validate, instance, label) { assert.equal(validate(instance), false, `${label} unexpectedly validated`); }
function assertClosedSchemas(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'object') assert.equal(value.additionalProperties, false, `${path} object schema is not closed`);
  for (const [key, child] of Object.entries(value)) assertClosedSchemas(child, `${path}/${key}`);
}
for (const name of SCHEMAS) assertClosedSchemas(json(name), name);

const common = json('common.schema.json');
assert.deepEqual(common.$defs.event_type.enum, EVENT_TYPES);
assert.deepEqual(common.$defs.artifact_class.enum, ARTIFACT_CLASSES);
assert.equal(json('event.schema.json').properties.type.$ref, 'common.schema.json#/$defs/event_type');
assert.equal(json('subscription-request.schema.json').properties.filters.properties.event_types.items.$ref, 'common.schema.json#/$defs/event_type');
for (const suffix of ['country.se', 'category.mental-health', 'hotline.foo', 'query.x', 'location.se', 'user.1', 'ip.127-0-0-1', 'behavior.click', 'behaviour.click', 'unknown']) {
  assertInvalid(validateRequest, { delivery: { method: 'webhook', endpoint_uri: 'https://synthetic.example.invalid/hook' }, filters: { event_types: [`org.worldhotlines.dataset.release.${suffix}`] } }, `forbidden event type ${suffix}`);
}

const forbidden = /(^|[_-])(email|user|country|category|hotline|query|ip|location|behaviou?r)([_-]|$)/i;
function keys(value) { if (Array.isArray(value)) return value.flatMap(keys); if (!value || typeof value !== 'object') return []; return Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)]); }
for (const name of FIXTURES) {
  const fixture = json(name);
  assertValid(validateEvent, fixture, name);
  assert.ok(fixture.data.release_entry_id.startsWith('synthetic-'), `${name} release id is not reserved synthetic`);
  assert.match(fixture.time, /^2038-01-19T/);
  assert.equal(fixture.data.dataset_version, `sha256:${'f'.repeat(64)}`);
  assert.ok(!keys(fixture).some((key) => forbidden.test(key)), `${name} has forbidden privacy key`);
  assert.deepEqual(fixture.data.artifact_classes, [...fixture.data.artifact_classes].sort(utf16Compare));
  assert.equal(fixture.data.release_kind, fixture.type.slice(fixture.type.lastIndexOf('.') + 1));
  assert.equal(Object.hasOwn(fixture.data.change_summary, 'total_changes'), false, `${name} exposes redundant total_changes`);
  const release = { id: fixture.data.release_entry_id, entry_hash: fixture.data.release_entry_hash, previous_entry_hash: fixture.data.release_kind === 'baseline' ? null : `sha256:${'a'.repeat(64)}`, changes: { to_dataset_version: fixture.data.dataset_version, counts: fixture.data.change_summary } };
  assert.deepEqual(buildEvent({ release, timestamp: fixture.time, type: fixture.type, counts: fixture.data.change_summary, artifactClasses: fixture.data.artifact_classes }), fixture);
  assert.deepEqual(readFileSync(resolve(ROOT, name)), canonicalBytes(fixture));
}

const baseline = json('fixture-baseline.json');
const badTotal = { ...baseline.data.change_summary, total_changes: 1 };
assertInvalid(validateEvent, { ...baseline, data: { ...baseline.data, change_summary: badTotal } }, 'public total_changes property');
assert.throws(() => buildEvent({ release: { previous_entry_hash: null, changes: { to_dataset_version: baseline.data.dataset_version, counts: badTotal }, id: baseline.data.release_entry_id, entry_hash: baseline.data.release_entry_hash }, timestamp: baseline.time }), /registry total_changes/);
for (const timestamp of ['', '2038-01-19', '2038-02-30T00:00:00Z', '2038-01-19T03:14:07+00:00', 'not-a-date']) assert.throws(() => buildEvent({ release: latestRelease(), timestamp }), /RFC3339/);
for (const artifacts of [[], ['dataset', 'dataset'], ['bogus']]) assert.throws(() => buildEvent({ release: latestRelease(), timestamp: '2038-01-19T03:14:07Z', artifactClasses: artifacts }), /artifact classes/);
assert.throws(() => buildEvent({ release: latestRelease(), timestamp: '2038-01-19T03:14:07Z', type: EVENT_TYPES.find((type) => type.endsWith('.added')) }), /inconsistent/);
const tracked = latestRelease();
const current = buildEvent({ release: tracked, timestamp: `${tracked.date}T00:00:00.000Z` });
assert.equal(current.data.release_entry_hash, tracked.entry_hash);
assert.equal(buildEvent({ release: tracked, timestamp: '2038-01-19T03:14:07Z' }).id, current.id, 'time changed stable event id');
for (const [counts, suffix] of [
  [{ added: 2, removed: 0, modified: 0, metadata_added: 0, metadata_removed: 0, metadata_modified: 0 }, 'added'],
  [{ added: 0, removed: 0, modified: 0, metadata_added: 1, metadata_removed: 0, metadata_modified: 0 }, 'country-metadata'],
  [{ added: 0, removed: 1, modified: 0, metadata_added: 0, metadata_removed: 0, metadata_modified: 0 }, 'modified'],
  [{ added: 1, removed: 0, modified: 0, metadata_added: 1, metadata_removed: 0, metadata_modified: 0 }, 'modified'],
]) assert.ok(buildEvent({ release: { ...tracked, previous_entry_hash: 'sha256:x' }, timestamp: '2038-01-19T03:14:07Z', counts }).type.endsWith(`.${suffix}`));
const byKind = Object.fromEntries(FIXTURES.map((name) => { const event = json(name); return [event.data.release_kind, event]; }));
for (const [kind, event] of Object.entries(byKind)) {
  for (const contradictoryKind of Object.keys(byKind).filter((candidate) => candidate !== kind)) {
    const contradictory = structuredClone(event);
    contradictory.type = `org.worldhotlines.dataset.release.${contradictoryKind}`;
    contradictory.data.release_kind = contradictoryKind;
    if (new Set([kind, contradictoryKind]).size === 2 && [kind, contradictoryKind].every((candidate) => ['baseline', 'no-change'].includes(candidate))) assertValid(validateEvent, contradictory, 'zero counts use payload discriminator');
    else assertInvalid(validateEvent, contradictory, `${kind} counts labeled ${contradictoryKind}`);
  }
  const mismatchedKind = structuredClone(event); mismatchedKind.data.release_kind = kind === 'baseline' ? 'no-change' : 'baseline';
  assertInvalid(validateEvent, mismatchedKind, `${kind} type/release_kind mismatch`);
}
assertInvalid(validateEvent, { ...baseline, extra: true }, 'open event');
assertInvalid(validateEvent, { ...baseline, data: { ...baseline.data, artifact_classes: [] } }, 'empty artifacts');

const openapiPath = resolve(ROOT, 'openapi.json');
const api = await SwaggerParser.validate(openapiPath);
await SwaggerParser.dereference(openapiPath);
assert.match(api.openapi, /^3\.1\./);
assert.equal(api.info['x-world-hotlines-status'], 'design-contract');
assert.match(api.info.description, /not deployed/i);
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
for (const [path, item] of Object.entries(api.paths)) for (const [method, operation] of Object.entries(item)) if (methods.has(method)) {
  assert.equal(operation['x-world-hotlines-status'], 'design-contract', `${method.toUpperCase()} ${path} lacks design status`);
  assert.match(`${operation.summary ?? ''} ${operation.description ?? ''} ${api.info.description}`, /not deployed|propose/i, `${method.toUpperCase()} ${path} lacks not-deployed wording`);
}

// Test-only generator: fixed manifest, clean-parent/interruption behavior, and lexical symlink refusal.
const sandbox = mkdtempSync(resolve(tmpdir(), 'weh-subscriptions-'));
const sourceCopy = resolve(sandbox, 'source/v1'); mkdirSync(sourceCopy, { recursive: true });
for (const name of required.filter((name) => !name.startsWith('fixture-'))) cpSync(resolve(CONTRACT_ROOT, name), resolve(sourceCopy, name));
const cleanParent = resolve(sandbox, 'public/subscriptions'); mkdirSync(cleanParent, { recursive: true });
const output = resolve(cleanParent, 'v1');
generateSubscriptionContractsForTest({ source: sourceCopy, output, managedRoot: sandbox });
assert.deepEqual(readdirSync(output).sort(), required.sort(), 'test generator did not write exact manifest');
const outside = resolve(sandbox, 'outside'); mkdirSync(outside); const marker = resolve(outside, 'marker'); writeFileSync(marker, 'safe');
for (const phase of ['contract', 'fixture']) {
  const failureParent = resolve(sandbox, `failure-${phase}`); mkdirSync(failureParent);
  const failureOutput = resolve(failureParent, 'v1');
  assert.throws(() => generateSubscriptionContractsForTest({
    source: sourceCopy, output: failureOutput, managedRoot: sandbox,
    afterWrite: (write) => { if (write.phase === phase && write.index === 0) throw new Error(`injected ${phase} failure`); },
  }), new RegExp(`injected ${phase} failure`));
  assert.equal(existsSync(failureOutput), false, `${phase} failure stranded final output`);
  assert.equal(readFileSync(marker, 'utf8'), 'safe', `${phase} failure touched outside marker`);
  generateSubscriptionContractsForTest({ source: sourceCopy, output: failureOutput, managedRoot: sandbox });
  assert.deepEqual(readdirSync(failureOutput).sort(), required.sort(), `${phase} retry manifest differs`);
  for (const name of required) assert.deepEqual(readFileSync(resolve(failureOutput, name)), readFileSync(resolve(ROOT, name)), `${phase} retry differs for ${name}`);
}
const linkedParent = resolve(sandbox, 'linked-parent'); symlinkSync(outside, linkedParent);
assert.throws(() => generateSubscriptionContractsForTest({ source: sourceCopy, output: resolve(linkedParent, 'v1'), managedRoot: sandbox }), /symlink/);
assert.equal(readFileSync(marker, 'utf8'), 'safe'); assert.deepEqual(readdirSync(outside), ['marker']);
const sourceLink = resolve(sandbox, 'source-link'); symlinkSync(resolve(sandbox, 'source'), sourceLink);
const sourceLinkOutputParent = resolve(sandbox, 'source-link-output'); mkdirSync(sourceLinkOutputParent);
assert.throws(() => generateSubscriptionContractsForTest({ source: resolve(sourceLink, 'v1'), output: resolve(sourceLinkOutputParent, 'v1'), managedRoot: sandbox }), /symlink/);
const outputLinkParent = resolve(sandbox, 'output-link-parent'); mkdirSync(outputLinkParent); symlinkSync(outside, resolve(outputLinkParent, 'v1'));
assert.throws(() => generateSubscriptionContractsForTest({ source: sourceCopy, output: resolve(outputLinkParent, 'v1'), managedRoot: sandbox }), /symlink/);
for (const entries of [['v1'], ['v1.tmp-orphan'], ['v1.old-orphan'], ['v1.old-one', 'v1.old-two']]) {
  const parent = resolve(sandbox, `interrupted-${entries.length}-${entries[0].replaceAll('.', '-')}`); mkdirSync(parent);
  for (const entry of entries) mkdirSync(resolve(parent, entry));
  assert.throws(() => generateSubscriptionContractsForTest({ source: sourceCopy, output: resolve(parent, 'v1'), managedRoot: sandbox }), /must not already exist|clean and empty/);
  assert.equal(readFileSync(marker, 'utf8'), 'safe');
}

export function assertLoopbackTarget(target) {
  const url = new URL(target); if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('simulator permits explicit loopback literals only'); return url;
}
for (const bad of ['https://example.com', 'http://localhost', 'http://10.0.0.1', 'http://169.254.169.254', 'http://[::ffff:127.0.0.1]']) assert.throws(() => assertLoopbackTarget(bad));
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PREVIOUS = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
const unixTime = 2147483647;
const body = canonicalBytes(baseline);
const signed = signature(String(unixTime), body, SECRET);
assert.throws(() => signature(String(unixTime), body, 'synthetic-test-secret'), /32 random bytes/);
const currentSecrets = { current: { value: SECRET } };
assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: signed, secrets: currentSecrets, now: unixTime }).ok, true);
const previousSigned = signature(String(unixTime), body, PREVIOUS);
const previousAtBoundary = { current: { value: SECRET }, previous: { value: PREVIOUS, activated_at: unixTime - MAX_SECRET_OVERLAP_SECONDS, expires_at: unixTime } };
assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: previousSigned, secrets: previousAtBoundary, now: unixTime }).ok, true);
assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: previousSigned, secrets: previousAtBoundary, now: unixTime + 1 }).reason, 'signature');
const activationWindow = { current: { value: SECRET }, previous: { value: PREVIOUS, activated_at: unixTime, expires_at: unixTime + 10 } };
assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: previousSigned, secrets: activationWindow, now: unixTime - 1 }).reason, 'signature', 'previous authenticated before activation');
assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: previousSigned, secrets: activationWindow, now: unixTime }).ok, true, 'previous rejected at activation boundary');
assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: previousSigned, secrets: activationWindow, now: unixTime + 10 }).ok, true, 'previous rejected at expiry boundary');
assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: previousSigned, secrets: activationWindow, now: unixTime + 11 }).reason, 'signature', 'previous authenticated after expiry');
assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: signed, secrets: activationWindow, now: unixTime - 1 }).ok, true, 'valid current unusable before previous activation');
assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: signed, secrets: activationWindow, now: unixTime + 11 }).ok, true, 'valid current unusable after previous expiry');
for (const previous of [
  { value: PREVIOUS }, { value: PREVIOUS, activated_at: unixTime - 1 }, { value: PREVIOUS, expires_at: unixTime },
  { value: PREVIOUS, activated_at: NaN, expires_at: unixTime }, { value: PREVIOUS, activated_at: Infinity, expires_at: unixTime },
  { value: PREVIOUS, activated_at: String(unixTime - 1), expires_at: unixTime }, { value: PREVIOUS, activated_at: unixTime - 1, expires_at: NaN },
  { value: PREVIOUS, activated_at: unixTime - 1, expires_at: Infinity }, { value: PREVIOUS, activated_at: unixTime - 1, expires_at: String(unixTime) },
  { value: PREVIOUS, activated_at: unixTime, expires_at: unixTime - 1 }, { value: PREVIOUS, activated_at: unixTime - MAX_SECRET_OVERLAP_SECONDS - 1, expires_at: unixTime },
  { value: 'malformed', activated_at: unixTime - 1, expires_at: unixTime }, { value: PREVIOUS, activated_at: unixTime - 1, expires_at: unixTime, extra: true },
]) assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: previousSigned, secrets: { current: { value: SECRET }, previous }, now: unixTime }).reason, 'secret-config');
for (const current of [{ value: SECRET, expires_at: unixTime }, { value: 'malformed' }, {}, SECRET, null, [], Object.assign(Object.create(null), { value: SECRET })]) assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: signed, secrets: { current }, now: unixTime }).reason, 'secret-config');
for (const secrets of [
  null, [], { current: { value: SECRET }, extra: true }, { current: { value: SECRET }, previous: null },
  Object.assign(Object.create(null), { current: { value: SECRET } }),
]) assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: signed, secrets, now: unixTime }).reason, 'secret-config');
assert.equal(verifySignature({ timestamp: unixTime, rawBody: body, signatureHeader: previousSigned, secrets: { current: { value: 'malformed' }, previous: previousAtBoundary.previous }, now: unixTime }).reason, 'secret-config', 'malformed current fell through to previous');
const cli = (extraEnv) => spawnSync(process.execPath, ['scripts/subscription-sign.mjs', 'verify', resolve(ROOT, 'fixture-baseline.json'), String(unixTime), previousSigned], { cwd: WEB_ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, WEH_SYNTHETIC_WEBHOOK_SECRET: SECRET, WEH_SYNTHETIC_WEBHOOK_PREVIOUS_SECRET: PREVIOUS, WEH_SYNTHETIC_NOW: String(unixTime), ...extraEnv } });
for (const metadata of [
  {}, { WEH_SYNTHETIC_WEBHOOK_PREVIOUS_ACTIVATED_AT: String(unixTime - 1) }, { WEH_SYNTHETIC_WEBHOOK_PREVIOUS_EXPIRES_AT: String(unixTime) },
  { WEH_SYNTHETIC_WEBHOOK_PREVIOUS_ACTIVATED_AT: 'NaN', WEH_SYNTHETIC_WEBHOOK_PREVIOUS_EXPIRES_AT: String(unixTime) },
  { WEH_SYNTHETIC_WEBHOOK_PREVIOUS_ACTIVATED_AT: 'Infinity', WEH_SYNTHETIC_WEBHOOK_PREVIOUS_EXPIRES_AT: String(unixTime) },
  { WEH_SYNTHETIC_WEBHOOK_PREVIOUS_ACTIVATED_AT: String(unixTime - 1), WEH_SYNTHETIC_WEBHOOK_PREVIOUS_EXPIRES_AT: '1.5' },
]) assert.equal(cli(metadata).status, 2, 'CLI accepted missing or malformed previous-secret metadata');
assert.equal(cli({ WEH_SYNTHETIC_WEBHOOK_PREVIOUS_ACTIVATED_AT: String(unixTime - MAX_SECRET_OVERLAP_SECONDS), WEH_SYNTHETIC_WEBHOOK_PREVIOUS_EXPIRES_AT: String(unixTime) }).status, 0, 'CLI rejected valid boundary overlap');
const cliVerified = cli({ WEH_SYNTHETIC_WEBHOOK_PREVIOUS_ACTIVATED_AT: String(unixTime - 1), WEH_SYNTHETIC_WEBHOOK_PREVIOUS_EXPIRES_AT: String(unixTime) });
assert.equal(cliVerified.stdout.trim(), 'verified');
assert.ok(!`${cliVerified.stdout}${cliVerified.stderr}`.includes(SECRET) && !`${cliVerified.stdout}${cliVerified.stderr}`.includes(PREVIOUS), 'CLI exposed secret material');
const cliMalformedCurrent = cli({ WEH_SYNTHETIC_WEBHOOK_SECRET: 'malformed', WEH_SYNTHETIC_WEBHOOK_PREVIOUS_ACTIVATED_AT: String(unixTime - 1), WEH_SYNTHETIC_WEBHOOK_PREVIOUS_EXPIRES_AT: String(unixTime) });
assert.equal(cliMalformedCurrent.status, 1); assert.equal(cliMalformedCurrent.stdout.trim(), 'rejected:secret-config');
assert.ok(!`${cliMalformedCurrent.stdout}${cliMalformedCurrent.stderr}`.includes(PREVIOUS), 'CLI exposed previous secret material on rejection');

function oneHeader(request, name) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index].toLowerCase() === name) values.push(request.rawHeaders[index + 1]);
  return values.length === 1 ? values[0] : null;
}
const seen = new Set(); let hits = 0;
const server = createServer((request, response) => {
  hits++;
  if (request.url === '/redirect') return response.writeHead(302, { location: 'http://169.254.169.254/latest' }).end();
  if (request.url === '/slow') return setTimeout(() => response.writeHead(204).end(), 100);
  if (request.url?.startsWith('/status/')) return response.writeHead(Number(request.url.slice(8))).end();
  if (request.method !== 'POST') return response.writeHead(405).end();
  const critical = ['content-type', 'world-hotlines-timestamp', 'world-hotlines-signature', 'world-hotlines-event-id', 'world-hotlines-delivery-id', 'idempotency-key'];
  const headers = Object.fromEntries(critical.map((name) => [name, oneHeader(request, name)]));
  if (Object.values(headers).some((value) => value == null) || headers['content-type'] !== 'application/json') return response.writeHead(400).end();
  const chunks = []; let size = 0; let ended = false;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES && !ended) { ended = true; request.pause(); response.writeHead(413, { connection: 'close' }).end(() => request.destroy()); return; }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (ended) return;
    const raw = Buffer.concat(chunks);
    const verified = verifySignature({ timestamp: headers['world-hotlines-timestamp'], rawBody: raw, signatureHeader: headers['world-hotlines-signature'], secrets: currentSecrets, now: unixTime });
    let event; try { event = JSON.parse(raw); } catch { return response.writeHead(400).end(); }
    if (!verified.ok || !validateEvent(event) || headers['world-hotlines-event-id'] !== event.id || headers['idempotency-key'] !== event.id || headers['world-hotlines-delivery-id'] === event.id || !/^del_[A-Za-z0-9_-]+$/.test(headers['world-hotlines-delivery-id'])) return response.writeHead(400).end();
    const duplicate = seen.has(event.id); seen.add(event.id); response.writeHead(duplicate ? 208 : 204).end();
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
async function deliver({ payload = body, headers = {}, delivery = 'del_1', target = '/delivery' } = {}) {
  return fetch(assertLoopbackTarget(`${base}${target}`), { method: 'POST', redirect: 'manual', body: payload, headers: { 'content-type': 'application/json', 'world-hotlines-timestamp': String(unixTime), 'world-hotlines-signature': signature(String(unixTime), payload, SECRET), 'world-hotlines-event-id': baseline.id, 'world-hotlines-delivery-id': delivery, 'idempotency-key': baseline.id, ...headers } });
}
try {
  assert.equal((await deliver()).status, 204); assert.equal((await deliver({ delivery: 'del_2' })).status, 208);
  for (const options of [
    { payload: Buffer.from('{') }, { headers: { 'content-type': 'text/plain' } }, { headers: { 'world-hotlines-timestamp': 'bad' } },
    { headers: { 'world-hotlines-timestamp': String(unixTime - 301) } }, { headers: { 'world-hotlines-timestamp': String(unixTime + 301) } },
    { headers: { 'world-hotlines-signature': 'v2=' + '0'.repeat(64) } }, { headers: { 'world-hotlines-signature': 'v1=' + '0'.repeat(64) } },
    { headers: { 'world-hotlines-event-id': 'evt_' + '0'.repeat(64) } }, { headers: { 'idempotency-key': 'evt_' + '0'.repeat(64) } },
    { delivery: baseline.id }, { headers: { 'world-hotlines-delivery-id': 'bad' } },
  ]) assert.equal((await deliver(options)).status, 400);
  const rawBaseHeaders = ['content-type', 'application/json', 'world-hotlines-timestamp', String(unixTime), 'world-hotlines-signature', signed, 'world-hotlines-event-id', baseline.id, 'world-hotlines-delivery-id', 'del_raw', 'idempotency-key', baseline.id];
  const rawStatus = (headers) => new Promise((ok, fail) => { const req = httpRequest(`${base}/delivery`, { method: 'POST', headers }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); }); req.on('error', fail); req.end(body); });
  for (const name of ['content-type', 'world-hotlines-timestamp', 'world-hotlines-signature', 'world-hotlines-event-id', 'world-hotlines-delivery-id', 'idempotency-key']) {
    const omitted = rawBaseHeaders.flatMap((value, index) => index % 2 === 0 && value === name ? [] : index % 2 === 1 && rawBaseHeaders[index - 1] === name ? [] : [value]);
    assert.equal(await rawStatus(omitted), 400, `missing ${name} accepted`);
    assert.equal(await rawStatus([...rawBaseHeaders, name, rawBaseHeaders[rawBaseHeaders.indexOf(name) + 1]]), 400, `duplicate ${name} accepted`);
  }
  assert.equal((await deliver({ payload: Buffer.alloc(MAX_BODY_BYTES + 1) })).status, 413);
  const redirect = await fetch(`${base}/redirect`, { redirect: 'manual' }); assert.equal(redirect.status, 302);

  const RETRY_DELAYS = [0, 30, 120, 600, 3600, 21600];
  const classify = (status) => status >= 200 && status < 300 ? 'success' : status === 410 ? 'disable' : [400, 401, 403, 404, 405, 409, 413, 415, 422].includes(status) ? 'permanent' : 'retry';
  async function retryDelivery(attempt, schedule = async () => {}) { const observed = []; for (let index = 0; index < RETRY_DELAYS.length; index++) { await schedule(RETRY_DELAYS[index], index); let result; try { result = await attempt(index); } catch (error) { result = { status: 0, error: error.name }; } observed.push(result); if (classify(result.status) !== 'retry') return { outcome: classify(result.status), observed }; } return { outcome: 'exhausted', observed }; }
  assert.equal((await retryDelivery(async () => ({ status: 410 }))).outcome, 'disable');
  assert.equal((await retryDelivery(async () => ({ status: 422 }))).outcome, 'permanent');
  const schedule = []; const exhausted = await retryDelivery(async () => ({ status: 503 }), async (delay) => schedule.push(delay)); assert.equal(exhausted.outcome, 'exhausted'); assert.deepEqual(schedule, RETRY_DELAYS);
  let retryHits = 0; assert.equal((await retryDelivery(async () => ({ status: ++retryHits < 3 ? 429 : 204 }))).observed.length, 3);
  const timedOut = await retryDelivery(async () => { const controller = new AbortController(); setTimeout(() => controller.abort(), 10); return fetch(`${base}/slow`, { signal: controller.signal }); });
  assert.equal(timedOut.outcome, 'exhausted'); assert.equal(timedOut.observed.length, RETRY_DELAYS.length); assert.ok(timedOut.observed.every((item) => item.error === 'AbortError'));
} finally { await new Promise((ok) => server.close(ok)); }

console.log('Subscription contracts OK: Draft 2020-12 schemas/formats/fixtures, OpenAPI 3.1 refs, privacy and event semantics, safe generator, bounded receiver, strict HMAC rotation, loopback-only deterministic retries');
