import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assigned,
  assignmentValue,
  signEnvelope,
  SyntheticRollbackAuthorizationStore,
  transition,
  validateConfig,
  validateHistory,
  verifyEnvelope,
} from '../model.mjs';

const fixture = JSON.parse(readFileSync(resolve(
  import.meta.dirname,
  '../contracts/v1/fixture.synthetic.json',
)));
const publicJwk = JSON.parse(readFileSync(resolve(
  import.meta.dirname,
  '../contracts/v1/keys.synthetic.json',
))).public_jwk;
const privateJwk = {
  ...publicJwk,
  d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A',
};
const publicKeys = { [fixture.protected.key_id]: publicJwk };
const now = '2030-01-01T12:00:00.000Z';

function draft() {
  const config = structuredClone(fixture.payload);
  config.config_id = 'mwc_synthetic_rev1';
  config.revision = 1;
  config.lifecycle.state = 'draft';
  config.rollout.percentage = 0;
  config.rollback = {
    previous_config_id: null,
    previous_revision: null,
    target_config_id: null,
    target_revision: null,
  };
  return config;
}

function verificationOptions(history, overrides = {}) {
  return {
    publicKeys,
    now,
    expectedOrganizationId: 'org_public_synthetic',
    expectedProjectId: 'project_public_synthetic',
    expectedDomain: 'https://widget.synthetic.example.invalid',
    history,
    ...overrides,
  };
}

function signed(config, protectedOverrides = {}) {
  const protectedFields = structuredClone(fixture.protected);
  Object.assign(protectedFields, protectedOverrides);
  return signEnvelope(config, protectedFields, privateJwk);
}

function authorizationRecord(current, target, overrides = {}) {
  return {
    authorization_id: 'rbk_synthetic_once_0001',
    organization_id: current.organization_id,
    project_id: current.project_id,
    current: { config_id: current.config_id, revision: current.revision },
    target: { config_id: target.config_id, revision: target.revision },
    not_before: '2030-01-01T00:00:00.000Z',
    expires_at: '2030-01-02T00:00:00.000Z',
    consumed: false,
    ...overrides,
  };
}

test('public fixture is deterministic and verifies against its exact predecessor', () => {
  const rev1 = draft();
  assert.deepEqual(signEnvelope(fixture.payload, fixture.protected, privateJwk), fixture);
  assert.deepEqual(
    verifyEnvelope(fixture, verificationOptions([rev1])),
    fixture.payload,
  );
});

test('draft -> staged -> active revisions sign and verify end to end', () => {
  const rev1 = draft();
  const accepted = [];
  for (const config of [
    rev1,
    transition([rev1], { type: 'stage', percentage: 25 }).config,
  ]) {
    const envelope = signed(config);
    assert.deepEqual(verifyEnvelope(envelope, verificationOptions(accepted)), config);
    accepted.push(config);
  }
  const active = transition(accepted, { type: 'activate' }).config;
  assert.deepEqual(
    verifyEnvelope(signed(active), verificationOptions(accepted)),
    active,
  );
  accepted.push(active);
  assert.deepEqual(accepted.map((item) => item.revision), [1, 2, 3]);
  assert.equal(new Set(accepted.map((item) => item.config_id)).size, 3);
  assert.equal(active.rollback.previous_config_id, accepted[1].config_id);
});

