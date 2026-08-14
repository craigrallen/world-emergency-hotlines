import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const assets = new Map([
  ['social-card.png', [1200, 630]],
  ['apple-touch-icon.png', [180, 180]],
  ['favicon-192x192.png', [192, 192]],
  ['favicon-32x32.png', [32, 32]],
]);
const generated = await mkdtemp(join(tmpdir(), 'weh-seo-images-'));

try {
  const run = spawnSync(process.execPath, [join(root, 'scripts/generate-seo-images.mjs'), '--output-dir', generated], { stdio: 'inherit' });
  if (run.status !== 0) process.exitCode = run.status ?? 1;
  else {
    for (const [name, [width, height]] of assets) {
      const expectedPath = join(root, 'public', name);
      const generatedPath = join(generated, name);
      const [expected, actual, metadata] = await Promise.all([
        readFile(expectedPath), readFile(generatedPath), sharp(generatedPath).metadata(),
      ]);
      if (!expected.equals(actual)) throw new Error(`${name} is stale; run npm run generate:seo-images`);
      if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height) {
        throw new Error(`${name} must be a ${width}x${height} PNG`);
      }
    }
    console.log(`SEO image verification OK: ${assets.size} deterministic PNG artifacts byte-match committed files.`);
  }
} finally {
  await rm(generated, { recursive: true, force: true });
}
