import assert from 'node:assert/strict';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

export const PURPOSE = 'world-emergency-hotlines:managed-widget-config:v1';
export const ALGORITHM = 'Ed25519';
export const MAX_REVISION = 2_147_483_647;
export const SUPPORTED_CATEGORIES = Object.freeze([
  'animal_welfare', 'bereavement', 'child_protection', 'consular', 'disability',
  'disaster', 'domestic_violence', 'eating_disorders', 'elder_abuse', 'emergency',
  'financial_aid', 'gambling', 'general_support', 'housing', 'human_rights',
  'human_trafficking', 'legal_aid', 'lgbtqia', 'male_victims', 'mental_health',
  'missing_persons', 'perinatal', 'refugee_migrant', 'self_harm', 'sexual_violence',
  'stalking', 'substance_use', 'suicide_crisis', 'veterans', 'youth',
]);
export const SUPPORTED_CHANNELS = Object.freeze(['chat', 'phone', 'text']);

const B64URL = /^[A-Za-z0-9_-]+$/;
const CONFIG_ID = /^mwc_[a-z0-9_]{3,48}$/;
const PUBLIC_ORG_ID = /^org_public_[a-z0-9_]+$/;
const PUBLIC_PROJECT_ID = /^project_public_[a-z0-9_]+$/;
const KEY_ID = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?\.invalid$/;
const INSTALLATION_TOKEN = /^synthetic-installation-[a-z0-9-]{4,64}$/;
const ROLLBACK_AUTHORIZATION_ID = /^rbk_[a-z0-9_]{8,64}$/;
const STATES = Object.freeze(['draft', 'staged', 'active', 'retired']);

function exact(value, keys) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys) {
    assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
  }
}

function sortedUnique(values) {
  assert.deepEqual(values, [...new Set(values)].sort());
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    assert.ok(Number.isSafeInteger(value));
    return String(value);
  }
  if (Array.isArray(value)) {
    assert.equal(Object.getPrototypeOf(value), Array.prototype);
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  exact(value, Object.keys(value));
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function decodeBase64url(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, B64URL);
  assert.notEqual(value.length % 4, 1);
  const bytes = Buffer.from(value, 'base64url');
  assert.equal(bytes.toString('base64url'), value);
  return bytes;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed));
  assert.equal(new Date(parsed).toISOString(), value);
  return parsed;
}

function origin(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^https:\/\/[a-z0-9][a-z0-9.-]*\.invalid$/);
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.origin, value);
  assert.equal(parsed.username + parsed.password + parsed.search + parsed.hash, '');
  assert.ok(parsed.hostname.endsWith('.invalid'));
}

function identity(config) {
  return { config_id: config.config_id, revision: config.revision };
}

function sameIdentity(left, right) {
  return left.config_id === right.config_id && left.revision === right.revision;
}

function successorConfigId(config) {
  const content = structuredClone(config);
  delete content.config_id;
  const digest = createHash('sha256')
    .update('world-emergency-hotlines:managed-widget-config-id:v1\0')
    .update(canonicalJson(content))
    .digest('hex')
    .slice(0, 24);
  return `mwc_${digest}`;
}

