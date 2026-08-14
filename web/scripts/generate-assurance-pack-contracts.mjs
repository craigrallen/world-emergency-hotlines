import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAssurancePack, validateAssurancePack } from '../../assurance-packs/model.mjs';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const SOURCE = resolve(REPO_ROOT, 'assurance-packs/contracts/v1');
const OUTPUT = resolve(WEB_ROOT, 'public/assurance-packs/v1');
export const FILES = Object.freeze(['README.md', 'assurance-pack.schema.json', 'assurance-pack.synthetic.json']);
export const DERIVATION_FILES = Object.freeze([
  'assurance-packs/fixtures/evidence.synthetic.json',
  'assurance-packs/fixtures/trust-policy.synthetic.json',
  'hotlines.json',
  'assurance-packs/fixtures/assessed-release.synthetic.json',
  'assurance-packs/fixtures/assessed-artifacts.synthetic.json',
]);

function components(path, root) {
  const rel = relative(root, path); if (!rel || rel.startsWith('..') || rel.split(sep).some((part) => !part || part === '.' || part === '..')) throw new Error('unsafe assurance-pack path');
  const values = [{ path: root, metadata: lstatSync(root) }]; let cursor = root;
  for (const part of rel.split(sep)) { cursor = resolve(cursor, part); if (!existsSync(cursor)) break; values.push({ path: cursor, metadata: lstatSync(cursor) }); }
  for (const [index, item] of values.entries()) { if (item.metadata.isSymbolicLink()) throw new Error(`refusing assurance-pack symlink component: ${item.path}`); if (index < values.length - 1 && !item.metadata.isDirectory()) throw new Error(`assurance-pack ancestor is not a directory: ${item.path}`); }
  return values;
}
function unchanged(pins) { for (const pin of pins) { const now = lstatSync(pin.path); if (now.isSymbolicLink() || now.dev !== pin.metadata.dev || now.ino !== pin.metadata.ino) throw new Error(`assurance-pack path replaced during generation: ${pin.path}`); } }
function fileIdentity(metadata) { return { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs }; }
function sameFileIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function readExact(path, expected) {
  if (constants.O_NOFOLLOW === undefined) throw new Error('assurance-pack generation requires O_NOFOLLOW support');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const opened = fstatSync(fd); if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) throw new Error(`assurance-pack source changed during read: ${path}`); const bytes = readFileSync(fd); const after = fstatSync(fd); if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes.length) throw new Error(`assurance-pack source changed during read: ${path}`); return bytes; } finally { closeSync(fd); }
}
function inspect(root, managedRoot = REPO_ROOT) {
  const pins = components(root, managedRoot); const metadata = lstatSync(root); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('assurance-pack root must be a real directory');
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify([...FILES])) throw new Error('unexpected assurance-pack contract manifest');
  const bytes = new Map(); for (const name of FILES) { const path = resolve(root, name); const file = lstatSync(path); if (!file.isFile() || file.isSymbolicLink()) throw new Error(`unsafe assurance-pack artifact: ${name}`); bytes.set(name, readExact(path, file)); }
  unchanged(pins); return { pins, bytes };
}
function inspectFile(path, managedRoot) {
  const pins = components(path, managedRoot); const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`unsafe assurance-pack derivation input: ${path}`);
  const read = () => {
    if (constants.O_NOFOLLOW === undefined) throw new Error('assurance-pack generation requires O_NOFOLLOW support');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd, { bigint: true }); const bytes = readFileSync(fd); const after = fstatSync(fd, { bigint: true });
      if (!before.isFile() || !sameFileIdentity(fileIdentity(before), fileIdentity(after)) || BigInt(bytes.length) !== before.size) throw new Error(`assurance-pack derivation input changed during read: ${path}`);
      return { bytes, identity: fileIdentity(after), digest: digest(bytes) };
    } finally { closeSync(fd); }
  };
  const first = read(); const second = read();
  if (!sameFileIdentity(first.identity, second.identity) || first.digest !== second.digest || !first.bytes.equals(second.bytes)) throw new Error(`assurance-pack derivation input was not digest-stable: ${path}`);
  unchanged(pins); return { path, managedRoot, pins, bytes: second.bytes, identity: second.identity, digest: second.digest };
}
function verifyDependency(state) {
  const current = inspectFile(state.path, state.managedRoot);
  if (!sameFileIdentity(current.identity, state.identity) || current.bytes.length !== state.bytes.length || current.digest !== state.digest || !current.bytes.equals(state.bytes)) throw new Error(`assurance-pack derivation dependency changed during generation: ${state.path}`);
}
function validateJsonSchema(value, schema, root = schema, path = '$') {
  if (schema.$ref) { const target = schema.$ref.split('/').slice(1).reduce((node, key) => node[key.replaceAll('~1', '/').replaceAll('~0', '~')], root); return validateJsonSchema(value, target, root, path); }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) throw new Error(`${path} violates const`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} violates enum`);
  if (schema.allOf) for (const candidate of schema.allOf) validateJsonSchema(value, candidate, root, path);
  if (schema.oneOf) { let matches = 0; for (const candidate of schema.oneOf) { try { validateJsonSchema(value, candidate, root, path); matches++; } catch {} } if (matches !== 1) throw new Error(`${path} violates oneOf`); }
  if (schema.if) { let matched = true; try { validateJsonSchema(value, schema.if, root, path); } catch { matched = false; } if (matched && schema.then) validateJsonSchema(value, schema.then, root, path); if (!matched && schema.else) validateJsonSchema(value, schema.else, root, path); }
  if (schema.type === 'object' || schema.properties || schema.required) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} must be object`); for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required`); if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) throw new Error(`${path}.${key} is prohibited`); for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in value) validateJsonSchema(value[key], child, root, `${path}.${key}`); }
  if (schema.type === 'array') { if (!Array.isArray(value)) throw new Error(`${path} must be array`); if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} is too short`); if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) throw new Error(`${path} must be unique`); value.forEach((item, index) => validateJsonSchema(item, schema.items, root, `${path}[${index}]`)); }
  if (schema.type === 'string') { if (typeof value !== 'string') throw new Error(`${path} must be string`); if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) throw new Error(`${path} violates pattern`); }
  if (schema.type === 'integer') { if (!Number.isInteger(value)) throw new Error(`${path} must be integer`); if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} is too small`); if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} is too large`); }
  if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} is too small`);
  if (schema.type === 'null' && value !== null) throw new Error(`${path} must be null`);
}
function validateSource(bytes, dependencyRoot = REPO_ROOT, hooks = {}) {
  let schema, pack; try { schema = JSON.parse(bytes.get('assurance-pack.schema.json')); pack = JSON.parse(bytes.get('assurance-pack.synthetic.json')); } catch { throw new Error('assurance-pack JSON is invalid'); }
  const states = new Map(DERIVATION_FILES.map((name) => [name, inspectFile(resolve(dependencyRoot, name), dependencyRoot)]));
  hooks.afterDependenciesRead?.(); for (const state of states.values()) verifyDependency(state);
  let input, policy; try {
    input = JSON.parse(states.get(DERIVATION_FILES[0]).bytes); policy = JSON.parse(states.get(DERIVATION_FILES[1]).bytes); JSON.parse(states.get(DERIVATION_FILES[2]).bytes);
  } catch { throw new Error('assurance-pack derivation JSON is invalid'); }
  const release = states.get(DERIVATION_FILES[3]).bytes; const index = states.get(DERIVATION_FILES[4]).bytes;
  validateJsonSchema(pack, schema); validateAssurancePack(pack);
  if (JSON.stringify(deriveAssurancePack(input, policy, states.get(DERIVATION_FILES[1]).bytes, states.get(DERIVATION_FILES[2]).bytes, release, index)) !== JSON.stringify(pack)) throw new Error('assurance-pack deterministic derivation is stale');
  for (const state of states.values()) verifyDependency(state); return states;
}

export function generateAssurancePackContracts(source = SOURCE, output = OUTPUT, managedRoot = REPO_ROOT, hooks = {}) {
  source = resolve(source); output = resolve(output); managedRoot = resolve(managedRoot); const dependencyRoot = resolve(hooks.dependencyRoot ?? REPO_ROOT); const sourceState = inspect(source, managedRoot); const dependencyStates = validateSource(sourceState.bytes, dependencyRoot, hooks);
  const outputComponents = components(output, managedRoot); if (existsSync(output)) throw new Error('assurance-pack output must be recreated'); const parent = resolve(output, '..'); const parentPins = components(parent, managedRoot); if (!lstatSync(parent).isDirectory()) throw new Error('assurance-pack output parent must be a real directory');
  const stage = `${output}.tmp-${process.pid}`; components(stage, managedRoot); let stagePin;
  try {
    mkdirSync(stage, { mode: 0o755 }); stagePin = lstatSync(stage); if (!stagePin.isDirectory() || stagePin.isSymbolicLink()) throw new Error('unsafe assurance-pack stage');
    for (const name of FILES) { const target = resolve(stage, name); const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644); try { writeFileSync(fd, sourceState.bytes.get(name)); } finally { closeSync(fd); } }
    const staged = inspect(stage, managedRoot); for (const name of FILES) if (!staged.bytes.get(name).equals(sourceState.bytes.get(name))) throw new Error(`staged assurance-pack bytes changed: ${name}`);
    hooks.beforePublish?.(); unchanged(sourceState.pins); for (const state of dependencyStates.values()) verifyDependency(state); unchanged(parentPins); if (existsSync(output)) throw new Error('assurance-pack output appeared during generation'); const now = lstatSync(stage); if (now.dev !== stagePin.dev || now.ino !== stagePin.ino || now.isSymbolicLink()) throw new Error('assurance-pack stage replaced during generation'); renameSync(stage, output); unchanged(outputComponents.filter((x) => x.path !== output));
  } catch (error) {
    if (stagePin && existsSync(stage)) { const now = lstatSync(stage); if (!now.isSymbolicLink() && now.dev === stagePin.dev && now.ino === stagePin.ino) rmSync(stage, { recursive: true }); }
    throw error;
  }
}

export function verifyAssurancePackContractDrift() { const source = inspect(SOURCE), output = inspect(OUTPUT); validateSource(source.bytes); for (const name of FILES) if (!source.bytes.get(name).equals(output.bytes.get(name))) throw new Error(`stale assurance-pack contract: ${name}`); }
if (process.argv[1] === fileURLToPath(import.meta.url)) generateAssurancePackContracts();
