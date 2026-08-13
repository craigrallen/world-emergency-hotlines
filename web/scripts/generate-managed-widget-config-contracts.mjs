import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const SOURCE = resolve(REPO_ROOT, 'managed-widget-config/contracts/v1');
const OUTPUT = resolve(WEB_ROOT, 'public/managed-widget-config/v1');
const CATEGORY_STATS = resolve(WEB_ROOT, 'public/data/categories-stats.json');

export const FILES = Object.freeze([
  'README.md',
  'config.schema.json',
  'envelope.schema.json',
  'fixture.synthetic.json',
  'keys.synthetic.json',
  'openapi.json',
]);

function checkedDirectory(root, label, managedRoot = REPO_ROOT) {
  safeContained(root, managedRoot, label);
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(FILES)) {
    throw new Error(`unexpected ${label} manifest`);
  }
  for (const name of FILES) {
    const item = lstatSync(resolve(root, name));
    if (item.isSymbolicLink() || !item.isFile()) {
      throw new Error(`unsafe ${label} entry`);
    }
  }
}

function safeContained(path, root, label) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || rel.split(sep).some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe ${label}`);
  }
  let cursor = root;
  const rootMetadata = lstatSync(cursor);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('managed root must be a real directory');
  }
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) return;
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`refusing symlink path component: ${cursor}`);
    if (cursor !== path && !metadata.isDirectory()) {
      throw new Error(`path ancestor is not a directory: ${cursor}`);
    }
  }
}

export function verifySupportedCategoryDrift(
  schemaPath = resolve(SOURCE, 'config.schema.json'),
  statsPath = CATEGORY_STATS,
  publishedSlugs = null,
) {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const declared = schema.properties.filters.properties.categories.items.enum;
  const published = publishedSlugs === null
    ? (() => {
        const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
        if (!Array.isArray(stats.categories) || stats.categories.length === 0) {
          throw new Error('categories-stats.categories must be a non-empty array');
        }
        return stats.categories.map((category) => {
          if (!category || typeof category !== 'object' || typeof category.slug !== 'string') {
            throw new Error('categories-stats entry must contain a slug');
          }
          return category.slug;
        });
      })()
    : publishedSlugs;
  if (!Array.isArray(published) || published.some((slug) => typeof slug !== 'string')) {
    throw new Error('published categories must be an array of slugs');
  }
  published.sort();
  if (JSON.stringify(declared) !== JSON.stringify(published)) {
    throw new Error('managed widget category enum drifted from published categories');
  }
}

export function verifyManagedWidgetConfigContractDrift(
  source = SOURCE,
  output = OUTPUT,
  managedRoot = REPO_ROOT,
  publishedSlugs = null,
) {
  checkedDirectory(source, 'managed widget config source', managedRoot);
  checkedDirectory(output, 'managed widget config output', managedRoot);
  for (const name of FILES) {
    if (!readFileSync(resolve(source, name)).equals(readFileSync(resolve(output, name)))) {
      throw new Error(`stale managed widget config contract: ${name}`);
    }
  }
  verifySupportedCategoryDrift(resolve(source, 'config.schema.json'), CATEGORY_STATS, publishedSlugs);
}

export function generateManagedWidgetConfigContracts(
  source = SOURCE,
  output = OUTPUT,
  managedRoot = REPO_ROOT,
) {
  return generateInto(resolve(source), resolve(output), resolve(managedRoot));
}

function generateInto(source, output, managedRoot, afterWrite) {
  checkedDirectory(source, 'managed widget config source', managedRoot);
  verifySupportedCategoryDrift(resolve(source, 'config.schema.json'));
  safeContained(output, managedRoot, 'managed widget config output');
  if (existsSync(output)) throw new Error('managed widget config output must be recreated');
  const temporary = `${output}.tmp-${process.pid}`;
  safeContained(temporary, managedRoot, 'managed widget config temporary output');
  if (existsSync(temporary)) throw new Error('managed widget config temporary output already exists');
  try {
    mkdirSync(temporary);
    for (const [index, name] of FILES.entries()) {
      writeFileSync(resolve(temporary, name), readFileSync(resolve(source, name)), { flag: 'wx' });
      afterWrite?.({ name, index });
    }
    renameSync(temporary, output);
  } catch (error) {
    if (existsSync(temporary) && !lstatSync(temporary).isSymbolicLink()) {
      rmSync(temporary, { recursive: true });
    }
    throw error;
  }
}

export function generateManagedWidgetConfigContractsForTest(options) {
  return generateInto(
    resolve(options.source),
    resolve(options.output),
    resolve(options.managedRoot),
    options.afterWrite,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateManagedWidgetConfigContracts();
}
