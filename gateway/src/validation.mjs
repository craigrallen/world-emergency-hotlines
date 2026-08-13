import { Buffer } from 'node:buffer';

export const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
export const KEY_ID = /^[a-z0-9]{12}$/;
export const VERIFIER = /^[A-Za-z0-9_-]{43}$/;
export const PERMISSIONS = Object.freeze(['manifest', 'records', 'resolver']);
export const QUOTA_LIMITS = Object.freeze({ maxRate: 1000, maxBurst: 10000, maxRefillSeconds: 86400 });

export function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
export function exactObject(value, keys, required = keys) {
  if (!plain(value)) return false;
  const own = Object.keys(value);
  return own.every((key) => keys.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}
export function canonicalDate(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
}
export function validQuota(value) {
  return exactObject(value, ['rate', 'burst']) && Number.isFinite(value.rate) && value.rate > 0 && value.rate <= QUOTA_LIMITS.maxRate &&
    Number.isInteger(value.burst) && value.burst >= 1 && value.burst <= QUOTA_LIMITS.maxBurst &&
    // Division is deliberately avoided at the boundary so binary rounding cannot
    // admit a policy whose whole-bucket reset header exceeds the wire contract.
    value.burst <= value.rate * QUOTA_LIMITS.maxRefillSeconds;
}
export function validVerifier(value) {
  if (typeof value !== 'string' || !VERIFIER.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value;
}
export function validateKeyRecord(record, mode) {
  const fields = ['id','verifier','state','not_before','expires_at','api_majors','permissions','quota','synthetic'];
  if (!exactObject(record, fields) || !KEY_ID.test(record.id) || !validVerifier(record.verifier) || !['active','revoked','expired'].includes(record.state)) return false;
  if (!canonicalDate(record.not_before) || !canonicalDate(record.expires_at)) return false;
  if (record.not_before !== null && record.expires_at !== null && Date.parse(record.not_before) >= Date.parse(record.expires_at)) return false;
  if (!Array.isArray(record.api_majors) || record.api_majors.length < 1 || record.api_majors.length > 1 || record.api_majors[0] !== 1) return false;
  if (!Array.isArray(record.permissions) || record.permissions.length < 1 || record.permissions.length > PERMISSIONS.length || new Set(record.permissions).size !== record.permissions.length || !record.permissions.every((p) => PERMISSIONS.includes(p))) return false;
  if (!validQuota(record.quota) || typeof record.synthetic !== 'boolean' || (mode === 'production' && record.synthetic)) return false;
  return true;
}

export function validateOrigin(value, mode) {
  if (typeof value !== 'string') return false;
  let url; try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || value.endsWith('/')) return false;
  if (url.hostname.includes('*') || (mode === 'production' && url.hostname.endsWith('.invalid'))) return false;
  return url.origin === value;
}
