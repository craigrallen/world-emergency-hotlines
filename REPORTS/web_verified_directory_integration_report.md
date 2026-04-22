# Web-verified directory integration report

- Source rows reviewed: 253
- Matched directly by country name: 227
- Matched via explicit alias map: 16
- Unmatched rows kept out of preview: 10
- Matched rows skipped because canonical v2 already has richer non-legacy records: 26
- Preview countries written: 217
- Preview hotline records written: 1508

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

## Protected canonical countries skipped from preview

- `Australia` → `Australia` (protected statuses: verified_knowledge)
- `Belgium` → `Belgium` (protected statuses: verified_knowledge)
- `Brazil` → `Brazil` (protected statuses: verified_knowledge)
- `Canada` → `Canada` (protected statuses: verified_knowledge)
- `Denmark` → `Denmark` (protected statuses: verified_knowledge)
- `France` → `France` (protected statuses: verified_knowledge)
- `Germany` → `Germany` (protected statuses: verified_knowledge)
- `Hong Kong` → `Hong Kong` (protected statuses: verified_knowledge)
- `India` → `India` (protected statuses: verified_knowledge)
- `Ireland` → `Ireland` (protected statuses: verified_knowledge)
- `Italy` → `Italy` (protected statuses: verified_knowledge)
- `Japan` → `Japan` (protected statuses: verified_knowledge)
- `Korea, Republic of` → `South Korea` (protected statuses: verified_knowledge)
- `Mexico` → `Mexico` (protected statuses: verified_knowledge)
- `Netherlands` → `Netherlands` (protected statuses: verified_knowledge)
- `New Zealand` → `New Zealand` (protected statuses: verified_knowledge)
- `Northern Mariana Islands` → `Northern Mariana Islands` (protected statuses: verified_knowledge)
- `Saint Barthélemy` → `Saint Barthélemy` (protected statuses: verified_knowledge)
- `Saint Martin (French part)` → `Saint Martin (French part)` (protected statuses: verified_knowledge)
- `Singapore` → `Singapore` (protected statuses: verified_knowledge)
- `South Africa` → `South Africa` (protected statuses: verified_knowledge)
- `Spain` → `Spain` (protected statuses: verified_knowledge)
- `Sweden` → `Sweden` (protected statuses: verified_knowledge)
- `United Kingdom` → `United Kingdom` (protected statuses: verified_knowledge)
- `United States` → `United States` (protected statuses: verified_knowledge)
- `Wallis and Futuna` → `Wallis and Futuna` (protected statuses: verified_knowledge)

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
- The preview writes schema-`2.0` records so review tooling can validate them against the canonical v2 shape, but `_preview_metadata.dataset_role` and the filename make clear that the output is non-canonical.
- Countries that already contain richer non-legacy canonical hotlines are **excluded** from the preview to avoid any chance of downgrade-by-confusion.
- Imported hotline records are marked `legacy_unverified` in v2 preview output even when the source row passed its own QA, because the generated directory mixes Wikipedia, Child Helpline International, and HotPeach-derived data rather than only first-party provider pages.
- `unmatched_country_rows.json` preserves disputed or out-of-scope political entities for manual review instead of forcing them into the canonical country list.
