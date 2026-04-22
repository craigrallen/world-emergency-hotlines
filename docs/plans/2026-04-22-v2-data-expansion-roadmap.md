# Schema v2 data expansion roadmap — safe canonical promotion plan

Status: implementation roadmap
Owner: maintainers of `world-emergency-hotlines`
Scope: expand and improve the dataset without modifying canonical records unsafely and without downgrading any existing rich schema-v2 entries

## 1. Current repo baseline

This plan is grounded in the repo state on `2026-04-22`:

- Canonical dataset: `hotlines.json`
- Schema definition: `SCHEMA.md`
- Coverage snapshot: `COVERAGE.md`
- Verification context: `VERIFICATION_LOG.md`
- Supplemental intake workflow: `scripts/integrate_web_verified_directory.py`
- Supplemental source artifacts: `sources/web_verified_crisis_directory/`
- Existing safety regression: `tests/test_web_verified_directory_preview.py`

Current documented constraints and inventory:

- `hotlines.json` is the only canonical dataset and already uses schema `2.0`.
- Existing rich records must not be overwritten by lower-confidence imports.
- The vendored web-derived directory has `253` rows.
- `243` source rows currently map to repo countries/territories.
- `26` matched rows are intentionally skipped because canonical data already has richer non-legacy records.
- `217` countries remain in the non-canonical preview.
- `10` rows remain in `sources/web_verified_crisis_directory/unmatched_country_rows.json` for manual geopolitical review.
- Current preview safety guarantee: imported preview rows stay `legacy_unverified` and do not overwrite richer canonical countries.

## 2. Non-negotiable guardrails

Every task below assumes these rules remain true:

1. Never overwrite `hotlines.json` directly from any supplemental source.
2. Never replace a hotline whose canonical `verification_status` is one of:
   - `verified_web`
   - `verified_authority`
   - `verified_knowledge`
   - `disputed`
   - `deprecated`
3. Treat all source-directory rows as intake leads until promoted through an explicit review step.
4. Keep schema-v2 compatibility for every review artifact that resembles canonical output.
5. Preserve provenance so a reviewer can answer:
   - where a field came from,
   - when it was checked,
   - what source class it came from,
   - why it was or was not promoted.
6. Any automation that writes canonical data must support dry-run mode and emit a review report before write mode.

## 3. Target end state

By the end of this roadmap, the repo should support a staged pipeline:

```text
raw source artifacts
  -> normalized intake rows
  -> schema-v2 supplemental preview
  -> review queue / duplicate queue / gap queue
  -> approved promotion patch
  -> canonical hotlines.json
```

That pipeline should make it easy to:

- ingest more global directories safely,
- enrich emergency metadata structurally,
- promote reviewed records into canonical form without downgrade risk,
- generate priority queues by country and category,
- detect duplicates and near-duplicates before merge,
- expand beyond suicide + mental health into more helpline categories.

## 4. Phase-by-phase implementation plan

---

## Phase 0 — lock in safety contract before adding more sources

### Goal
Make the current “supplemental preview only” workflow explicit and testable as the base contract for all future imports.

### Deliverables

- `docs/data-flow.md`
- `tests/test_canonical_promotion_safety.py`
- README pointer to this roadmap and the data-flow doc

### Tasks

1. Create `docs/data-flow.md` documenting these dataset roles:
   - canonical dataset: `hotlines.json`
   - supplemental preview datasets under `sources/**`
   - review outputs under `REPORTS/`
   - future reviewer decisions under `reviews/`
2. Define explicit write permissions by artifact type:
   - preview generators may write only under `sources/**` and `REPORTS/**`
   - promotion tooling may write canonical files only after passing guard checks
3. Add a regression test file `tests/test_canonical_promotion_safety.py` that checks:
   - no preview dataset claims canonical role
   - protected canonical countries cannot appear in promotion candidates unless action is `merge_missing_fields` or `append_new_hotline`
   - canonical write commands require `--apply`
4. Refactor shared protected-status logic into a reusable helper module:
   - create `scripts/lib/safety.py`
   - move `PROTECTED_CANONICAL_STATUSES` and country-level protection helpers there

