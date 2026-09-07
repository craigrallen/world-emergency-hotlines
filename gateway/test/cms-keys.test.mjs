import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// The fake CMS runs inside this test process, so the CLI must be spawned
// asynchronously: a blocking spawn would stop the server from answering it.
const run = async (env) => { try { const { stdout, stderr } = await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../src/cli.mjs'), 'sync-keys'], { encoding: 'utf8', env: { ...process.env, ...env } }); return { status: 0, stdout, stderr }; } catch (error) { return { status: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; } };
import { CmsKeysError, KEY_RECORDS_SCHEMA, fetchKeyRecords, syncKeysIntoConfig, validCmsUrl, validateKeyRecordsDocument } from '../src/cms-keys.mjs';
import { createKey, verifier, authenticate } from '../src/security.mjs';

const pepper = 'synthetic-test-pepper-with-32-chars';
const API_KEY = 'service-api-key-synthetic-0001';
const record = (raw, id, extra = {}) => ({ id, verifier: verifier(raw, pepper), state: 'active', not_before: null, expires_at: null, api_majors: [1], permissions: ['manifest', 'records', 'resolver'], quota: { rate: 10, burst: 20 }, synthetic: false, ...extra });

function fakeCms(handler) {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `users API-Key ${API_KEY}`) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"errors":[{"message":"Unauthorized"}]}'); return; }
    const [status, body] = handler(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/cms/api`, close: () => new Promise((done) => server.close(done)) })));
}

test('URL validation admits https and private/loopback http only', () => {
  for (const ok of ['https://cms.example.org/cms/api', 'http://localhost:3000/cms/api', 'http://cms.railway.internal:3000/cms/api']) assert.equal(validCmsUrl(ok), true, ok);
  for (const bad of ['http://cms.example.org/cms/api', 'https://cms.example.org/cms/api/', 'https://u:p@cms.example.org', 'https://cms.example.org?x=1', '', null]) assert.equal(validCmsUrl(bad), false, String(bad));
});

test('document validation is closed: schema, mode, records, duplicate ids, synthetic in production', () => {
  const key = createKey(), other = createKey();
  const good = { schema: KEY_RECORDS_SCHEMA, mode: 'production', keys: [record(key.raw, key.id), record(other.raw, other.id, { state: 'revoked' })] };
  const records = validateKeyRecordsDocument(good);
  assert.equal(records.length, 2);
  assert.ok(Object.isFrozen(records) && Object.isFrozen(records[0]) && Object.isFrozen(records[0].quota));
  for (const [bad, reason] of [
    [null, 'document_shape_invalid'], [{ ...good, schema: 'other' }, 'document_shape_invalid'], [{ ...good, mode: 'synthetic' }, 'document_shape_invalid'], [{ ...good, keys: {} }, 'document_shape_invalid'],
    [{ ...good, keys: [record(key.raw, key.id), record(key.raw, key.id)] }, 'duplicate_id'],
    [{ ...good, keys: [record(key.raw, key.id, { synthetic: true })] }, 'record_invalid'],
    [{ ...good, keys: [{ ...record(key.raw, key.id), raw_key: key.raw }] }, 'record_invalid'],
    [{ ...good, keys: [record(key.raw, 'BAD') ] }, 'record_invalid'],
  ]) assert.throws(() => validateKeyRecordsDocument(bad), (error) => error instanceof CmsKeysError && error.reason === reason, reason);
  assert.throws(() => validateKeyRecordsDocument(good, 'nope'), (error) => error.reason === 'mode_invalid');
  const synthetic = validateKeyRecordsDocument({ schema: KEY_RECORDS_SCHEMA, mode: 'synthetic', keys: [record(key.raw, key.id, { synthetic: true })] }, 'synthetic');
  assert.equal(synthetic[0].synthetic, true);
});

test('fetchKeyRecords authenticates with the service API key and the records authenticate real keys', async () => {
  const key = createKey();
  const cms = await fakeCms((req) => {
    assert.equal(new URL(req.url, 'http://x').pathname, '/cms/api/gateway/keys');
    return [200, { schema: KEY_RECORDS_SCHEMA, mode: 'production', keys: [record(key.raw, key.id)] }];
  });
  try {
    const records = await fetchKeyRecords({ url: cms.url, apiKey: API_KEY });
    const byId = new Map(records.map((item) => [item.id, item]));
    assert.equal(authenticate(`Bearer ${key.raw}`, byId, pepper, 'production', Date.now()).ok, true);
    assert.equal(authenticate(`Bearer ${createKey().raw}`, byId, pepper, 'production', Date.now()).ok, false);
    await assert.rejects(fetchKeyRecords({ url: cms.url, apiKey: 'wrong-api-key-synthetic-0002' }), (error) => error.reason === 'unauthorized' && error.status === 401);
  } finally { await cms.close(); }
  for (const [options, reason] of [[{ url: 'http://public.example.org/cms/api', apiKey: API_KEY }, 'url_invalid'], [{ url: 'http://localhost:1/cms/api', apiKey: 'short' }, 'api_key_invalid'], [{ url: 'http://localhost:1/cms/api', apiKey: API_KEY, fetchImpl: 1 }, 'fetch_invalid'], [{ url: 'http://localhost:1/cms/api', apiKey: API_KEY, timeoutMs: 5 }, 'timeout_invalid']]) {
    await assert.rejects(fetchKeyRecords(options), (error) => error instanceof CmsKeysError && error.reason === reason, reason);
  }
  await assert.rejects(fetchKeyRecords({ url: 'http://localhost:1/cms/api', apiKey: API_KEY, fetchImpl: async () => { throw new Error('refused'); } }), (error) => error.reason === 'network_error');
  await assert.rejects(fetchKeyRecords({ url: 'http://localhost:1/cms/api', apiKey: API_KEY, fetchImpl: async () => new Response('not json', { status: 200 }) }), (error) => error.reason === 'body_not_json');
  await assert.rejects(fetchKeyRecords({ url: 'http://localhost:1/cms/api', apiKey: API_KEY, fetchImpl: async () => new Response('{}', { status: 500 }) }), (error) => error.reason === 'request_failed' && error.status === 500);
  await assert.rejects(fetchKeyRecords({ url: 'http://localhost:1/cms/api', apiKey: API_KEY, timeoutMs: 100, fetchImpl: (_i, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) }), (error) => error.reason === 'timeout');
});

test('sync-keys rewrites only the keys array atomically and the CLI prints counts, never secrets', async () => {
  const key = createKey(), revoked = createKey();
  const cms = await fakeCms(() => [200, { schema: KEY_RECORDS_SCHEMA, mode: 'production', keys: [record(key.raw, key.id), record(revoked.raw, revoked.id, { state: 'revoked' })] }]);
  const dir = mkdtempSync(resolve(tmpdir(), 'weh-gateway-keys-'));
  const configPath = resolve(dir, 'gateway.json');
  writeFileSync(configPath, JSON.stringify({ host: '0.0.0.0', port: 8082, mode: 'production', origins: [], keys: [{ id: 'stalekey00001' }] }));
  try {
    const summary = await syncKeysIntoConfig({ configPath, url: cms.url, apiKey: API_KEY });
    assert.deepEqual(summary, { previous_keys: 1, keys: 2, states: { active: 1, revoked: 1, expired: 0 } });
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.host, '0.0.0.0');
    assert.deepEqual(written.keys.map((item) => item.id).sort(), [key.id, revoked.id].sort());
    assert.ok(!JSON.stringify(written).includes(key.raw));
    const cli = await run({ GATEWAY_CONFIG: configPath, GATEWAY_CMS_URL: cms.url, GATEWAY_CMS_API_KEY: API_KEY });
    assert.equal(cli.status, 0, cli.stderr);
    const line = JSON.parse(cli.stdout.trim());
    assert.equal(line.event, 'gateway_keys_synced');
    assert.equal(line.keys, 2);
    assert.equal(cli.stdout.includes(API_KEY), false);
    assert.equal(cli.stdout.includes(key.id), false);
    const denied = await run({ GATEWAY_CONFIG: configPath, GATEWAY_CMS_URL: cms.url, GATEWAY_CMS_API_KEY: 'wrong-api-key-synthetic-0002' });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /unauthorized/);
    assert.equal(denied.stderr.includes('wrong-api-key'), false);
  } finally {
    await cms.close();
    rmSync(dir, { recursive: true, force: true });
  }
  await assert.rejects(syncKeysIntoConfig({ configPath: resolve(dir, 'missing.json'), url: 'http://localhost:1/cms/api', apiKey: API_KEY }), (error) => error.reason === 'config_unreadable');
  // An authenticated empty snapshot clears the keys instead of leaving stale ones accepted.
  const empty = await fakeCms(() => [200, { schema: KEY_RECORDS_SCHEMA, mode: 'production', keys: [] }]);
  const dir2 = mkdtempSync(resolve(tmpdir(), 'weh-gateway-keys-'));
  const path2 = resolve(dir2, 'gateway.json');
  writeFileSync(path2, JSON.stringify({ keys: [{ id: 'stalekey00001' }] }));
  try {
    assert.deepEqual(await syncKeysIntoConfig({ configPath: path2, url: empty.url, apiKey: API_KEY }), { previous_keys: 1, keys: 0, states: { active: 0, revoked: 0, expired: 0 } });
    assert.deepEqual(JSON.parse(readFileSync(path2, 'utf8')).keys, []);
  } finally { await empty.close(); rmSync(dir2, { recursive: true, force: true }); }
});
