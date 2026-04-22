# First safe approved promotion batch

- Generated at: 2026-04-22T15:23:41Z
- Canonical dataset: `hotlines.json` (not modified in this task)
- Preview dataset: `sources/web_verified_crisis_directory/web_verified_directory_v2_preview.json`
- Approved candidate count: 7
- Batch rule: legacy-only canonical countries + metadata-only emergency merges + no new hotline/number additions

## Included countries

| Country | Candidate ID | Actions | Why included |
| --- | --- | --- | --- |
| Bonaire, Sint Eustatius and Saba | `bonairesinteustatiusandsaba-emergency-mergemissingfields-webverifieddirectoryv2previewjson-3` | `notes, provenance, sources` | Legacy-only canonical emergency record; preview adds only reviewable notes/sources/provenance metadata. |
| British Indian Ocean Territory | `britishindianoceanterritory-emergency-mergemissingfields-webverifieddirectoryv2previewjson-4` | `notes, provenance, sources` | Legacy-only canonical emergency record; preview adds only reviewable notes/sources/provenance metadata. |
| Christmas Island | `christmasisland-emergency-mergemissingfields-webverifieddirectoryv2previewjson-5` | `notes, provenance, sources` | Legacy-only canonical emergency record; preview adds only reviewable notes/sources/provenance metadata. |
| Cocos (Keeling) Islands | `cocoskeelingislands-emergency-mergemissingfields-webverifieddirectoryv2previewjson-6` | `notes, provenance, sources` | Legacy-only canonical emergency record; preview adds only reviewable notes/sources/provenance metadata. |
| Montserrat | `montserrat-emergency-mergemissingfields-webverifieddirectoryv2previewjson-17` | `notes, provenance, sources` | Legacy-only canonical emergency record; preview adds only reviewable notes/sources/provenance metadata. |
| South Georgia and the South Sandwich Islands | `southgeorgiaandthesouthsandwichislands-emergency-mergemissingfields-webverifieddirectoryv2previewjson-29` | `notes, provenance, sources` | Legacy-only canonical emergency record; preview adds only reviewable notes/sources/provenance metadata. |
| Western Sahara | `westernsahara-emergency-mergemissingfields-webverifieddirectoryv2previewjson-30` | `notes, provenance, sources` | Legacy-only canonical emergency record; preview adds only reviewable notes/sources/provenance metadata. |

## Explicitly deferred for a later batch

- `append_new_hotline` candidates from Macao, Saint Pierre and Miquelon, Montserrat, and Western Sahara remain out of scope for this first batch.
- `upgrade_emergency_metadata` and `merge_missing_fields` candidates that would append additional emergency/general numbers (Antarctica, Macao, Saint Pierre and Miquelon, Åland Islands) were deferred to keep this batch number-stable.

## Review/apply files

- Candidate bundle: `reviews/promotion_candidates/2026-04-22-first-safe-approved-batch.json`
- Approval draft: `reviews/promotion_candidates/2026-04-22-first-safe-approved-batch.approvals.json`

## Verification used

1. Rebuilt the full safe candidate set with `scripts/build_promotion_candidates.py`.
2. Filtered to metadata-only emergency merges with no `voice_numbers` action.
3. Ran `scripts/apply_promotion_candidates.py` in dry-run mode with the approval draft to confirm the batch is apply-ready without writing canonical data.
4. Ran targeted pytest coverage for promotion safety and gap-report tooling.
