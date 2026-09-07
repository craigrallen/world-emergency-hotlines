import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebhookError, computeSignature, constructEvent, parseSignatureHeader, signTestPayload, verifyWebhookSignature } from '../src/webhook.mjs';

const secret = `whsec_${'b'.repeat(32)}`;
const fixture = readFileSync(new URL('../fixtures/events/checkout.session.completed.synthetic.json', import.meta.url));
const now = 2145916800;

test('signature header parsing accepts Stripe shapes and rejects malformed input', () => {
  const sig = 'a'.repeat(64);
  assert.deepEqual(parseSignatureHeader(`t=123,v1=${sig}`), { timestamp: 123, signatures: [sig] });
  assert.deepEqual(parseSignatureHeader(`t=123,v1=${sig},v0=${'b'.repeat(64)},v1=${'c'.repeat(64)}`), { timestamp: 123, signatures: [sig, 'c'.repeat(64)] });
  for (const header of [undefined, '', 'v1=abc', `t=1`, `t=1,v1=${'A'.repeat(64)}`, `t=1,v1=${'a'.repeat(63)}`, `t=x,v1=${sig}`, `t=1,t=2,v1=${sig}`, `t=1,junk=1,v1=${sig}`, `t=1,v1=${sig},`, 'x'.repeat(5000)]) {
    assert.equal(parseSignatureHeader(header), null, String(header).slice(0, 30));
  }
});

test('sign and verify round trip; tampering, replay, and clock drift fail closed', () => {
  const header = signTestPayload({ rawBody: fixture, secret, timestamp: now });
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.deepEqual(verifyWebhookSignature({ rawBody: fixture, header, secret, now }), { ok: true, timestamp: now });
  assert.equal(verifyWebhookSignature({ rawBody: fixture, header, secret, now: now + 300 }).ok, true);
  assert.equal(verifyWebhookSignature({ rawBody: fixture, header, secret, now: now + 301 }).reason, 'timestamp_outside_tolerance');
  assert.equal(verifyWebhookSignature({ rawBody: fixture, header, secret, now: now - 301 }).reason, 'timestamp_outside_tolerance');
  assert.equal(verifyWebhookSignature({ rawBody: Buffer.concat([fixture, Buffer.from(' ')]), header, secret, now }).reason, 'signature_mismatch');
  assert.equal(verifyWebhookSignature({ rawBody: fixture, header, secret: `whsec_${'c'.repeat(32)}`, now }).reason, 'signature_mismatch');
  assert.equal(verifyWebhookSignature({ rawBody: fixture.toString(), header, secret, now }).reason, 'body_not_buffer');
  assert.equal(verifyWebhookSignature({ rawBody: fixture, header, secret: '', now }).reason, 'secret_missing');
  assert.equal(verifyWebhookSignature({ rawBody: fixture, header, secret, now: 1.5 }).reason, 'clock_invalid');
  assert.equal(verifyWebhookSignature({ rawBody: fixture, header, secret, now, toleranceSeconds: -1 }).reason, 'tolerance_invalid');
  const multi = `t=${now},v1=${'0'.repeat(64)},v1=${computeSignature(secret, now, fixture)}`;
  assert.equal(verifyWebhookSignature({ rawBody: fixture, header: multi, secret, now }).ok, true);
});

test('constructEvent enforces the closed event shape', () => {
  const event = constructEvent({ rawBody: fixture, header: signTestPayload({ rawBody: fixture, secret, timestamp: now }), secret, now });
  assert.equal(event.type, 'checkout.session.completed');
  assert.equal(event.data.object.id, 'cs_test_synthetic00000001');
  const sign = (body) => ({ rawBody: Buffer.from(body), header: signTestPayload({ rawBody: Buffer.from(body), secret, timestamp: now }), secret, now });
  const base = JSON.parse(fixture);
  const reasons = [
    ['{not json', 'body_not_json'],
    [JSON.stringify([]), 'event_shape_invalid'],
    [JSON.stringify({ ...base, object: 'charge' }), 'event_shape_invalid'],
    [JSON.stringify({ ...base, id: 'ch_synthetic00000001' }), 'event_shape_invalid'],
    [JSON.stringify({ ...base, type: 'Checkout' }), 'event_type_invalid'],
    [JSON.stringify({ ...base, livemode: 'false' }), 'event_shape_invalid'],
    [JSON.stringify({ ...base, created: -1 }), 'event_shape_invalid'],
    [JSON.stringify({ ...base, data: {} }), 'event_data_invalid'],
    [JSON.stringify({ ...base, data: { object: [] } }), 'event_data_invalid'],
  ];
  for (const [body, reason] of reasons) assert.throws(() => constructEvent(sign(body)), (error) => error instanceof WebhookError && error.reason === reason, reason);
  assert.throws(() => constructEvent({ rawBody: fixture, header: 'nope', secret, now }), (error) => error.reason === 'header_malformed');
});