### Exact commands

```bash
python3 -m unittest tests/test_web_verified_directory_preview.py
python3 -m unittest tests/test_canonical_promotion_safety.py
```

### Verification

- Tests pass.
- `docs/data-flow.md` clearly distinguishes canonical vs preview roles.
- No command in docs suggests direct overwrite of `hotlines.json` from source directories.

### Definition of done

A new contributor can read one doc and understand what is safe to regenerate, what is safe to review, and what is never safe to overwrite.

---

## Phase 1 — build a safe promotion workflow from supplemental intake to canonical

### Goal
Convert today’s ad hoc manual review into an explicit, reviewable promotion pipeline.

### Deliverables

- `scripts/build_promotion_candidates.py`
- `scripts/apply_promotion_candidates.py`
- `reviews/promotion_candidates/README.md`
- `reviews/promotion_candidates/*.json`
- `REPORTS/promotion_candidates_<timestamp>.md`

### Tasks

1. Introduce a promotion-candidate artifact format with one record per proposed change:

```jsonc
{
  "country": "Romania",
  "alpha-2": "RO",
  "candidate_type": "append_new_hotline", // or merge_missing_fields | upgrade_emergency_metadata
  "canonical_match": {
    "country": "Romania",
    "hotline_name": "Telefonul Copilului",
    "match_confidence": 0.96
  },
  "proposed_hotline": { /* schema-v2 hotline */ },
  "source_artifact": "sources/web_verified_crisis_directory/web_verified_directory_v2_preview.json",
  "field_actions": {
    "voice_numbers": "append_unique",
    "website": "fill_if_empty",
    "hours": "fill_if_empty",
    "sources": "append_unique"
  },
  "safety_flags": ["canonical_country_has_only_legacy_records"],
  "requires_human_review": true
}
```

2. Implement `scripts/build_promotion_candidates.py`:
   - input: canonical dataset + one or more preview datasets
   - output: JSON candidate bundle + markdown report
   - rules:
     - do not emit destructive replacements
     - do not emit “replace hotline” actions
     - only emit:
       - `append_new_hotline`
       - `merge_missing_fields`
       - `upgrade_emergency_metadata`
     - if canonical hotline is already rich, proposal must be additive only
3. Implement `scripts/apply_promotion_candidates.py`:
   - default mode: dry run
   - write mode: `--apply`
   - inputs: candidate JSON + optional reviewer approvals file
   - writes:
     - updated `hotlines.json`
     - report under `REPORTS/`
   - hard-fail if an action would remove canonical values or change protected statuses without explicit rule support
4. Add reviewer approval support:
   - `reviews/promotion_candidates/<date>-<batch>.approvals.json`
   - action states: `approved`, `rejected`, `needs_manual_source_check`
5. Add tests covering:
   - additive merge into legacy-only countries
   - rejection of destructive overwrite attempts
   - rejection of status downgrade attempts
   - dry-run vs `--apply`

### Exact commands

```bash
python3 scripts/build_promotion_candidates.py \
  --canonical hotlines.json \
  --preview sources/web_verified_crisis_directory/web_verified_directory_v2_preview.json \
  --out reviews/promotion_candidates/2026-04-22-web-directory-candidates.json \
  --report REPORTS/promotion_candidates_20260422_web_directory.md

python3 scripts/apply_promotion_candidates.py \
  --canonical hotlines.json \
  --candidates reviews/promotion_candidates/2026-04-22-web-directory-candidates.json

python3 scripts/apply_promotion_candidates.py \
  --canonical hotlines.json \
  --candidates reviews/promotion_candidates/2026-04-22-web-directory-candidates.json \
  --approvals reviews/promotion_candidates/2026-04-22-web-directory-candidates.approvals.json \
  --apply
```

### Verification

- Dry-run prints zero destructive actions.
- Apply mode changes only approved candidates.
- Git diff for `hotlines.json` shows additive edits only.
- Protected countries remain protected.

### Definition of done

Maintainers can take a staged source, generate explicit promotion candidates, approve a subset, and apply only safe additive canonical changes.

---

## Phase 2 — richer provenance and verification semantics

