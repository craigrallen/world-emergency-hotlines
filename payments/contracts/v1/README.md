# Payments foundation v1 — PREPARED, NOT ENABLED

This directory documents the Stripe integration surface that the `payments/` service exposes when it is enabled. Today it is disabled: `PAYMENTS_MODE` defaults to `disabled`, the Caddy `/billing/api/*` route answers 503 unless a `PAYMENTS_UPSTREAM` is configured, no Stripe account keys exist in this repository, and no price is published. Enabling it requires the checklist in `docs/PAYMENTS.md`, including the outstanding licensing/legal decision. Current static site, `/api/v1/**`, feeds, widget, and data stay free, keyless, and unmetered; crisis information is never paywalled.

## Design

- **Hosted Stripe Checkout, redirect flow.** The browser posts an offer id to `/billing/api/checkout-session`; the server creates a Checkout Session and answers `303 Location: https://checkout.stripe.com/...`. No Stripe.js, iframe, or card field runs on this origin, so the site's CSP only needs `form-action` to allow `checkout.stripe.com` and `billing.stripe.com`, and `Permissions-Policy: payment=()` can stay.
- **Offer ids, never price ids, cross the wire.** `offers.json` is the public list of offer ids; the private `PAYMENTS_OFFERS` variable maps each id to a Stripe price. Requests naming an unmapped offer are rejected.
- **Same-origin only.** Browser-originated POSTs must carry an `Origin` equal to `PAYMENTS_PUBLIC_ORIGIN` (and `Sec-Fetch-Site: same-origin` when present).
- **Webhook verification.** `/billing/api/webhook` verifies `Stripe-Signature` (HMAC-SHA256 over `timestamp.body`, 300-second tolerance, constant-time compare), rejects events whose `livemode` disagrees with the deployment mode, deduplicates by event id, and records only pseudonymous identifiers plus closed enum statuses.
- **Customer Portal.** `/billing/api/portal-session` exchanges a completed subscription Checkout Session id for a Customer Portal URL so subscribers can cancel or update payment details without an account system.
- **Fail closed.** Unknown `PAYMENTS_*`/`STRIPE_*` variables, key/mode mismatches, malformed offers, or a missing webhook secret stop startup. Secret values never appear in logs or error messages.

## Routes

| Route | Method | Disabled | Enabled |
| --- | --- | --- | --- |
| `/billing/api/health` | GET, HEAD | 200 `status:"disabled"` | 200 `status:"enabled"` |
| `/billing/api/checkout-session` | POST | 503 `payments_disabled` | 303 to Checkout, or 200 JSON `{url,id}` for `Accept: application/json` |
| `/billing/api/portal-session` | POST | 503 `payments_disabled` | 303 to the Customer Portal, or 200 JSON `{url}` |
| `/billing/api/webhook` | POST | 503 `payments_disabled` | 200 `{received:true}`; 400 on bad signature or livemode mismatch |

Every other path is 404; query-bearing paths are 404; wrong methods are 405 with `Allow`. `openapi.json` is the machine-readable contract.

## Privacy

The store keeps `cs_`, `sub_`, `cus_`, `in_`, and `pi_` identifiers, the offer id, and enum statuses. It never stores or logs names, emails, addresses, card data, amounts, IP addresses, or request bodies. Access logs use the fixed event schema in `src/server.mjs` (`EVENT_KEYS`).

## Not included

No Stripe account, product, price, webhook endpoint, tax configuration, terms of service, refund policy, or deployed service is created by this repository. The in-memory store is single-instance; a durable store is required before more than one replica runs.
