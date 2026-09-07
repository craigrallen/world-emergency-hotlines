# Accounts and CMS backend — prepared, not enabled

This document is the activation runbook for the Payload CMS backend under `cms/`: member accounts, user administration, Stripe billing in the CMS, and managed API key issuance. **Nothing in this repository signs anyone in or takes payments today.** Like the payments foundation (`docs/PAYMENTS.md`), every switch fails closed until the checklist below is complete.

Hard boundaries that no configuration may change:

- Every current crisis-information surface (site, `/api/v1/**`, feeds, widget, data) stays free, keyless, unmetered, and never behind an account.
- No price is published in this repository, in the CMS, or on the site; prices live only in the Stripe Dashboard and appear on Stripe's hosted checkout page. The CMS stores Stripe *price ids*, which are not prices.
- The repository has no license and the licensing review outcome is `held`. Charging money requires that decision plus terms, refund policy, and tax review. This runbook does not grant that authority.
- The canonical dataset stays owned by the Python pipeline (`docs/data-flow.md`). The CMS has no collection that reads or writes `hotlines.json`.

## What exists

| Piece | Where | State |
| --- | --- | --- |
| Payload 3 + Next.js app | `cms/` | Typechecked, tested (SQLite + mock Stripe), builds; not deployed |
| Collections | `cms/src/collections/` | `users` (roles admin/staff/member/service), `plans`, `subscriptions`, `entitlements`, `stripe-events`, `api-keys` |
| Admin panel (user administration) | `/admin` via Caddy | Admin and staff roles only; members never see it |
| Account REST | `/cms/api/account/*` | status, me, checkout, portal, api-keys; GraphQL disabled |
| Stripe in the CMS | `@payloadcms/plugin-stripe` + `cms/src/lib/stripe.ts` | Signed webhook route `/cms/api/stripe/webhooks`; REST proxy off |
| Payments service durable store | `payments/src/cms-store.mjs` | `PAYMENTS_STORE=cms` persists webhook ids and entitlements in the CMS |
| Gateway key sync | `gateway/src/cms-keys.mjs`, `node src/cli.mjs sync-keys` | Pulls issued key records into `GATEWAY_CONFIG` |
| Caddy routes | `Caddyfile` `@cms` | `/cms/*`, `/admin`, `/admin/*`, `/_next/*` answer 503 `accounts_disabled` unless `CMS_UPSTREAM` is set |
| Account pages | `web/src/pages/account/` | Static, `noindex`, all controls disabled until the runtime status probe succeeds |
| Local full stack | `docker-compose.yml` | Postgres + CMS + payments + Caddy at `http://localhost:8080` |
| Verification | `npm run verify:accounts` (in `verify:all`), `verify-caddy.sh`, `verify-docker-image.sh`, `cms-ci.yml` | CI enforces the disabled state, route parity, documented variables, and secret hygiene |

## Architecture

```
browser ── /account (static Astro page) ── fetch /cms/api/account/* ──▶ Caddy ──▶ CMS (Payload/Next) ──▶ Postgres
                                                                                 │
                                    Stripe ── POST /cms/api/stripe/webhooks ──────┤ (signed; customer/subscription/invoice events)
                                                                                 │
payments service ── PAYMENTS_STORE=cms ── /cms/api/stripe-events, /cms/api/entitlements ─┤ (service API key)
gateway ── sync-keys ── GET /cms/api/gateway/keys ────────────────────────────────┘ (service API key)
```

