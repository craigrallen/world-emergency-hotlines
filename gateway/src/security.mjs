import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { validateKeyRecord } from './validation.mjs';

export const KEY_PATTERN = /^weh_live_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
export function redact(value) {
  if (typeof value === 'string') return value.replace(/weh_(?:live|test)_[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/(authorization|x-api-key)\s*[:=]\s*[^\s,}]+/gi, '$1=[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [/authorization|api.?key|token|secret/i.test(k) ? k : k, /authorization|api.?key|token|secret/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
}
export function verifier(raw, pepper) { return createHmac('sha256', pepper).update(raw).digest('base64url'); }
export function safeEqual(a, b) {
  const x = Buffer.from(a || '', 'base64url'), y = Buffer.from(b || '', 'base64url');
  const padded = Buffer.alloc(Math.max(x.length, y.length, 32)); const other = Buffer.alloc(padded.length);
  x.copy(padded); y.copy(other); return timingSafeEqual(padded, other) && x.length === y.length;
}
export function createKey({ entropy = randomBytes, test = false } = {}) {
  if (entropy !== randomBytes && !test) throw new Error('deterministic entropy requires --test-only');
  const id = entropy(6).toString('hex');
  const secret = entropy(32).toString('base64url');
  return { id, raw: `weh_live_${id}_${secret}` };
}
export function authenticate(header, recordsById, pepper, mode = 'production', now = Date.now()) {
  const invalid = { ok:false, outcome:'invalid' };
  const match = typeof header === 'string' && /^Bearer ([^ ]+)$/.exec(header);
  const parsed = match && KEY_PATTERN.exec(match[1]);
  const usableMap = recordsById instanceof Map && Object.getPrototypeOf(recordsById) === Map.prototype;
  const record = parsed && usableMap ? recordsById.get(parsed[1]) : null;
  const candidate = parsed ? verifier(match[1], pepper) : verifier('invalid-placeholder', pepper);
  const selectedValid = record !== null && ['synthetic', 'production'].includes(mode) && validateKeyRecord(record, mode);
  const matches = safeEqual(candidate, selectedValid ? record.verifier : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  if (!Number.isFinite(now) || !selectedValid || !matches) return invalid;
  if (record.state !== 'active') return invalid;
  if (record.not_before && now < Date.parse(record.not_before)) return invalid;
  if (record.expires_at && now >= Date.parse(record.expires_at)) return invalid;
  return { ok:true, outcome:'authenticated', record };
}
