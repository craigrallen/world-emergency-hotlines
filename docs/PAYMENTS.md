# Stripe payments — prepared, not enabled

This document is the activation runbook for the Stripe payment foundation. **Nothing in this repository takes payments today.** The foundation exists so that, if and when the proposed opted-in managed API tiers are approved, enabling billing is a configuration change with a checklist rather than a rushed build. Until every item in [Activation checklist](#activation-checklist) is complete, the switches described here stay off.

Hard boundaries that no configuration may change:

- Every current crisis-information surface (site, `/api/v1/**`, feeds, widget, data) stays free, keyless, unmetered, and never paywalled.
- No price is published in this repository or on the site; prices live only in the Stripe Dashboard and appear on Stripe's hosted checkout page.
- The repository has no license and the licensing review outcome is `held` (see `reviews/licensing-legal-review/v1/`). Charging money requires that decision plus terms, refund policy, and tax review. This runbook does not grant that authority.

## What exists

| Piece | Where | State |
| --- | --- | --- |
| Payments service (Node 22, dependency-free) | `payments/` | Tested; not deployed; `PAYMENTS_MODE=disabled` by default |
| Contracts (offer ids, OpenAPI, README) | `payments/contracts/v1/` | Documented; no prices |
| Caddy route `/billing/api/*` | `Caddyfile` | Fails closed with 503 unless `PAYMENTS_UPSTREAM` is set |
| CSP `form-action` for Stripe hosted origins | `Caddyfile` | Allows only `checkout.stripe.com` and `billing.stripe.com`; no Stripe scripts, frames, or connect-src |
| `/billing`, `/billing/success`, `/billing/cancelled` pages | `web/src/pages/billing/` | Built `noindex`, buttons disabled unless `PUBLIC_PAYMENTS_MODE` is `test` or `live` at build time |
| Verification | `npm run verify:payments` (in `verify:all`), `verify-caddy.sh`, `verify-docker-image.sh` | CI enforces the disabled state, contract parity, Stripe-only `form-action`, ignored env files, and a tracked-file key scan |
| Secret hygiene | `.gitignore`, `.dockerignore`, `payments/.env.example` | `.env*` never committed or copied into images |

## Architecture

```
browser ── POST /billing/api/checkout-session (offer id only) ──▶ Caddy ──▶ payments service ──▶ Stripe API
   ▲                                                                                   │
   └──────────── 303 https://checkout.stripe.com/... (card entry happens on Stripe) ◀──┘

Stripe ── POST /billing/api/webhook (signed) ──▶ Caddy ──▶ payments service ──▶ store (ids + statuses only)
```

- **Hosted Checkout, redirect flow.** The site never loads Stripe.js, never embeds an iframe, and never sees card data (Stripe's SAQ A posture). The browser sends only an offer id; the server maps it to a Stripe price it alone knows.
- **Same-origin only.** Browser POSTs must carry `Origin: <PAYMENTS_PUBLIC_ORIGIN>`. Cross-site form posts are refused.
- **Webhook verification.** `Stripe-Signature` is verified with the endpoint secret (HMAC-SHA256, 300-second tolerance, constant-time compare). Events whose `livemode` disagrees with the deployment mode are rejected. Events are deduplicated by id.
- **Data minimisation.** The store records `cs_`, `sub_`, `cus_`, `in_`, and `pi_` identifiers, the offer id, and enum statuses. It never records names, emails, addresses, amounts, or card data, and access logs use a fixed field list with no secrets or request bodies.
- **Fail closed everywhere.** Unknown `PAYMENTS_*`/`STRIPE_*` variables, a key whose mode disagrees with `PAYMENTS_MODE`, or a missing webhook secret stop the service from starting. Caddy answers 503 while `PAYMENTS_UPSTREAM` is unset. The Astro pages disable their buttons unless told otherwise at build time. Any one of those three is enough to prevent a purchase.

## Environment variables

Documented with defaults in `payments/.env.example`. Summary:

| Variable | Service | Purpose |
| --- | --- | --- |
| `PAYMENTS_MODE` | payments | `disabled` (default), `test`, or `live`. Kill switch. |
| `PAYMENTS_HOST`, `PORT` | payments | Bind address and port. Railway private networking is IPv6, so use `::` there. |
| `PAYMENTS_PUBLIC_ORIGIN` | payments | Canonical site origin for return URLs and the same-origin check. `https://worldhotlines.org`. |
| `PAYMENTS_SUCCESS_PATH`, `PAYMENTS_CANCEL_PATH`, `PAYMENTS_RETURN_PATH` | payments | Return paths on the public origin. Defaults match the built pages. |
| `PAYMENTS_TRUST_PROXY` | payments | `1` behind Caddy so `X-Forwarded-For` drives abuse limiting. |
| `PAYMENTS_OFFERS` | payments | JSON map of offer id → `{price, mode, quantity?}`. Ids must match `payments/contracts/v1/offers.json`. |
| `PAYMENTS_AUTOMATIC_TAX` | payments | `1` to enable Stripe Tax on sessions. Requires Tax configured in Stripe and a tax decision. Off by default. |
| `PAYMENTS_STRIPE_TIMEOUT_MS` | payments | Outbound Stripe timeout. Default 15000. |
| `STRIPE_SECRET_KEY` | payments | Restricted key preferred (`rk_test_`/`rk_live_`). Its mode must match `PAYMENTS_MODE`. |
| `STRIPE_WEBHOOK_SECRET` | payments | The endpoint's `whsec_` signing secret. |
| `STRIPE_API_VERSION` | payments | Optional pin, e.g. the version shown in the Dashboard. |
| `PAYMENTS_UPSTREAM` | web (Caddy) | `host:port` of the payments service, e.g. `payments.railway.internal:8081`. Unset means 503. |
| `PUBLIC_PAYMENTS_MODE` | web (build) | `test` or `live` enables the `/billing` buttons in the built HTML. Unset means disabled. |

Run `node src/cli.mjs check-config` from `payments/` (or `railway run` it) to validate a configuration. It prints a secret-free summary and exits non-zero with the offending variable name on any problem.

## Local testing

```bash
cd payments
cp .env.example .env            # gitignored; fill in test-mode values
npm test                        # 35 unit and integration tests, no network
set -a; . ./.env; set +a
node src/cli.mjs check-config
node src/cli.mjs serve          # http://127.0.0.1:8081/billing/api/health

# Exercise the webhook without Stripe: sign a synthetic fixture with your test secret.
sig=$(node src/cli.mjs sign-test-event --file fixtures/events/checkout.session.completed.synthetic.json)
curl -i -X POST http://127.0.0.1:8081/billing/api/webhook -H 'content-type: application/json' \
  -H "stripe-signature: $sig" --data-binary @fixtures/events/checkout.session.completed.synthetic.json

# With the Stripe CLI, forward real test events:
stripe listen --forward-to localhost:8081/billing/api/webhook
```

To run the whole site locally with the route proxied, start Caddy with `PAYMENTS_UPSTREAM=127.0.0.1:8081` alongside the payments service. Without that variable Caddy answers 503, which is the state CI verifies.

## Activation checklist

Work top to bottom. Every step is reversible by unsetting `PAYMENTS_UPSTREAM` or setting `PAYMENTS_MODE=disabled`.

### Decisions (blocking)

- [ ] Licensing decision recorded and the `held` outcome in `reviews/licensing-legal-review/v1/` formally superseded by counsel.
- [ ] Terms of service, refund/cancellation policy, and privacy notice covering Stripe as processor approved and linked from `/billing`.
- [ ] Tax position decided (Stripe Tax on or off; registrations where required).
- [ ] Prices and included volumes for the Growth tier approved. They are entered in Stripe only, never in this repository.

### Stripe Dashboard (test mode first)

- [ ] Business profile, statement descriptor, support email, and branding completed.
- [ ] Product and recurring price created for `growth_monthly`. Copy the `price_…` id into `PAYMENTS_OFFERS`.
- [ ] Restricted API key created with: Checkout Sessions write and read, Customer Portal write. Nothing else. Store it only in the Railway service variables.
- [ ] Customer Portal configured (cancellation, payment method update, invoice history) with return URL `https://worldhotlines.org/billing`.
- [ ] Webhook endpoint added for `https://worldhotlines.org/billing/api/webhook` with events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy the `whsec_…` secret.
- [ ] Radar rules reviewed; email receipts enabled.

### Railway

- [ ] New service from this repository with **root directory `payments`** (picks up `payments/Dockerfile` and `payments/railway.toml`). Set the variables from the table above with `PAYMENTS_MODE=test`, `PAYMENTS_HOST=::`, `PAYMENTS_TRUST_PROXY=1`. Health check `/billing/api/health` must go green.
- [ ] Durable store decision: the in-memory store is single-instance and forgets events on restart. Before more than one replica or any entitlement automation, implement the four-method store contract (`payments/src/store.mjs`) on a database and inject it in `payments/src/cli.mjs`.
- [ ] On the **web** service, set `PAYMENTS_UPSTREAM=payments.railway.internal:8081` (private networking) and redeploy. `POST /billing/api/checkout-session` should now reach the service (a 400 `unknown_offer` for a bogus offer proves the path).
- [ ] On the **web** service, set build variable `PUBLIC_PAYMENTS_MODE=test` and redeploy so `/billing` renders live buttons with the test-mode banner.
- [ ] Complete a test-card checkout end to end, confirm the webhook shows delivered in the Dashboard, and confirm the Customer Portal opens from `/billing/success`.

### Go live

- [ ] Repeat the Dashboard steps in live mode (live price, live restricted key, live webhook endpoint and secret).
- [ ] Set `PAYMENTS_MODE=live`, `STRIPE_SECRET_KEY=rk_live_…`, `STRIPE_WEBHOOK_SECRET=whsec_…` (live), `PAYMENTS_OFFERS` with the live price. `check-config` must pass. Redeploy the payments service.
- [ ] Set `PUBLIC_PAYMENTS_MODE=live` on the web service and redeploy.
- [ ] Update `docs/PACKAGING.md` and `payments/contracts/v1/README.md` status wording in a reviewed pull request; the verifiers pin the current "prepared, not enabled" wording deliberately so this cannot happen silently.
- [ ] Rollback rehearsed: unsetting `PAYMENTS_UPSTREAM` returns every route to 503 within one deploy; `PAYMENTS_MODE=disabled` does the same at the service.

## Operational notes

- **Secrets.** Only Railway service variables hold Stripe keys. `.env` files are ignored by git and Docker, `check-config` never prints secrets, error messages name variables only, and `verify:payments` scans tracked files for key-shaped strings. Rotate the restricted key and webhook secret if either is ever pasted anywhere else.
- **Logs.** The service emits one JSON line per request with `route`, `status_code`, `outcome`, `event_type`, and `offer`. No IPs, bodies, customer ids, or headers.
- **Abuse limiting.** Session-creation routes have per-client and global token buckets (see `LIMITS` in `payments/src/server.mjs`). They are advisory; Stripe's own rate limits and Radar remain the real controls.
- **Custom Checkout domains.** The service accepts only `https://checkout.stripe.com/` and `https://billing.stripe.com/` URLs. If a custom Checkout domain is adopted later, extend `CHECKOUT_ORIGIN`/`PORTAL_ORIGIN` and the CSP `form-action` together.
- **What entitlement means.** A recorded `sub:` entitlement with status `active` is a fact about payment only. Issuing a managed API key is a separate gateway workflow (`gateway/`) that does not yet exist in deployed form.

## Not done by this foundation

No Stripe account, product, price, webhook, tax setup, terms, or deployed service is created here. No customer accounts or login exist; subscribers manage billing through the Stripe Customer Portal using their checkout session reference. Managed API key issuance on payment is not implemented.
