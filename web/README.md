# `web/` — Astro site

Stylish Astro rewrite of the World Emergency & Hotlines directory. Runs on
Cloudflare Pages with D1 + Workers AI (Phase 2+). The canonical data lives at
the repo root — this package **consumes** `hotlines.json` / `information.json`,
it does not own them.

## Quickstart

```bash
cd web
npm install
npm run data:build      # generates public/data/ shards from the canonical JSON
npm run verify:data     # checks generated manifest/shard/search/category integrity
npm run dev             # http://localhost:4321
```

`npm run build` runs `data:build` first, then `astro build`, producing a static
site in `dist/`. Deploy anywhere that serves static files — Cloudflare Pages,
Railway (reuse the existing `Dockerfile` with a tweak), Vercel, Netlify.

## D1 (Phase 2)

```bash
wrangler d1 create world-hotlines
# paste the returned database_id into wrangler.toml
wrangler d1 execute world-hotlines --file=./db/schema.sql
node db/seed.mjs > db/seed.sql
wrangler d1 execute world-hotlines --file=./db/seed.sql
```

Then flip `output: 'static'` → `'hybrid'` in `astro.config.mjs` and add the
`@astrojs/cloudflare` adapter (already installed).

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
    build-static-data.mjs    regenerates public/data/ from hotlines.json
    verify-static-data.mjs   validates generated public/data/ integrity
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
