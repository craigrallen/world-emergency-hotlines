import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvent, canonicalBytes } from './subscription-events.mjs';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const SOURCE = resolve(WEB_ROOT, 'contracts/subscriptions/v1');
const OUTPUT = resolve(WEB_ROOT, 'public/subscriptions/v1');
const CONTRACT_FILES = Object.freeze(['README.md', 'common.schema.json', 'error.schema.json', 'event.schema.json', 'openapi.json', 'subscription-request.schema.json', 'subscription-response.schema.json', 'webhook-contract.json']);
const SYNTHETIC_TIMESTAMP = '2038-01-19T03:14:07.000Z';

function assertRealDirectoryChain(path, stop) {
  const rel = relative(stop, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).some((part) => !part || part === '.' || part === '..')) throw new Error(`path must be strictly contained by managed root: ${path}`);
  let cursor = stop;
  if (!lstatSync(cursor).isDirectory() || lstatSync(cursor).isSymbolicLink()) throw new Error(`managed root must be a real directory: ${cursor}`);
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) return;
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`refusing symlink path component: ${cursor}`);
    if (!metadata.isDirectory()) throw new Error(`path ancestor must be a directory: ${cursor}`);
  }
}

function syntheticRelease(name, digit, counts, baseline = false) {
  return {
    id: `synthetic-${name}-2038-01-19`, previous_entry_hash: baseline ? null : `sha256:${'a'.repeat(64)}`,
    entry_hash: `sha256:${digit.repeat(64)}`, changes: { to_dataset_version: `sha256:${'f'.repeat(64)}`, counts },
  };
}

const zero = { added: 0, removed: 0, modified: 0, country_metadata_added: 0, country_metadata_removed: 0, country_metadata_modified: 0, total_changes: 0 };
const SCENARIOS = Object.freeze({
  baseline: syntheticRelease('baseline', '1', zero, true),
  'no-change': syntheticRelease('no-change', '2', zero),
  added: syntheticRelease('added', '3', { ...zero, added: 2, total_changes: 2 }),
  modified: syntheticRelease('modified', '4', { ...zero, removed: 1, total_changes: 1 }),
  'country-metadata': syntheticRelease('country-metadata', '5', { ...zero, country_metadata_added: 1, country_metadata_modified: 1, total_changes: 2 }),
});

function generateInto({ source, output, managedRoot, afterWrite }) {
  assertRealDirectoryChain(source, managedRoot);
  const sourceMetadata = lstatSync(source);
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) throw new Error('contract source must be a real directory');
  assertRealDirectoryChain(dirname(output), managedRoot);
  if (existsSync(output)) {
    if (lstatSync(output).isSymbolicLink()) throw new Error('subscription output must not be a symlink');
    throw new Error('subscription output must not already exist; the build must recreate its managed parent first');
  }
  if (readdirSync(dirname(output)).length !== 0) throw new Error('subscription output parent must be newly clean and empty');
  const actual = readdirSync(source).sort();
  if (actual.length !== CONTRACT_FILES.length || actual.some((name, index) => name !== CONTRACT_FILES[index])) throw new Error('contract source must contain the exact file manifest');
  for (const name of CONTRACT_FILES) {
    assertRealDirectoryChain(source, managedRoot);
    const sourcePath = resolve(source, name);
    const metadata = lstatSync(sourcePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`contract source entry must be a regular non-symlink file: ${name}`);
  }
  assertRealDirectoryChain(dirname(output), managedRoot);
  let createdOutput = false;
  try {
    mkdirSync(output);
    createdOutput = true;
    for (const [index, name] of CONTRACT_FILES.entries()) {
      assertRealDirectoryChain(source, managedRoot);
      assertRealDirectoryChain(output, managedRoot);
      const sourcePath = resolve(source, name);
      if (lstatSync(sourcePath).isSymbolicLink() || !lstatSync(sourcePath).isFile()) throw new Error(`contract source entry changed type: ${name}`);
      writeFileSync(resolve(output, name), readFileSync(sourcePath), { flag: 'wx' });
      afterWrite?.({ phase: 'contract', name, index });
    }
    for (const [index, [name, release]] of Object.entries(SCENARIOS).entries()) {
      assertRealDirectoryChain(output, managedRoot);
      const fixtureName = `fixture-${name}.json`;
      writeFileSync(resolve(output, fixtureName), canonicalBytes(buildEvent({ release, timestamp: SYNTHETIC_TIMESTAMP })), { flag: 'wx' });
      afterWrite?.({ phase: 'fixture', name: fixtureName, index });
    }
  } catch (error) {
    if (createdOutput) {
      assertRealDirectoryChain(output, managedRoot);
      const metadata = lstatSync(output);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`refusing unsafe failed-generation cleanup for ${output}`, { cause: error });
      rmSync(output, { recursive: true });
    }
    throw error;
  }
}

export function generateSubscriptionContracts() {
  generateInto({ source: SOURCE, output: OUTPUT, managedRoot: REPO_ROOT });
}

// Test-only entry point. Production callers must use the fixed zero-argument function above.
export function generateSubscriptionContractsForTest({ source, output, managedRoot, afterWrite }) {
  generateInto({ source: resolve(source), output: resolve(output), managedRoot: resolve(managedRoot), afterWrite });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateSubscriptionContracts();
