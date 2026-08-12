# Coverage Status — 2026-08-12

This snapshot is measured directly from `hotlines.json` (schema v2.0). For the history of how the dataset got here, see the pass-by-pass narrative in [README.md](README.md#session-progress-2026-04-22) and [VERIFICATION_LOG.md](VERIFICATION_LOG.md).

## Totals

| Metric | Count |
| --- | --- |
| Countries / territories in dataset | 250 |
| Hotline records total | **3,250** |
| Categories in use | 30 |
| Records `verified_authority` | 660 |
| Records `verified_web` | 584 |
| Records `verified_knowledge` | 183 |
| Records `cross_referenced` | 957 |
| Records `legacy_unverified` | 866 |
| Records `disputed` / `deprecated` | 0 |
| Records with core metadata (name + category + organization + geography) | **3,250 (100%)** |
| Records with at least one contact method (phone, SMS, chat, email, or website) | **3,250 (100%)** |
| Records with `hours` populated | 2,151 (66%) |
| Records with `languages` populated | 1,587 (49%) |
| Records with `website` | 1,145 (35%) |
| Records with `chat_url` | 201 (6%) |
| Records with `email` | 136 (4%) |
| Records with a `last_verified` date | 2,384 (73%) |
| Records categorised `general_support` | 723 (22%) |
| Countries with 0 hotlines (genuinely uninhabited) | 4 |

## Status legend

- **`verified_authority`** — Matched against a government body, national health ministry, WHO, IFRC, or similar official authority.
- **`verified_web`** — The number was confirmed against the provider's own official website (see `sources` and `last_verified` on the record).
- **`verified_knowledge`** — Hand-authored from trusted knowledge (category, hours, languages, cost, target, notes, website, sources) but not yet independently re-confirmed on the provider's own site.
- **`cross_referenced`** — Found in one or more public third-party directories (helplines.world, Find A Helpline, Child Helpline International, Wikipedia crisis-line lists, government travel-advisory emergency-number pages). Reasonable confidence, not yet checked against the provider's own site. This is currently the largest single tier.
- **`legacy_unverified`** — Imported from an earlier source dataset (`information.json`, the Vibbrancy `Hotlines.json` mirror) with minimal metadata, no independent check.
- **`disputed`** — Sources disagree; see the record's `notes` field. No records currently carry this status.
- **`deprecated`** — Service has closed or the record has no contact method. No records currently carry this status.

## Data sources

`hotlines.json` is assembled from several pipelines, each implemented as a script under `scripts/`:

1. **Curated hand-authoring** — rich records written directly against schema v2.0, applied idempotently by `scripts/apply_enrichment.py` from `scripts/enrichment/*.json`.
2. **Open-data merges** — `information.json` and the Vibbrancy (`atlacord/Naga`) `Hotlines.json` mirror, folded in by `scripts/merge_all.py` with name + number-set deduplication.
3. **Third-party aggregators** — helplines.world (`scripts/merge_helplines_world.py`), Find A Helpline (`scripts/fetch_findahelpline.py` / `scripts/merge_findahelpline.py`), Wikipedia crisis-line lists (`scripts/fetch_wikipedia_crisis_lines.py` / `scripts/merge_wikipedia.py`), and Child Helpline International (`scripts/fetch_child_helpline_international.py` / `scripts/integrate_child_helpline_international.py`).
4. **Government/authority sources** — travel-advisory emergency-number pages (`scripts/merge_fco.py`, plus the FCO/GC travel-advice source files under `sources/`).
5. **Web verification** — `scripts/web_verify.py` fetches a record's own `website`, checks whether its phone numbers appear on the page, and on match promotes `verification_status` to `verified_web` and updates `last_verified`. State is cached in `scripts/.web_verify_cache.json` with a 30-day re-check window, so runs are resumable and idempotent (`--limit N`, `--status X`).

Supporting tooling: `scripts/validate_and_normalize.py` and `scripts/validate_canonical.py` enforce the schema-v2 shape (every field present with the correct default type, phone numbers usable in `tel:` links, no record left without a contact method); `scripts/dedupe_check.py`, `scripts/cross_source_validate.py`, and `scripts/recover_phone_notes.py` / `scripts/fixup_orphans.py` catch duplicate and malformed records. `scripts/validate_canonical.py` runs in CI on every push/PR to `main` (`.github/workflows/data-ci.yml`) alongside the Python unit tests in `tests/`.

Non-canonical preview/staging artifacts (web-verified-directory preview, Child Helpline International preview, promotion candidates) live under `sources/**` and `REPORTS/**` and are never merged into `hotlines.json` without an explicit `--apply` step — see `docs/data-flow.md`.

## Countries with 0 hotlines

All genuinely uninhabited or research-only:

- Bouvet Island — Norwegian subantarctic dependency.
- French Southern Territories — research stations only.
- Heard Island and McDonald Islands — uninhabited Australian territory.
- United States Minor Outlying Islands — Baker, Howland, Jarvis, Johnston Atoll, Kingman Reef, Midway, Navassa, Palmyra, Wake.

## Categories in use

30 categories appear across the 3,250 records, including `emergency`, `suicide_crisis`, `mental_health`, `general_support`, `child_protection`, `domestic_violence`, `sexual_violence`, `lgbtqia`, `substance_use`, `bereavement`, `human_trafficking`, `stalking`, `male_victims`, `elder_abuse`, `eating_disorders`, `refugee_migrant`, `veterans`, `gambling`, `disability`, `disaster`, `missing_persons`, `perinatal`, `self_harm`, `youth`, `legal_aid`, `financial_aid`, `housing`, `human_rights`, `animal_welfare`, and `consular`. `general_support` is the largest single category (723 records, 22%) — see current gaps below.

## Current gaps

1. **866 `legacy_unverified` records** carry only minimal metadata (name + number, some with email/website) and haven't been independently checked. Candidates for enrichment via Befrienders Worldwide, IASP, or Find A Helpline.
2. **957 `cross_referenced` records** are sourced from third-party directories but not yet checked against the provider's own site. `scripts/web_verify.py` can run against any record with a `website` populated to promote these toward `verified_web`.
3. **723 records sit in `general_support`** rather than a more specific category. Some are genuinely generic listening lines. `scripts/recategorize.py` only ever reclassifies the `legacy_unverified` subset of these (454 of the 723) — it explicitly skips `general_support` records in other verification tiers, so widening its keyword table would not touch the remaining 269.
4. **1,663 records (51%) have no `languages` value**, and **1,099 (34%) have no `hours` value** — mostly the `legacy_unverified` and `cross_referenced` tiers, which is expected until those tiers are enriched or web-verified.
5. **4 territories have 0 hotline records** — all genuinely uninhabited or research-station-only (listed above); this is expected, not a gap to fill.
6. **`categories_reference` (top-level metadata block in `hotlines.json`) omits `consular`**, even though 175 records currently use that category. Consumers reading category labels from `categories_reference` rather than from the records themselves will miss it.
7. **`scripts/dedupe_check.py` currently flags 256 candidate duplicate groups, covering 611 records** (matches on normalised name, phone-number tail, or website host within a country). These are broader heuristic candidates than the canonical validator's 117 exact-contact groups. They are read-only findings, not confirmed duplicates — the same signals also match legitimately distinct services that share a contact point (e.g. one government line serving several categories), so resolving a group requires manual review against the provider's own scope/service contract. Nothing in this pipeline merges records automatically, and none should be merged without that review.

## Freshness review

`scripts/freshness_report.py` creates deterministic Markdown and JSON review
queues without modifying `hotlines.json`. Callers must supply `--as-of
YYYY-MM-DD`; records with no `last_verified` date or whose date is at least
the configured threshold are queued, with `emergency` and `suicide_crisis`
records first. A freshness flag is a review prompt, not evidence that a
service is invalid, and the script never changes verification metadata.

The read-only `.github/workflows/freshness-review.yml` workflow runs each
Monday at 06:17 UTC and can also be dispatched manually. It uploads the
Markdown/JSON reports for 30 days and verifies that the canonical dataset's
SHA-256 is unchanged.