- **Same origin everywhere.** The CMS is only reached through the canonical origin. Caddy proxies three prefixes; Payload's `serverURL`, `cors`, and `csrf` are all `PUBLIC_SITE_URL`, cookies are `HttpOnly`/`Lax`/`Secure`. Cookie sessions from another origin are refused.
- **Roles.** `admin` (everything), `staff` (admin panel read access, no role changes), `member` (own account only), `service` (API-key-only automation for the payments store and gateway sync). Members cannot set `role`, `enableAPIKey`, `stripeCustomerId`, or `notes`; the users collection strips those fields from non-admin writes.
- **Hosted Checkout, account-bound.** `/cms/api/account/checkout` creates the Stripe customer once, then a Checkout Session carrying `client_reference_id` and `metadata.cms_user`, and answers only the `checkout.stripe.com` URL. The webhook links the resulting subscription to the account. The Customer Portal opens through `/cms/api/account/portal`.
- **Two webhook consumers, one ledger.** The payments service (anonymous `/billing` flow) and the CMS webhook share the `stripe-events` collection whose unique `eventId` makes the first writer win. Subscription state from both paths lands in `subscriptions`, and an event older than the newest applied one never overwrites state. The plugin acknowledges Stripe before handlers run, so a failed CMS handler releases its claim and logs; the payments service path returns real 500s and gets Stripe's retries.
- **Managed API keys.** A member with an active subscription mints a key from the account page. The CMS stores only the HMAC-SHA-256 verifier (pepper `GATEWAY_KEY_PEPPER`, shared with the gateway's `GATEWAY_PEPPER`); the raw key is shown once. `GET /cms/api/gateway/keys` exports records in `gateway/contracts/v1/key-record.schema.json` shape, including revocations, for `sync-keys`.
- **Data minimisation.** Accounts hold an email, optional name, password hash, and pseudonymous Stripe ids. No amounts, addresses, card data, analytics, or crisis-intent data.
- **Fail closed everywhere.** Unknown `CMS_*`/`STRIPE_*`/`SMTP_*`/`GATEWAY_*` variables, a short `PAYLOAD_SECRET`, SQLite in production, a Stripe key without its webhook secret, or a live key on a non-https origin all stop startup. Caddy answers 503 while `CMS_UPSTREAM` is unset. The account pages render disabled and re-check at runtime.

## Environment variables

Documented with defaults in `cms/.env.example`. Summary:

| Variable | Service | Purpose |
| --- | --- | --- |
| `PAYLOAD_SECRET` | cms | 32+ random characters; required at runtime. |
| `DATABASE_URL` | cms | `postgresql://…` in production; unset locally for SQLite at `cms/data/cms.db`. |
| `PUBLIC_SITE_URL` | cms | Canonical origin `https://worldhotlines.org`; drives cookies, CORS/CSRF, emails, Stripe return URLs. |
| `CMS_ACCOUNTS_REGISTRATION` | cms | `closed` (default) or `open`. Admins can always create users. |
| `CMS_REQUIRE_EMAIL_VERIFICATION` | cms | `1` requires verified emails (needs `SMTP_URL` in production). |
| `CMS_MAX_API_KEYS_PER_USER` | cms | Active managed keys per member (default 5). |
| `CMS_ADMIN_EMAIL`, `CMS_ADMIN_PASSWORD` | cms | First-boot admin on an empty database; remove afterwards. |
| `SMTP_URL`, `SMTP_FROM_ADDRESS`, `SMTP_FROM_NAME` | cms | Verification and reset emails; console logging without `SMTP_URL`. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | cms | Restricted key (`rk_`) preferred; both or neither. Key prefix sets test/live mode. |
| `CMS_STRIPE_API_BASE` | cms (tests) | Loopback Stripe double; never in production. |
| `GATEWAY_KEY_PEPPER` | cms | Equals the gateway's `GATEWAY_PEPPER`; unset disables key issuance. |
| `CMS_UPSTREAM` | web (Caddy) | `host:port` of the CMS, e.g. `cms.railway.internal:3000`. Unset means 503. |
| `PUBLIC_ACCOUNTS_MODE` | web (build) | `enabled` renders the account forms enabled before the runtime probe; unset means disabled. |
| `PAYMENTS_STORE`, `PAYMENTS_CMS_URL`, `PAYMENTS_CMS_API_KEY` | payments | `cms` + CMS API base + service API key for the durable store. |
| `GATEWAY_CMS_URL`, `GATEWAY_CMS_API_KEY` | gateway | Source for `sync-keys`. |

## Local development

```bash
cd cms
cp .env.example .env            # gitignored; SQLite needs only PAYLOAD_SECRET and PUBLIC_SITE_URL=http://localhost:3000
npm install
npm run dev                     # http://localhost:3000/admin creates the first admin; /cms/api/account/status
npm test                        # vitest: SQLite database, in-process Stripe double, real REST router
npm run typecheck && npm run build

# Whole stack behind Caddy (accounts on, Stripe off unless keys are set):
cd .. && printf 'PAYLOAD_SECRET=%s\nCMS_ADMIN_EMAIL=admin@example.org\nCMS_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" > .env
docker compose up --build        # http://localhost:8080/account and /admin
```

After any collection change run `npm run generate:types` (CI fails if `src/payload-types.ts` drifts) and create a Postgres migration with `npm run migrate:create -- <name>`; `payload migrate:create` needs no database connection.

## Activation checklist

Work top to bottom. Every step is reversible by unsetting `CMS_UPSTREAM`.

### Decisions (blocking)

- [ ] Licensing decision recorded and the `held` outcome in `reviews/licensing-legal-review/v1/` formally superseded by counsel.
- [ ] Terms of service, privacy notice covering accounts (email, password hash, Stripe ids) and Stripe as processor, and a data-retention/deletion procedure approved and linked from `/account`.
- [ ] Decision on open registration versus invitation, and on email verification.
- [ ] Payments checklist in `docs/PAYMENTS.md` complete up to and including the Stripe Dashboard test-mode steps.

### Railway (test mode first)

- [ ] Attach a Railway Postgres database. Create a service from this repository with **root directory `cms`** (picks up `cms/Dockerfile` and `cms/railway.toml`). Set `PAYLOAD_SECRET`, `DATABASE_URL`, `PUBLIC_SITE_URL=https://worldhotlines.org`, `CMS_ACCOUNTS_REGISTRATION`, `SMTP_*`, and for first boot `CMS_ADMIN_EMAIL`/`CMS_ADMIN_PASSWORD`. Health check `/cms/api/account/status` must go green; then remove the bootstrap variables.
- [ ] On the **web** service set `CMS_UPSTREAM=cms.railway.internal:3000` and redeploy. `/admin` shows the Payload sign-in; `/cms/api/account/status` returns `status:"enabled"`.
- [ ] Sign in at `/admin`, create staff users, and create a `service` user with **Enable API key** for the payments store and another for the gateway sync. Copy the keys into the respective Railway services only.
- [ ] Set build variable `PUBLIC_ACCOUNTS_MODE=enabled` on the web service so `/account` renders live forms; confirm register/sign-in/sign-out and password reset (needs SMTP) end to end.
- [ ] Stripe test mode: set `STRIPE_SECRET_KEY` (restricted) and `STRIPE_WEBHOOK_SECRET` on the CMS; register `https://worldhotlines.org/cms/api/stripe/webhooks` for `checkout.session.*`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`. Create a `plans` document per offer with its test price id and mark it active. Complete a test-card checkout from `/account`; the subscription appears on the account page and in `/admin`.
- [ ] Payments service: set `PAYMENTS_STORE=cms`, `PAYMENTS_CMS_URL=http://cms.railway.internal:3000/cms/api`, `PAYMENTS_CMS_API_KEY`. `check-config` passes; a `/billing` test checkout creates `stripe-events` and `entitlements` documents and a mirrored subscription.
- [ ] Gateway (when deployed): set `GATEWAY_KEY_PEPPER` on the CMS equal to the gateway's `GATEWAY_PEPPER`; run `node src/cli.mjs sync-keys` on a schedule; confirm a key minted from `/account` authenticates and a revoked one stops.

### Go live

- [ ] Repeat the Stripe steps in live mode (live restricted key, live webhook secret, live price ids on the plans).
- [ ] Rollback rehearsed: unsetting `CMS_UPSTREAM` returns every CMS route to 503 within one deploy while the static site keeps serving; the account pages fall back to their disabled notice on the next load.
- [ ] Update `docs/PACKAGING.md` status wording in a reviewed pull request; the verifiers pin the current "prepared, not enabled" wording deliberately.

## Operational notes

- **Secrets.** Only Railway variables hold `PAYLOAD_SECRET`, Stripe material, SMTP credentials, and the pepper. `.env` files are ignored by git and Docker, and `verify:payments` scans tracked files for key-shaped strings.
- **Logs.** The CMS logs event types and outcomes, never bodies, tokens, or raw keys. Payload's request logging stays at its defaults.
- **Locking.** Five failed sign-ins lock an account for ten minutes; admins unlock from `/admin`. Sessions expire after two hours.
- **Migrations.** Production runs the committed Postgres migrations on start (`prodMigrations`). SQLite is development and tests only; the CMS refuses to start with SQLite when `NODE_ENV=production`.
- **What entitlement means.** An `active`/`trialing` subscription on the account is a fact about payment. Managed API access is enforced by the gateway with the synced key records; nothing on the free site is affected.
