# Deploying Hotlines.world to Railway

One-time setup. After this, every push to `main` auto-deploys.

The deployed app is the Astro site under `web/` (a static site — see `web/ARCHITECTURE.md`), built and served via the root `Dockerfile`. Branch protection on `main` requires the data pipeline (`data-ci.yml`) and web build (`web-ci.yml`) checks to pass before a change can merge. Once a commit lands on `main`, GitHub Actions and Railway are both triggered independently by that update — the repo's config doesn't prove, and shouldn't be assumed to guarantee, that Railway's build waits for Actions to finish.

## 1. Create the Railway project (2 minutes)

1. Sign in at <https://railway.app> (uses GitHub).
2. Click **New Project → Deploy from GitHub repo**.
3. Pick `craigrallen/world-emergency-hotlines`.
4. Railway detects `railway.toml` and the root `Dockerfile` and starts building.
5. When the build finishes, click **Settings → Networking → Generate Domain**. You'll get a URL like `world-emergency-hotlines-production.up.railway.app`.

That's it — the site is live. Railway's health check hits `/` (configured in `railway.toml`); the deploy is marked healthy once Caddy responds there.

The canonical public origin is `https://worldhotlines.org`. Builds use it for canonical links, `robots.txt`, and `sitemap.xml` when Railway's `PUBLIC_SITE_URL` is unset or invalid. During rollout, the generated `https://world-emergency-hotlines-production.up.railway.app` origin remains available as a fallback, but must not be published as the canonical or integration origin. If `PUBLIC_SITE_URL` is set, keep it at `https://worldhotlines.org`.

## 2. Attach your own domain (optional, 5 minutes)

For `worldhotlines.org` and `www.worldhotlines.org` (or another domain you own) pointing at the deployment:

1. In Railway: **Settings → Networking → Custom Domain → Add**. Enter the hostname.
2. Railway will show you a CNAME target (e.g. `ghj12.up.railway.app`). Add that CNAME at your DNS provider.
3. Wait for DNS propagation + automatic HTTPS (Railway provisions certs via Let's Encrypt).

Caddy permanently redirects only `www.worldhotlines.org` to `https://worldhotlines.org`, preserving the request path and query. The Railway fallback host is intentionally served without redirect for rollout and recovery.

## 3. Updates

Any commit that lands on `main` (which requires the `data` and `web` checks to have passed for merge) triggers a Railway redeploy automatically. No CLI needed. The dataset shards and the Astro build both run inside the Docker build itself (see §5) — there is no separate "regenerate the site" step to run locally before pushing.

## 4. Local preview

To preview changes locally before pushing:

```bash
cd web
npm install
npm run build       # regenerates public/data/ from ../hotlines.json, then astro build
npm run preview      # serves dist/ locally
```

Or with Docker (matches production exactly):

```bash
docker build -t hotlines-world .
docker run -p 8080:8080 hotlines-world
# Open http://localhost:8080
```

For active development with hot reload, `cd web && npm run dev` serves `http://localhost:4321`. `npm run verify:all` runs the data/contact-link, search, and discovery-route verification scripts against the generated `public/data/`; `npm run typecheck` runs `astro check`. See `web/README.md` for the full command list.

## 5. What's in the image

- **Build stage** — `node:22-alpine`. Installs `web/`'s npm dependencies, copies in `hotlines.json` and `information.json`, then runs `npm run build` inside `web/`, which regenerates the `public/data/` JSON shards from the canonical dataset (`scripts/build-static-data.mjs`) and runs `astro build` to produce a static site in `web/dist/` (286 prerendered pages as of this dataset: one per country, one per category, plus the top-level routes).
- **Serve stage** — `caddy:2.8-alpine`. Copies `web/dist/` to `/srv` and serves it with the `Caddyfile` from the repo root: gzip/zstd compression, security headers (HSTS, CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy), and per-asset-type cache rules (immutable for hashed `_astro/` assets, short TTL + stale-while-revalidate for HTML and `/data/*`).
- Railway injects `$PORT` at runtime; Caddy binds to it automatically (`ENV PORT=8080` is the image default, overridden by Railway).

## 6. Payments service (prepared, not enabled)

A separate Stripe payments foundation lives in `payments/` and is **not deployed**. Caddy already routes `/billing/api/*`, but while the web service has no `PAYMENTS_UPSTREAM` variable that route answers `503 payments_disabled`, and the built `/billing` pages render with disabled buttons unless the web build sees `PUBLIC_PAYMENTS_MODE=test|live`. Nothing here changes the free static site.

When (and only when) the activation checklist in `docs/PAYMENTS.md` is complete: create a second Railway service from this repository with root directory `payments` (it picks up `payments/Dockerfile` and `payments/railway.toml`, health check `/billing/api/health`), set its `PAYMENTS_*`/`STRIPE_*` variables, then set `PAYMENTS_UPSTREAM=payments.railway.internal:8081` on the web service. Unsetting that one variable is the rollback.

## 7. Troubleshooting

- **Build fails installing npm dependencies** → check `web/package-lock.json` is committed and in sync with `web/package.json`; the Dockerfile runs `npm install --no-audit --no-fund` against it.
- **Build fails during `astro build` / `astro check`** → reproduce locally with `cd web && npm run build` (or `npm run typecheck`); the same commands run in `web-ci.yml` on every push/PR.
- **Site loads but shows "page not found" for a country/category page** → the page is generated at build time from `hotlines.json`; confirm the country/category exists in the canonical dataset and rebuild.
- **Custom domain not resolving** → DNS can take time to propagate; check with `dig <domain>` or `nslookup <domain>`.
- **CSP blocking something** (e.g. a new external asset host) → edit the `Content-Security-Policy` header in `Caddyfile` and redeploy. The only Stripe entries are `form-action` allowances for `checkout.stripe.com` and `billing.stripe.com`; hosted Checkout needs no Stripe script or frame on this origin.
- **`/billing/api/*` returns 503** → expected while `PAYMENTS_UPSTREAM` is unset (payments are not enabled). A 502 means the variable is set but the payments service is unreachable.
