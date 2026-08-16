import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const dockerignore = readFileSync(resolve(repo, '.dockerignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
if (!dockerignore.includes('reviews')) throw new Error('.dockerignore must exclude the complete reviews/ tree');

const dist = resolve(repo, 'web/dist');
const forbidden = ['reviews/multilingual-ui', 'internal-multilingual-ui-review-pack/v1', 'pending_not_reviewed', 'static_ui_runtime_dictionaries_only'];
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(dir, entry.name);
  return entry.isDirectory() ? files(path) : [path];
});
if (!existsSync(dist)) throw new Error('web/dist is absent; build current sources before the dist-only non-publication scan');
for (const path of files(dist)) {
  const bytes = readFileSync(path);
  for (const marker of forbidden) if (bytes.includes(Buffer.from(marker))) throw new Error(`internal review-pack marker published in ${path}`);
}
console.log('Internal review-pack non-publication OK: current web/dist scanned');
