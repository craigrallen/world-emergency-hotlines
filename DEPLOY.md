# Deploying Hotlines.world to Railway

One-time setup. After this, every push to `main` auto-deploys.

## 1. Create the Railway project (2 minutes)

1. Sign in at <https://railway.app> (uses GitHub — free tier is enough for this site).
2. Click **New Project → Deploy from GitHub repo**.
3. Pick `craigrallen/world-emergency-hotlines`.
4. Railway detects `railway.toml` and `Dockerfile` and starts building. First build takes ~1–2 minutes.
5. When the build finishes, click **Settings → Networking → Generate Domain**. You'll get a URL like `world-emergency-hotlines-production.up.railway.app`.

That's it — the site is live.

## 2. Attach your own domain (optional, 5 minutes)

If you want `hotlines.world` (or any domain you own) pointing at the deployment:

1. In Railway: **Settings → Networking → Custom Domain → Add**. Enter the hostname.
2. Railway will show you a CNAME target (e.g. `ghj12.up.railway.app`). Add that CNAME at your DNS provider (Cloudflare, Namecheap, etc.).
3. Wait ~5 minutes for DNS propagation + automatic HTTPS (Railway provisions certs via Let's Encrypt).

## 3. Updates

Any commit that lands on `main` triggers a redeploy automatically. No CLI needed.

To regenerate the site after editing `hotlines.json`:

```powershell
cd "C:\Users\Widemind\OneDrive\Documents\Claude\Projects\World emergency and hotlines"
python site/build.py
powershell -ExecutionPolicy Bypass -File .\push-updates.ps1 -Message "Update dataset"
```

Railway picks up the push and redeploys within ~90 seconds.

## 4. Local preview

To preview changes locally before pushing:

```powershell
cd site
python build.py
# Serve public/ on localhost:8000
python -m http.server --directory public 8000
# Open http://localhost:8000
```

Or with Docker (matches production exactly):

```powershell
docker build -t hotlines-world .
docker run -p 8080:8080 hotlines-world
# Open http://localhost:8080
```

## 5. What's in the image

- Python 3.12 (build stage) runs `site/build.py` to generate 276 static HTML pages and `data.json` from `hotlines.json`.
- Final image is Caddy 2.8 on Alpine (~40 MB) serving `/srv`.
- Caddy is configured for gzip/zstd compression, strong security headers (CSP, HSTS, X-Frame-Options), and cache-friendly routes.
- Railway injects `$PORT` at runtime; Caddy binds to it automatically.

## 6. Costs

Railway's free tier (Hobby plan, $5 free credit/month) easily covers a static site of this size (~1.5 MB of data, low traffic). If traffic grows, you'll see line items for CPU/RAM/egress — the site is essentially free to host unless you hit millions of page views.

## 7. Troubleshooting

- **Build fails with "python3: not found"** → Railway may have cached an old base image; re-trigger deploy in the dashboard.
- **Site loads but shows "page not found"** → `site/public/` may be stale; run `python site/build.py` locally and push.
- **Custom domain not resolving** → DNS can take up to 48 hours globally; check with `dig hotlines.world` or `nslookup hotlines.world`.
- **CSP blocking something** → edit the `Content-Security-Policy` header in `Caddyfile` and redeploy.