export function validateConfig(config) {
  exact(config, [
    'schema_version', 'config_id', 'revision', 'organization_id', 'project_id',
    'allowed_domains', 'presentation', 'filters', 'safety', 'pins', 'lifecycle',
    'rollout', 'rollback',
  ]);
  assert.equal(config.schema_version, '1.0');
  assert.match(config.config_id, CONFIG_ID);
  assert.ok(Number.isSafeInteger(config.revision));
  assert.ok(config.revision >= 1 && config.revision <= MAX_REVISION);
  assert.match(config.organization_id, PUBLIC_ORG_ID);
  assert.match(config.project_id, PUBLIC_PROJECT_ID);

  assert.ok(Array.isArray(config.allowed_domains));
  assert.ok(config.allowed_domains.length >= 1 && config.allowed_domains.length <= 16);
  config.allowed_domains.forEach(origin);
  sortedUnique(config.allowed_domains);

  exact(config.presentation, ['locale', 'theme', 'accessibility_preset']);
  assert.match(config.presentation.locale, /^[a-z]{2}(?:-[A-Z]{2})?$/);
  assert.ok(['system', 'light', 'dark'].includes(config.presentation.theme));
  assert.ok(['standard', 'high-contrast', 'large-text'].includes(config.presentation.accessibility_preset));

  exact(config.filters, ['categories', 'channels', 'evidence_policy']);
  assert.ok(Array.isArray(config.filters.categories) && config.filters.categories.length > 0);
  assert.ok(config.filters.categories.every((value) => SUPPORTED_CATEGORIES.includes(value)));
  sortedUnique(config.filters.categories);
  assert.ok(Array.isArray(config.filters.channels) && config.filters.channels.length > 0);
  assert.ok(config.filters.channels.every((value) => SUPPORTED_CHANNELS.includes(value)));
  sortedUnique(config.filters.channels);
  assert.equal(config.filters.evidence_policy, 'published_dataset_only');

  exact(config.safety, [
    'emergency_context', 'provenance', 'verification_uncertainty', 'correction_link',
    'non_real_time_limitation', 'fallback_copy',
  ]);
  for (const key of [
    'emergency_context', 'provenance', 'verification_uncertainty', 'correction_link',
    'non_real_time_limitation',
  ]) assert.equal(config.safety[key], 'required_visible');
  assert.equal(typeof config.safety.fallback_copy, 'string');
  const fallbackLength = [...config.safety.fallback_copy].length;
  assert.ok(fallbackLength >= 20 && fallbackLength <= 240);
  assert.match(config.safety.fallback_copy, /emergency/i);
  assert.match(config.safety.fallback_copy, /not real[- ]time/i);

  exact(config.pins, ['widget_major', 'api_major', 'release_id']);
  assert.equal(config.pins.widget_major, 1);
  assert.equal(config.pins.api_major, 1);
  assert.match(config.pins.release_id, /^sha256:[0-9a-f]{64}$/);

  exact(config.lifecycle, ['state']);
  assert.ok(STATES.includes(config.lifecycle.state));
  exact(config.rollout, ['percentage', 'salt']);
  assert.ok(Number.isSafeInteger(config.rollout.percentage));
  assert.ok(config.rollout.percentage >= 0 && config.rollout.percentage <= 100);
  assert.match(config.rollout.salt, /^synthetic-[a-z0-9-]+$/);
  if (['draft', 'retired'].includes(config.lifecycle.state)) assert.equal(config.rollout.percentage, 0);
  if (config.lifecycle.state === 'staged') assert.ok(config.rollout.percentage >= 1 && config.rollout.percentage <= 99);
  if (config.lifecycle.state === 'active') assert.equal(config.rollout.percentage, 100);

  exact(config.rollback, [
    'previous_config_id', 'previous_revision', 'target_config_id', 'target_revision',
  ]);
  if (config.revision === 1) {
    assert.equal(config.rollback.previous_config_id, null);
    assert.equal(config.rollback.previous_revision, null);
  } else {
    assert.match(config.rollback.previous_config_id, CONFIG_ID);
    assert.equal(config.rollback.previous_revision, config.revision - 1);
  }
  const hasTarget = config.rollback.target_config_id !== null || config.rollback.target_revision !== null;
  if (hasTarget) {
    assert.match(config.rollback.target_config_id, CONFIG_ID);
    assert.ok(Number.isSafeInteger(config.rollback.target_revision));
    assert.ok(config.rollback.target_revision >= 1 && config.rollback.target_revision <= MAX_REVISION);
    assert.equal(config.lifecycle.state, 'active');
    assert.ok(config.revision >= 3);
    assert.equal(config.rollback.target_revision, config.revision - 2);
  } else {
    assert.equal(config.rollback.target_config_id, null);
    assert.equal(config.rollback.target_revision, null);
  }
  return true;
}

