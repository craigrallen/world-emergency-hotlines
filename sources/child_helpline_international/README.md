# Child Helpline International source artifacts

This directory vendors a conservative Child Helpline International source snapshot plus a schema-v2-compatible non-canonical preview for later review and promotion.

## Included artifacts

- `child_helpline_posts.json` — fetched WordPress post index for the `child-helpline` category, including slugs, timestamps, links, and excerpts.
- `child_helpline_directory.json` — normalized source artifact grouped by source country, preserving parsed contact details, hours, languages, source URLs, and source post metadata.
- `child_helpline_international_v2_preview.json` — schema-v2 preview generated from the normalized artifact. This file is **not** canonical and may include protected canonical countries only as append-only / merge-missing review input for later promotion-candidate tooling.
- `unmatched_countries.json` — source countries intentionally left out of preview because they do not map cleanly onto the repo’s current canonical country list.

## Safety model

Child Helpline International is a valuable NGO directory, but it is still a third-party source rather than a country’s own first-party provider pages. For that reason this workflow stays conservative:

- fetched records are preserved as source artifacts under `sources/child_helpline_international/`
- preview hotlines remain `legacy_unverified`
- preview provenance is marked `source_class=ngo_directory` and `review_state=staged`
- protected canonical countries may still appear in preview, but only as staged append-only / merge-missing review input; the preview itself never writes canonical data
- unmatched geopolitical entities are documented instead of guessed into the canonical list

## Regeneration

From the repo root:

```bash
python scripts/fetch_child_helpline_international.py
python scripts/integrate_child_helpline_international.py
```

Those commands refresh only this source directory and its review/report artifacts. They do **not** overwrite `hotlines.json`.