### Goal
Represent what kind of verification each field actually has, instead of flattening everything to `legacy_unverified` or a single record-level label.

### Deliverables

- `docs/provenance.md`
- schema-v2-compatible provenance extension in `SCHEMA.md`
- `scripts/lib/provenance.py`
- tests for provenance normalization

### Tasks

1. Extend `SCHEMA.md` with a supplemental provenance model that remains backward-compatible:

```jsonc
"provenance": {
  "record_status": "legacy_unverified",
  "source_class": "aggregator_directory", // first_party | government | NGO_directory | community_index
  "verification_method": "manual_web_review", // manual_web_review | scripted_import | knowledge_authored
  "retrieved_at": "2026-04-22T12:07:32Z",
  "review_state": "staged", // staged | reviewed | promoted | rejected
  "evidence": [
    {
      "field": "voice_numbers",
      "value": "116 123",
      "source_url": "https://...",
      "source_type": "first_party",
      "checked_at": "2026-04-22",
      "confidence": "high"
    }
  ]
}
```

2. Keep record-level `verification_status` for compatibility, but define mapping rules:
   - first-party provider website -> `verified_web`
   - government / WHO / IFRC / EENA -> `verified_authority`
   - imported aggregator only -> `legacy_unverified`
   - conflicting authoritative sources -> `disputed`
3. Update `scripts/integrate_web_verified_directory.py` so preview rows also include normalized provenance metadata under `_import_metadata` or `provenance` without claiming more confidence than warranted.
4. Add verifier tooling:
   - `scripts/normalize_provenance.py`
   - detect invalid source classes / missing timestamps / invalid status mapping
5. Add tests for these semantics.

### Exact commands

```bash
python3 scripts/normalize_provenance.py --check hotlines.json
python3 scripts/normalize_provenance.py --check sources/web_verified_crisis_directory/web_verified_directory_v2_preview.json
python3 -m unittest tests/test_provenance.py
```

### Verification

- Existing consumers can still rely on `verification_status`.
- New provenance fields explain why imported records remain non-canonical.
- Every promoted record has field-level evidence or an explicit reason it does not.

### Definition of done

A reviewer can inspect a hotline and tell exactly whether it came from a first-party site, authority, aggregator, or knowledge-authored seed.

---

## Phase 3 — emergency metadata structuring without breaking schema v2

### Goal
Capture emergency-service detail in a structured way while keeping `general_emergency` intact for compatibility.

### Deliverables

- `SCHEMA.md` update for structured emergency metadata
- `scripts/normalize_emergency_metadata.py`
- `tests/test_emergency_metadata.py`

### Tasks

1. Add a country-level supplemental field:

```jsonc
"emergency_services": {
  "primary": ["112"],
  "police": ["112"],
  "ambulance": ["112"],
  "fire": ["112"],
  "alternate": ["911"],
  "notes": "...",
  "sources": ["https://..."],
  "verification_status": "verified_authority"
}
```

2. Keep `general_emergency` as the quick-reference array required by the current schema.
3. Update preview-generation and future source adapters so separate police / fire / ambulance numbers are preserved structurally instead of flattened into notes.
4. Add normalization rules:
   - `general_emergency` should equal deduped `primary + alternate` quick-reference numbers
   - service-specific numbers belong in `emergency_services`
   - emergency-only countries with no crisis lines still remain valid country records
5. Add tests for countries with:
   - one unified number
   - separate police/fire/ambulance numbers
   - territory-specific alternates

### Exact commands

```bash
python3 scripts/normalize_emergency_metadata.py --check hotlines.json
python3 -m unittest tests/test_emergency_metadata.py
```

### Verification

- No emergency numbers are lost in migration.
- Separate emergency service numbers no longer live only inside free-text notes.
- `general_emergency` remains compatible for downstream clients.

### Definition of done

A consumer can reliably answer both “what emergency number should I call?” and “which number is specifically for ambulance/police/fire?” from structured data.

---

## Phase 4 — gap reporting and priority queue generation

### Goal
Make expansion work queue-driven instead of intuition-driven.

### Deliverables

