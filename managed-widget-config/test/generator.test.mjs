import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import {
  FILES,
  generateManagedWidgetConfigContractsForTest,
} from '../../web/scripts/generate-managed-widget-config-contracts.mjs';

const sourceFixture = resolve(import.meta.dirname, '../contracts/v1');

function sandbox() {
  const managedRoot = mkdtempSync(resolve(tmpdir(), 'mwc-generator-'));
  const source = resolve(managedRoot, 'source/v1');
  const output = resolve(managedRoot, 'public/v1');
  mkdirSync(dirname(source), { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  cpSync(sourceFixture, source, { recursive: true });
  return { managedRoot, source, output };
}

test('generator publishes the exact manifest atomically', () => {
  const paths = sandbox();
  generateManagedWidgetConfigContractsForTest(paths);
  for (const name of FILES) {
    assert.deepEqual(readFileSync(resolve(paths.output, name)), readFileSync(resolve(paths.source, name)));
  }
  assert.throws(() => generateManagedWidgetConfigContractsForTest(paths), /must be recreated/);
});

test('generator removes an interrupted temporary tree without publishing output', () => {
  const paths = sandbox();
  assert.throws(() => generateManagedWidgetConfigContractsForTest({
    ...paths,
    afterWrite({ index }) {
      if (index === 1) throw new Error('simulated interruption');
    },
  }), /simulated interruption/);
  assert.equal(existsSync(paths.output), false);
  assert.equal(existsSync(`${paths.output}.tmp-${process.pid}`), false);
});

test('generator rejects escaped, symlinked, missing-parent, and occupied-temp paths', () => {
  {
    const paths = sandbox();
    assert.throws(() => generateManagedWidgetConfigContractsForTest({
      ...paths,
      output: resolve(paths.managedRoot, '../escaped-output'),
    }), /unsafe/);
  }
  {
    const paths = sandbox();
    const real = resolve(paths.managedRoot, 'real-public');
    const link = resolve(paths.managedRoot, 'linked-public');
    mkdirSync(real);
    symlinkSync(real, link, 'dir');
    assert.throws(() => generateManagedWidgetConfigContractsForTest({
      ...paths,
      output: resolve(link, 'v1'),
    }), /symlink/);
  }
  {
    const paths = sandbox();
    assert.throws(() => generateManagedWidgetConfigContractsForTest({
      ...paths,
      output: resolve(paths.managedRoot, 'missing/parent/v1'),
    }));
  }
  {
    const paths = sandbox();
    mkdirSync(`${paths.output}.tmp-${process.pid}`);
    assert.throws(() => generateManagedWidgetConfigContractsForTest(paths), /temporary output already exists/);
  }
});
