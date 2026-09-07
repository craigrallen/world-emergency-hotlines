// Managed API key records sourced from the Payload CMS (`cms/`).
//
// The CMS issues gateway keys to account holders with an active entitlement and
// stores only the HMAC verifier, never the raw key. `GET {cmsUrl}/gateway/keys`
// (service API key required) returns those records in the exact key-record
// contract shape, and this module validates every record with the same closed
// validator the gateway uses at startup before the records can reach a config.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { plain, validateKeyRecord } from './validation.mjs';

export const KEY_RECORDS_SCHEMA = 'gateway-key-records/v1';
export const CMS_API_KEY = /^[A-Za-z0-9_-]{16,256}$/;
export const DEFAULT_TIMEOUT_MS = 10000;
const MAX_KEYS = 10000;

export class CmsKeysError extends Error {
  constructor(reason, status = null) {
    super(`cms key sync ${reason}${status === null ? '' : ` (status ${status})`}`);
    this.name = 'CmsKeysError';
    this.reason = reason;
    this.status = status;
  }
}

/** CMS API base URL: https anywhere, http only on loopback or private-network hosts. */
export function validCmsUrl(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512 || value.endsWith('/') || /\s/.test(value)) return false;
  // Dot segments are refused on the raw string because URL parsing would normalise them away.
  if (value.replace(/^[a-z]+:\/\/[^/]*/i, '').split('/').some((segment) => segment === '.' || segment === '..')) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  if (!/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/.test(url.pathname)) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.localhost');
}

/** Validate a key-records document against the closed contract; returns frozen records. */
export function validateKeyRecordsDocument(document, mode = 'production') {
  if (!['synthetic', 'production'].includes(mode)) throw new CmsKeysError('mode_invalid');
  if (!plain(document) || document.schema !== KEY_RECORDS_SCHEMA || document.mode !== mode || !Array.isArray(document.keys)) throw new CmsKeysError('document_shape_invalid');
  if (document.keys.length > MAX_KEYS) throw new CmsKeysError('too_many_keys');
  const ids = new Set();
  const records = document.keys.map((record) => {
    if (!validateKeyRecord(record, mode)) throw new CmsKeysError('record_invalid');
    if (ids.has(record.id)) throw new CmsKeysError('duplicate_id');
    ids.add(record.id);
    return Object.freeze({ ...record, api_majors: Object.freeze([...record.api_majors]), permissions: Object.freeze([...record.permissions]), quota: Object.freeze({ ...record.quota }) });
  });
  return Object.freeze(records);
}

export async function fetchKeyRecords({ url, apiKey, mode = 'production', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, usersCollection = 'users' } = {}) {
  if (!validCmsUrl(url)) throw new CmsKeysError('url_invalid');
  if (typeof apiKey !== 'string' || !CMS_API_KEY.test(apiKey)) throw new CmsKeysError('api_key_invalid');
  if (typeof fetchImpl !== 'function') throw new CmsKeysError('fetch_invalid');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new CmsKeysError('timeout_invalid');
  if (typeof usersCollection !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(usersCollection)) throw new CmsKeysError('collection_invalid');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${url}/gateway/keys?mode=${mode}`, { method: 'GET', headers: { authorization: `${usersCollection} API-Key ${apiKey}`, accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
  } catch {
    throw new CmsKeysError(controller.signal.aborted ? 'timeout' : 'network_error');
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) throw new CmsKeysError('unauthorized', response.status);
  if (response.status !== 200) throw new CmsKeysError('request_failed', response.status);
  let document;
  try { document = await response.json(); } catch { throw new CmsKeysError('body_not_json'); }
  return validateKeyRecordsDocument(document, mode);
}

/**
 * Replace the `keys` array of a gateway configuration file with records from the
 * CMS. The file is rewritten atomically (temp file + rename) and the previous
 * content is returned so callers can log a secret-free summary.
 */
export async function syncKeysIntoConfig({ configPath, ...options }) {
  if (typeof configPath !== 'string' || configPath.length === 0) throw new CmsKeysError('config_path_invalid');
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { throw new CmsKeysError('config_unreadable'); }
  if (!plain(config)) throw new CmsKeysError('config_shape_invalid');
  const records = await fetchKeyRecords(options);
  if (records.length === 0) throw new CmsKeysError('no_keys');
  const previous = Array.isArray(config.keys) ? config.keys.length : 0;
  const next = { ...config, keys: records.map((record) => ({ ...record, api_majors: [...record.api_majors], permissions: [...record.permissions], quota: { ...record.quota } })) };
  const temp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, configPath);
  const states = { active: 0, revoked: 0, expired: 0 };
  for (const record of records) states[record.state] += 1;
  return Object.freeze({ previous_keys: previous, keys: records.length, states: Object.freeze(states) });
}
