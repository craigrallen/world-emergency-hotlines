# World Emergency & Crisis Hotlines

A project to build a source-backed global reference of emergency numbers and crisis support helplines: general emergency (police/fire/ambulance), suicide and mental-health crisis lines, child-protection lines (Childline-equivalents), domestic and sexual violence lines, LGBTQIA+ support, substance use, bereavement, and more. Coverage and verification depth vary by place and category; the dataset does not claim completeness or real-time service availability.

Public site: <https://worldhotlines.org>

## Files in this project

| File | Purpose |
| --- | --- |
| `SCHEMA.md` | Full schema documentation for `hotlines.json` |
| `hotlines.json` | The enriched, canonical dataset (schema v2.0) |
| `information.json` | Original source dataset (preserved for reference and for migrating remaining countries) |
| `sources/web_verified_crisis_directory/` | Vendored 2026-04-22 web-derived source artifacts plus a conservative non-canonical schema-v2 preview |
| `sources/child_helpline_international/` | Repo-owned Child Helpline International source artifacts, unmatched-country list, and a conservative child-helpline schema-v2 preview |
| `scripts/integrate_web_verified_directory.py` | Converts the supplemental source directory into a reviewable schema-v2 preview + integration report while explicitly skipping countries that already have richer canonical records |
| `scripts/fetch_child_helpline_international.py` | Fetches the Child Helpline International WordPress directory with browser-like headers and normalizes it into repo-owned source artifacts |
| `scripts/integrate_child_helpline_international.py` | Converts the Child Helpline International source artifact into a non-canonical schema-v2 preview + integration report while preserving existing richer canonical records |
| `tests/test_web_verified_directory_preview.py` | Regression checks that the supplemental preview stays schema-v2, non-canonical, and cannot downgrade protected rich records |
| `tests/test_child_helpline_international_source.py` | Regression checks for the Child Helpline International source artifact, preview safety contract, and sample parsing fidelity |
| `tests/test_canonical_promotion_safety.py` | Phase-0 safety-contract checks for non-canonical previews, protected-country promotion rules, and explicit `--apply` requirements in the promotion flow |
| `COVERAGE.md` | Per-country coverage status: verified, legacy, or missing |
| `docs/data-flow.md` | Canonical vs preview/review artifact roles and write-permission contract |
| `docs/SEO_AUTHORITY_AND_EDITORIAL_METHODOLOGY.md` | Safety-first editorial, metadata, correction, and legitimate authority-building policy |
| `docs/plans/2026-04-22-v2-data-expansion-roadmap.md` | Concrete implementation roadmap for safe schema-v2 data expansion and promotion |
| `docs/OPERATIONS.md` | Privacy-safe public intake, read-only source monitoring, and the verification reviewer workbench |
| `docs/INTEGRATIONS.md` | Integration decision guide, v1 examples, limitations, and production checklist |
| `managed-api-plans/` | Static, synthetic managed-API plan contract with one ordered authoritative metering planner; no service, store, CAS helper, or billing is deployed |
| `payments/` | Dependency-free Stripe hosted-Checkout and webhook foundation (service, contracts, tests, Railway/Docker files); prepared but disabled, not deployed, no prices |
| `docs/PAYMENTS.md` | Payments architecture, environment variables, and the activation checklist that must be completed before billing can be switched on |
| `deprecation-proposals/` | Static synthetic deprecation/replacement proposals and closed redacted audit-export contract; no canonical mutation or publication authority |
| `docs/RELEASES.md` / `docs/releases.json` | Contract and machine-readable source for factual public release milestones |
| `docs/dataset-releases.json` / `docs/dataset-release-snapshots/` | Trusted-base CI unchanged-prefix checks, a self-consistent hash chain, and complete metadata-only snapshots |
| `docs/PRIVACY_SAFE_METRICS.md` | Static privacy-safe aggregate/dashboard contract; telemetry remains unimplemented |
| `docs/PACKAGING.md` | Current public-beta versus not-offered capability matrix |
| `docs/DESIGN_PARTNER_PILOT.md` | Internal/reviewable bounded pilot brief |
| `README.md` | This file |

## Proposed managed API design

The managed API plan is a non-offer design only; every current static crisis-information surface remains free, keyless, and unmetered. Its single transition-producing operation takes only an exact authoritative store-read `{generation, utc_month, used_units}` state, a trusted instant, and the exact request classification. It derives one full-state CAS transition: same-month requests increment usage and generation (or preserve the 100,000 cap while advancing generation for 429), and the first metered request in a later month atomically rolls forward with `used_units: 1`. Zero-unit requests never transition. No caller-selected next state is accepted, and no managed API, counter store, CAS helper, signup, or billing system is deployed. See [`managed-api-plans/contracts/v1/README.md`](managed-api-plans/contracts/v1/README.md).

## Scope

Every UN member state, plus widely-recognised territories and autonomous regions with their own emergency infrastructure (Hong Kong, Taiwan, Puerto Rico, Gibraltar, the Crown Dependencies, etc.).

For each country we aim to record, at minimum:

