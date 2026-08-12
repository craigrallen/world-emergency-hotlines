# Data flow and safety contract

This repo uses a staged data flow. The safety rule for Phase 0 is simple: `hotlines.json` is canonical, source-derived previews are not, and no automation may overwrite canonical data without an explicit apply step.

## Dataset roles

### 1. Canonical dataset

- Path: `hotlines.json`
- Role: the only canonical hotline dataset in the repo
- Schema: schema v2 (`$schema_version: "2.0"`)
- Write policy: only canonical promotion or apply tooling may write here, and only when the command is run with explicit `--apply` semantics

`hotlines.json` should never be regenerated directly from `sources/**` artifacts.

### 2. Supplemental preview datasets

- Paths: `sources/**`
- Examples:
  - `sources/web_verified_crisis_directory/web_verified_directory_v2_preview.json`
  - `sources/web_verified_crisis_directory/unmatched_country_rows.json`
- Role: non-canonical intake, preview, and review-support artifacts
- Write policy: preview generators may write under `sources/**`, but those outputs must remain clearly non-canonical

Preview datasets may use the schema-v2 shape for compatibility with review tooling, but they must still identify themselves as preview artifacts and must not claim canonical status.

### 3. Review outputs

- Paths: `REPORTS/**`
- Role: human-readable reports, QA summaries, integration notes, and future promotion reports
- Write policy: preview and promotion tooling may write reports here

Reports are review aids only. They are never canonical data.

### 4. Reviewer decisions

- Paths: `reviews/**`
- Role: future approval/rejection records for promotion candidates
- Write policy: reviewer workflows may write decision artifacts here

This directory is reserved for explicit human review state, not for source imports.

## Allowed writes by artifact type

| Artifact type | May write to | Must not write to |
| --- | --- | --- |
| Preview generators | `sources/**`, `REPORTS/**` | `hotlines.json` |
| Review/report tooling | `REPORTS/**`, future `reviews/**` | `hotlines.json` unless the command is explicitly an apply flow with `--apply` |
| Canonical apply/promotion tooling | `hotlines.json`, `REPORTS/**`, future `reviews/**` | direct source artifacts unless intentionally generating a new review artifact |

## Protection contract for rich canonical data

The following canonical hotline `verification_status` values are protected from downgrade-by-overwrite:

- `verified_web`
- `verified_authority`
- `verified_knowledge`
- `disputed`
- `deprecated`

If a canonical country already contains any hotline with one of those statuses, preview imports must not rewrite that country as if the preview were canonical.

For future promotion candidates, protected countries may only appear in additive actions such as:

- `merge_missing_fields`
- `append_new_hotline`

Phase 0 does **not** authorize destructive replacement flows.

## Current Phase 0 command contract

### Non-canonical preview generation

- `scripts/integrate_web_verified_directory.py` reads canonical data plus source artifacts
- It writes only:
  - `sources/web_verified_crisis_directory/web_verified_directory_v2_preview.json`
  - `sources/web_verified_crisis_directory/unmatched_country_rows.json`
  - `REPORTS/web_verified_directory_integration_report.md`
- It does **not** modify `hotlines.json`

### Canonical write flows

Canonical-writing commands must require explicit `--apply` intent.

Current enforced example:

```bash
python3 scripts/apply_enrichment.py
# dry run only; does not write hotlines.json

python3 scripts/apply_enrichment.py --apply
# writes hotlines.json
```

## Service-record identity and geography contract

Beyond *where* data may be written, canonical records have a content
contract: every hotline must carry a non-empty, human-readable `geography`
(a published service area, not a geocode). `country` + `geography` +
`category` describes a record's *scope* — it is not an identity key, and no
field subset (including the contact channel) is an automatic merge key;
multiple distinct services may legitimately share the same scope. Shared
phone numbers/emails/websites across categories or areas are expected and
do not by themselves mean a duplicate — nor does the *absence* of a shared
contact mean two records are distinct. `scripts/validate_canonical.py` and
`scripts/dedupe_check.py` only ever *surface* candidate duplicate groups
(classified `same_category_duplicate_candidate`,
`cross_category_shared_contact_candidate`, or
`mixed_scope_and_duplicate_candidate`) for manual review; neither may merge
or delete canonical records. See
[docs/service-record-contract.md](service-record-contract.md) for the full
geography and record-identity rules, the candidate classifications, and the
manual review outcomes (`retain_distinct_service_scopes`,
`merge_confirmed_same_service`, `blocked_conflicting_evidence`) reviewers
use when triaging candidates.

## Contributor checklist

Before running any data command, ask:

1. Am I generating a preview artifact or editing canonical data?
2. Is the output path under `sources/**` / `REPORTS/**`, or is it `hotlines.json`?
3. If the command can write canonical data, did I intentionally pass `--apply`?
4. Could this action downgrade or overwrite an existing rich canonical record?

If the answer to the last question is "maybe," stop and generate a review artifact first.