function stableHistoryView(config) {
  return {
    schema_version: config.schema_version,
    organization_id: config.organization_id,
    project_id: config.project_id,
    allowed_domains: config.allowed_domains,
    pins: config.pins,
  };
}

function rollbackContentView(config) {
  return {
    presentation: config.presentation,
    filters: config.filters,
    safety: config.safety,
    rollout_salt: config.rollout.salt,
  };
}

export function validateHistory(history) {
  assert.ok(Array.isArray(history) && history.length > 0);
  assert.equal(Object.getPrototypeOf(history), Array.prototype);
  const identities = new Set();
  for (let index = 0; index < history.length; index += 1) {
    const config = history[index];
    validateConfig(config);
    assert.equal(config.revision, index + 1);
    assert.ok(!identities.has(config.config_id));
    identities.add(config.config_id);
    if (index === 0) continue;
    assert.equal(config.config_id, successorConfigId(config));
    const previous = history[index - 1];
    assert.equal(config.rollback.previous_config_id, previous.config_id);
    assert.equal(config.rollback.previous_revision, previous.revision);
    assert.deepEqual(stableHistoryView(config), stableHistoryView(previous));
    const pair = `${previous.lifecycle.state}->${config.lifecycle.state}`;
    const rollback = config.rollback.target_config_id !== null;
    if (rollback) {
      assert.equal(pair, 'active->active');
      assert.ok(index >= 2);
      const target = history[index - 2];
      assert.equal(config.rollback.target_config_id, target.config_id);
      assert.equal(config.rollback.target_revision, target.revision);
      assert.deepEqual(rollbackContentView(config), rollbackContentView(target));
    } else {
      assert.ok(['draft->staged', 'draft->active', 'staged->active', 'active->retired'].includes(pair));
    }
  }
  return true;
}

function signingBytes(envelope) {
  return Buffer.from(`${PURPOSE}\n${canonicalJson(envelope.protected)}\n${canonicalJson(envelope.payload)}`);
}

function validateProtected(protectedFields) {
  exact(protectedFields, [
    'algorithm', 'key_id', 'purpose', 'audience', 'issued_at', 'not_before', 'expires_at',
  ]);
  assert.equal(protectedFields.algorithm, ALGORITHM);
  assert.match(protectedFields.key_id, KEY_ID);
  assert.equal(protectedFields.purpose, PURPOSE);
  exact(protectedFields.audience, ['organization_id', 'project_id']);
  assert.match(protectedFields.audience.organization_id, PUBLIC_ORG_ID);
  assert.match(protectedFields.audience.project_id, PUBLIC_PROJECT_ID);
}

export function signEnvelope(payload, protectedFields, privateJwk) {
  validateConfig(payload);
  validateProtected(protectedFields);
  assert.equal(protectedFields.audience.organization_id, payload.organization_id);
  assert.equal(protectedFields.audience.project_id, payload.project_id);
  const unsigned = {
    envelope_version: '1.0',
    protected: structuredClone(protectedFields),
    payload: structuredClone(payload),
  };
  const signature = cryptoSign(
    null,
    signingBytes(unsigned),
    createPrivateKey({ key: privateJwk, format: 'jwk' }),
  ).toString('base64url');
  return { ...unsigned, signature };
}

const AUTHORIZATION_STORES = new WeakMap();

function validateAuthorizationRecord(record) {
  exact(record, [
    'authorization_id', 'organization_id', 'project_id', 'current', 'target',
    'not_before', 'expires_at', 'consumed',
  ]);
  assert.match(record.authorization_id, ROLLBACK_AUTHORIZATION_ID);
  assert.match(record.organization_id, PUBLIC_ORG_ID);
  assert.match(record.project_id, PUBLIC_PROJECT_ID);
  exact(record.current, ['config_id', 'revision']);
  exact(record.target, ['config_id', 'revision']);
  for (const item of [record.current, record.target]) {
    assert.match(item.config_id, CONFIG_ID);
    assert.ok(Number.isSafeInteger(item.revision));
    assert.ok(item.revision >= 1 && item.revision <= MAX_REVISION);
  }
  const notBefore = timestamp(record.not_before);
  const expires = timestamp(record.expires_at);
  assert.ok(notBefore < expires);
  assert.equal(typeof record.consumed, 'boolean');
}