test('rollback atomically consumes an exact pre-registered authorization once', () => {
  const rev1 = draft();
  const rev2 = transition([rev1], { type: 'stage', percentage: 25 }).config;
  const rev3 = transition([rev1, rev2], { type: 'activate' }).config;
  const history = [rev1, rev2, rev3];
  const rollback = transition(history, { type: 'rollback' }).config;
  const envelope = signed(rollback);
  const authorization = authorizationRecord(rev3, rev2);
  const store = new SyntheticRollbackAuthorizationStore([authorization]);
  assert.deepEqual(verifyEnvelope(envelope, verificationOptions(history, {
    rollbackAuthorizationId: authorization.authorization_id,
    rollbackAuthorizationStore: store,
  })), rollback);
  assert.throws(() => verifyEnvelope(envelope, verificationOptions(history, {
    rollbackAuthorizationId: authorization.authorization_id,
    rollbackAuthorizationStore: store,
  })), /verification failed/);

  const invalidRecords = [
    authorizationRecord(rev3, rev2, { authorization_id: 'rbk_synthetic_wrong_tenant', organization_id: 'org_public_other' }),
    authorizationRecord(rev3, rev2, { authorization_id: 'rbk_synthetic_wrong_project', project_id: 'project_public_other' }),
    authorizationRecord(rev2, rev2, { authorization_id: 'rbk_synthetic_wrong_current' }),
    authorizationRecord(rev3, rev1, { authorization_id: 'rbk_synthetic_wrong_target' }),
    authorizationRecord(rev3, rev2, { authorization_id: 'rbk_synthetic_too_early', not_before: '2030-01-01T12:00:00.001Z' }),
    authorizationRecord(rev3, rev2, { authorization_id: 'rbk_synthetic_expired', expires_at: now }),
  ];
  for (const candidate of invalidRecords) {
    assert.throws(() => verifyEnvelope(envelope, verificationOptions(history, {
      rollbackAuthorizationId: candidate.authorization_id,
      rollbackAuthorizationStore: new SyntheticRollbackAuthorizationStore([candidate]),
    })), /verification failed/);
  }

  const unrelated = new SyntheticRollbackAuthorizationStore([]);
  assert.throws(() => verifyEnvelope(envelope, verificationOptions(history, {
    rollbackAuthorizationId: authorization.authorization_id,
    rollbackAuthorizationStore: unrelated,
  })), /verification failed/);

  const fake = { consumeOnce: () => true };
  class HostileStore extends SyntheticRollbackAuthorizationStore {}
  for (const hostile of [fake, new HostileStore([authorization])]) {
    assert.throws(() => verifyEnvelope(envelope, verificationOptions(history, {
      rollbackAuthorizationId: authorization.authorization_id,
      rollbackAuthorizationStore: hostile,
    })), /verification failed/);
  }

  const badSignature = structuredClone(envelope);
  badSignature.signature = `${badSignature.signature.slice(0, -1)}${badSignature.signature.endsWith('A') ? 'B' : 'A'}`;
  const unusedAuthorization = authorizationRecord(rev3, rev2, { authorization_id: 'rbk_synthetic_unused_0005' });
  const unusedStore = new SyntheticRollbackAuthorizationStore([unusedAuthorization]);
  assert.throws(() => verifyEnvelope(badSignature, verificationOptions(history, {
    rollbackAuthorizationId: unusedAuthorization.authorization_id,
    rollbackAuthorizationStore: unusedStore,
  })), /verification failed/);
  assert.deepEqual(verifyEnvelope(envelope, verificationOptions(history, {
    rollbackAuthorizationId: unusedAuthorization.authorization_id,
    rollbackAuthorizationStore: unusedStore,
  })), rollback);
});

test('rollback restores mutable content but cannot drift tenant, domains, or pins', () => {
  const rev1 = draft();
  rev1.presentation.theme = 'dark';
  const rev2 = transition([rev1], { type: 'activate' }).config;
  assert.equal(validateHistory([rev1, rev2]), true);
  const rev3 = transition([rev1, rev2], { type: 'rollback' }).config;
  assert.deepEqual(rev3.presentation, rev1.presentation);
  assert.deepEqual(rev3.filters, rev1.filters);
  assert.equal(validateHistory([rev1, rev2, rev3]), true);
  for (const mutate of [
    (value) => { value.organization_id = 'org_public_other'; },
    (value) => { value.allowed_domains = ['https://other.example.invalid']; },
    (value) => { value.pins.release_id = `sha256:${'2'.repeat(64)}`; },
    (value) => { value.presentation.theme = 'light'; },
  ]) {
    const history = structuredClone([rev1, rev2, rev3]);
    mutate(history[2]);
    assert.throws(() => validateHistory(history));
  }
});

