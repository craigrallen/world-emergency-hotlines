import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { inflateSync } from 'node:zlib';
import { PWA_CONTROL_INPUTS, PWA_OUTPUTS, generatePwaAssetBytes } from './generate-pwa-assets.mjs';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(WEB_ROOT, '..');
const PUBLIC_ROOT = resolve(WEB_ROOT, 'public');
const errors = [];
const fail = (message) => errors.push(message);
const safeRead = (path, label) => {
  try { return readFileSync(path); } catch (error) { fail(`cannot read ${label}: ${error.message}`); return null; }
};
const safeJson = (bytes, label) => {
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch (error) { fail(`invalid ${label}: ${error.message}`); return null; }
};

const canonicalBytes = safeRead(resolve(REPO_ROOT, 'hotlines.json'), 'canonical hotlines.json prerequisite');
const canonical = safeJson(canonicalBytes, 'canonical hotlines.json prerequisite');
const datasetHash = canonicalBytes ? createHash('sha256').update(canonicalBytes).digest('hex') : null;
let expected = null;
if (datasetHash && /^\d{4}-\d{2}-\d{2}$/.test(canonical?.last_updated ?? '')) {
  try {
    expected = generatePwaAssetBytes({ webRoot: WEB_ROOT, datasetVersion: `sha256:${datasetHash}`, sourceLastUpdated: canonical.last_updated });
  } catch (error) { fail(`could not generate expected PWA bytes: ${error.message}`); }
} else if (canonical) fail('canonical hotlines.json prerequisite must contain a YYYY-MM-DD last_updated value');

if (expected) {
  for (const name of PWA_OUTPUTS) {
    const path = resolve(PUBLIC_ROOT, name);
    if (!existsSync(path)) { fail(`missing generated PWA artifact: public/${name}; run npm run data:build and commit the result`); continue; }
    const actual = safeRead(path, `public/${name}`);
    if (actual && !actual.equals(expected.get(name))) fail(`generated PWA byte drift: public/${name}; run npm run data:build, review, and commit the exact output`);
  }
}

const manifest = safeJson(safeRead(resolve(PUBLIC_ROOT, 'manifest.webmanifest'), 'public/manifest.webmanifest'), 'public/manifest.webmanifest');
if (manifest) {
  for (const field of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'icons']) if (!manifest[field]) fail(`manifest missing ${field}`);
  if (manifest.start_url !== '/' || manifest.scope !== '/' || manifest.display !== 'standalone') fail('manifest install scope/start/display changed');
  const icon = Array.isArray(manifest.icons) && manifest.icons.find((entry) => entry.src === '/pwa-icon-512.png');
  if (!icon || icon.sizes !== '512x512' || icon.type !== 'image/png' || icon.purpose !== 'any') fail('manifest must reference the reviewed 512x512 PNG install icon with purpose any');
}

const iconBytes = safeRead(resolve(PUBLIC_ROOT, 'pwa-icon-512.png'), 'public/pwa-icon-512.png');
if (iconBytes) {
  try {
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!iconBytes.subarray(0, 8).equals(pngSignature)) throw new Error('invalid PNG signature');
    const chunks = [];
    for (let offset = 8; offset < iconBytes.length;) {
      if (offset + 12 > iconBytes.length) throw new Error('truncated PNG chunk');
      const length = iconBytes.readUInt32BE(offset);
      const type = iconBytes.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + length > iconBytes.length) throw new Error(`truncated ${type} chunk`);
      chunks.push({ type, data: iconBytes.subarray(offset + 8, offset + 8 + length) });
      offset += 12 + length;
    }
    if (iconBytes.length > 70_000) throw new Error(`icon is ${iconBytes.length} bytes; expected at most 70000`);
    const ihdr = chunks[0];
    if (ihdr?.type !== 'IHDR' || ihdr.data.length !== 13 || ihdr.data.readUInt32BE(0) !== 512 || ihdr.data.readUInt32BE(4) !== 512 || !ihdr.data.subarray(8).equals(Buffer.from([2, 3, 0, 0, 0]))) throw new Error('expected 512x512 2-bit indexed-color non-interlaced IHDR');
    const palette = chunks.find(({ type }) => type === 'PLTE');
    const expectedPalette = Buffer.from([245, 247, 251, 29, 78, 216, 255, 255, 255]);
    if (!palette?.data.equals(expectedPalette)) throw new Error('expected exact three-color PLTE palette');
    if (chunks.at(-1)?.type !== 'IEND' || chunks.at(-1).data.length !== 0) throw new Error('missing terminal IEND');
    const decoded = inflateSync(Buffer.concat(chunks.filter(({ type }) => type === 'IDAT').map(({ data }) => data)));
    const rowBytes = 512 / 4;
    if (decoded.length !== 512 * (1 + rowBytes)) throw new Error(`decoded ${decoded.length} scanline bytes instead of ${512 * (1 + rowBytes)}`);
    for (let y = 0; y < 512; y++) {
      const row = y * (1 + rowBytes);
      if (decoded[row] !== 0) throw new Error(`unsupported filter on row ${y}`);
      for (let x = 0; x < 512; x++) {
        const actual = (decoded[row + 1 + (x >>> 2)] >>> (6 - 2 * (x & 3))) & 3;
        const inCard = x >= 56 && x < 456 && y >= 56 && y < 456;
        const inCross = (x >= 218 && x < 294 && y >= 132 && y < 380) || (y >= 218 && y < 294 && x >= 132 && x < 380);
        const wanted = inCross ? 2 : inCard ? 1 : 0;
        if (actual !== wanted) throw new Error(`unexpected palette index ${actual} at ${x},${y}`);
      }
    }
  } catch (error) { fail(`pwa-icon-512.png is not the exact decodable compact indexed PNG: ${error.message}`); }
}

