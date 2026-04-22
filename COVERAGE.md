# Coverage Status — updated 2026-04-22 (pass 2, post-merge)

Tracking which countries are in `hotlines.json` (schema v2.0) and at what depth.

## Totals

| Metric | Count |
| --- | --- |
| Countries / territories in dataset | 250 |
| Hotline records total | 1,613 |
| Records rich-enriched (`verified_knowledge`) | 216 |
| Records migrated but not yet enriched (`legacy_unverified`) | 1,397 |
| Countries with 0 hotlines (genuinely uninhabited) | 4 |

## Status legend

- **Rich** — Full v2.0 enrichment: category, hours, languages, cost, target, notes, website, sources. `verification_status: verified_knowledge`, pending web-confirmation pass.
- **Migrated** — Record migrated from `information.json` and/or the Vibbrancy `Hotlines.json`. Carries name + numbers (and email/website if parseable), category best-guessed from name, all other metadata empty. `verification_status: legacy_unverified`.
- **Uninhabited** — No permanent civilian population; no standing emergency number.

## Countries with rich enrichment (22)

All have `verified_knowledge` records for at least their general emergency, suicide/crisis, child protection, domestic violence, and typically several more categories:

Australia, Belgium, Brazil, Canada, Denmark, France, Germany, Hong Kong, India, Ireland, Italy, Japan, Mexico, Netherlands, New Zealand, Singapore, South Africa, South Korea, Spain, Sweden, United Kingdom, United States.

Each country here has 6–25 rich hotline records plus additional migrated legacy records that the merge script identified as non-duplicates (e.g. niche UK helplines for specific medical conditions, regional Canadian distress lines).

## Countries with migrated-only records (224)

All other UN member states, autonomous regions, and recognised territories. Every entry has at least a general emergency number plus any crisis-line entries that were in the legacy sources.

### New territories added in the merge (48 from Vibbrancy)

Åland Islands, American Samoa, Anguilla, Antarctica, Aruba, Bermuda, Bonaire/Sint Eustatius/Saba, Bouvet Island, British Indian Ocean Territory, British Virgin Islands, Christmas Island, Cocos (Keeling) Islands, Congo, Falkland Islands, Faroe Islands, French Guiana, French Polynesia, French Southern Territories, Guadeloupe, Guam, Heard Island and McDonald Islands, Holy See (Vatican City), Isle of Man, Jersey, Macao, Martinique, Mayotte, Montserrat, New Caledonia, Niue, Norfolk Island, Northern Mariana Islands, Pitcairn, Puerto Rico, Réunion, Saint Barthélemy, Saint Helena/Ascension/Tristan da Cunha, Saint Martin (French part), Saint Pierre and Miquelon, Sint Maarten (Dutch part), South Georgia and the South Sandwich Islands, Svalbard and Jan Mayen, Tokelau, Turks and Caicos Islands, United States Minor Outlying Islands, Virgin Islands (U.S.), Wallis and Futuna, Western Sahara.

## Countries with 0 hotlines

All genuinely uninhabited:

- **Bouvet Island** — Norwegian subantarctic dependency.
- **French Southern Territories** — research stations only.
- **Heard Island and McDonald Islands** — uninhabited Australian territory.
- **United States Minor Outlying Islands** — Baker, Howland, Jarvis, Johnston Atoll, Kingman Reef, Midway, Navassa, Palmyra, Wake. No standing civilian services.

## Priority queue for next enrichment passes

### Tier 2 — high population + published national suicide/crisis lines (pending)

Finland, Norway, Switzerland, Austria, Portugal, Poland, Czech Republic, Greece, Hungary, Romania, Croatia, Slovakia, Slovenia, Estonia, Latvia, Lithuania, Bulgaria, Serbia, Malta, Cyprus, Luxembourg, Iceland, Taiwan, Malaysia, Philippines, Thailand, Indonesia, Vietnam, Pakistan, Bangladesh, Sri Lanka, UAE, Saudi Arabia, Israel, Jordan, Turkey, Argentina, Chile, Colombia, Peru, Uruguay, Costa Rica, Panama, Ecuador.

### Tier 3 — remaining countries (pending)

Everything else. Primary sources for this tier:

- Befrienders Worldwide — https://www.befrienders.org/find-support-now
- IASP Crisis Centre directory — https://www.iasp.info/resources/Crisis_Centres/
- Find A Helpline — https://findahelpline.com
- WHO country profiles — https://www.who.int/countries
- National health ministries

### Spot-check audit (pending)

Random sample 20 records across the legacy-unverified pool, re-verify against official sources, flag discrepancies, promote to `verified_web`.