- `scripts/build_gap_report.py`
- `scripts/build_priority_queue.py`
- `REPORTS/gap_report_<timestamp>.md`
- `REPORTS/priority_queue_<timestamp>.json`
- optional generated docs refresh for `COVERAGE.md`

### Tasks

1. Build per-country gap analysis from canonical data:
   - missing emergency number
   - missing suicide/crisis line
   - missing child-protection line
   - missing domestic-violence line
   - no non-legacy records
   - no first-party sources
   - no `last_verified` date
2. Build scoring logic for priority queue generation. Suggested weighted score:
   - +10 no non-legacy records
   - +8 no suicide-crisis line
   - +6 no child-protection line
   - +5 no domestic-violence line
   - +4 emergency metadata unstructured
   - +3 country present in supplemental preview with reviewable candidate data
   - +2 country population or traffic heuristic bucket
3. Produce queue slices:
   - top 25 countries to enrich next
   - top 25 countries to web-verify next
   - top 25 countries to review from supplemental preview next
4. Generate category gap reports too:
   - countries missing `child_protection`
   - countries missing `domestic_violence`
   - countries missing `lgbtqia`
   - countries missing `missing_persons`
5. Optionally refresh `COVERAGE.md` from generated data instead of hand-editing it.

### Exact commands

```bash
python3 scripts/build_gap_report.py --canonical hotlines.json --out REPORTS/gap_report_20260422.md
python3 scripts/build_priority_queue.py --canonical hotlines.json --out REPORTS/priority_queue_20260422.json
```

### Verification

- Queue outputs are deterministic.
- High-priority countries align with the documented tier-2 / tier-3 backlog.
- Reports clearly separate “missing because unavailable” from “missing because not researched yet”.

### Definition of done

Maintainers can start each work session from a generated queue instead of rebuilding priorities manually.

---

## Phase 5 — source adapters for global directories

### Goal
Standardize import adapters so new sources can be added safely without custom one-off logic each time.

### Deliverables

- `scripts/adapters/base.py`
- `scripts/adapters/web_verified_crisis_directory.py`
- `scripts/adapters/findahelpline.py`
- `scripts/adapters/befrienders.py`
- `scripts/adapters/iasp.py`
- `docs/source-adapters.md`
- adapter fixture tests

### Tasks

1. Define a normalized adapter output schema, e.g.:

```jsonc
{
  "source_name": "findahelpline",
  "source_row_id": "country:RO/service:telefonul-copilului",
  "country_name": "Romania",
  "country_match_hint": "RO",
  "service_name": "Telefonul Copilului",
  "category": "child_protection",
  "voice_numbers": ["116 111"],
  "sms_numbers": [],
  "website": "https://...",
  "hours": "24/7",
  "languages": ["Romanian"],
  "source_urls": ["https://..."],
  "source_class": "aggregator_directory"
}
```

2. Move the current conversion logic out of `scripts/integrate_web_verified_directory.py` into adapter + pipeline layers.
3. Create one adapter per source family:
   - `web_verified_crisis_directory`
   - `findahelpline`
   - `befrienders`
   - `iasp`
4. For each adapter, include:
   - fetch/parse step or import-from-vendored-file step
   - country alias reconciliation
   - category mapping
   - provenance/source-class tagging
   - fixture-based regression tests
5. Add a unified builder:
   - `scripts/build_supplemental_preview.py`
   - combine one or more adapter outputs into a single preview bundle

### Exact commands

```bash
python3 scripts/build_supplemental_preview.py \
  --canonical hotlines.json \
  --adapter web_verified_crisis_directory \
  --adapter befrienders \
  --adapter iasp \
  --out sources/generated/global_supplemental_preview.json

python3 -m unittest tests/test_source_adapters.py
```

### Verification

- Each adapter can be tested independently.
- New source onboarding becomes incremental instead of a one-off script rewrite.
- Adapter outputs carry normalized categories and provenance before promotion review begins.

### Definition of done

Adding a new global directory means implementing one adapter and reusing the same preview/promotion pipeline.

---

## Phase 6 — duplicate detection and review tooling

### Goal
Detect overlapping services across imports and within canonical data before humans spend time reviewing the same hotline repeatedly.

