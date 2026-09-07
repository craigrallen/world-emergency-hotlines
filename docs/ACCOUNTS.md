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
| Collections | `cms/src/collections/` | `users` (roles admin/staff/member/service; service accounts carry one scope), `plans`, `subscriptions`, `entitlements`, `stripe-events`, `api-keys` |
| Admin panel (user administration) | `/admin` via Caddy | Admin and staff roles only; members never see it |
| Account REST | `/cms/api/account/*` | status, me, checkout, portal, api-keys; GraphQL disabled |
| Stripe in the CMS | `cms/src/endpoints/stripe-webhook.ts` + `cms/src/lib/stripe.ts` | Signed webhook endpoint `/cms/api/stripe/webhooks` (Stripe SDK signature check); non-2xx when handling fails so Stripe retries |
| Payments service durable store | `payments/src/cms-store.mjs` | `PAYMENTS_STORE=cms` persists webhook ids and entitlements in the CMS |
| Gateway key sync | `gateway/src/cms-keys.mjs`, `node src/cli.mjs sync-keys`, `gateway/src/reload.mjs` | Pulls issued key records into `GATEWAY_CONFIG`; a running gateway reloads them within `GATEWAY_KEYS_RELOAD_SECONDS` (default 30) or on `SIGHUP` |
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
- **Roles.** `admin` (everything), `staff` (admin panel read access, no role changes), `member` (own account only), `service` (API-key-only automation limited to exactly one scope: `payments_store` may only claim webhook events and write entitlement records for the payments service; `gateway_sync` may only read the key-record export; neither can read subscriptions, plans, or keys, so a leaked gateway credential cannot forge an entitlement and a leaked store credential cannot export verifiers). Members cannot set `role`, `serviceScope`, `enableAPIKey`, `stripeCustomerId`, or `notes`; the users collection strips those fields from non-admin writes and enforces a 12 to 256 character password on registration, self-service change, and reset. The email-verification fields are always part of the schema (so the committed Postgres migration supports both modes); when verification is not required, accounts are created already verified.
- **Hosted Checkout, account-bound.** `/cms/api/account/checkout` creates the Stripe customer once, then a Checkout Session carrying `client_reference_id` and `metadata.cms_user`, and answers only the `checkout.stripe.com` URL. The webhook links the resulting subscription to the account. Only active subscription-mode plans are sold here: a one-time payment plan would charge without granting an entitlement, so the endpoint refuses it (`unsupported_offer`) and the status endpoint never lists it. The Customer Portal opens through `/cms/api/account/portal`.
- **Two webhook consumers, one ledger, one claim each.** The payments service (anonymous `/billing` flow) and the CMS webhook both receive Stripe's events and share the `stripe-events` collection, but they do different work (the CMS links accounts and mirrors subscriptions; the payments service keeps the durable `cs:`/`sub:` entitlement records), so claims are unique per consumer and event (`claimKey` = `source:eventId`): each consumer processes every event exactly once across its replicas and neither can mark an event done for the other (the payments-store credential is pinned to the `payments:` namespace and can neither create nor change `cms:` claims). Subscription state from both paths lands in `subscriptions`. Each apply runs in a transaction with the subscription row locked (Postgres `SELECT … FOR UPDATE`), and ordering is tracked per event family (checkout, subscription, invoice), so an older event never overwrites a newer one of the same family even when deliveries race, while a delayed `customer.subscription.*` event is never discarded because a later checkout or invoice event arrived first. Two events created in the same second cannot be ordered by their whole-second timestamps, so a tie never trusts the payload: both consumers fetch the object's current state from Stripe (subscription, checkout session, or invoice) and apply that instead, and if Stripe cannot be asked the event fails and is retried rather than applied in an unknown order. The entitlement records get the same guarantee: the CMS re-reads the stored record under its row lock and refuses (409) a write that would move any family's epoch backwards or that was built from a stale revision (every write names the record revision it read, and the CMS stamps the next revision), and the payments service re-reads, re-reconciles, and re-applies, so two payments replicas cannot resurrect older state even at equal timestamps. A claim counts as a duplicate only once its event was applied (the ledger row carries an outcome); while an earlier delivery is still in progress a repeat answers 409 so Stripe keeps retrying, and a claim left incomplete by a worker that died before releasing it is taken over after 120 seconds (under a row lock, so two late retries cannot both take it), so a failure whose cleanup also failed never becomes a permanent duplicate. Both consumers answer non-2xx when handling fails, after releasing their claim, so Stripe retries the delivery automatically: a failed mirror from the payments path fails the entitlement write itself, and the CMS webhook endpoint answers 500 (it is a first-class endpoint rather than the plugin route, which acknowledges before handlers run). When the payments mirror and the CMS webhook tie at the same second with different state, Stripe's current object decides (the mirror fetches it through the CMS's Stripe client and fails the store write, so the payments service retries, if Stripe cannot be asked); a CMS without a Stripe client has no webhook consumer, so the payments record applies as the only writer.
- **Managed API keys.** A member with an active subscription mints a key from the account page; the entitlement check, the per-user limit, and the insert run in one transaction with the user's row locked. The key's permissions and quota come only from the plan attached to that subscription, and that plan follows the billed Stripe price alone (stored on the subscription as `stripePriceId`, and carried by payments-service records as `price`): a price no plan is configured for clears the plan even if the subscription still carries old offer metadata, and once a billed price is known, offer metadata (including the payments mirror replaying its record) never restores a plan. A subscription without a resolvable plan policy (deleted plan, unknown price) cannot mint a key (`plan_unconfigured`) and its existing keys leave the gateway export. The CMS stores only the HMAC-SHA-256 verifier (pepper `GATEWAY_KEY_PEPPER`, shared with the gateway's `GATEWAY_PEPPER`), the billing mode, and the subscription that granted the key; the raw key is shown once. `GET /cms/api/gateway/keys` exports records in `gateway/contracts/v1/key-record.schema.json` shape, including revocations, for `sync-keys`. Live-mode keys are always exported; test-mode keys only while the CMS itself runs with a Stripe test key, so promoting to live drops them at the next sync. The exported state follows the subscription that granted each key, not the account: while that subscription is not active (past due, unpaid, canceled, deleted) an active key is exported as `revoked`, and it returns to `active` at the next sync if the subscription recovers; its permissions and quota follow the plan currently attached to that subscription, so a key minted on a higher tier cannot outlive that tier on a cheaper subscription, and a plan change moves the key's policy with it. Deleting a subscription in `/admin` revokes the keys it granted in the same transaction, and a key minted from the account page whose granting subscription is otherwise gone is exported revoked rather than falling back. Only keys created by an admin without a granting subscription fall back to the account's entitlement in the key's billing mode. Stored key records are not changed by the export. An authenticated empty snapshot clears the gateway's key list (a gateway with no keys refuses to start, which fails closed), and a running gateway re-reads `GATEWAY_CONFIG` within `GATEWAY_KEYS_RELOAD_SECONDS` (default 30) or on `SIGHUP` (a change it could not read or validate is retried on the next poll, and a rewrite that lands during startup is applied immediately), so revocations take effect without a restart. The export carries only keys that evaluate as active: the gateway refuses a key it does not know exactly as it refuses a revoked one, so revoked and expired history never counts against the gateway's 10,000-record snapshot limit, and more active keys than that fails the sync (`snapshot_too_large`) rather than truncating the snapshot.
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
| `GATEWAY_KEYS_RELOAD_SECONDS` | gateway | How often `serve` re-reads the key records from `GATEWAY_CONFIG` (default 30; `0` disables polling, `SIGHUP` always reloads). |

## Local development

```bash
cd cms
cp .env.example .env            # gitignored; SQLite needs only PAYLOAD_SECRET and PUBLIC_SITE_URL=http://localhost:3000
npm install
npm run dev                     # http://localhost:3000/admin creates the first admin; /cms/api/account/status
npm test                        # vitest: SQLite database, in-process Stripe double, real REST router
npm run typecheck && npm run build

# Whole stack behind Caddy (accounts on, Stripe off unless keys are set):
cd .. && printf 'PAYLOAD_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
printf 'CMS_ADMIN_EMAIL=admin@example.org\nCMS_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 16)" > .env.cms
docker compose up --build        # http://localhost:8080/account and /admin
```

Compose reads optional secrets from the untracked `.env.cms` and `.env.payments` files only when they exist, so unset variables stay absent. To turn the payments service's durable store on locally, create a `service` user with scope `payments_store` and an API key in `/admin` and put `PAYMENTS_STORE=cms`, `PAYMENTS_CMS_URL=http://cms:3000/cms/api` (single-label Compose hostnames are accepted over plain http), and `PAYMENTS_CMS_API_KEY=<that key>` in `.env.payments`, then `docker compose up -d payments`. Both services also treat an empty optional variable as "not configured".

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
- [ ] Sign in at `/admin`, create staff users, and create two `service` users with **Enable API key**: one with scope `payments_store` for the payments service and one with scope `gateway_sync` for the gateway. Copy each key into its own Railway service only; neither key works for the other purpose.
- [ ] Set build variable `PUBLIC_ACCOUNTS_MODE=enabled` on the web service so `/account` renders live forms; confirm register/sign-in/sign-out and password reset (needs SMTP) end to end.
- [ ] Stripe test mode: set `STRIPE_SECRET_KEY` (restricted) and `STRIPE_WEBHOOK_SECRET` on the CMS; register `https://worldhotlines.org/cms/api/stripe/webhooks` for `checkout.session.*`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`. Create a `plans` document per offer with its test price id and mark it active. Complete a test-card checkout from `/account`; the subscription appears on the account page and in `/admin`.
- [ ] Payments service: set `PAYMENTS_STORE=cms`, `PAYMENTS_CMS_URL=http://cms.railway.internal:3000/cms/api`, `PAYMENTS_CMS_API_KEY`. `check-config` passes; a `/billing` test checkout creates `stripe-events` and `entitlements` documents and a mirrored subscription.
- [ ] Gateway (when deployed): set `GATEWAY_KEY_PEPPER` on the CMS equal to the gateway's `GATEWAY_PEPPER`; run `node src/cli.mjs sync-keys` on a schedule against the same `GATEWAY_CONFIG` the running gateway reads (it reloads within `GATEWAY_KEYS_RELOAD_SECONDS`, default 30); confirm a key minted from `/account` authenticates and a revoked one stops within that window without a restart.

### Go live

- [ ] Repeat the Stripe steps in live mode (live restricted key, live webhook secret, live price ids on the plans). Keys minted from test-mode subscriptions stop being exported once the CMS runs live; run `sync-keys` on the gateway so they are dropped.
- [ ] Rollback rehearsed: unsetting `CMS_UPSTREAM` returns every CMS route to 503 within one deploy while the static site keeps serving; the account pages fall back to their disabled notice on the next load.
- [ ] Update `docs/PACKAGING.md` status wording in a reviewed pull request; the verifiers pin the current "prepared, not enabled" wording deliberately.

## Operational notes

- **Secrets.** Only Railway variables hold `PAYLOAD_SECRET`, Stripe material, SMTP credentials, and the pepper. `.env` files are ignored by git and Docker, and `verify:payments` scans tracked files for key-shaped strings.
- **Logs.** The CMS logs event types and outcomes, never bodies, tokens, or raw keys. Payload's request logging stays at its defaults.
- **Locking.** Five failed sign-ins lock an account for ten minutes; admins unlock from `/admin`. Sessions expire after two hours.
- **Migrations.** Production runs the committed Postgres migrations on start (`prodMigrations`). SQLite is development and tests only; the CMS refuses to start with SQLite when `NODE_ENV=production`.
- **Webhook retries.** Both webhook endpoints answer non-2xx (500 `handler_failed`, or 409 `event_in_progress` while an earlier delivery of the same event is still being applied) when an event cannot be applied, after releasing the consumer's claim, so Stripe retries automatically (for days, with backoff). An incomplete claim older than 120 seconds is taken over by the next delivery. A Dashboard resend is only needed for an event Stripe never delivered.
- **Deleting an account.** Deleting a user from `/admin` deletes that user's managed API keys in the same transaction (the gateway drops them at its next `sync-keys`) and unlinks their subscription mirrors; Stripe customer and subscription records are unaffected and must be handled in the Dashboard under the retention procedure.
- **What entitlement means.** An `active`/`trialing` subscription on the account is a fact about payment. Managed API access is enforced by the gateway with the synced key records; nothing on the free site is affected.