for (const input of PWA_CONTROL_INPUTS) {
  const path = input.startsWith('repo:') ? resolve(REPO_ROOT, input.slice(5)) : resolve(WEB_ROOT, input);
  if (!existsSync(path)) fail(`missing offline-shell controlling source: ${input}`);
}

const layout = safeRead(resolve(WEB_ROOT, 'src/layouts/Base.astro'), 'src/layouts/Base.astro')?.toString('utf8') ?? '';
if (!layout.includes('rel="manifest" href="/manifest.webmanifest"') || !layout.includes('src="/pwa-register.js"')) fail('common layout does not link manifest and registration');
if (!layout.includes('role="status"') || !layout.includes('aria-live="polite"') || !layout.includes('data-offline-status')) fail('common layout lacks accessible offline status');

const caddy = safeRead(resolve(REPO_ROOT, 'Caddyfile'), 'repo Caddyfile')?.toString('utf8') ?? '';
if (!/@media[\s\S]*not path \/service-worker\.js/.test(caddy) || !caddy.includes('header @serviceWorker Cache-Control "no-cache"') || !caddy.includes('application/manifest+json')) fail('Caddy must exclude the worker from general media caching and set worker no-cache plus manifest MIME');

const releaseIndex = safeJson(safeRead(resolve(PUBLIC_ROOT, 'release/v1/artifacts.json'), 'generated release metadata prerequisite public/release/v1/artifacts.json'), 'generated release metadata prerequisite public/release/v1/artifacts.json');
if (releaseIndex?.artifacts) {
  const indexed = new Set(releaseIndex.artifacts.map((artifact) => artifact.path));
  for (const name of PWA_OUTPUTS) if (!indexed.has(`/${name}`)) fail(`release checksum index missing /${name}; run npm run data:build before verify:pwa`);
}

