# Release notifications — design contract

This directory defines a proposed future managed release-webhook service. It is not a signup service, no POST endpoint is deployed, and this repository collects no destination, contact, subscriber, or usage data. The static files are useful for integrator design and local testing only.

Subscriptions may filter only technical release event type, API major, or artifact class. Country, category, provider/hotline, query, person, location, behaviour, and crisis-need profiles are intentionally outside the contract. Event payloads contain release identities and aggregate change counts, never raw before/after hotline values or user identifiers.

All published fixtures use reserved `synthetic-*` release IDs, a fixed synthetic 2038 date, and fixed synthetic SHA-256 values. They do not identify or derive from a tracked production release. Repository tests build a separate, non-public event to check linkage to the currently tracked release.

Event types have deterministic meanings, and the closed `release_kind` field repeats that meaning in the payload so schema validation can distinguish baseline from later zero-change releases. `baseline` is only a zero-change release whose tracked baseline identity has no previous entry; `no-change` is every other zero-change release; `added` requires additions and no other component; `country-metadata` requires metadata changes and no record changes; and `modified` covers every remaining nonzero or mixed case, including removed-only releases. The six component counts are authoritative; consumers derive a total by summing them. Artifact classes are a non-empty, unique, UTF-16-sorted exact enum.

The caller supplies `time` as a valid RFC 3339 UTC timestamp. Time intentionally does not affect stable identity: the event ID is SHA-256 over canonical JSON containing `contract: "org.worldhotlines.subscription-event/v1"`, `source`, `type`, and `data`. This explicit domain/version prefix separates the identifier from other hashes and leaves delivery time free to vary without changing idempotency.

The currently available zero-registration notification options are `/feeds/releases.json` (JSON Feed), `/feeds/releases.rss` (RSS), and `/feeds/releases.atom` (Atom). They and the static dataset remain available independently of any future managed offering.

## Verification reference

Generate secret material as exactly 32 random bytes represented by canonical unpadded base64url. Strictly decode it back to bytes, then compute HMAC-SHA256 over `ASCII(timestamp) + "." + exactRawBody`. Parse `World-Hotlines-Signature` as `v1=<hex>`, reject unsupported versions or timestamps outside 300 seconds, decode both digests to equal-length byte arrays, then compare with a constant-time primitive. Record the stable event id before processing and return 2xx for duplicates after retrieving the prior result.

```text
verify(rawBody, timestamp, signature, now, secrets):
  require abs(now - integer(timestamp)) <= 300
  require signature starts with "v1=" and has exactly 64 lowercase hex digits
  require current has a canonical secret and no expiry metadata
  require previous, when present, has finite safe integer activated_at and expires_at, expires_at >= activated_at, and expires_at - activated_at <= 86400
  for secret in [current, previous-only-if-activated_at <= now <= expires_at]:
    expected = HMAC_SHA256(secret, ASCII(timestamp) || "." || rawBody)
    if equal_length(expected, decode_hex(signature)) and timing_safe_equal(...): accept
  reject
```

The previous secret is eligible only during the inclusive interval `activated_at <= now <= expires_at`; outside that interval it is not eligible. Both bounds must be valid finite safe Unix-second integers and the overlap `expires_at - activated_at` must be at most 86400 seconds. The current secret remains usable before, during, and after that interval.

The reference CLI uses `WEH_SYNTHETIC_WEBHOOK_SECRET` for the current secret. To verify with a previous secret, all three variables are mandatory: `WEH_SYNTHETIC_WEBHOOK_PREVIOUS_SECRET`, `WEH_SYNTHETIC_WEBHOOK_PREVIOUS_ACTIVATED_AT`, and `WEH_SYNTHETIC_WEBHOOK_PREVIOUS_EXPIRES_AT`. Both timestamps are strict safe Unix-second integers; the optional verification clock override is `WEH_SYNTHETIC_NOW`. Secret values are never logged.

The static contract generator has fixed repository-controlled source and destination paths. The normal build first recreates `web/public/subscriptions`, then writes an exact file manifest into a new `v1` directory. If generation fails after creating that directory, it revalidates containment and symlink state, removes only that newly created partial output, and rethrows so an immediate retry can proceed. It rejects symlinked or non-directory ancestors immediately before filesystem operations. This is path/symlink hardening and failure cleanup for a trusted single-writer build, not filesystem atomicity or a guarantee against an attacker concurrently replacing entries.

See `webhook-contract.json` for retry, timeout, idempotency, secret rotation, body limit, SSRF, and terminal semantics. Those values are design choices, not an active SLA. A future hosted product could add managed delivery, retries, and operational assurance without withholding the free feeds or static data; no price or assurance commitment exists today.
