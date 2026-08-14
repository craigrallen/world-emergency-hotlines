# Provider claim staging and independent review v1 — STATIC/SYNTHETIC CONTRACT, NOT AN INTAKE SERVICE

This directory is a versioned, read-only reference contract. Every identity, listing, stable ID, URL, and item of evidence is conspicuously synthetic. `.invalid` identities and `syn_`-prefixed IDs cannot represent or collide with canonical `weh_` record IDs. Nothing here is a real provider claim, contact, customer export, portal, intake route, admin route, publication system, or offer of service.

Provider assertions cross an explicit trust boundary: they are always `untrusted_claimant_evidence`. Submission can only create a `staged` envelope. Review passes through `under_review` and ends at `accepted_for_candidate`, `rejected`, or `needs_more_evidence`. `accepted_for_candidate` means only that a claim may be considered by the repository's existing, separately approved promotion workflow. It never means canonical, verified, published, endorsed, ranked, or search-visible, and the reference harness cannot output a canonical record.

The reviewer must use a synthetic identity distinct from both claimant and provider identities, declare no conflict, cite bounded evidence, record a closed reason code and uncertainty, and produce an effect declaration that keeps canonical mutation, verified status, ranking/search effects, and publication false. Self-review, provider review, identity collision, invalid transitions, uncited evidence, arbitrary metadata, unsupported status/rank fields, non-HTTPS or non-`.invalid` URLs, and unknown fields fail closed.

The envelope permits only three proposed fields: `organization_name`, `service_description`, and `service_url`. Runtime validation additionally restricts text and rejects personal or crisis narratives. The contract excludes phone numbers, email addresses, contact collection, crisis stories, user data, live availability, outcomes, quality, security, telemetry, pricing, billing, support, SLA, DPA, and commercial claims. It performs no network access, persistence, automatic verification, promotion, or publication.

Both schemas are closed Draft 2020-12 schemas. Cross-document identity, evidence, independence, transition, reason/effect coherence, and narrative checks are enforced by the dependency-free `provider-claims/model.mjs` harness and are listed in `x-runtime-invariants`. Consumers must apply both schema and runtime checks.

The generated `/provider-claims/v1/` files are exact byte copies of these static source artifacts. They are included in release-integrity checks only as published contract bytes; this does not make their synthetic claim a canonical dataset input. The subsystem neither reads nor writes `hotlines.json` during contract generation.

Public crisis information remains free. This repository has no license; public access does not grant reuse rights, and permission must be confirmed before production reuse.
