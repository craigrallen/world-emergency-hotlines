// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// We start in `static` output and can flip to `server` once SSR routes
// (api/*, country/*) start reading D1. Keeping `static` for Phase 1 means
// the site runs on any host without a Cloudflare account.
export default defineConfig({
  site: 'https://hotlines.interconnected.au',
  output: 'static',
  trailingSlash: 'never',
  // Tailwind v3 is wired up via postcss.config.mjs (the former
  // @astrojs/tailwind integration was dropped in Astro 6).
  // When Phase 2 lands we switch to:
  //   output: 'server',
  //   adapter: cloudflare({ mode: 'directory' }),
  vite: {
    ssr: {
      // maplibre-gl is ESM-only and browser-side; don't try to SSR it
      noExternal: ['maplibre-gl'],
    },
  },
});
