# Provenance and verification semantics

This repo keeps `verification_status` as the schema-v2 compatibility field, but Phase 2 adds an optional `provenance` object so maintainers can tell **why** a record has that status and what kind of evidence exists behind it.

## Why this exists

A single coarse status flag is not enough to answer review questions like:

- Was this number copied from an aggregator or verified on the provider's own site?
- Did a script import the record, or did a maintainer manually review it?
- Is this a staged preview artifact or a promoted canonical record?
- Which hotline fields have supporting evidence and which are still best-effort imports?

`provenance` solves those questions without breaking old consumers.

## Backward-compatibility contract

- `verification_status` remains required/primary for existing consumers.
- `provenance` is optional supplemental metadata.
- Datasets and tools must remain valid when `provenance` is absent.
- Preview/import tooling must not claim stronger trust than the underlying evidence supports.
- Promotion/apply tooling may merge provenance additively, but must not replace richer existing provenance with weaker imported claims.

## Recommended semantics

### `record_status`

Use values aligned with schema-v2 `verification_status`:

- `verified_web`
- `verified_authority`
- `verified_knowledge`
- `cross_referenced`
- `legacy_unverified`
- `disputed`
- `deprecated`

### `source_class`

What kind of source the record primarily came from:

- `first_party`
- `government`
- `authority`
- `ngo_directory`
- `aggregator_directory`
- `community_index`
- `knowledge_authored`

### `verification_method`

How the record entered or was confirmed in this repo:

- `manual_web_review`
- `scripted_import`
- `knowledge_authored`
- `manual_dataset_review`

### `review_state`

Workflow state:

- `staged`
- `reviewed`
- `promoted`
- `rejected`

### `evidence[]`

Optional field-level evidence items. Typical keys:

- `field`
- `value`
- `source_url`
- `source_type`
- `checked_at`
- `confidence`
- `note`

## Mapping guidance

- first-party manual review → `verification_status=verified_web`
- authority/government manual review → `verification_status=verified_authority`
- knowledge-authored seed → `verification_status=verified_knowledge`
- aggregator/community import without first-party confirmation → `verification_status=legacy_unverified`
- conflicting authoritative evidence → `verification_status=disputed`

## Current conservative Phase 2 behavior

- `scripts/integrate_web_verified_directory.py` now emits optional hotline-level `provenance` for preview rows.
- Imported web-verified-directory rows still map to `legacy_unverified` because the source is an aggregator-style review artifact, not a first-party proof set.
- `scripts/normalize_provenance.py --check ...` validates provenance structure and status consistency without rewriting datasets.
- Promotion/apply tooling can preserve and merge optional provenance non-destructively.

## Safety assumptions

- Provenance should explain confidence, not inflate it.
- Absence of provenance is allowed and must not block existing canonical data.
- Existing rich-format canonical records are protected from downgrade.
- Appended evidence is acceptable; destructive provenance replacement is not.
