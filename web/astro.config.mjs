// @ts-check
import { defineConfig } from 'astro/config';
import { SITE_URL } from './src/lib/site.js';

// Tailwind is wired via postcss.config.mjs (PostCSS plugin) — no @astrojs/tailwind needed.

// We start in `static` output and could flip to `hybrid` if SSR routes
// (api/*, country/*) ever need to read from a database. Keeping `static`
// means the site runs on any static host with no adapter required.
export default defineConfig({
  site: SITE_URL,
  output: 'static',
  trailingSlash: 'never',
  // A deferred, unimplemented Phase 2 SSR idea would have needed:
  //   import cloudflare from '@astrojs/cloudflare';
  //   output: 'hybrid',
  //   adapter: cloudflare({ mode: 'directory' }),
  // Neither the adapter nor wrangler is installed; see README for status.
  vite: {
    ssr: {
      // maplibre-gl is ESM-only and browser-side; don't try to SSR it
      noExternal: ['maplibre-gl'],
    },
  },
});
