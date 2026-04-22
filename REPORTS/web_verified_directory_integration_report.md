# Web-verified directory integration report

- Source rows reviewed: 253
- Matched directly by country name: 227
- Matched via explicit alias map: 16
- Unmatched rows kept out of preview: 10
- Preview countries written: 243
- Preview hotline records written: 1739

## Source verification-status counts

- `manual_review`: 4
- `pass`: 186
- `warning`: 63

## Explicit source→repo aliases used

- `Antigua & Barbuda` → `Antigua and Barbuda`
- `British Virgin Islands` → `Virgin Islands (British)`
- `Brunei Darussalam` → `Brunei`
- `Cabo Verde` → `Cabo Verde (Cape Verde)`
- `Caribbean Netherlands` → `Bonaire, Sint Eustatius and Saba`
- `Cocos Islands` → `Cocos (Keeling) Islands`
- `Curacao` → `Curaçao`
- `Czechia` → `Czech Republic`
- `Côte d'Ivoire` → `Ivory Coast`
- `Falkland Islands (Malvinas)` → `Falkland Islands`
- `Korea, Democratic People's Republic of` → `North Korea`
- `Korea, Republic of` → `South Korea`
- `Micronesia, Federated States of` → `Federated States of Micronesia`
- `Republic of the Congo` → `Congo`
- `Saint Helena` → `Saint Helena, Ascension and Tristan da Cunha`
- `Sint Maarten` → `Sint Maarten (Dutch part)`
- `São Tomé & Príncipe` → `Sao Tome and Principe`
- `U.S. Virgin Islands` → `Virgin Islands (U.S.)`
- `Vatican City` → `Holy See`

## Unmatched source rows

- `Abkhazia` (`warning`)
- `Akrotiri and Dhekelia` (`warning`)
- `Ascension Island` (`warning`)
- `Clipperton Island` (`warning`)
- `Northern Cyprus` (`warning`)
- `Somaliland` (`warning`)
- `South Ossetia` (`warning`)
- `Tibet` (`warning`)
- `Transnistria` (`warning`)
- `Tristan da Cunha` (`warning`)

## Safety notes

- The preview intentionally does **not** overwrite `hotlines.json`.
- Imported hotline records are marked `legacy_unverified` in v2 preview output even when the source row passed its own QA, because the generated directory mixes Wikipedia, Child Helpline International, and HotPeach-derived data rather than only first-party provider pages.
- `unmatched_country_rows.json` preserves disputed or out-of-scope political entities for manual review instead of forcing them into the canonical country list.
