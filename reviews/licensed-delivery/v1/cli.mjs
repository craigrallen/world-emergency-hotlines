#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeCompliance,
  issuePresentation,
  sha256,
  validateBinaryObservation,
  validateFetchObservation,
  validateOutwardObservation,
  validatePresentationObservation,
  validateRenderAttestation,
} from './model.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const fixturePins = Object.freeze({
  'fixtures/synthetic-input.json': '174117ce223406ca3ad680e3137e95493fb44cabd41e1f776cb3c79320b7ca45',
  'fixtures/presentation.synthetic.json': 'dfd95ba3fcd2bd16d2a1d39db8460c438da90431b4a2440852f82c6c05b8d099',
  'fixtures/observations.synthetic.json': '776de581d7921807caa1e719ba790356d23284cc903b234bcb7efaafe7d384df',
});

function loadPinnedFixture(path) {
  const bytes = readFileSync(resolve(root, path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== fixturePins[path]) throw new Error(`refusing unpinned synthetic fixture: ${path}`);
  const value = JSON.parse(bytes);
  if (value.synthetic_fixture !== true) throw new Error(`missing synthetic fixture marker: ${path}`);
  return value;
}

function trustedDemoContext(input, presentation) {
  if (input.record.contact_urls.length !== 1 || new URL(input.record.contact_urls[0]).hostname !== 'example.invalid') throw new Error('synthetic URL must use example.invalid');
  if (input.record.contact_emails.length !== 1 || !input.record.contact_emails[0].endsWith('@example.invalid')) throw new Error('synthetic email must use example.invalid');
  const observationKey = 'SYNTHETIC-OBSERVATION-KEY-000000000000000000';
  const artifactDigest = sha256(Buffer.from('artifact'));
  const metadataDigest = sha256(Buffer.from('synthetic-metadata'));
  const tokenDigest = sha256(Buffer.from(presentation.presentation_token));
  const acquisition = id => [id, {status: 'active', artifact_sha256: artifactDigest, acquisition_provenance: 'registered_capture_service', scan_method: 'static_digest_scan_v1', scan_version: '1'}];
  return {
    observation_keys: {'obs-key-1': {status: 'active', key: observationKey}},
    registered_apps: {'tenant-synthetic-a\0app-synthetic-a\0synthetic-1.0': {status: 'active'}},
    presentation_keys: {[input.key_id]: {status: 'active', key: input.key}},
    presentation_ledger: {[tokenDigest]: {status: 'active', tenant_id: 'tenant-synthetic-a', app_id: 'app-synthetic-a', app_version: 'synthetic-1.0', record_revision: presentation.record_revision, issued_at: presentation.issued_at, expires_at: presentation.expires_at, key_id: input.key_id}},
    metadata_registry: {[metadataDigest]: {status: 'active', metadata_type: 'canary', tenant_id: 'tenant-synthetic-a', app_id: 'app-synthetic-a', app_version: 'synthetic-1.0', issuance_key_id: input.key_id}},
    acquisition_registry: Object.fromEntries([acquisition('build-synthetic-1'), acquisition('synthetic-build-1')]),
    scan_version_registry: {[`static_digest_scan_v1\0${'1'}`]: {status: 'active'}},
  };
}

export function runDemo() {
  const input = loadPinnedFixture('fixtures/synthetic-input.json');
  const storedPresentation = loadPinnedFixture('fixtures/presentation.synthetic.json').envelope;
  const observations = loadPinnedFixture('fixtures/observations.synthetic.json');
  const issuedPresentation = issuePresentation(input);
  if (JSON.stringify(issuedPresentation) !== JSON.stringify(storedPresentation)) throw new Error('synthetic presentation fixture does not match deterministic issuance');
  const context = trustedDemoContext(input, storedPresentation);
  const verified = {
    presentations: [validatePresentationObservation(observations.presentation_observation, context)],
    renders: [validateRenderAttestation(observations.render_attestation, context)],
    fetches: [validateFetchObservation(observations.fetch_observation, context)],
    outward: [validateOutwardObservation(observations.outward_observation, context)],
    binaries: [validateBinaryObservation(observations.app_binary_observation, context)],
  };
  return analyzeCompliance(verified);
}

export function runCli(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== 'demo') throw new Error('usage: node cli.mjs demo');
  return runDemo();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(runCli(), null, 2)}\n`);
}
