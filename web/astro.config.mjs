// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';

// We start in `static` output and can flip to `hybrid` once SSR routes
// (api/*, country/*) start reading D1. Keeping `static` for Phase 1 means
// the site runs on any host without a Cloudflare account.
export default defineConfig({
  site: 'https://hotlines.interconnected.au',
  output: 'static',
  trailingSlash: 'never',
  integrations: [
    tailwind({ applyBaseStyles: false }),
  ],
  // When Phase 2 lands we switch to:
  //   output: 'hybrid',
  //   adapter: cloudflare({ mode: 'directory' }),
  vite: {
    ssr: {
      // maplibre-gl is ESM-only and browser-side; don't try to SSR it
      noExternal: ['maplibre-gl'],
    },
  },
});
