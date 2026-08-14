# Managed API plans v1 — PROPOSED STATIC/SYNTHETIC DESIGN, NOT AN OFFER

This directory is a deterministic planning contract. The managed API is not live; there is no signup, checkout, billing, customer/contact capture, key issuance, counter store, compare-and-swap implementation, telemetry, SLA, DPA, tax/VAT promise, support-response promise, or deployed managed route.

Current static site, `/api/v1/**`, feeds, widget, and data stay free, keyless, and unmetered. Crisis information must never be degraded or paywalled. Repository access does not grant reuse rights: no repository license exists, so commercial and non-commercial integrators must confirm permission.

`developer_free` proposes 100,000 managed request units per UTC calendar month for USD 0, without a payment method. It hard-stops with 429 until the next month, with no overage charge or automatic paid conversion. Support is community/best-effort only, with no SLA or uptime commitment. The 1-organization, 1-project, and 2-active-key limits are design-only proposals.

`growth` proposes a base subscription, included calls, and transparent metered overage, but every price and volume is `not_published`; charging requires explicit opt-in. `enterprise` has unpublished custom volume, SLA/support, procurement, and security options.

One unit is an authenticated and authorized managed-artifact GET or HEAD attempt, including 200/304 and attempts rejected only by the monthly allowance. Health, exact OPTIONS, authentication failures, forbidden requests, unknown/query-bearing routes, and free static surfaces consume zero. Short-term token-bucket rate limiting is separate.

The only transition-producing model operation takes exactly the authoritative store-read `{generation, utc_month, used_units}` state, a trusted evaluation instant, and the exact request classification. It validates and evaluates these in one ordered derivation. `used_units` is always an integer from 0 through 100,000; generation is a non-negative safe integer. Invalid, over-cap, backward-month, or generation-overflow state fails closed before any transition is returned.

For a metered request in the same UTC month, the operation derives one full-state transition. An allowed attempt increments usage and generation. A 429 attempt increments generation while preserving usage exactly at 100,000. For a strictly later UTC month, one atomic transition advances generation, changes to the trusted month, and records this request as `used_units: 1`; there is no optional reset step. Zero-unit requests always return `{units:0, decision:'not_metered', transition:null}`, including across a month boundary, so the next metered request performs the atomic rollover.

Only account ID, UTC month, aggregate technical unit count, and monotonic technical counter generation may support a future quota/billing counter. Never retain URL/query/raw path, country/category/hotline/crisis intent, behavior, IP/referrer, contact data, authorization/raw keys, or distress analytics.

A future trusted server would pass only the model-derived transition to a store that atomically compares all fields of `expected_state` against the current authoritative state before writing the exact `next_state`. Full-state mismatch rejects stale competitors, concurrent attempts, and replay. The model exposes no apply helper and accepts no caller-selected transition or `next_state`. No counter store, CAS helper, billing system, or managed API is deployed.
