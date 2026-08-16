# `web/` — Astro site

Stylish Astro rewrite of the World Emergency & Hotlines directory. Builds and
deploys today as a static site (no adapter, no server runtime); D1 + Workers
AI + Cloudflare Pages below is deferred, historical scaffolding for a
possible future SSR phase that was never wired up. The canonical data lives
at the repo root — this package **consumes** `hotlines.json` /
`information.json`, it does not own them.

## Offline/PWA readiness

Browsers with web app manifest and service-worker support can install the site over HTTPS. This first offline slice is deliberately only a readiness shell: a finite five-file allowlist contains the offline explanation, manifest, and local icons. Every same-origin GET navigation remains network-first and uses the fixed explanation only when the network rejects, including country, category, finder, map, and query-bearing page URLs. Requested pages and query-derived URLs are never cached; non-navigation hotline data, static API, widget, and search requests remain untouched.

The fallback shows its deterministic shell identity, canonical dataset identity prefix, and canonical source date. Those labels identify build inputs; they do not establish hotline freshness, completeness, reachability, or availability. Worker updates bypass the HTTP cache, activate a strictly versioned shell, and delete older project shell caches. Unsupported browsers and install failures continue as the normal online site. The implementation requests no geolocation and sends no analytics or offline-status reports.

## Quickstart

```bash
cd web
npm install
npm run generate:pwa     # explicitly refreshes the five tracked PWA outputs after controlling-source changes
npm run data:build       # generates public/data/ shards from the canonical JSON
npm run verify:all       # runs data/contact-link, search, and discovery checks
npm run verify:feeds     # deterministic diff/registry and JSON Feed/RSS/Atom contracts
npm run release:dataset:candidate -- --id <slug> --date <YYYY-MM-DD> --title <title> --summary <summary>
npm run dev              # http://localhost:4321
```

PWA generation is intentionally explicit: normal data/build/verification commands byte-compare all five tracked outputs and fail with a regeneration command instead of silently repairing drift. `npm run build` runs `data:build` first, then `astro build`, producing a static
site in `dist/`. Use `verify:data` for generated data and contact-link checks,
`verify:search` for SearchBox behavior, `verify:discovery` for discovery routes,
or `verify:all` to run all verification scripts in order. The repo-root
`Dockerfile` already builds this exact `dist/` output and serves it with Caddy —
that's the production path on Railway today (see `DEPLOY.md`), no changes
needed. The static output also runs unmodified on any other static host —
Cloudflare Pages, Vercel, Netlify, etc.

## D1 (deferred — not part of the current build)

The `db/` scripts and `wrangler.toml` below are unused historical scaffolding
for a Cloudflare D1/SSR phase that was never implemented. Neither `wrangler`
nor `@astrojs/cloudflare` is currently a dependency of this package; both
would need to be added before any of this could run:

```bash
npx wrangler d1 create world-hotlines
# paste the returned database_id into wrangler.toml
npx wrangler d1 execute world-hotlines --file=./db/schema.sql
node db/seed.mjs > db/seed.sql
npx wrangler d1 execute world-hotlines --file=./db/seed.sql
```

Then flip `output: 'static'` → `'hybrid'` in `astro.config.mjs` and add the
`@astrojs/cloudflare` adapter (not currently installed).

## Layout

```
web/
  src/
    pages/          index, about, map, data, categories/index,
                     category/[slug], country/[code], 404,
                     robots.txt.ts, sitemap.xml.ts
    components/     SearchBox, HotlineCard, EmergencyBanner, Header, Footer,
                     LanguageSwitcher, ThemeToggle, Icon
    layouts/Base.astro
    lib/
      data.ts       adapter: reads the static JSON shards in public/data/
                     at build time — there is no D1 (or any other) runtime path
      search.js     client-side search parsing/ranking (see ARCHITECTURE.md §6)
      i18n.ts       10-locale dictionary + helpers
      types.ts      TS types matching schema v2.0
      geo.ts        country centroids
      site.js       SITE_URL used by sitemap/robots/canonical links
  scripts/
    build-static-data.mjs         regenerates public/data/ from hotlines.json
    centroids.json                 source data for lib/geo.ts
    verify-static-data.mjs        validates generated public/data/ integrity
    verify-contact-links.mjs      validates hotline contact-link references
    verify-searchbox.mjs          checks SearchBox behavior against static data
    verify-discovery-routes.mjs   checks discovery route coverage
  db/
    schema.sql      D1 DDL (unused — see "D1" above)
    seed.mjs        emits INSERT statements to stdout (unused)
  public/
    favicon.svg
    data/           generated — do not commit (see .gitignore)
```

The tracked, internal-only multilingual UI review handoff is under
`../reviews/multilingual-ui/v1/`. `npm run verify:locales` proves it remains an
exact, non-qualifying export of the finite dictionaries and locale-status
manifest; `npm run generate:multilingual-review-pack` regenerates it.

## ML

None of the ML features (natural-language search, auto-translate, a
crisis-triage classifier) from the original design doc were built. Search
(`src/lib/search.js`) and i18n (`src/lib/i18n.ts`) are both plain deterministic
JS with no model inference. See `ARCHITECTURE.md` §11 for what was planned but
never implemented.