1. The general emergency number (police/fire/ambulance)
2. A suicide / acute mental-health crisis line where one exists
3. A child-protection line where one exists
4. Any domestic violence, sexual violence, LGBTQIA+, substance use, or other specialised lines

## Methodology and verification tiers

Every hotline record carries a `verification_status` so consumers can see how much confidence to place in it.

- **`verified_web`** — The number was confirmed against the provider's official website on `last_verified`.
- **`verified_authority`** — The number was confirmed against a named authoritative body/source, such as a government body, national health ministry, WHO, or IFRC.
- **`verified_knowledge`** — The number was asserted from prior training knowledge and was not reconfirmed on the public web. This is not provider, authority, or web verification.
- **`cross_referenced`** — The record originated from a third-party public directory (e.g. helplines.world, Find A Helpline, or Child Helpline International). Moderate trust reflects presumed directory diligence; this status is not provider or authority verification. Currently the largest single tier — see [Current state](#current-state-2026-08-12).
- **`legacy_unverified`** — Carried over from an earlier source dataset without independent check. Treat as a lead, not a fact.
- **`disputed`** — Sources disagree; see the record's `notes` field. No records currently carry this status.
- **`deprecated`** — Service has closed or the number is no longer in use. No records currently carry this status.

Only `verified_web`, `verified_authority`, and `verified_knowledge` are number-verification claims, and they apply only to the number. They do not verify category, hours, languages, cost, target audience, notes, website, sources, non-number contact channels, eligibility, geography, availability, or broader scope; each requires separate field-level evidence. The other statuses retain the distinct meanings above: record origin for `cross_referenced`, record inheritance for `legacy_unverified`, conflicting record values for `disputed`, and service/contact lifecycle for `deprecated`.

## Session progress (2026-04-22)

### Pass 1 — schema + tier-1 authoring
- Designed and documented the enriched v2.0 schema (`SCHEMA.md`).
- Authored 216 rich records across 22 tier-1 countries (US, UK, AU, CA, IE, NZ, DE, FR, JP, IN, NL, ES, IT, ZA, BR, MX, SE, DK, BE, SG, HK, KR). Each with category, hours, languages, cost, target audience, notes, website, and source URLs.

### Pass 2 — merge, territories, Excel
- Fetched and parsed the Vibbrancy (`atlacord/Naga`) `Hotlines.json` (249 entries, different schema). Written parser that converts its free-text `CRISIS_RESOURCES` into structured hotline records.
- Merged `information.json` (202 countries) + Vibbrancy (249 countries) + pass-1 enrichment (22 countries) into a single `hotlines.json` using fuzzy name + number-set deduplication.
- Added 48 territories previously missing: Åland, Anguilla, Aruba, Bermuda, Bonaire, Faroe Islands, French Polynesia, Guadeloupe, Guam, Holy See (Vatican), Isle of Man, Jersey, Macao, Martinique, Mayotte, Montserrat, New Caledonia, Niue, Norfolk Island, Northern Mariana Islands, Puerto Rico, Réunion, Saint Barthélemy, Saint Helena, Saint Martin, Saint Pierre and Miquelon, Sint Maarten, Tokelau, Turks and Caicos, US Virgin Islands, British Virgin Islands, Wallis and Futuna, Western Sahara, and others.
- Populated emergency numbers for the inhabited territories that had no crisis-resource data.
- Generated `hotlines.xlsx` (3 sheets: Hotlines with 1,958 rows + header, By Country with 250 rows, Categories legend).

### Pass 3 — tier-2 and tier-3 rich enrichment
- Authored rich JSON enrichment for all remaining countries in Europe, the Americas, Africa, Asia-Pacific, the Middle East, and Oceania — see `scripts/enrichment/*.json`.
- Added an idempotent applicator (`scripts/apply_enrichment.py`) that merges enrichment files into `hotlines.json` without overwriting existing rich entries.
- Ran a spot-check audit: 20 legacy records sampled at random all looked valid; one orphan (NEDA, intentional — service closed 2023). See `REPORTS/spot_check_20260422.md`.

### State at the end of this session (2026-04-22, historical)

The counts below describe the dataset as it stood at the end of the 2026-04-22 session, immediately after this pass. They are kept for provenance; the dataset has grown substantially since then — see [Current state (2026-08-12)](#current-state-2026-08-12) below for the 2026-08-12 snapshot.

- **250 countries / territories** in `hotlines.json`.
- **1,952 hotline records**:
  - 743 fully enriched (`verified_knowledge`) with category, hours, languages, cost, target, notes, website, sources — pending web confirmation.
  - 1,209 migrated (`legacy_unverified`) — carry name + number and some email/website, pending enrichment.
- **120+ countries** have at least one `verified_knowledge` entry.
- **4 uninhabited territories** have no hotlines — documented as such.
- **Supplemental 2026-04-22 source directory vendored** under `sources/web_verified_crisis_directory/`:
  - 253 web-derived country/territory rows preserved as source artifacts.
  - `scripts/integrate_web_verified_directory.py` converts that source into a schema-v2-compatible `web_verified_directory_v2_preview.json` review artifact without overwriting canonical data.
  - The generated preview is explicitly **non-canonical** and skips countries whose canonical v2 records already contain richer non-legacy hotlines, preventing accidental downgrade-by-overwrite.
  - Regression coverage in `tests/test_web_verified_directory_preview.py` checks that protected canonical countries never appear in the preview and that preview hotlines remain `legacy_unverified`.
  - Current conservative mapping still reaches **243 / 253** source rows; with the current canonical v2 baseline, **232** of those matched rows are intentionally skipped because canonical data already contains richer non-legacy records, **11** countries remain in the supplemental preview, and the final 10 unmatched rows stay in `unmatched_country_rows.json` for manual geopolitical review.
- **Supplemental Child Helpline International adapter added** under `sources/child_helpline_international/`:
  - `scripts/fetch_child_helpline_international.py` fetches the published Child Helpline International WordPress directory with browser-like headers and writes repo-owned source artifacts.
  - `scripts/integrate_child_helpline_international.py` converts those artifacts into a schema-v2-compatible `child_helpline_international_v2_preview.json` review artifact without touching canonical data.
  - Imported child-helpline records remain deliberately `legacy_unverified` with `provenance.source_class=ngo_directory` and `review_state=staged` until maintainers explicitly review/promo them.
  - Countries whose canonical records already have richer non-legacy hotlines may still appear in this preview only as append-only / merge-missing review input for the existing promotion-candidate pipeline, and unmatched geopolitical entities remain documented in `unmatched_countries.json` instead of being guessed into the canonical list.

## Current state (2026-08-12)

The dataset has grown substantially since the 2026-04-22 session through additional merge/integration passes (Find A Helpline, Wikipedia crisis lines, Child Helpline International, government travel-advisory emergency numbers, and others — see `scripts/` and `sources/`). As of 2026-08-12, `hotlines.json` (schema v2.0) contains:

- **250 countries / territories**, of which **4** genuinely have zero hotline records (uninhabited territories — see [COVERAGE.md](COVERAGE.md)).
- **3,255 hotline records** across **30 categories**.
- Verification status breakdown:
  - `cross_referenced` — 951
  - `legacy_unverified` — 863
  - `verified_authority` — 672
  - `verified_web` — 586
  - `verified_knowledge` — 183
  - `disputed` / `deprecated` — 0
- **All 3,255 records** carry core metadata (name, category, organization, geography) and at least one contact method (phone, SMS, chat, email, or website).
- Field coverage: `hours` 2,160 · `languages` 1,582 · `website` 1,155 · `chat_url` 201 · `email` 136.
- **722 records** are categorised as `general_support` (the largest single category) rather than a more specific tier.
- **2,392** records carry a `last_verified` date; **863** do not — 862 `legacy_unverified` plus one `verified_knowledge` record. (Separately, exactly one `legacy_unverified` record — the NEDA orphan noted above — does carry a `last_verified` date.)

See [COVERAGE.md](COVERAGE.md) for the full per-status breakdown and current gaps.

## Current gaps / next work

These are the gaps visible in the 2026-08-12 dataset snapshot, not a committed schedule:

1. **863 `legacy_unverified` records** carry only minimal metadata and haven't been independently checked — candidates for enrichment via Befrienders Worldwide, IASP, or Find A Helpline.
2. **951 `cross_referenced` records** come from third-party directories without a recorded provider-site observation — candidates for read-only `scripts/source_monitor.py` review followed by the separate candidate/approval process. A source observation alone never promotes a record.
3. **722 records sit in `general_support`** rather than a more specific category; some are genuinely generic listening lines. Any recategorization requires source review rather than a blind keyword rewrite.
4. **4 territories have no hotline records** (Bouvet Island, French Southern Territories, Heard Island and McDonald Islands, US Minor Outlying Islands) — all are uninhabited or research-station-only, so this is expected, not a gap to fill.
5. **Safe supplemental promotion** — `docs/plans/2026-04-22-v2-data-expansion-roadmap.md` plus the non-canonical preview/report artifacts under `sources/` and `REPORTS/` remain the process for reviewing and promoting web-derived rows without downgrading existing rich canonical records.

## Safety contract docs

- Roadmap: `docs/plans/2026-04-22-v2-data-expansion-roadmap.md`
- Phase-0 data-flow contract: `docs/data-flow.md`

If you are adding or applying data, read those two docs first. They define what is safe to regenerate, what is review-only, and when `--apply` is required before any canonical write.

## How to use this dataset responsibly

If you're building anything that routes people to a crisis line — an app, a website, a chatbot — **on the day you publish, confirm each number against either the provider's official website or the applicable named government or other authoritative source**. Crisis line numbers change; operating hours change; services close. This dataset is a starting point, not a final source of truth.

If someone needs emergency help, use verified local emergency information for the person's current jurisdiction; do not assume any number works everywhere.

[Find A Helpline](https://findahelpline.com) and [Befrienders Worldwide](https://www.befrienders.org/) are third-party directory/research examples. Their inclusion does not imply endorsement, current availability, affiliation, or partnership.
