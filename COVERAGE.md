# Coverage Status — 2026-04-22 (pass 3 enrichment complete + supplemental preview safeguards preserved)

## Totals

| Metric | Count |
| --- | --- |
| Countries / territories in dataset | 250 |
| Hotline records total | 1,952 |
| Records rich-enriched (`verified_knowledge`) | 743 |
| Records migrated but not yet enriched (`legacy_unverified`) | 1,209 |
| Countries with at least one `verified_knowledge` record | ~120 |
| Countries with 0 hotlines (genuinely uninhabited) | 4 |
| Supplemental web-derived source rows vendored for review | 253 |
| Supplemental rows currently mapped to canonical country list | 243 |
| Supplemental rows skipped because richer canonical records already exist | 207 |
| Supplemental preview countries written | 36 |
| Supplemental rows held for manual geopolitical review | 10 |

## Status legend

- **Rich** — Full v2.0 enrichment: category, hours, languages, cost, target, notes, website, sources. `verification_status: verified_knowledge`, pending web-confirmation pass.
- **Legacy** — Name + numbers (+ any email/website parsed from the source). `verification_status: legacy_unverified`.
- **Uninhabited** — No permanent civilian population; no standing emergency number.

## Rich-enriched countries (120+)

All have at least a verified-knowledge general-emergency line plus some combination of suicide/crisis, child protection, domestic violence, mental-health, sexual-violence, LGBTQIA+, substance-use, gambling and other category-specific lines.

### Americas
Argentina, Bahamas, Barbados, Belize, Bolivia, Brazil, Canada, Chile, Colombia, Costa Rica, Cuba, Dominica, Dominican Republic, Ecuador, El Salvador, Grenada, Guatemala, Guyana, Haiti, Honduras, Jamaica, Mexico, Nicaragua, Panama, Paraguay, Peru, Saint Kitts and Nevis, Saint Lucia, Saint Vincent and the Grenadines, Suriname, Trinidad and Tobago, United States, Uruguay, Venezuela.

### Europe
Albania, Andorra, Austria, Belgium, Bosnia and Herzegovina, Bulgaria, Croatia, Cyprus, Czech Republic, Denmark, Estonia, Finland, France, Germany, Gibraltar, Greece, Guernsey, Hungary, Iceland, Ireland, Italy, Kosovo, Latvia, Liechtenstein, Lithuania, Luxembourg, Malta, Moldova, Monaco, Montenegro, Netherlands, North Macedonia, Norway, Poland, Portugal, Romania, Russia, San Marino, Serbia, Slovakia, Slovenia, Spain, Sweden, Switzerland, Ukraine, United Kingdom.

### Asia
Afghanistan, Armenia, Azerbaijan, Bahrain, Bangladesh, Bhutan, Brunei, Cambodia, China, East Timor, Georgia, Hong Kong, India, Indonesia, Iran, Iraq, Israel, Japan, Jordan, Kazakhstan, Kuwait, Kyrgyzstan, Laos, Lebanon, Malaysia, Maldives, Mongolia, Myanmar, Nepal, North Korea, Oman, Pakistan, Palestine, Philippines, Qatar, Saudi Arabia, Singapore, South Korea, Sri Lanka, Syria, Taiwan, Tajikistan, Thailand, Turkey, Turkmenistan, United Arab Emirates, Uzbekistan, Vietnam, Yemen.

### Africa
Algeria, Angola, Benin, Botswana, Burkina Faso, Burundi, Cabo Verde, Cameroon, Central African Republic, Chad, Comoros, Congo, DR Congo, Djibouti, Egypt, Equatorial Guinea, Eritrea, Eswatini, Ethiopia, Gabon, Gambia, Ghana, Guinea, Guinea-Bissau, Ivory Coast, Kenya, Lesotho, Liberia, Libya, Madagascar, Malawi, Mali, Mauritania, Mauritius, Morocco, Mozambique, Namibia, Niger, Nigeria, Rwanda, São Tomé and Príncipe, Senegal, Seychelles, Sierra Leone, Somalia, South Africa, South Sudan, Sudan, Tanzania, Togo, Tunisia, Uganda, Zambia, Zimbabwe.

### Oceania
Australia, Cook Islands, Federated States of Micronesia, Fiji, Kiribati, Marshall Islands, Nauru, New Zealand, Palau, Papua New Guinea, Samoa, Solomon Islands, Tonga, Tuvalu, Vanuatu.

## Countries with 0 hotlines

All genuinely uninhabited:
- Bouvet Island — Norwegian subantarctic dependency.
- French Southern Territories — research stations only.
- Heard Island and McDonald Islands — uninhabited Australian territory.
- United States Minor Outlying Islands — Baker, Howland, Jarvis, Johnston Atoll, Kingman Reef, Midway, Navassa, Palmyra, Wake.

## What "rich-enriched" means

Every `verified_knowledge` record has:
- `category` from a controlled vocabulary
- `voice_numbers` and/or `sms_numbers` / `chat_url` / `email`
- `hours` of operation
- `languages` supported
- `cost` (free / local_rate / standard_rate / etc.)
- `target` audience description
- `website` URL
- `sources` array pointing to authoritative pages
- `last_verified` date (2026-04-22)

## Supplemental web-derived source directory (2026-04-22)

A separate generated directory is vendored under `sources/web_verified_crisis_directory/` together with a conservative preview conversion.

- **253 source rows** were preserved as auditable artifacts.
- **243 rows** currently map to this repo's canonical country list.
- **207 matched rows** are intentionally excluded from preview output because the canonical v2 dataset already has richer non-legacy hotline records for those countries.
- **36 countries** are written into `web_verified_directory_v2_preview.json` for review.
- **10 rows** are intentionally held back in `unmatched_country_rows.json`: Abkhazia, Akrotiri and Dhekelia, Ascension Island, Clipperton Island, Northern Cyprus, Somaliland, South Ossetia, Tibet, Transnistria, and Tristan da Cunha.
- The preview does **not** replace `hotlines.json`; it is a safe staging layer for selective future merges.

## Still to do (beyond this dataset)

1. **Web verification pass** — fetch each provider's website and promote `verified_knowledge` → `verified_web` with current hours and confirmation. ~743 records.
2. **Enrich remaining legacy records** — roughly 1,209 records from the merged sources (Vibbrancy / information.json) still carry only name+number. Many could be promoted to rich form by matching against aggregator directories (Befrienders, IASP, Find A Helpline) and auto-filling hours/languages.
3. **Category cleanup** — the legacy-import auto-categoriser defaulted to `general_support` for records it couldn't classify. Spot-check audit found ~30% of legacy records would be more accurately categorised. Widening the keyword table in `scripts/merge_all.py` and re-running would resolve most.
4. **Small-territory deepening** — 106 countries / territories still have <3 hotlines. Most are small island states with limited infrastructure, but there are publishable national crisis lines in some (e.g. Malta, Cyprus, San Marino) that the current data doesn't capture.
5. **Safe supplemental promotion** — review the staged web-derived preview/report artifacts and promote entries selectively under the schema-v2 roadmap without overwriting or downgrading richer canonical records.
