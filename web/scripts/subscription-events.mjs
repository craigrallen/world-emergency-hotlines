import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableJson } from './release-integrity.mjs';
import { utf16Compare } from './dataset-diff.mjs';

export const CANONICAL_ORIGIN = 'https://worldhotlines.org';
export const MAX_BODY_BYTES = 65536;
export const REPLAY_WINDOW_SECONDS = 300;
export const EVENT_ID_DOMAIN = 'org.worldhotlines.subscription-event/v1';
export const MAX_SECRET_OVERLAP_SECONDS = 86400;
export const EVENT_TYPES = Object.freeze(['baseline', 'no-change', 'added', 'modified', 'country-metadata'].map((suffix) => `org.worldhotlines.dataset.release.${suffix}`));
export const ARTIFACT_CLASSES = Object.freeze(['dataset', 'static-api', 'release-metadata', 'release-feeds', 'subscription-contracts']);
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function latestRelease(registryPath = resolve(REPO_ROOT, 'docs/dataset-releases.json')) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (registry.schema_version !== '2.0' || !Array.isArray(registry.releases) || !registry.releases.length) throw new Error('schema-2 release registry with at least one entry required');
  return registry.releases.at(-1);
}

function strictUtcTimestamp(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  const parsed = match ? new Date(value) : null;
  if (!match || Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() + 1 !== Number(match[2]) || parsed.getUTCDate() !== Number(match[3]) || parsed.getUTCHours() !== Number(match[4]) || parsed.getUTCMinutes() !== Number(match[5]) || parsed.getUTCSeconds() !== Number(match[6])) throw new Error('an explicit valid RFC3339 UTC timestamp is required');
  return value;
}

export function normalizeCounts(summary) {
  if (!summary || typeof summary !== 'object') throw new Error('schema-2 change counts required');
  const result = {
    added: summary.added, removed: summary.removed, modified: summary.modified,
    metadata_added: summary.country_metadata_added ?? summary.metadata_added,
    metadata_removed: summary.country_metadata_removed ?? summary.metadata_removed,
    metadata_modified: summary.country_metadata_modified ?? summary.metadata_modified,
  };
  if (Object.values(result).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('all change counts must be non-negative safe integers');
  const sum = result.added + result.removed + result.modified + result.metadata_added + result.metadata_removed + result.metadata_modified;
  if (Object.hasOwn(summary, 'total_changes') && (!Number.isSafeInteger(summary.total_changes) || summary.total_changes < 0 || sum !== summary.total_changes)) throw new Error('release registry total_changes must equal its component counts');
  return result;
}

export function inferEventType(release, counts) {
  const prefix = 'org.worldhotlines.dataset.release.';
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total === 0) return `${prefix}${release.previous_entry_hash == null ? 'baseline' : 'no-change'}`;
  const records = counts.added + counts.removed + counts.modified;
  const metadata = counts.metadata_added + counts.metadata_removed + counts.metadata_modified;
  if (counts.added > 0 && counts.removed === 0 && counts.modified === 0 && metadata === 0) return `${prefix}added`;
  if (metadata > 0 && records === 0) return `${prefix}country-metadata`;
  return `${prefix}modified`;
}

export function buildEvent({ release = latestRelease(), timestamp, type, counts, artifactClasses = ['dataset', 'release-metadata', 'release-feeds', 'subscription-contracts'] }) {
  strictUtcTimestamp(timestamp);
  const summary = counts ?? release.changes?.counts;
  const changeSummary = normalizeCounts(summary);
  if (!Array.isArray(artifactClasses) || artifactClasses.length === 0 || new Set(artifactClasses).size !== artifactClasses.length || artifactClasses.some((item) => !ARTIFACT_CLASSES.includes(item))) throw new Error('artifact classes must be a non-empty duplicate-free exact-enum array');
  const sortedArtifactClasses = [...artifactClasses].sort(utf16Compare);
  const inferred = inferEventType(release, changeSummary);
  const data = {
    artifact_classes: sortedArtifactClasses,
    change_summary: changeSummary,
    dataset_version: release.changes.to_dataset_version,
    release_kind: inferred.slice(inferred.lastIndexOf('.') + 1),
    release_entry_hash: release.entry_hash,
    release_entry_id: release.id,
    schema_major: 2,
  };
  const eventType = type ?? inferred;
  if (!EVENT_TYPES.includes(eventType) || eventType !== inferred) throw new Error(`event type ${eventType} is inconsistent with release identity and counts (expected ${inferred})`);
  const identity = stableJson({ contract: EVENT_ID_DOMAIN, data, source: CANONICAL_ORIGIN, type: eventType });
  return {
    specversion: '1.0', id: `evt_${createHash('sha256').update(identity).digest('hex')}`,
    source: CANONICAL_ORIGIN, type: eventType, time: timestamp, datacontenttype: 'application/json', data,
  };
}

export function canonicalBytes(value) { return Buffer.from(`${stableJson(value)}\n`); }
export function decodeSecret(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('webhook secret must encode exactly 32 random bytes as unpadded base64url');
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== secret) throw new Error('invalid canonical base64url webhook secret');
  return decoded;
}
export function signature(timestamp, rawBody, secret) {
  if (!secret) throw new Error('synthetic secret required');
  return `v1=${createHmac('sha256', decodeSecret(secret)).update(String(timestamp), 'ascii').update('.').update(rawBody).digest('hex')}`;
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function hasExactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function validatedSecrets(secrets) {
  if (!isPlainObject(secrets) || !hasExactKeys(secrets, ['current'], ['previous'])) return null;
  if (!isPlainObject(secrets.current) || !hasExactKeys(secrets.current, ['value'])) return null;
  try { decodeSecret(secrets.current.value); } catch { return null; }
  let previous;
  if (Object.hasOwn(secrets, 'previous')) {
    previous = secrets.previous;
    if (!isPlainObject(previous) || !hasExactKeys(previous, ['value', 'activated_at', 'expires_at']) ||
      !Number.isSafeInteger(previous.activated_at) || !Number.isSafeInteger(previous.expires_at) ||
      previous.activated_at > previous.expires_at || previous.expires_at - previous.activated_at > MAX_SECRET_OVERLAP_SECONDS) return null;
    try { decodeSecret(previous.value); } catch { return null; }
  }
  return { current: secrets.current, previous };
}
export function verifySignature({ timestamp, rawBody, signatureHeader, secrets, now }) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length > MAX_BODY_BYTES) return { ok: false, reason: 'body' };
  if (!/^\d+$/.test(String(timestamp)) || !Number.isSafeInteger(now) || !Number.isSafeInteger(Number(timestamp)) || Math.abs(now - Number(timestamp)) > REPLAY_WINDOW_SECONDS) return { ok: false, reason: 'timestamp' };
  const match = /^v1=([a-f0-9]{64})$/.exec(signatureHeader ?? '');
  if (!match) return { ok: false, reason: 'version-or-format' };
  const validated = validatedSecrets(secrets);
  if (!validated) return { ok: false, reason: 'secret-config' };
  const candidates = [validated.current];
  // A valid previous secret outside its inclusive activation window is not a candidate;
  // current remains usable. Malformed rotation configuration fails closed above.
  if (validated.previous && validated.previous.activated_at <= now && now <= validated.previous.expires_at) candidates.push(validated.previous);
  const supplied = Buffer.from(match[1], 'hex');
  for (const secret of candidates) {
    const expected = Buffer.from(signature(timestamp, rawBody, secret.value).slice(3), 'hex');
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return { ok: true, reason: 'verified' };
  }
  return { ok: false, reason: 'signature' };
}
