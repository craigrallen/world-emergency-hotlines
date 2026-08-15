import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PWA_OUTPUTS = ['manifest.webmanifest', 'offline.html', 'pwa-register.js', 'service-worker.js', 'pwa-icon-512.png'];
export const PWA_CONTROL_INPUTS = ['scripts/generate-pwa-assets.mjs', 'src/layouts/Base.astro', 'repo:Caddyfile'];

const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const shortVersion = (value) => value.replace(/^sha256:/, '').slice(0, 12);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function storedZlib(bytes) {
  const blocks = [Buffer.from([0x78, 0x01])];
  for (let offset = 0; offset < bytes.length;) {
    const length = Math.min(65535, bytes.length - offset);
    const header = Buffer.alloc(5);
    header[0] = offset + length === bytes.length ? 1 : 0;
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE(0xffff ^ length, 3);
    blocks.push(header, bytes.subarray(offset, offset + length));
    offset += length;
  }
  let a = 1;
  let b = 0;
  for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  blocks.push(adler);
  return Buffer.concat(blocks);
}

function generateInstallIcon() {
  const size = 512;
  const packedRowBytes = size / 4;
  const scanlines = Buffer.alloc(size * (1 + packedRowBytes));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + packedRowBytes);
    scanlines[row] = 0;
    for (let x = 0; x < size; x++) {
      const inCard = x >= 56 && x < 456 && y >= 56 && y < 456;
      const inVertical = x >= 218 && x < 294 && y >= 132 && y < 380;
      const inHorizontal = y >= 218 && y < 294 && x >= 132 && x < 380;
      const paletteIndex = inVertical || inHorizontal ? 2 : inCard ? 1 : 0;
      const offset = row + 1 + (x >>> 2);
      scanlines[offset] |= paletteIndex << (6 - 2 * (x & 3));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([2, 3, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', Buffer.from([245, 247, 251, 29, 78, 216, 255, 255, 255])),
    pngChunk('IDAT', storedZlib(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function controlIdentity(webRoot) {
  const hash = createHash('sha256');
  for (const input of PWA_CONTROL_INPUTS) {
    const path = input.startsWith('repo:') ? resolve(webRoot, '..', input.slice(5)) : resolve(webRoot, input);
    const bytes = readFileSync(path);
    hash.update(`${Buffer.byteLength(input)}:`).update(input).update(`:${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}

export function generatePwaAssetBytes({ webRoot, datasetVersion, sourceLastUpdated }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(datasetVersion)) throw new Error('PWA datasetVersion must be an exact SHA-256 identity');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceLastUpdated ?? '')) throw new Error('PWA sourceLastUpdated must be YYYY-MM-DD');

  const shellVersion = createHash('sha256').update(controlIdentity(webRoot)).update(datasetVersion).digest('hex');
  const cacheName = `weh-offline-shell-v1-${shellVersion}`;
  const datasetLabel = shortVersion(datasetVersion);
  const manifest = {
    id: '/', name: 'World Emergency & Hotlines', short_name: 'Hotlines',
    description: 'A free public directory for manually finding emergency and crisis support listings. Offline mode is a limited shell, not a hotline pack.',
    start_url: '/', scope: '/', display: 'standalone', background_color: '#f5f7fb', theme_color: '#f5f7fb',
    icons: [
      { src: '/favicon-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/pwa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
  const offlineTitle = 'Limited offline shell · World Emergency & Hotlines';
  const offlineDescription = 'A limited cached readiness shell with no hotline, country, category, search, widget, API, or full-dataset results.';
  const socialAlt = 'World Emergency & Hotlines — listings across countries and territories worldwide; coverage varies';
  const offline = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f5f7fb"><meta name="robots" content="noindex,follow"><title>${offlineTitle}</title><meta name="description" content="${offlineDescription}">
<meta property="og:site_name" content="World Emergency &amp; Hotlines"><meta property="og:title" content="${offlineTitle}"><meta property="og:description" content="${offlineDescription}"><meta property="og:type" content="website"><meta property="og:image" content="https://worldhotlines.org/social-card.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:type" content="image/png"><meta property="og:image:alt" content="${socialAlt}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${offlineTitle}"><meta name="twitter:description" content="${offlineDescription}"><meta name="twitter:image" content="https://worldhotlines.org/social-card.png"><meta name="twitter:image:alt" content="${socialAlt}">
<style>html{font-family:ui-sans-serif,system-ui,sans-serif;color:#111827;background:#f5f7fb}body{max-width:44rem;margin:0 auto;padding:2rem 1rem;line-height:1.55}main{background:#fff;border:1px solid #ced6e4;border-radius:1.5rem;padding:clamp(1.25rem,5vw,2.5rem)}h1{line-height:1.1}a{color:#1d4ed8}.notice{border-left:.3rem solid #d97706;padding:.75rem 1rem;background:#fffbeb}.meta{font-size:.875rem;color:#58637c;overflow-wrap:anywhere}</style></head>
<body><main><p aria-label="World Emergency and Hotlines">🆘 Hotlines</p><h1>You are viewing the limited offline shell</h1>
<p class="notice"><strong>This is not an offline country pack.</strong> It contains no cached country, category, search, hotline, widget, static API, or full-dataset results.</p>
<p>Your requested page could not be loaded from the network. Reconnect, then return to the <a href="/">finder</a> and manually select a location. This site never requests geolocation.</p>
<p>Cached content does not prove that any service is currently available, reachable, suitable, or unchanged. In immediate danger, contact local emergency services using information you trust for your location.</p>
<p class="meta">Offline shell version: <code>${shellVersion}</code><br>Built against dataset <code>${datasetLabel}</code>; canonical source date: <time datetime="${sourceLastUpdated}">${sourceLastUpdated}</time>. These labels identify cached build inputs, not hotline freshness or completeness.</p>
</main></body></html>\n`;
  const serviceWorker = `/* Generated by scripts/generate-pwa-assets.mjs. */
const CACHE_NAME = ${JSON.stringify(cacheName)};
const SHELL_URLS = Object.freeze(['/offline.html', '/manifest.webmanifest', '/favicon-192x192.png', '/pwa-icon-512.png', '/favicon.svg']);
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS.map((path) => new Request(path, { cache: 'reload' })))));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith('weh-offline-shell-') && name !== CACHE_NAME).map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(request).catch(() => caches.open(CACHE_NAME).then((cache) => cache.match('/offline.html')).then((response) => response || Response.error())));
});
`;
  const registration = `/* No analytics or reporting: this script only manages the local offline shell. */
(() => {
  const status = document.querySelector('[data-offline-status]');
  const message = document.querySelector('[data-offline-message]');
  const show = (text) => { if (status && message) { message.textContent = text; status.hidden = false; } };
  const hide = () => { if (status) status.hidden = true; };
  const updateNetworkStatus = () => navigator.onLine ? hide() : show('You appear to be offline. Only the limited cached shell is available; hotline listings are not cached.');
  addEventListener('online', updateNetworkStatus);
  addEventListener('offline', updateNetworkStatus);
  updateNetworkStatus();
  if (!('serviceWorker' in navigator) || !isSecureContext) return;
  addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' }).catch(() => {}), { once: true });
})();
`;
  return new Map([
    ['manifest.webmanifest', Buffer.from(stableJson(manifest))], ['offline.html', Buffer.from(offline)],
    ['pwa-register.js', Buffer.from(registration)], ['service-worker.js', Buffer.from(serviceWorker)],
    ['pwa-icon-512.png', generateInstallIcon()],
  ]);
}

export function generatePwaAssets(options) {
  const publicRoot = resolve(options.webRoot, 'public');
  mkdirSync(publicRoot, { recursive: true });
  for (const [name, bytes] of generatePwaAssetBytes(options)) writeFileSync(resolve(publicRoot, name), bytes);
}

export function assertPwaAssetParity(options) {
  const publicRoot = resolve(options.webRoot, 'public');
  for (const [name, expected] of generatePwaAssetBytes(options)) {
    const path = resolve(publicRoot, name);
    if (!existsSync(path)) throw new Error(`missing generated PWA artifact public/${name}; run npm run generate:pwa and commit it`);
    if (!readFileSync(path).equals(expected)) throw new Error(`generated PWA byte drift in public/${name}; run npm run generate:pwa, review, and commit the exact output`);
  }
}