test('protected audience and independently expected tenant reject confused deputies', () => {
  const rev1 = draft();
  const cases = [
    verificationOptions([], { expectedProjectId: 'project_public_other' }),
    verificationOptions([], { expectedOrganizationId: 'org_public_other' }),
    verificationOptions([], {
      expectedOrganizationId: 'org_public_other',
      expectedProjectId: 'project_public_other',
    }),
  ];
  for (const options of cases) {
    assert.throws(() => verifyEnvelope(signed(rev1), options), /verification failed/);
  }

  const crossProject = structuredClone(rev1);
  crossProject.project_id = 'project_public_other';
  const sharedDomainEnvelope = signed(crossProject, {
    audience: {
      organization_id: crossProject.organization_id,
      project_id: crossProject.project_id,
    },
  });
  assert.throws(() => verifyEnvelope(
    sharedDomainEnvelope,
    verificationOptions([]),
  ), /verification failed/);
});

test('signature, time, key, domain, and forward-history checks fail closed', () => {
  const rev1 = draft();
  const envelope = signed(rev1);
  const mutations = [
    (value) => { value.payload.presentation.theme = 'dark'; },
    (value) => { value.signature = `${value.signature.slice(0, -1)}A`; },
    (value) => { value.protected.purpose = 'wrong'; },
    (value) => { value.protected.key_id = 'wrong.invalid'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(envelope);
    mutate(changed);
    assert.throws(() => verifyEnvelope(changed, verificationOptions([])), /verification failed/);
  }
  for (const overrides of [
    { now: '2029-12-31T23:59:59.999Z' },
    { now: '2030-01-02T00:00:00.000Z' },
    { expectedDomain: 'https://wrong.example.invalid' },
    { history: [rev1] },
  ]) {
    assert.throws(() => verifyEnvelope(
      envelope,
      verificationOptions([], overrides),
    ), /verification failed/);
  }

  const tooLong = signed(rev1, { expires_at: '2030-01-02T00:00:00.001Z' });
  assert.throws(() => verifyEnvelope(tooLong, verificationOptions([])), /verification failed/);
  const noncanonical = structuredClone(envelope);
  noncanonical.signature += '=';
  assert.throws(() => verifyEnvelope(noncanonical, verificationOptions([])), /verification failed/);
});

test('synthetic public key is a minimal Ed25519 public JWK', () => {
  assert.deepEqual(Object.keys(publicJwk).sort(), ['crv', 'kty', 'x']);
  assert.equal(publicJwk.kty, 'OKP');
  assert.equal(publicJwk.crv, 'Ed25519');
  assert.match(publicJwk.x, /^[A-Za-z0-9_-]{43}$/);
});

test('complete history invariants reject gaps, duplicates, forks, and invalid paths', () => {
  const rev1 = draft();
  const rev2 = transition([rev1], { type: 'stage', percentage: 25 }).config;
  const rev3 = transition([rev1, rev2], { type: 'activate' }).config;
  assert.equal(validateHistory([rev1, rev2, rev3]), true);
  const corruptions = [
    (history) => { history[1].revision = 3; },
    (history) => { history[1].config_id = history[0].config_id; },
    (history) => { history[2].rollback.previous_config_id = history[0].config_id; },
    (history) => { history[1].organization_id = 'org_public_other'; },
    (history) => { history[1].allowed_domains = ['https://other.example.invalid']; },
    (history) => { history[1].lifecycle.state = 'retired'; history[1].rollout.percentage = 0; },
  ];
  for (const corrupt of corruptions) {
    const history = structuredClone([rev1, rev2, rev3]);
    corrupt(history);
    assert.throws(() => validateHistory(history));
  }
  const retired = transition([rev1, rev2, rev3], { type: 'retire' }).config;
  assert.equal(retired.lifecycle.state, 'retired');
  assert.equal(retired.revision, 4);
});

test('successor identity is deterministic, complete-content-derived, and fork-separating', () => {
  const rev1 = draft();
  const first = transition([rev1], { type: 'stage', percentage: 25 }).config;
  const repeated = transition(structuredClone([rev1]), { type: 'stage', percentage: 25 }).config;
  assert.equal(first.config_id, repeated.config_id);
  assert.equal(first.config_id, 'mwc_e85f8e04ec1d1c9da74ebe17');

  const fork = transition([rev1], { type: 'stage', percentage: 26 }).config;
  assert.notEqual(first.config_id, fork.config_id);
  assert.throws(() => validateHistory([rev1, { ...structuredClone(fork), config_id: first.config_id }]));

  for (const mutate of [
    (value) => { value.presentation.theme = 'dark'; },
    (value) => { value.rollback.previous_config_id = 'mwc_arbitrary_stale'; },
    (value) => { value.pins.release_id = `sha256:${'3'.repeat(64)}`; },
  ]) {
    const corrupted = structuredClone(first);
    mutate(corrupted);
    assert.throws(() => validateHistory([rev1, corrupted]));
  }
});

test('rollout assignment uses unbiased 64-bit threshold with stable separation vectors', () => {
  const base = draft();
  const tokens = [
    'synthetic-installation-token-0001',
    'synthetic-installation-token-0002',
    'synthetic-installation-token-0003',
  ];
  const values = tokens.map((token) => assignmentValue(base, token).toString(16).padStart(16, '0'));
  assert.deepEqual(values, [
    'a2e0f60a497b5adc',
    '9cfdf0495c94c1a1',
    '32242237c4ce5d6d',
  ]);
  assert.notEqual(values[0], assignmentValue(
    { ...base, rollout: { ...base.rollout, salt: 'synthetic-rollout-b' } },
    tokens[0],
  ).toString(16).padStart(16, '0'));
  assert.notEqual(values[0], assignmentValue(base, tokens[1]).toString(16).padStart(16, '0'));

  for (const percentage of [1, 99]) {
    const staged = transition([base], { type: 'stage', percentage }).config;
    assert.equal(typeof assigned(staged, tokens[0]), 'boolean');
  }
  assert.equal(assigned(base, tokens[0]), false);
  const active = transition([base], { type: 'activate' }).config;
  assert.equal(assigned(active, tokens[0]), true);
  const retired = transition([base, active], { type: 'retire' }).config;
  assert.equal(assigned(retired, tokens[0]), false);
  assert.throws(() => transition([base], { type: 'stage', percentage: 0 }));
  assert.throws(() => transition([base], { type: 'stage', percentage: 100 }));
});

test('hostile JavaScript values fail closed', () => {
  const attacks = [
    (value) => { value.revision = Number.NaN; },
    (value) => { value.revision = Number.POSITIVE_INFINITY; },
    (value) => { value.revision = 2 ** 31; },
    (value) => { value.filters.categories = ['general_support', 'general_support']; },
    (value) => { value.filters.categories = ['nonexistent_category']; },
    (value) => { value.filters.channels = ['email']; },
    (value) => { value.allowed_domains = ['https://widget.synthetic.example.invalid', 'https://widget.synthetic.example.invalid']; },
    (value) => { value.safety.fallback_copy = 'A sufficiently long but unsafe fallback message.'; },
    (value) => { Object.setPrototypeOf(value, { polluted: true }); },
    (value) => { value.filters.categories = new Proxy([], {}); },
  ];
  for (const attack of attacks) {
    const value = draft();
    attack(value);
    assert.throws(() => validateConfig(value));
  }
});
