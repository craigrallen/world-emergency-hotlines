import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, 'cli.mjs');
const invoke = (args = ['demo'], executable = cli) => execFileSync(process.execPath, [executable, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

test('demo verifies every pinned synthetic observation class and produces deterministic non-empty analysis', () => {
  const first = invoke();
  assert.equal(first, invoke(), 'demo output is deterministic');
  const result = JSON.parse(first);
  assert.equal(result.assessment, 'corroborating_only_not_conclusive');
  assert.ok(result.signals.length > 0);
  assert.ok(result.signals.some(signal => signal.code === 'outward_in_canary_match'));
  assert.ok(result.signals.some(signal => signal.code === 'app_binary_metadata_match'));
});

test('CLI rejects issue/analyze, alternate paths, JSON, and every extra argument', () => {
  for (const args of [[], ['issue'], ['issue', 'input.json'], ['analyze'], ['analyze', 'input.json'], ['demo', 'input.json'], ['demo', '--key=production'], ['../fixtures/observations.synthetic.json']]) {
    assert.throws(() => invoke(args), /usage: node cli\.mjs demo/);
  }
});

test('production-like substitution cannot replace a pinned committed fixture', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'licensed-cli-'));
  try {
    cpSync(root, temp, {recursive: true});
    const fixturePath = resolve(temp, 'fixtures/observations.synthetic.json');
    const fixture = JSON.parse(readFileSync(fixturePath));
    fixture.presentation_observation.tenant_id = 'production-tenant';
    writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`);
    assert.throws(() => invoke(['demo'], resolve(temp, 'cli.mjs')), /refusing unpinned synthetic fixture/);
  } finally {
    rmSync(temp, {recursive: true, force: true});
  }
});
