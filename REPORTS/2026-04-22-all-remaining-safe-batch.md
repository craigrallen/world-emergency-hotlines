# All remaining clearly safe promotion batch

- Generated from rebuild: `reviews/promotion_candidates/2026-04-22-all-remaining-rebuild.json`
- Approval file: `reviews/promotion_candidates/2026-04-22-all-remaining-safe.approvals.json`
- Approved candidate count: 27
- Candidate type counts: `{'append_new_hotline': 19, 'merge_missing_fields': 4, 'upgrade_emergency_metadata': 4}`
- Batch rule: approve every remaining additive candidate emitted by the current promotion tooling after the first approved batch, limited to legacy-only canonical countries and schema-v2-safe actions (`append_unique`, `fill_if_empty`, `merge_provenance`).

## Included countries

| Country | Candidate count | Candidate types | Notes |
| --- | ---: | --- | --- |
| Antarctica | 2 | `{'merge_missing_fields': 1, 'upgrade_emergency_metadata': 1}` | country-level general emergency append; emergency hotline number append |
| Macao | 10 | `{'append_new_hotline': 8, 'merge_missing_fields': 1, 'upgrade_emergency_metadata': 1}` | country-level general emergency append; emergency hotline number append; new legacy-unverified specialist hotline append |
| Montserrat | 1 | `{'append_new_hotline': 1}` | new legacy-unverified specialist hotline append |
| Saint Pierre and Miquelon | 10 | `{'append_new_hotline': 8, 'merge_missing_fields': 1, 'upgrade_emergency_metadata': 1}` | country-level general emergency append; emergency hotline number append; new legacy-unverified specialist hotline append |
| Western Sahara | 2 | `{'append_new_hotline': 2}` | new legacy-unverified specialist hotline append |
| Åland Islands | 2 | `{'merge_missing_fields': 1, 'upgrade_emergency_metadata': 1}` | country-level general emergency append; emergency hotline number append |

## Deferred candidates

- None from the current safe candidate set. Any further promotion work would require new preview data, new tooling rules, or manual source review beyond the current additive promotion model.
