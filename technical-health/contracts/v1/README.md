# Static technical-health contract v1 — SYNTHETIC / NOT A SERVICE

These Draft 2020-12 schemas and conspicuously synthetic examples define the only permitted weekly technical aggregate cube and a deterministic static dashboard document. Nothing here collects telemetry, accepts raw events, persists data, performs networking, creates a customer boundary, or deploys a query/admin/monitoring service.

Each aggregate cell is exactly `event`, that event's closed approved dimensions, and `count`. The v1 release threshold is fixed at 100, and each finite cube coordinate may occur at most once. Boundary data must be deleted within 7 days; released cells within 90 days. There is one non-overlapping weekly cube and no marginals, joins, drill-down, identifiers, timestamps, routes, geography, crisis selections, hotline data, or open metadata.

The dashboard state means only that supplied static descriptors and a supplied thresholded batch validated. It never means a hotline, website, API, or provider is available; it says nothing about people, outcomes, uptime, live monitoring, support, or SLA. Missing or suppressed metrics must never be converted to a success state.

The dependency-free harness is `technical-health/model.mjs`. It accepts only a complete aggregate batch and a minimal release descriptor, has no I/O, and fails closed. The synthetic dashboard intentionally does not identify a real release, avoiding circular release-integrity claims.
