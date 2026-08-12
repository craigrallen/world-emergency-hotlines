# Service-record contract: geography and duplicate identity

This document defines what a canonical hotline record *is* — its geographic
scope and its identity relative to other records — so that validation,
dedupe tooling, and reviewers agree on what counts as "the same service" and
what counts as "a duplicate." It supplements [SCHEMA.md](../SCHEMA.md) (field
shapes) and [docs/data-flow.md](data-flow.md) (write/apply safety rules).

## 1. Geography semantics

- **Every canonical hotline has a non-empty `geography`.** It is a required
  field, on the same footing as `name` and `category` — not optional,
  not inferred, never blank.
- **The exact canonical `country` name means country-wide.** When a
  hotline's `geography` value is identical to its parent country record's
  `country` field, the service covers that whole country. There is no
  separate "national" sentinel value.
- **Subnational and cross-border labels are human-readable published
  service areas, not geocoding identifiers.** Values like `"California"`,
  `"UK and Ireland"`, or `"Atlanta/Fulton County, Georgia"` are copied from
  how the provider actually describes its own coverage. They are free-text
  labels for people, not machine geocodes — do not require or expect ISO
  subdivision codes, FIPS codes, postcodes, or coordinates here.
- **Do not infer scope.** `geography` reflects what the source actually
  states the service covers. If a source doesn't say, don't guess from the
  organization's name, its numbering scheme, or where its parent
  organization is headquartered — ask a maintainer or leave the record for
  review rather than fabricating a value.
- **Same-name collisions across countries and subnational areas must stay
  distinguishable through parent-country context.** A `geography` string is
  only unique *within* its parent country, never globally. For example,
  `"Georgia"` is a valid `geography` value both for the country Georgia
  (country-wide) and for the US state Georgia (under the `United States`
  country record) — the two are told apart by the enclosing `country` field,
  not by the geography string alone. Tooling must never key on `geography`
  in isolation; always read it together with `country`.

## 2. Record identity

**`country` + `geography` + `category` is a service-*scope* descriptor, not
a unique identity key.** It says where a service operates and what kind of
service it is — it does not, by itself or in any combination with a subset
of other fields, say *which* service a record is. Multiple organizations
(or multiple distinct services run by the same organization) can
legitimately publish the same category in the same geography within the
same country. A national suicide line, an NGO's independently-run suicide
line, and a regional health authority's own suicide line can all be
`country=France, geography=France, category=suicide_crisis` and still be
three different, correct, non-duplicate records. Tooling must never treat
the triple — or any other field subset — as a merge key.

- **Deciding two records are the same service is an identity decision, not
  a scope match.** It requires evidence about *who* is behind the record and
  *how* it's reached, considered together — provider/organization, service
  name, contact channel(s), and `sources`/evidence — evaluated alongside
  scope (`country` + `geography` + `category`). No automatic rule, and no
  subset of these fields, is a merge key on its own. Only a human, weighing
  all of it together, can conclude two records describe the same service.
- **Shared contact channels do not, by themselves, imply a duplicate.** A
  single phone number, email, or website is routinely shared across several
  legitimately distinct service offerings: a national provider running
  separate lines for `suicide_crisis` and `mental_health` behind the same
  switchboard, an embassy's consular line covering several service
  categories, or one hotline that genuinely serves more than one published
  area.
- **Deliberately repeating the same contact across distinct categories is
  allowed** when the provider actually offers those additional scopes. This
  is a shared-contact service, not a duplicate.
