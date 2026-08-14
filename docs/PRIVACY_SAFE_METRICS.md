# Privacy-safe technical metrics contract

This is an implementable specification plus a static/local reference harness for a possible customer-controlled technical-health measurement system. **Telemetry is not implemented or enabled by this repository.** The versioned schemas, conspicuously synthetic examples, and dependency-free validator/deriver live under `technical-health/`; generated public copies live under `/technical-health/v1/`. They perform no networking or persistence and expose no ingestion or query route. This specification is not legal guidance, permission, authorization to collect data, or a claim that a managed analytics service exists. Any implementation and release process requires explicit qualified privacy and legal review.

## Allowed specification

Only these technical integration events and closed dimensions are permitted:

| Event | Required dimensions |
| --- | --- |
| `integration_loaded` | `integration_mode`: `finder_link`, `api`, `widget`, or `snapshot`; `major_version`: `v1` |
| `artifact_fetch_result` | `artifact_type`: `manifest`, `country`, `resolver`, `widget`, or `snapshot`; `result`: `success`, `http_error`, `network_error`, `parse_error`, or `empty`; `major_version`: `v1` |
| `resolver_execution_result` | `result`: `success`, `parse_error`, or `empty`; `major_version`: `v1` |

No other event, field, enum value, or optional dimension is allowed. In particular, do not collect centrally stored per-event records. Increment allowlisted aggregate counters at the customer-controlled boundary, after validating the event and its exact required dimension set. The counters must contain no identifiers or pseudonyms.

## Single release cube and retention

Release at most once per weekly window using one non-overlapping cube whose cell key is exactly `event` plus that event's approved dimension set above. Release no separate or overlapping marginals. Do not permit ad hoc queries, joins, differencing, drill-down, cohort construction, or a query API. Suppress every cell containing fewer than **100 technical events**; there is no uniqueness threshold or uniqueness mechanism.

Delete all boundary counters and any raw transient processing data within **7 days**. Retain released weekly aggregate cells for at most **90 days**. A reviewed implementation may use shorter retention or a higher event threshold, but may not broaden the taxonomy or release cube.

## Allowed released aggregate batch

```json
{
  "schema": "technical-health-aggregate/v1",
  "window": "2026-W32",
  "retention_days": 90,
  "boundary_deletion_days": 7,
  "minimum_event_count": 100,
  "cells": [
    {
      "event": "artifact_fetch_result",
      "artifact_type": "resolver",
      "result": "network_error",
      "major_version": "v1",
      "count": 184
    }
  ],
  "suppressed_cell_count": 7
}
```

This batch contains only thresholded technical execution counts. It contains no raw events and exposes no alternate grouping.

## Rejected raw event

```json
{
  "event": "prohibited_user_action",
  "timestamp": "2026-08-13T14:03:12.418Z",
  "user_id": "abc-123",
  "record_id": "weh_example",
  "country": "SE",
  "category": "suicide_crisis",
  "channel": "phone",
  "fallback_details": "local service absent",
  "locality": "Example Street",
  "need": "suicidal thoughts",
  "hotline_phone": "+00 000 000",
  "page_path": "/private/crisis-plan",
  "referrer": "https://example.invalid/sensitive"
}
```

Reject this object at the customer boundary because it is a centrally stored raw event and contains prohibited identifiers, crisis-intent data, hotline data, location, routing details, and browsing context. Do not accept it for later redaction.

## Data-minimization checklist

- Aggregate allowlisted counters at the customer-controlled boundary; never transmit centrally stored per-event records.
- Fail closed on extra fields, missing dimensions, or unknown enum values.
- Collect no IDs, pseudonyms, cookies, fingerprints, IP addresses, timestamps, URLs, paths, referrers, hotline records, locations, needs, crisis intent, audience traits, or partner/customer/user dimensions.
- Apply the single weekly release cube, threshold suppression, and automated 7-day/90-day deletion limits before export.
- Provide no individual funnels, overlapping cohorts, joins, differencing, drill-down, ad hoc export, or query interface.
- Disabling measurement must not change access to crisis information.
- Obtain explicit qualified privacy and legal review before implementation or collection.

## Interpretation boundaries

These counts measure technical executions only. They do not measure people, users, clients, devices, sessions, audience, intent, distress, contact attempts, actions, successful contact, service delivery, safety, availability, or outcomes. They must not be used to rank services, infer crisis needs, evaluate individuals, or optimize crisis routing. Differences between cells can reflect implementation behavior and suppression; they do not establish human behavior or impact.

## Delivered dashboard contract

The v1 dashboard is deterministic static reference output derived only from a valid complete aggregate batch and a minimal valid release descriptor. It reports `thresholded_aggregate_present` and `descriptor_indexed`; these are validation facts, not an operational “healthy” state. It cannot represent missing metrics as success and contains no timestamps, customer/organization/project IDs, component or route labels, latency, geography, categories, hotlines, behavioral fields, raw records, or open metadata. The public example uses synthetic SHA-256-shaped identities and does not identify the current release, which avoids a circular release-integrity claim.

The existing `/status` HTML surface remains build-time static release evidence sourced from the generated release descriptor. It links to this contract but does not display or imply collected metrics. Neither surface reports hotline availability, user outcomes, uptime, incidents, or an active monitored/support/SLA service. Public crisis information remains free and measurement must never gate it.
