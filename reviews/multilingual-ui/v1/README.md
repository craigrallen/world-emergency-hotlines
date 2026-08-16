# Internal multilingual UI review handoff (v1)

This directory is a static, synthetic, non-authoritative handoff for eventual
qualified human review of the site's finite UI strings. It is tracked for
internal review and is not copied into `web/public` or the built site.

`review-pack.json` is generated from `web/src/lib/i18n.ts`,
`web/src/lib/locale-status.json`, and the closed safety policy in
`safety-classification.json`. Its ordered canonical key inventory and exact
English key/value tuples are digest-bound, and its values are allowlisted by construction from
the static UI runtime dictionaries only; canonical provider data, hotline
records, provider contacts, and provider evidence are excluded source classes.
Leakage scans are defense in depth, not provenance evidence. English is the source/master. A
`locale_override` means only that a value exists in the locale dictionary; it
does not mean the value is correct or reviewed. `english_fallback` records the
actual runtime fallback. Every decision is deliberately
`pending_not_reviewed`, with absent identity, timestamps, evidence, and notes.

## Reviewer instructions

Review only the UI key, source English, and offered locale value in this pack.
Do not review, translate, or infer changes to provider names, hotline records,
contacts, evidence, or any canonical dataset. Treat `safety_facing` copy as
high consequence. Treat `legal_sensitive` copy as requiring legal clearance
where applicable in addition to language review.

This pack cannot qualify a locale. No qualification may occur until an
identity-distinct, qualified human reviewer decision is recorded through a
future separately approved process. That process does not exist in this slice,
and editing this generated JSON is not a substitute for it. Any future approved
decision requires a new versioned artifact and an authenticated decision
process with its own reviewed contract; v1 remains permanently pending-only
and must never be relaxed in place. A UI-string review
also does not prove that any service is available, reachable, current, or
accurate; users must still verify service and number information locally.

## Generation and verification

From `web/`:

```sh
npm run generate:multilingual-review-pack
npm run verify:locales
```

The verifier checks the committed bytes against fresh generation, independently
executes instrumented TypeScript-emitted runtime dictionaries for parity, and validates
the real artifact against a closed JSON Schema. The schema fixes v1 counts and
locale/cell inventories, order, and statuses. Exact regeneration remains
required for semantics JSON Schema cannot express here, including key
uniqueness, source parity, classifications, and runtime override presence;
schema validation is not an independent substitute. The tests adversarially cover
key and locale drift, English parity, override/fallback truth, classification
drift, ordering/reproducibility, fail-closed placeholders, forbidden claims,
and contact-shaped leakage, including any standalone three-digit decimal token
after explicit benign-context removal. Changing the canonical key inventory requires an
explicit review of the safety policy and its key-inventory digest.

`reviews/` is excluded from the Docker build context. The non-publication
verifier rejects internal pack paths and markers in `web/dist`; the deployment
image smoke test repeats that assertion against `/srv` and served routes.