export class SyntheticRollbackAuthorizationStore {
  constructor(records) {
    assert.ok(Array.isArray(records));
    assert.equal(Object.getPrototypeOf(records), Array.prototype);
    const entries = new Map();
    for (const supplied of records) {
      validateAuthorizationRecord(supplied);
      assert.ok(!entries.has(supplied.authorization_id));
      entries.set(supplied.authorization_id, structuredClone(supplied));
    }
    AUTHORIZATION_STORES.set(this, entries);
    Object.freeze(this);
  }

  consumeOnce(authorizationId, expected, now) {
    assert.equal(Object.getPrototypeOf(this), SyntheticRollbackAuthorizationStore.prototype);
    const entries = AUTHORIZATION_STORES.get(this);
    assert.ok(entries);
    assert.match(authorizationId, ROLLBACK_AUTHORIZATION_ID);
    exact(expected, ['organization_id', 'project_id', 'current', 'target']);
    exact(expected.current, ['config_id', 'revision']);
    exact(expected.target, ['config_id', 'revision']);
    const at = timestamp(now);
    const record = entries.get(authorizationId);
    if (!record || record.consumed) return false;
    if (record.organization_id !== expected.organization_id
      || record.project_id !== expected.project_id
      || !sameIdentity(record.current, expected.current)
      || !sameIdentity(record.target, expected.target)
      || timestamp(record.not_before) > at
      || at >= timestamp(record.expires_at)) return false;
    record.consumed = true;
    return true;
  }
}

export function verifyEnvelope(envelope, options) {
  try {
    const {
      publicKeys, now, expectedOrganizationId, expectedProjectId, expectedDomain,
      history, rollbackAuthorizationId = null, rollbackAuthorizationStore = null,
    } = options;
    exact(envelope, ['envelope_version', 'protected', 'payload', 'signature']);
    assert.equal(envelope.envelope_version, '1.0');
    validateProtected(envelope.protected);
    const protectedFields = envelope.protected;
    assert.equal(protectedFields.audience.organization_id, expectedOrganizationId);
    assert.equal(protectedFields.audience.project_id, expectedProjectId);
    const issued = timestamp(protectedFields.issued_at);
    const notBefore = timestamp(protectedFields.not_before);
    const expires = timestamp(protectedFields.expires_at);
    const at = timestamp(now);
    assert.ok(issued <= notBefore && notBefore <= at && at < expires);
    assert.ok(expires - issued <= 86_400_000);

    validateConfig(envelope.payload);
    assert.equal(envelope.payload.organization_id, expectedOrganizationId);
    assert.equal(envelope.payload.project_id, expectedProjectId);
    assert.equal(protectedFields.audience.organization_id, envelope.payload.organization_id);
    assert.equal(protectedFields.audience.project_id, envelope.payload.project_id);
    assert.ok(envelope.payload.allowed_domains.includes(expectedDomain));
    assert.ok(Array.isArray(history));
    if (history.length > 0) validateHistory(history);
    const current = history.at(-1);
    if (current) {
      assert.equal(envelope.payload.revision, current.revision + 1);
      assert.equal(envelope.payload.rollback.previous_config_id, current.config_id);
      assert.equal(envelope.payload.rollback.previous_revision, current.revision);
    } else {
      assert.equal(envelope.payload.revision, 1);
      assert.equal(envelope.payload.rollback.previous_config_id, null);
      assert.equal(envelope.payload.rollback.previous_revision, null);
    }

    const rollback = envelope.payload.rollback.target_config_id !== null;
    if (rollback) {
      assert.ok(history.length >= 2);
      const target = history.at(-2);
      assert.equal(envelope.payload.rollback.target_config_id, target.config_id);
      assert.equal(envelope.payload.rollback.target_revision, target.revision);
      assert.match(rollbackAuthorizationId, ROLLBACK_AUTHORIZATION_ID);
      assert.equal(
        Object.getPrototypeOf(rollbackAuthorizationStore),
        SyntheticRollbackAuthorizationStore.prototype,
      );
    } else {
      assert.equal(rollbackAuthorizationId, null);
      assert.equal(rollbackAuthorizationStore, null);
    }

    const key = publicKeys[protectedFields.key_id];
    assert.ok(key);
    const signature = decodeBase64url(envelope.signature);
    assert.equal(signature.length, 64);
    assert.ok(cryptoVerify(
      null,
      signingBytes(envelope),
      createPublicKey({ key, format: 'jwk' }),
      signature,
    ));
    validateHistory([...history, envelope.payload]);
    if (rollback) {
      const target = history.at(-2);
      assert.equal(rollbackAuthorizationStore.consumeOnce(rollbackAuthorizationId, {
        organization_id: expectedOrganizationId,
        project_id: expectedProjectId,
        current: identity(current),
        target: identity(target),
      }, now), true);
    }
    return structuredClone(envelope.payload);
  } catch {
    throw new Error('managed widget configuration verification failed');
  }
}

