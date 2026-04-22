# Hotlines Dataset — Schema v2.0

This document defines the enriched schema used in `hotlines.json`.

The goal is to capture not just *which number to call* but everything a person in crisis needs to know: what it's for, who answers, when, in what languages, and whether it costs anything.

## Top-level structure

```jsonc
{
  "$schema_version": "2.0",
  "last_updated": "YYYY-MM-DD",
  "methodology": "...",
  "categories_reference": { /* see below */ },
  "countries": [ /* Country records */ ]
}
```

## Country record

```jsonc
{
  "country": "United Kingdom",
  "alpha-2": "GB",                          // ISO 3166-1 alpha-2
  "alpha-3": "GBR",                         // ISO 3166-1 alpha-3
  "region": "Europe",                       // UN M49 region
  "subregion": "Northern Europe",           // UN M49 subregion
  "general_emergency": ["999", "112"],      // Quick-reference life-safety number(s)
  "notes": "112 works from mobiles and is EU-wide; 18000 is SMS for deaf/HoH.",
  "hotlines": [ /* Hotline records */ ]
}
```

## Hotline record

Every field except `name` and `category` is optional. Missing data is represented by an empty array or `null`, never omitted — this keeps the schema predictable for consumers.

```jsonc
{
  "name": "Samaritans",                      // Display name of the service
  "organization": "Samaritans",              // Operating organisation (may equal name)
  "category": "suicide_crisis",              // One of the enum values below

  "voice_numbers": ["116 123"],              // Regular voice-call numbers (free-form strings)
  "sms_numbers": [],                         // SMS-only numbers (e.g. "741741")
  "text_numbers": [],                        // Numbers that accept either (rare)
  "short_codes": [],                         // Country-specific short codes if distinct

  "chat_url": "https://www.samaritans.org/how-we-can-help/contact-samaritan/",
  "email": "jo@samaritans.org",
  "website": "https://www.samaritans.org",

  "hours": "24/7",                           // Free-form; use "24/7" when always available
  "languages": ["English", "Welsh"],         // Languages supported on the line
  "cost": "free",                            // One of: free | free_from_mobile | local_rate | standard_rate | paid
  "target": "anyone in emotional distress",  // Who the service is for
  "geography": "UK and Ireland",             // If not country-wide
  "notes": "Non-religious, confidential...", // Anything else worth knowing

  "verification_status": "verified_web",     // See below
  "last_verified": "2026-04-22",             // ISO date of last verification
  "sources": [                               // Authoritative URLs used to verify
    "https://www.samaritans.org/how-we-can-help/contact-samaritan/"
  ]
}
```

## `category` enum

| Value | Meaning |
| --- | --- |
| `emergency` | General emergency (police/fire/ambulance). Usually a single 3-digit code. |
| `suicide_crisis` | Suicide prevention and acute suicidal crisis |
| `mental_health` | General mental health support (not acute crisis) |
| `child_protection` | Child abuse, child welfare, children in crisis (e.g. Childline) |
| `youth` | General youth helplines (non-abuse) |
| `domestic_violence` | Domestic abuse, intimate partner violence |
| `sexual_violence` | Rape crisis, sexual assault, sexual abuse survivors |
| `lgbtqia` | LGBTQIA+ specific support, including youth-specific (e.g. Trevor Project) |
| `substance_use` | Drug and alcohol addiction support |
| `elder_abuse` | Elder abuse and protection |
| `veterans` | Military veterans and serving personnel |
| `human_trafficking` | Human trafficking, modern slavery, forced labour |
| `disaster` | Disaster relief, disaster distress, natural-disaster response |
| `missing_persons` | Missing persons, runaway children (e.g. 116 000) |
| `bereavement` | Grief and bereavement support |
| `eating_disorders` | Eating disorder support |
| `gambling` | Problem gambling |
| `self_harm` | Self-injury-specific support (non-suicidal) |
| `perinatal` | Pregnancy loss, postnatal support |
| `disability` | Disability, chronic illness, specific conditions (MS, dementia, etc.) |
| `general_support` | Loneliness, general wellbeing, listening lines not covered above |
| `stalking` | Stalking, harassment |
| `male_victims` | Helplines specifically for male victims of abuse |
| `refugee_migrant` | Refugee / asylum seeker / migrant support |
| `legal_aid` | Civil legal advice, legal clinics, ombudsperson lines |
| `financial_aid` | Financial hardship, debt, fraud reporting |
| `housing` | Homelessness, emergency shelter, housing advice |
| `human_rights` | Human-rights reporting, discrimination, civil liberties |
| `animal_welfare` | Animal welfare and RSPCA-type services |

## `cost` enum

| Value | Meaning |
| --- | --- |
| `free` | Free to call from any phone |
| `free_from_mobile` | Free from mobile phones only (landlines may bill) |
| `free_from_landline` | Free from landlines only |
| `local_rate` | Billed at local call rate |
| `standard_rate` | Billed at the caller's standard/plan rate |
| `paid` | Premium or toll charge applies |
| `unknown` | Cost not known / not verified |

## `verification_status` enum

| Value | Meaning |
| --- | --- |
| `verified_web` | The number was confirmed against the provider's official website on `last_verified` |
| `verified_authority` | Confirmed against a government or authoritative body (WHO, IFRC, national health ministry) |
| `verified_knowledge` | Asserted from Claude's training knowledge (cutoff May 2025) but not yet re-confirmed on the public web |
| `cross_referenced` | Record originated from a third-party public directory (e.g. helplines.world). Trust is moderate — the directory has presumably done some diligence, but we have not re-verified on the provider's own site |
| `legacy_unverified` | Inherited from the source dataset without independent verification |
| `disputed` | Conflicting sources found — value in this record is best guess; see `notes` |
| `deprecated` | Service has closed or the number is no longer in use |

## Number formatting convention

- Voice numbers are stored **as the service publishes them**, including spaces, so they look familiar to users (`"116 123"`, `"0800 1111"`).
- International dialling prefixes (`+`) are only included where the number is explicitly published that way (e.g. some international helplines). Otherwise, numbers are in local dialling format.
- A country's `general_emergency` array always lists the primary local number first, then widely-recognised alternates (e.g. `["999", "112"]` for the UK).

## Backwards compatibility

The original flat `{name, numbers[]}` structure is preserved inside every migrated hotline as `_legacy` when useful:

```jsonc
"_legacy": { "name": "Samaritans Helpline", "numbers": ["116 123"] }
```

This lets consumers of the old shape continue working while new fields are populated.
