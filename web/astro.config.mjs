// @ts-check
import { defineConfig } from 'astro/config';
import { SITE_URL } from './src/lib/site.js';

// Tailwind is wired via postcss.config.mjs (PostCSS plugin) — no @astrojs/tailwind
// needed for Astro 7. @astrojs/cloudflare is kept in deps for the Phase 2 SSR switch.

// We start in `static` output and can flip to `hybrid` once SSR routes
// (api/*, country/*) start reading D1. Keeping `static` for Phase 1 means
// the site runs on any host without a Cloudflare account.
export default defineConfig({
  site: SITE_URL,
  output: 'static',
  trailingSlash: 'never',
  // When Phase 2 lands we switch to:
  //   import cloudflare from '@astrojs/cloudflare';
  //   output: 'hybrid',
  //   adapter: cloudflare({ mode: 'directory' }),
  vite: {
    ssr: {
      // maplibre-gl is ESM-only and browser-side; don't try to SSR it
      noExternal: ['maplibre-gl'],
    },
  },
});