async function verifyWorkerBehavior(source) {
  const createDeferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const cacheStorage = new Map();
  const deleted = [];
  const fallback = { kind: 'fixed-offline-fallback' };
  const network = { mode: 'success', calls: [] };
  const makeCache = (fallbackResponse = fallback) => ({
    matchCalls: [], writes: [], fallbackResponse,
    addAll(requests) { this.writes.push({ operation: 'addAll', requests }); return Promise.resolve(); },
    add(request) { this.writes.push({ operation: 'add', request }); return Promise.resolve(); },
    put(request, response) { this.writes.push({ operation: 'put', request, response }); return Promise.resolve(); },
    match(path) { this.matchCalls.push(path); return Promise.resolve(this.fallbackResponse); },
  });
  const caches = {
    async open(name) { if (!cacheStorage.has(name)) cacheStorage.set(name, makeCache()); return cacheStorage.get(name); },
    async keys() { return [...cacheStorage.keys()]; },
    async delete(name) { deleted.push(name); return cacheStorage.delete(name); },
  };
  class WorkerRequest {
    constructor(url, options = {}) { this.url = url; this.cache = options.cache; }
  }
  const evaluateWorker = (workerSource) => {
    const listeners = new Map();
    let claimCalls = 0;
    const context = {
      URL, Request: WorkerRequest, Response, caches,
      fetch(request) { network.calls.push(request.url); return network.mode === 'success' ? Promise.resolve({ kind: 'network', url: request.url }) : network.mode === 'deferred' ? network.deferred.promise : Promise.reject(new Error('offline')); },
      self: { location: { origin: 'https://worldhotlines.org' }, clients: { claim: async () => { claimCalls++; } }, addEventListener(type, callback) { listeners.set(type, callback); } },
    };
    vm.runInNewContext(workerSource, context, { filename: 'service-worker.js', timeout: 1000 });
    return { listeners, claimCalls: () => claimCalls };
  };
  if (source.includes('skipWaiting')) fail('worker source must not contain skipWaiting');
  const newWorker = evaluateWorker(source);
  const listeners = newWorker.listeners;
  let installWaitUntilCalled = false;
  let installPromise = Promise.resolve();
  listeners.get('install')({ waitUntil(value) { installWaitUntilCalled = true; installPromise = Promise.resolve(value); } });
  if (!installWaitUntilCalled) fail('worker install did not register its precache with waitUntil');
  await installPromise;
  const newCacheName = [...cacheStorage.keys()][0];
  const cache = cacheStorage.get(newCacheName);
  if (cache.writes.length !== 1 || cache.writes[0].operation !== 'addAll' || cache.writes[0].requests.length !== 5) fail('worker install did not perform exactly one finite five-request shell precache');
  const installWrites = cache.writes.splice(0);
  const dispatch = async (workerListeners, { url, method = 'GET', mode = 'navigate' }) => {
    let responsePromise;
    workerListeners.get('fetch')({ request: { url, method, mode }, respondWith(value) { responsePromise = Promise.resolve(value); } });
    return responsePromise ? responsePromise.then((response) => ({ handled: true, response })) : { handled: false };
  };
  for (const url of ['https://worldhotlines.org/country/se', 'https://worldhotlines.org/category/crisis', 'https://worldhotlines.org/find-help?lang=sv', 'https://worldhotlines.org/map?view=list']) {
    network.mode = 'failure';
    const result = await dispatch(listeners, { url });
    if (!result.handled || result.response !== fallback) fail(`worker did not return the fixed fallback for failed same-origin navigation: ${url}`);
  }
  if (cache.matchCalls.some((key) => key !== '/offline.html') || new Set(cache.matchCalls).size !== 1) fail('worker fallback uses request- or query-derived cache keys instead of only /offline.html');
  network.mode = 'success';
  const success = await dispatch(listeners, { url: 'https://worldhotlines.org/country/se?lang=sv' });
  if (!success.handled || success.response?.kind !== 'network') fail('worker is not network-first for successful same-origin navigation');
  for (const request of [
    { url: 'https://worldhotlines.org/api/v1/manifest.json', mode: 'cors' },
    { url: 'https://worldhotlines.org/data/manifest.json', mode: 'cors' },
    { url: 'https://worldhotlines.org/widget/v1/hotlines-widget.js', mode: 'no-cors' },
    { url: 'https://other.example/country/se', mode: 'navigate' },
    { url: 'https://worldhotlines.org/country/se', method: 'POST', mode: 'navigate' },
  ]) if ((await dispatch(listeners, request)).handled) fail(`worker unexpectedly intercepted passthrough request: ${request.url}`);
  if (cache.writes.length !== 0) fail(`worker behavior harness observed ${cache.writes.length} fetch-time cache write(s)`);
  if (installWrites.length !== 1) fail('worker behavior harness lost the separately accounted install-time cache write');

  const oldCacheName = 'weh-offline-shell-v1-old-controlled-worker';
  const oldFallback = { kind: 'old-worker-fallback' };
  cacheStorage.set(oldCacheName, makeCache(oldFallback));
  const oldSource = source.replaceAll(newCacheName, oldCacheName);
  const oldWorker = evaluateWorker(oldSource);
  network.mode = 'deferred';
  network.deferred = createDeferred();
  const inFlight = dispatch(oldWorker.listeners, { url: 'https://worldhotlines.org/country/old-client' });
  await Promise.resolve();
  if (deleted.length || !cacheStorage.has(oldCacheName)) fail('waiting update deleted the old controlled worker cache before activation');
  network.mode = 'failure';
  network.deferred.resolve(Promise.reject(new Error('offline during old-worker request')));
  const oldResult = await inFlight;
  if (!oldResult.handled || oldResult.response !== oldFallback) fail('old worker in-flight navigation lost its old-cache fallback while update waited');
  if (deleted.length || !cacheStorage.has(oldCacheName)) fail('installed update cleaned caches without receiving its lifecycle-controlled activate event');
  let activateWaitUntilCalled = false;
  let activatePromise = Promise.resolve();
  listeners.get('activate')({ waitUntil(value) { activateWaitUntilCalled = true; activatePromise = Promise.resolve(value); } });
  if (!activateWaitUntilCalled) fail('worker activate did not protect cache cleanup with waitUntil');
  await activatePromise;
  if (cacheStorage.has(oldCacheName) || !deleted.includes(oldCacheName)) fail('activated worker did not delete the older project cache');
  if (!cacheStorage.has(newCacheName) || deleted.includes(newCacheName)) fail('activated worker deleted its current cache');
  if (newWorker.claimCalls() !== 1) fail('activated worker did not claim clients exactly once after cleanup');
}

const worker = safeRead(resolve(PUBLIC_ROOT, 'service-worker.js'), 'public/service-worker.js');
if (worker) {
  try { await verifyWorkerBehavior(worker.toString('utf8')); } catch (error) { fail(`service-worker behavior harness failed: ${error.stack ?? error.message}`); }
}

if (errors.length) {
  console.error(`PWA verification failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('PWA readiness OK: exact five-file parity, compact deterministic indexed icon, safe waiting/activation concurrency, complete network-first fallback, no runtime writes, release/Caddy coverage');
