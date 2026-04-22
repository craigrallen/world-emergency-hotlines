# World Emergency & Crisis Hotlines

A project to build a definitive, exhaustive reference of every country's emergency number and crisis support helpline: general emergency (police/fire/ambulance), suicide and mental-health crisis lines, child-protection lines (Childline-equivalents), domestic and sexual violence lines, LGBTQIA+ support, substance use, bereavement, and more.

## Files in this project

| File | Purpose |
| --- | --- |
| `SCHEMA.md` | Full schema documentation for `hotlines.json` |
| `hotlines.json` | The enriched, canonical dataset (schema v2.0) |
| `information.json` | Original source dataset (preserved for reference and for migrating remaining countries) |
| `sources/web_verified_crisis_directory/` | Vendored 2026-04-22 web-derived source artifacts plus a conservative non-canonical schema-v2 preview |
| `scripts/integrate_web_verified_directory.py` | Converts the supplemental source directory into a reviewable schema-v2 preview + integration report while explicitly skipping countries that already have richer canonical records |
| `tests/test_web_verified_directory_preview.py` | Regression checks that the supplemental preview stays schema-v2, non-canonical, and cannot downgrade protected rich records |
| `tests/test_canonical_promotion_safety.py` | Phase-0 safety-contract checks for non-canonical previews, protected-country promotion rules, and explicit `--apply` requirements for canonical writes |
| `COVERAGE.md` | Per-country coverage status: verified, legacy, or missing |
| `VERIFICATION_LOG.md` | Running log of which sources were used to verify which numbers |
| `docs/data-flow.md` | Canonical vs preview/review artifact roles and write-permission contract |
| `docs/plans/2026-04-22-v2-data-expansion-roadmap.md` | Concrete implementation roadmap for safe schema-v2 data expansion and promotion |
| `README.md` | This file |

## Scope

Every UN member state, plus widely-recognised territories and autonomous regions with their own emergency infrastructure (Hong Kong, Taiwan, Puerto Rico, Gibraltar, the Crown Dependencies, etc.).

For each country we aim to record, at minimum:

1. The general emergency number (police/fire/ambulance)
2. A suicide / acute mental-health crisis line where one exists
3. A child-protection line where one exists
4. Any domestic violence, sexual violence, LGBTQIA+, substance use, or other specialised lines

## Methodology and verification tiers

Every hotline record carries a `verification_status` so consumers can see how much confidence to place in it.

- **`verified_web`** — Number was opened on the provider's official website and matched on `last_verified`.
- **`verified_authority`** — Matched against a government body, national health ministry, WHO, IFRC, or similar.
- **`verified_knowledge`** — Stated from authoritative training knowledge (Claude's knowledge cutoff is end of May 2025). Stable for long-running institutions (Samaritans, 911, 112, Lifeline) but should be re-confirmed on the web before a final publication.
- **`legacy_unverified`** — Carried over from the source dataset without independent check. Treat as a lead, not a fact.
- **`disputed`** — Sources disagree; see the record's `notes` field.
- **`deprecated`** — Service has closed or the number is no longer in use.

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

### Current state
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

## Planned next sessions

1. **Web-verification pass** — promote the 743 `verified_knowledge` records to `verified_web` by fetching each provider's official site and re-confirming hours/URLs/numbers. Estimate: 2–3 focused sessions.
2. **Legacy enrichment** — lift the remaining 1,209 `legacy_unverified` records into rich form by cross-referencing Befrienders Worldwide, IASP, Find A Helpline. Estimate: 4–6 sessions.
3. **Categorisation cleanup** — ~30% of legacy records landed in `general_support` because the auto-categoriser's keyword table missed them. Widening the table in `scripts/merge_all.py` and re-running `merge_all.py` would move most of these to their correct category in seconds.
4. **Small-territory deepening** — 106 territories still have <3 hotlines. Most are small island states with limited infrastructure; add what's publishable for the rest.
5. **Safe supplemental promotion** — use `docs/plans/2026-04-22-v2-data-expansion-roadmap.md` plus the non-canonical preview/report artifacts to selectively review and promote web-derived rows without downgrading any existing rich-format canonical records.

## Safety contract docs

- Roadmap: `docs/plans/2026-04-22-v2-data-expansion-roadmap.md`
- Phase-0 data-flow contract: `docs/data-flow.md`

If you are adding or applying data, read those two docs first. They define what is safe to regenerate, what is review-only, and when `--apply` is required before any canonical write.

## How to use this dataset responsibly

If you're building anything that routes people to a crisis line — an app, a website, a chatbot — **verify each number against the provider's official website on the day you publish**. Crisis line numbers change; operating hours change; services close. This dataset is a starting point, not a final source of truth.

If you or someone you know is in crisis right now and you don't know which number to call, the universal options are:

- **European Union and many others**: `112`
- **North America**: `911`
- **UK**: `999` (or `112`)
- **Australia**: `000` (or `112` from mobile)
- **Online** (global): https://findahelpline.com

A global umbrella of suicide crisis services is maintained by [Befrienders Worldwide](https://www.befrienders.org/) and [IASP](https://www.iasp.info/resources/Crisis_Centres/).