- **Exact matches on category *and* area *and* contact remain manual review
  candidates — never a confirmed duplicate and never proof of distinctness.**
  When two or more records share the same `category`, the same `geography`
  (within the same `country`), and the same contact channel(s), that
  combination is a stronger *candidate* signal than a bare scope match — but
  it is still only a candidate, and the reverse is equally true: records
  that *don't* share category, geography, or contact are not thereby proven
  distinct. Only a human review, informed by the identity evidence above,
  can resolve a candidate group. See [§3](#3-candidate-group-classification)
  for how `validate_canonical.py`'s exact-contact classification and
  `dedupe_check.py`'s broader detector each surface candidates.
- **No tooling may automatically merge or delete canonical records.**
  `scripts/validate_canonical.py` and `scripts/dedupe_check.py` are
  detection-only: they surface candidates, they never mutate
  `hotlines.json`. Merges happen only through explicit, reviewed canonical
  apply work (see [docs/data-flow.md](data-flow.md#canonical-write-flows)),
  the same way any other canonical write requires `--apply` intent.
- **Sources, evidence, and richer metadata are preserved.** Reviewing or
  resolving a duplicate candidate must not discard `sources`, `provenance`,
  or any field with more detail than a competing record — see the
  protection contract in [docs/data-flow.md](data-flow.md).

## 3. Candidate group classification

Both detection scripts group records and label each group, but they group
differently and their labels mean different things:

- **`scripts/validate_canonical.py`** groups records within a country by
  **exact contact**: an identical, complete normalized set of every contact
  field (`voice_numbers`, `sms_numbers`, `text_numbers`, `short_codes`,
  `chat_url`, `email`, `website`). Every member of a group shares the same
  normalized contact in full — this is a precise, non-heuristic match.
- **`scripts/dedupe_check.py`** groups more broadly, using heuristics —
  normalized-name match, shared phone-number suffix, shared website host,
  and high name-similarity — combined transitively (union-find). A single
  reported group can chain records together through *different* pairwise
  signals, so it does not guarantee every member shares contact, or any
  other single attribute, with every other member.

Within each group, both scripts apply the same three mutually exclusive,
group-level classifications, based on how many times each represented
`category` occurs in the group:

| Classification | When it applies | What it means |
| --- | --- | --- |
| `same_category_duplicate_candidate` | The group has exactly one represented category. | The strongest candidate signal available — but still only a candidate requiring review, never a confirmed duplicate. |
| `cross_category_shared_contact_candidate` | The group has more than one represented category, and every category occurs exactly once. | Looks like one shared-contact switchboard serving distinct scopes — but this is a candidate requiring review, not a distinctness determination. |
| `mixed_scope_and_duplicate_candidate` | The group has more than one represented category, and at least one category occurs more than once. | A same-category duplicate candidate may be present *inside* an otherwise mixed group. Must be surfaced on its own — never collapsed into (or hidden by) a whole-group cross-category label. |

`geography` is tracked orthogonally: whenever a group's members don't all
share the same `geography`, that is reported as an additional
cross-geography count/flag alongside the category classification above — it
is never used to infer distinctness by itself, and it never changes which of
the three classifications above applies.

All of these labels are candidates for human review. None of them is a
merge instruction, and none of them — including `cross_category_shared_contact_candidate`
— asserts that the records involved are confirmed to be distinct services.

## 4. Manual review outcomes

When a maintainer reviews a candidate group (from either
`validate_canonical.py`'s exact-contact classification or
`dedupe_check.py`'s findings report), the outcome is recorded as one of:

| Outcome | Meaning |
| --- | --- |
| `retain_distinct_service_scopes` | The group shares a contact channel, but review of provider/organization, name, and sources confirms genuinely separate service offerings. Both/all records are kept as-is. |
| `merge_confirmed_same_service` | Review of provider/organization, name, contact, and sources confirms the group is the same service offering. Merged only via explicit reviewed canonical apply tooling — never by the detection scripts themselves. |
| `blocked_conflicting_evidence` | Sources disagree on identity or scope, or evidence is otherwise insufficient to decide. Left unresolved and flagged for further investigation; not merged, not discarded. |

These are review-record labels, not a `hotlines.json` field. They describe
what a human decided about a candidate group, for use in future
`reviews/**` artifacts (see [docs/data-flow.md](data-flow.md#4-reviewer-decisions)).