### Deliverables

- `scripts/find_duplicates.py`
- `REPORTS/duplicate_review_<timestamp>.md`
- `reviews/duplicates/<batch>.json`
- `tests/test_duplicate_detection.py`

### Tasks

1. Implement duplicate heuristics at three levels:
   - exact number-set match
   - fuzzy name + overlapping numbers
   - shared website/chat URL + same country + category
2. Score duplicate confidence and label cases:
   - `exact_duplicate`
   - `same_service_variant`
   - `possible_duplicate_manual_review`
3. Emit review bundles for manual decisions:

```jsonc
{
  "country": "South Africa",
  "duplicate_group_id": "za-sadag-001",
  "items": [ /* canonical + preview candidates */ ],
  "recommended_action": "merge_sources_append_missing_metadata"
}
```

4. Add duplicate-aware promotion rules:
   - append sources to canonical if service matches
   - append numbers only if not contradictory
   - if numbers conflict, require manual review and mark candidate blocked
5. Include canonical self-audit mode to catch duplicate legacy rows already living inside `hotlines.json`.

### Exact commands

```bash
python3 scripts/find_duplicates.py \
  --canonical hotlines.json \
  --preview sources/web_verified_crisis_directory/web_verified_directory_v2_preview.json \
  --out reviews/duplicates/2026-04-22-web-directory-duplicates.json \
  --report REPORTS/duplicate_review_20260422.md

python3 -m unittest tests/test_duplicate_detection.py
```

### Verification

- Duplicate report groups obvious overlaps cleanly.
- Conflicting numbers are blocked from auto-promotion.
- Canonical self-audit surfaces low-risk cleanup opportunities.

### Definition of done

Promotion review is organized around grouped duplicate decisions instead of raw row-by-row inspection.

---

## Phase 7 — staged expansion to more categories and countries

### Goal
Use the new pipeline to expand coverage deliberately, starting with high-value categories and high-priority countries.

### Deliverables

- `docs/expansion-tracks.md`
- generated queue/report artifacts per batch
- incremental canonical promotion batches

### Track A — country expansion

#### Batch A1: tier-2 countries already named in repo docs

Start with the backlog already listed in `README.md` and `COVERAGE.md`:

- Finland
- Norway
- Switzerland
- Austria
- Portugal
- Poland
- Czech Republic
- Greece
- Hungary
- Romania
- Croatia
- Slovakia
- Slovenia
- Estonia
- Latvia
- Lithuania
- Bulgaria
- Serbia
- Malta
- Cyprus
- Luxembourg
- Iceland
- Taiwan
- Malaysia
- Philippines
- Thailand
- Indonesia
- Vietnam
- Pakistan
- Bangladesh
- Sri Lanka
- UAE
- Saudi Arabia
- Israel
- Jordan
- Turkey
- Argentina
- Chile
- Colombia
- Peru
- Uruguay
- Costa Rica
- Panama
- Ecuador

#### Batch A2: countries already represented in supplemental preview with promising coverage

Promote additive data first where:

- canonical country is legacy-only,
- preview has emergency + at least one crisis service,
- duplicate detector reports no unresolved conflicts.

#### Batch A3: unmatched geopolitical rows

Do not merge by default. Instead create `docs/geopolitical-entity-policy.md` defining whether rows like Abkhazia, Northern Cyprus, Somaliland, and Tristan da Cunha belong as:

- canonical countries/territories,
- aliases under an existing canonical country,
- or permanently review-only artifacts.

### Track B — category expansion

Add category-specific work queues in this order:

1. `child_protection`
2. `domestic_violence`
3. `sexual_violence`
4. `missing_persons`
5. `lgbtqia`
6. `substance_use`
7. `bereavement`
8. `eating_disorders`
9. `gambling`
10. `refugee_migrant`

For each category batch:

- select top countries from gap report,
- pull first-party / authority sources where possible,
- stage adapter output,
- run duplicate review,
- promote approved additive changes,
- refresh coverage and verification logs.

### Recommended batch-size rule

Keep each promotion batch small enough to review in one session:

- 10–20 countries per batch, or
- 100–150 hotline proposals per batch,
- whichever comes first.

