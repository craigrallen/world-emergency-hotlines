# `web/` — Astro site

Stylish Astro rewrite of the World Emergency & Hotlines directory. Builds and
deploys today as a static site (no adapter, no server runtime); D1 + Workers
AI + Cloudflare Pages below is deferred, historical scaffolding for a
possible future SSR phase that was never wired up. The canonical data lives
at the repo root — this package **consumes** `hotlines.json` /
`information.json`, it does not own them.

## Quickstart

```bash
cd web
npm install
npm run data:build       # generates public/data/ shards from the canonical JSON
npm run verify:all       # runs data/contact-link, search, and discovery checks
npm run dev              # http://localhost:4321
```

`npm run build` runs `data:build` first, then `astro build`, producing a static
site in `dist/`. Use `verify:data` for generated data and contact-link checks,
`verify:search` for SearchBox behavior, `verify:discovery` for discovery routes,
or `verify:all` to run all verification scripts in order. Deploy anywhere that
serves static files — Cloudflare Pages, Railway (reuse the existing `Dockerfile`
with a tweak), Vercel, Netlify.

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
    pages/          landing, map, country/[code], category/[slug], about
    components/     reusable UI (SearchBox, HotlineCard, EmergencyBanner, …)
    layouts/Base.astro
    lib/
      data.ts       adapter: static JSON now, D1 in Phase 2
      types.ts      TS types matching schema v2.0
      geo.ts        country centroids
  scripts/
    build-static-data.mjs         regenerates public/data/ from hotlines.json
    verify-static-data.mjs        validates generated public/data/ integrity
    verify-contact-links.mjs      validates hotline contact-link references
    verify-searchbox.mjs          checks SearchBox behavior against static data
    verify-discovery-routes.mjs   checks discovery route coverage
  db/
    schema.sql      D1 DDL
    seed.mjs        emits INSERT statements to stdout
  public/
    favicon.svg
    data/           generated — do not commit (see .gitignore)
```

## ML

Four features staged across phases. See `ARCHITECTURE.md` §6 for the full
design, especially the crisis-triage safety rule ("can only surface an
emergency banner faster, never gate or suppress legitimate results").