function rolloutThreshold(percentage) {
  return (1n << 64n) * BigInt(percentage) / 100n;
}

export function assignmentValue(config, installationToken) {
  validateConfig(config);
  assert.match(installationToken, INSTALLATION_TOKEN);
  const digest = createHash('sha256')
    .update('world-emergency-hotlines:managed-widget-rollout:v1\0')
    .update(config.rollout.salt)
    .update('\0')
    .update(installationToken)
    .digest();
  return digest.readBigUInt64BE(0);
}

export function assigned(config, installationToken) {
  const value = assignmentValue(config, installationToken);
  if (config.lifecycle.state === 'active') return true;
  if (config.lifecycle.state !== 'staged') return false;
  return value < rolloutThreshold(config.rollout.percentage);
}

export function transition(history, action) {
  validateHistory(history);
  exact(action, action.type === 'stage' ? ['type', 'percentage'] : ['type']);
  const current = history.at(-1);
  if (action.type === 'preview') return { changed: false, config: structuredClone(current) };

  const next = structuredClone(current);
  next.revision = current.revision + 1;
  assert.ok(next.revision <= MAX_REVISION);
  next.rollback = {
    previous_config_id: current.config_id,
    previous_revision: current.revision,
    target_config_id: null,
    target_revision: null,
  };
  if (action.type === 'stage') {
    assert.equal(current.lifecycle.state, 'draft');
    assert.ok(Number.isSafeInteger(action.percentage));
    assert.ok(action.percentage >= 1 && action.percentage <= 99);
    next.lifecycle.state = 'staged';
    next.rollout.percentage = action.percentage;
  } else if (action.type === 'activate') {
    assert.ok(['draft', 'staged'].includes(current.lifecycle.state));
    next.lifecycle.state = 'active';
    next.rollout.percentage = 100;
  } else if (action.type === 'retire') {
    assert.equal(current.lifecycle.state, 'active');
    next.lifecycle.state = 'retired';
    next.rollout.percentage = 0;
  } else if (action.type === 'rollback') {
    assert.equal(current.lifecycle.state, 'active');
    assert.ok(history.length >= 2);
    const target = history.at(-2);
    next.presentation = structuredClone(target.presentation);
    next.filters = structuredClone(target.filters);
    next.safety = structuredClone(target.safety);
    next.lifecycle.state = 'active';
    next.rollout = { ...structuredClone(target.rollout), percentage: 100 };
    next.rollback.target_config_id = target.config_id;
    next.rollback.target_revision = target.revision;
  } else {
    throw new Error('invalid transition');
  }
  next.config_id = successorConfigId(next);
  validateHistory([...history, next]);
  return { changed: true, config: next };
}
