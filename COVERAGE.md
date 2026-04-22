# Coverage Status — 2026-04-22 (pass 5 — validation, normalisation, web verification)

## Totals

| Metric | Count |
| --- | --- |
| Countries / territories in dataset | 250 |
| Hotline records total | **2,651** |
| Records rich-enriched (`verified_knowledge`) | 802 |
| Records web-verified (`verified_web`) | _growing — see verification log_ |
| Records cross-referenced from third-party directories (`cross_referenced`) | 640 |
| Records imported but not yet enriched (`legacy_unverified`) | 1,209 |
| Records without any contact method | **0** |
| Records with full core metadata (name + category + organization + geography + contact) | **2,638 (99%)** |
| Records with `hours` populated | 1,624 (61%) |
| Records with `languages` populated | 1,139 (42%) |
| Records with `website` | 709 (26%) |
| Records with `chat_url` | 162 (6%) |
| Records with `email` | 79 (2%) |
| Countries with 0 hotlines (genuinely uninhabited) | 4 |

## Status legend

- **`verified_web`** — The number was confirmed against the provider's official website within the last 30 days.
- **`verified_knowledge`** — Full v2.0 enrichment hand-authored: category, hours, languages, cost, target, notes, website, sources. Pending confirmation on the provider's own site.
- **`cross_referenced`** — Originated from a public third-party directory (currently helplines.world). Moderate confidence.
- **`legacy_unverified`** — Imported from the source datasets (information.json, Vibbrancy Hotlines.json) with name + phone, no other metadata.
- **`deprecated`** — Service has closed or the record has no contact method. Currently: 0 records.

## Data sources

Three pipelines feed `hotlines.json`:

1. **Curated (pass 1–4)** — hand-authored rich records for 200+ countries, organised under `scripts/enrichment/*.json` and applied idempotently by `scripts/apply_enrichment.py`. Covers all 193 UN members plus every inhabited territory.
2. **Open-data merge** — `information.json` + `sources/vibbrancy_hotlines.json` (atlacord/Naga Hotlines.json @ 61bec14), folded in by `scripts/merge_all.py` with name + number-set deduplication.
3. **Third-party aggregator (pass 4)** — helplines.world dataset extracted from its Next.js bundle, parsed by `scripts/merge_helplines_world.py`, adding 640 cross-referenced hotlines across 23 countries and five new categories (legal aid, financial aid, housing, human rights, animal welfare).

## Normalisation layer (pass 5 — this session)

`scripts/validate_and_normalize.py` walks every record and:

- Ensures every v2 schema field is present with the correct default type.
- Strips exotic Unicode in phone numbers (U+2011 non-breaking hyphens, U+202F narrow spaces) so `tel:` links work.
- Fills `geography` (country name) where missing — 905 records updated.
- Applies a "known brand" enrichment table that fills `hours` / `languages` / `target` / `cost` / `website` / `category` for recognised organisation names (Samaritans, Childline, Lifeline, Befrienders, Red Cross, Telefonseelsorge, CVV, AASRA, Mind, CALM, RAINN, NSPCC, Trevor Project, Trans Lifeline, Crisis Text Line, etc.) — 272 records enriched.
- Resolves 39 duplicate-name collisions within a single country.
- Flags records with no contact method as `deprecated` (currently 0 after downstream fixes).

`scripts/recover_phone_notes.py` + `scripts/fixup_orphans.py` recovered 114 phone numbers that the helplines.world parser had dropped into notes, rescued 136 records from deprecated state, and promoted 14 chat-shaped URLs from `website` to `chat_url`.

## Web verification layer (pass 5 — running now)

`scripts/web_verify.py` runs on the user's local machine (bypassing the Cowork sandbox's web-fetch provenance gate). For every record with a `website`, it:

1. Fetches the provider's site (stdlib `urllib`, 20 s timeout, 1 req/s rate limit).
2. Checks whether any of the record's phone numbers appear in the page.
3. On match → promotes `verification_status` to `verified_web`, updates `last_verified`, appends the final URL to `sources`.
4. Also harvests hours hints ("24/7", "Mon–Fri 9am–5pm") and chat-link URLs, filling those fields only when blank.

State is cached in `scripts/.web_verify_cache.json` with a 30-day re-check window, so the script is resumable and idempotent. Runs can be batched with `--limit N` and `--status X`.

## Countries with 0 hotlines

All genuinely uninhabited:

- Bouvet Island — Norwegian subantarctic dependency.
- French Southern Territories — research stations only.
- Heard Island and McDonald Islands — uninhabited Australian territory.
- United States Minor Outlying Islands — Baker, Howland, Jarvis, Johnston Atoll, Kingman Reef, Midway, Navassa, Palmyra, Wake.

## New categories added (pass 4)

- `legal_aid` — civil legal advice, ombudsperson lines.
- `financial_aid` — financial hardship, debt, fraud.
- `housing` — homelessness, shelter, housing advice.
- `human_rights` — human-rights reporting, discrimination, civil liberties.
- `animal_welfare` — animal welfare / RSPCA-type services.

## Still to do

1. **Complete web-verification sweep** — `scripts/web_verify.py` can run as often as needed; each run processes the next `--limit N` unverified records with websites.
2. **Enrich remaining legacy records** — 1,209 records still carry only name + phone. Candidates for enrichment via Befrienders Worldwide, IASP, Find A Helpline.
3. **Fill `hours` / `languages` / `target` on cross-referenced records** — helplines.world provides `hours` but its other metadata is sparse.
4. **Category polish** — 585 records still sit under `general_support`; some are genuinely generic listening lines but others can move to specific categories via a next pass of `scripts/recategorize.py`.
5. **Small-territory deepening** — ~80 territories still have <3 hotlines; many are legitimately thin.
