// Stripe webhook signature verification (the documented `Stripe-Signature`
// scheme): HMAC-SHA256 over `${timestamp}.${rawBody}` with the endpoint's
// signing secret, compared in constant time, with a replay tolerance window.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { plain } from './validation.mjs';

export const DEFAULT_TOLERANCE_SECONDS = 300;
export const EVENT_ID = /^evt_[A-Za-z0-9]{8,}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export class WebhookError extends Error {
  constructor(reason) {
    super(`webhook rejected: ${reason}`);
    this.name = 'WebhookError';
    this.reason = reason;
  }
}

export function parseSignatureHeader(header) {
  if (typeof header !== 'string' || header.length === 0 || header.length > 4096) return null;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'v1') {
      if (!HEX_64.test(value)) return null;
      signatures.push(value);
    } else if (!/^v\d+$/.test(key)) {
      return null;
    }
  }
  if (timestamp === null || signatures.length === 0 || signatures.length > 16) return null;
  return { timestamp, signatures };
}

export function computeSignature(secret, timestamp, rawBody) {
  if (typeof secret !== 'string' || secret.length === 0) throw new TypeError('secret required');
  if (!Number.isInteger(timestamp) || timestamp < 0) throw new TypeError('timestamp must be a non-negative integer');
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

/** Test/CLI helper producing a header Stripe's verifier would accept. */
export function signTestPayload({ rawBody, secret, timestamp }) {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

export function verifyWebhookSignature({ rawBody, header, secret, now, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS }) {
  if (!Buffer.isBuffer(rawBody)) return { ok: false, reason: 'body_not_buffer' };
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'secret_missing' };
  if (!Number.isInteger(now) || now < 0) return { ok: false, reason: 'clock_invalid' };
  if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 0 || toleranceSeconds > 86400) return { ok: false, reason: 'tolerance_invalid' };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'header_malformed' };
  if (Math.abs(now - parsed.timestamp) > toleranceSeconds) return { ok: false, reason: 'timestamp_outside_tolerance' };
  const expected = Buffer.from(computeSignature(secret, parsed.timestamp, rawBody), 'hex');
  let matched = false;
  for (const candidate of parsed.signatures) {
    const bytes = Buffer.from(candidate, 'hex');
    if (bytes.length === expected.length && timingSafeEqual(bytes, expected)) matched = true;
  }
  return matched ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: 'signature_mismatch' };
}

/** Verify and parse an event, enforcing the closed shape the dispatcher relies on. */
export function constructEvent({ rawBody, header, secret, now, toleranceSeconds }) {
  const verified = verifyWebhookSignature({ rawBody, header, secret, now, toleranceSeconds });
  if (!verified.ok) throw new WebhookError(verified.reason);
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookError('body_not_json'); }
  if (!plain(event) || event.object !== 'event' || typeof event.id !== 'string' || !EVENT_ID.test(event.id)) throw new WebhookError('event_shape_invalid');
  if (typeof event.type !== 'string' || !/^[a-z_]+(?:\.[a-z_]+)+$/.test(event.type) || event.type.length > 128) throw new WebhookError('event_type_invalid');
  if (typeof event.livemode !== 'boolean' || !Number.isInteger(event.created) || event.created < 0) throw new WebhookError('event_shape_invalid');
  if (!plain(event.data) || !plain(event.data.object)) throw new WebhookError('event_data_invalid');
  return event;
}