### Exact commands

```bash
python3 scripts/build_priority_queue.py --canonical hotlines.json --focus country_expansion
python3 scripts/build_priority_queue.py --canonical hotlines.json --focus child_protection
python3 scripts/build_priority_queue.py --canonical hotlines.json --focus domestic_violence
```

### Verification

- Each batch ends with updated reports, tests, and a bounded canonical diff.
- Reviewers can explain why each promoted record was selected now.
- No “bulk import and hope” step exists anywhere in the process.

### Definition of done

Expansion becomes routine, reviewable, and category-driven instead of a fragile one-time import.

---

## 5. Suggested repo layout after roadmap implementation

```text
docs/
  data-flow.md
  provenance.md
  source-adapters.md
  expansion-tracks.md
  geopolitical-entity-policy.md
  plans/
    2026-04-22-v2-data-expansion-roadmap.md
reviews/
  promotion_candidates/
  duplicates/
scripts/
  adapters/
    base.py
    web_verified_crisis_directory.py
    findahelpline.py
    befrienders.py
    iasp.py
  lib/
    safety.py
    provenance.py
  build_supplemental_preview.py
  build_promotion_candidates.py
  apply_promotion_candidates.py
  normalize_provenance.py
  normalize_emergency_metadata.py
  build_gap_report.py
  build_priority_queue.py
  find_duplicates.py
tests/
  test_canonical_promotion_safety.py
  test_provenance.py
  test_emergency_metadata.py
  test_source_adapters.py
  test_duplicate_detection.py
```

## 6. Recommended implementation order

Do these in order; later phases depend on earlier guardrails.

1. Phase 0 — safety contract
2. Phase 1 — promotion pipeline
3. Phase 2 — provenance semantics
4. Phase 3 — emergency metadata structure
5. Phase 4 — gap and priority reports
6. Phase 5 — adapter framework
7. Phase 6 — duplicate tooling
8. Phase 7 — expansion batches

## 7. Concrete first work session after this roadmap lands

If starting immediately after this plan is committed, do this exact first session:

```bash
python3 -m unittest tests/test_web_verified_directory_preview.py
mkdir -p docs reviews/promotion_candidates reviews/duplicates scripts/lib scripts/adapters
python3 scripts/integrate_web_verified_directory.py
python3 scripts/build_promotion_candidates.py \
  --canonical hotlines.json \
  --preview sources/web_verified_crisis_directory/web_verified_directory_v2_preview.json \
  --out reviews/promotion_candidates/2026-04-22-web-directory-candidates.json \
  --report REPORTS/promotion_candidates_20260422_web_directory.md
python3 scripts/find_duplicates.py \
  --canonical hotlines.json \
  --preview sources/web_verified_crisis_directory/web_verified_directory_v2_preview.json \
  --out reviews/duplicates/2026-04-22-web-directory-duplicates.json \
  --report REPORTS/duplicate_review_20260422.md
python3 scripts/build_gap_report.py --canonical hotlines.json --out REPORTS/gap_report_20260422.md
python3 scripts/build_priority_queue.py --canonical hotlines.json --out REPORTS/priority_queue_20260422.json
```

Expected outcome of that first session:

- existing preview safety still passes,
- promotion candidates exist but are not yet applied,
- duplicates are grouped for review,
- maintainers have a ranked queue for the next country/category batches.

## 8. Success criteria for the roadmap

This roadmap is complete when the repo can do all of the following repeatedly and safely:

- ingest new global directories without touching canonical data immediately,
- preserve richer provenance than a single coarse status flag,
- structure emergency metadata beyond a flat quick-reference list,
- generate deterministic gap and priority reports,
- detect duplicates before promotion,
- promote only approved additive changes into `hotlines.json`,
- expand category and country coverage in small reviewable batches.

## 9. Explicit anti-goals

These are out of scope unless separately approved:

- rewriting all existing canonical rich records in one bulk pass,
- replacing `hotlines.json` with any generated preview,
- importing unmatched geopolitical entities directly into canonical without a written entity policy,
- collapsing first-party, authority, and aggregator evidence into a single status without provenance.
