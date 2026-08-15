# Coverage Status — 2026-08-12

This snapshot is measured directly from `hotlines.json` (schema v2.0). For the history of how the dataset got here, see the pass-by-pass narrative in [README.md](README.md#session-progress-2026-04-22).

## Totals

| Metric | Count |
| --- | --- |
| Countries / territories in dataset | 250 |
| Hotline records total | **3,255** |
| Categories in use | 30 |
| Records `verified_authority` | 672 |
| Records `verified_web` | 586 |
| Records `verified_knowledge` | 183 |
| Records `cross_referenced` | 951 |
| Records `legacy_unverified` | 863 |
| Records `disputed` / `deprecated` | 0 |
| Records with core metadata (name + category + organization + geography) | **3,255 (100%)** |
| Records with at least one contact method (phone, SMS, chat, email, or website) | **3,255 (100%)** |
| Records with `hours` populated | 2,160 (66%) |
| Records with `languages` populated | 1,582 (49%) |
| Records with `website` | 1,155 (35%) |
| Records with `chat_url` | 201 (6%) |
| Records with `email` | 136 (4%) |
| Records with a `last_verified` date | 2,392 (73%) |
| Records categorised `general_support` | 722 (22%) |
| Countries with 0 hotlines (genuinely uninhabited) | 4 |

## Status legend

- **`verified_authority`** — The number was confirmed against a named authoritative body/source, such as a government body, national health ministry, WHO, or IFRC.
- **`verified_web`** — The number was confirmed against the provider's own official website (see `sources` and `last_verified` on the record).
- **`verified_knowledge`** — The number was asserted from prior training knowledge and was not reconfirmed on the public web. This is not provider, authority, or web verification.
- **`cross_referenced`** — The record originated from a third-party public directory (e.g. helplines.world, Find A Helpline, or Child Helpline International). Moderate trust reflects presumed directory diligence; this status is not provider or authority verification. This is currently the largest single tier.
- **`legacy_unverified`** — Imported from an earlier source dataset (`information.json`, the Vibbrancy `Hotlines.json` mirror) with minimal metadata, no independent check.
- **`disputed`** — Sources disagree; see the record's `notes` field. No records currently carry this status.
- **`deprecated`** — Service has closed or the number is no longer in use. No records currently carry this status.

Only `verified_web`, `verified_authority`, and `verified_knowledge` are number-verification claims, and they apply only to the number. They do not verify category, hours, languages, cost, target audience, notes, website, sources, non-number contact channels, eligibility, geography, availability, or broader scope; each requires separate field-level evidence. The other statuses retain the distinct meanings above: record origin for `cross_referenced`, record inheritance for `legacy_unverified`, conflicting record values for `disputed`, and service/contact lifecycle for `deprecated`.

## Data sources

`hotlines.json` is assembled from several pipelines, each implemented as a script under `scripts/`:

1. **Curated hand-authoring** — rich records written directly against schema v2.0, applied idempotently by `scripts/apply_enrichment.py` from `scripts/enrichment/*.json`.
2. **Open-data merges** — `information.json` and the Vibbrancy (`atlacord/Naga`) `Hotlines.json` mirror, folded in by `scripts/merge_all.py` with name + number-set deduplication.
3. **Third-party aggregators** — helplines.world (`scripts/merge_helplines_world.py`), Find A Helpline (`scripts/fetch_findahelpline.py` / `scripts/merge_findahelpline.py`), Wikipedia crisis-line lists (`scripts/fetch_wikipedia_crisis_lines.py` / `scripts/merge_wikipedia.py`), and Child Helpline International (`scripts/fetch_child_helpline_international.py` / `scripts/integrate_child_helpline_international.py`).
4. **Government/authority sources** — travel-advisory emergency-number pages (`scripts/merge_fco.py`, plus the FCO/GC travel-advice source files under `sources/`).
5. **Source monitoring** — `scripts/web_verify.py` is a deprecated compatibility entry point for the read-only source monitor. It observes bounded source state and does not promote records, update canonical status, or change `last_verified`; promotion requires the separate candidate/approval workflow.

Supporting tooling: `scripts/validate_and_normalize.py` and `scripts/validate_canonical.py` enforce the schema-v2 shape (every field present with the correct default type, phone numbers usable in `tel:` links, no record left without a contact method); `scripts/dedupe_check.py`, `scripts/cross_source_validate.py`, and `scripts/recover_phone_notes.py` / `scripts/fixup_orphans.py` catch duplicate and malformed records. `scripts/validate_canonical.py` runs in CI on pushes to `main` and on pull requests (`.github/workflows/data-ci.yml`) alongside the Python unit tests in `tests/`.

Documented preview/staging flows keep the web-verified-directory preview, Child Helpline International preview, and promotion candidates under `sources/**` and `REPORTS/**`; their code and tests enforce non-canonical output, protected-record safeguards, or explicit apply intent as applicable — see `docs/data-flow.md`. Legacy scripts that write directly to `hotlines.json` still exist, so repository-wide enforcement remains incomplete.

## Countries with 0 hotlines

All genuinely uninhabited or research-only:

- Bouvet Island — Norwegian subantarctic dependency.
- French Southern Territories — research stations only.
- Heard Island and McDonald Islands — uninhabited Australian territory.
- United States Minor Outlying Islands — Baker, Howland, Jarvis, Johnston Atoll, Kingman Reef, Midway, Navassa, Palmyra, Wake.

## Categories in use

30 categories appear across the 3,255 records, including `emergency`, `suicide_crisis`, `mental_health`, `general_support`, `child_protection`, `domestic_violence`, `sexual_violence`, `lgbtqia`, `substance_use`, `bereavement`, `human_trafficking`, `stalking`, `male_victims`, `elder_abuse`, `eating_disorders`, `refugee_migrant`, `veterans`, `gambling`, `disability`, `disaster`, `missing_persons`, `perinatal`, `self_harm`, `youth`, `legal_aid`, `financial_aid`, `housing`, `human_rights`, `animal_welfare`, and `consular`. `general_support` is the largest single category (722 records, 22%) — see current gaps below.

## Current gaps

1. **863 `legacy_unverified` records** carry only minimal metadata (name + number, some with email/website) and haven't been independently checked. Candidates for enrichment via Befrienders Worldwide, IASP, or Find A Helpline.
2. **951 `cross_referenced` records** are sourced from third-party directories and are review candidates. The read-only source monitor can collect observations where a record is eligible, but an observation cannot promote it; separate evidence review, candidate creation, approval, and canonical apply are required.
3. **722 records sit in `general_support`** rather than a more specific category. Some are genuinely generic listening lines; source review is required before reclassification.
4. **1,673 records (51%) have no `languages` value**, and **1,095 (34%) have no `hours` value** — mostly the `legacy_unverified` and `cross_referenced` tiers, which is expected until those tiers are reviewed and enriched.
5. **4 territories have 0 hotline records** — all genuinely uninhabited or research-station-only (listed above); this is expected, not a gap to fill.
6. **`categories_reference` (top-level metadata block in `hotlines.json`) omits `consular`**, even though 175 records currently use that category. Consumers reading category labels from `categories_reference` rather than from the records themselves will miss it.
7. **`scripts/dedupe_check.py` currently flags 257 candidate duplicate groups** (matches on normalised name, phone-number tail, or website host within a country). These are broader heuristic candidates than the canonical validator's 116 exact-contact groups. They are read-only findings, not confirmed duplicates — the same signals also match legitimately distinct services that share a contact point (e.g. one government line serving several categories), so resolving a group requires manual review against the provider's own scope/service contract. Nothing in this pipeline merges records automatically, and none should be merged without that review.

## Freshness review

`scripts/freshness_report.py` creates deterministic Markdown and JSON review
queues without modifying `hotlines.json`. Callers must supply `--as-of
YYYY-MM-DD`; records with no `last_verified` date or whose date is at least
the configured threshold are queued, with `emergency` and `suicide_crisis`
records first. A freshness flag is a review prompt, not evidence that a
service is invalid, and the script never changes verification metadata.

The read-only `.github/workflows/freshness-review.yml` workflow is
manual-dispatch-only. It uploads the Markdown/JSON reports for 90 days and
verifies that the canonical dataset's SHA-256 is unchanged.
