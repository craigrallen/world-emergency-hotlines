# Child Helpline International first safe promotion batch

- Generated at: 2026-04-22T16:52:22Z
- Source candidate bundle: `reviews/promotion_candidates/child_helpline_international_candidates.json`
- Prepared batch: `reviews/promotion_candidates/2026-04-22-child-helpline-international-first-safe-batch.json`
- Approvals draft: `reviews/promotion_candidates/2026-04-22-child-helpline-international-first-safe-batch.approvals.json`
- Canonical dataset modified: **no**

## Included in this first batch

This batch keeps to the smallest clearly safe CHI append set currently visible in the candidate artifact:

1. **Aruba — Telefon Pa Hubentud (`131`)**
   - Distinct from current Aruba canonical entries.
   - Has direct website (`https://131.aw/`) and contact email.
   - Additive append only.
2. **Brunei — Talian ANAK 121 (`121`)**
   - Distinct from Brunei canonical emergency and Hope Line entries.
   - Government-domain website present.
   - Additive append only.
3. **Democratic Republic of the Congo — Tukinge Watoto (`117`)**
   - Distinct from current verified emergency and Panzi entries.
   - Clear child-protection framing and 24/7 number.
   - Additive append only.
4. **Liechtenstein — Pro Juventute Beratung + Hilfe 147 (`147`)**
   - No existing canonical child-protection hotline in Liechtenstein.
   - Established branded hotline with direct website.
   - Additive append only.
5. **Madagascar — Ligne Verte 147 Madagascar (`147`)**
   - Distinct from current verified emergency and suicide-crisis entries.
   - Clear child-protection framing and direct website/email.
   - Additive append only.

## Deferred for later review

Deferred candidates fall into a few clear buckets:

- **Existing equivalent already present in canonical data**
  - Examples: Austria, Bulgaria, Cyprus, Germany, Luxembourg, Moldova, Montenegro, Portugal, Romania, Thailand, Uganda, Zambia.
  - These need duplicate-aware review rather than blind append approval.
- **Malformed or suspicious imported fields**
  - Examples: Algeria (email appears mismatched), Bangladesh (broken hours string), France (`%20contact@...` email), Morocco (`contact@cyberconfiance.maq.com/?p=2511`), Tajikistan (missing phone number).
- **Scope or overlap ambiguity**
  - Examples: Iraq (candidate explicitly scoped to Kurdistan Region while country geography is broader), Suriname (overlaps existing legacy youth line `123`).
- **Lower-confidence/no-website cases**
  - Examples: China, Guinea, Lesotho, Liberia.

## Why this batch is safe-first

- Every selected item is `append_new_hotline` with `{"hotlines": "append_unique"}`.
- No selected item targets an existing canonical hotline for overwrite.
- No canonical record was written in this task.
- Batch is small enough for straightforward maintainer review before any future apply step.

## Suggested next maintainer step

If maintainers agree with the selection, they can review the bundle plus approvals draft and run a dry-run/apply workflow separately. This task intentionally stops short of canonical application.
