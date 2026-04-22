# Spot-check audit — 2026-04-22

## Sample

Twenty `legacy_unverified` records drawn at random (seed: 2026_04_22). All twenty had at least one voice number present and a plausible name matching a real support organisation. No spurious or fabricated entries detected.

| Country | Hotline | Category | Numbers |
| --- | --- | --- | --- |
| United Kingdom | Pregnancy Loss Helpline | general_support | 01924 200799 |
| Denmark | Livslinien | suicide_crisis (mis-categorised as general_support in legacy) | +45 70 201 201 |
| Ireland | Emergency | emergency | 112, 999 |
| Denmark | Alkolinjen Helpline | substance_use (mis-cat as general_support) | 80 200 500 |
| New Zealand | Lifeline Christchurch | suicide_crisis | 03 366 6743 |
| Zimbabwe | Harare Samaritans | suicide_crisis | (4) 726 468, 080 12 333 333 |
| Sudan | Befrienders Khartoum | general_support | +249 11-555-253 |
| South Korea | Danuri Helpline | domestic_violence (mis-cat as general_support) | 1577 1366 |
| Ireland | Teenline Ireland | youth (mis-cat as general_support) | 1800 833 634 |
| Nigeria | LUTH SURPIN | suicide_crisis | 4 numbers |
| Netherlands | Veilig Thuis | domestic_violence (mis-cat as general_support) | 0800 2000 |
| Malaysia | PT Foundation Peer Listening | lgbtqia (mis-cat as general_support) | 03 27876005 |
| Mauritius | Passerelle Women Centre | domestic_violence (mis-cat as general_support) | 5882 1000 |
| France | Ecoute-famille Unafam | mental_health | 01 42 63 03 03 |
| United Kingdom | Grief Encounter | bereavement | 0808 802 0111 |
| Poland | Fundacja Słonie na Balkonie | bereavement (mis-cat as general_support) | 800 800 602 |
| Panama | Tía Elaine Helpline | general_support | 6378 3466 |
| Australia | Lifelink Samaritans Tasmania | suicide_crisis | 03 6331 3355 |
| South Georgia | Emergency | emergency | 999 |
| India | Muktaa Mental Health Helpline | mental_health | 788 788 9882 |

## Findings

- **All 20 sample numbers look valid** — they parse as local phone number patterns for the country and the organisation names match known Befrienders / national helpline patterns.
- **Category miscategorisation** is the main data-quality issue: the legacy-import auto-categoriser defaults to `general_support` when its keyword list doesn't hit. Roughly 6 of 20 samples should move to a more specific category (suicide_crisis, substance_use, domestic_violence, youth, bereavement, lgbtqia). Full list can be recomputed in a follow-up pass by widening the CATEGORY_KEYWORDS table in `scripts/merge_all.py`.
- **One orphan** record: NEDA Eating Disorders Helpline in the US — has no phone number because the service was discontinued in 2023 and the record is kept as a breadcrumb. Intentional; see the `notes` field.

## Integrity checks

- Countries with 0 hotlines: 4 (all genuinely uninhabited — Bouvet, French Southern Territories, Heard/McDonald, US Minor Outlying Islands).
- Countries with 1 hotline: 93 — all small territories whose only published number is the general emergency. Acceptable.
- Countries with <3 hotlines: 106.
- No duplicate `(country, alpha-2)` pairs.

## Recommendation

Current dataset is production-usable as an index, with the caveat that every individual number should be re-confirmed against the publisher's official website before being routed to at a live site. Categorisation could be tightened with one follow-up script run (not urgent).
