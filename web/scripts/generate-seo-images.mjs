import sharp from 'sharp';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const outputFlag = args.indexOf('--output-dir');
if (outputFlag !== -1 && !args[outputFlag + 1]) throw new Error('--output-dir requires a path');
if (args.some((arg, index) => arg.startsWith('-') && index !== outputFlag)) throw new Error('Usage: generate-seo-images.mjs [--output-dir PATH]');
const outputDir = outputFlag === -1
  ? fileURLToPath(new URL('../public/', import.meta.url))
  : resolve(args[outputFlag + 1]);
await mkdir(outputDir, { recursive: true });

const source = await readFile(new URL('../assets/social-card.svg', import.meta.url));
const sourceText = source.toString('utf8');
if (/<text\b|font-family\s*=|@font-face\b|<font\b/i.test(sourceText)) {
  throw new Error('social-card.svg must use tracked vector geometry without fonts or text elements');
}
await sharp(source).png({ compressionLevel: 9, adaptiveFiltering: false, force: true }).toFile(resolve(outputDir, 'social-card.png'));
const icon = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="128" fill="#2563eb"/><path d="M256 112v288M112 256h288" stroke="white" stroke-width="68" stroke-linecap="round"/></svg>');
for (const [name, size] of [['favicon-32x32.png', 32], ['favicon-192x192.png', 192], ['apple-touch-icon.png', 180]]) {
  await sharp(icon).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9, adaptiveFiltering: false, force: true }).toFile(resolve(outputDir, name));
}
