# Crisis Resources — SQLite Schema for ISAR Import

## File

`crisis_resources.sqlite` — single table, ~228 KB, 651 records across 104 countries.

## Table: `crisis_resources`

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | INTEGER | NO | auto | Primary key |
| `title` | TEXT | YES | | Organization name (may include local language script) |
| `sub_title` | TEXT | YES | | Brief English description of the service |
| `country` | TEXT | NO | | ISO 3166-1 alpha-2 country code (e.g. `US`, `GB`, `MX`) |
| `state` | TEXT | YES | | State/province code (e.g. `US-CA`, `CA-ON`, `AU-NSW`) |
| `city` | TEXT | YES | | City name (only for city-specific services) |
| `locality` | TEXT | YES | | Broader area (e.g. `San Francisco Bay Area`, `Los Angeles County`) |
| `address` | TEXT | YES | | Physical address if applicable |
| `phone` | TEXT | YES | | Phone number(s) in local format |
| `email` | TEXT | YES | | Contact email |
| `website` | TEXT | YES | | Official website URL |
| `social` | TEXT | YES | | JSON string of social media links `{"twitter":"url","facebook":"url"}` or `[]` |
| `resource_status` | INTEGER | NO | 1 | 0=disabled, 1=enabled, 2=archived, 3=deleted |
| `source` | TEXT | NO | `seeder` | How the record was created (`seeder`, `manual`, `api`) |
| `language` | TEXT | NO | `en` | Language of the `sub_title` description |
| `created_at` | TEXT | YES | | ISO 8601 timestamp |
| `updated_at` | TEXT | YES | | ISO 8601 timestamp |

## Indexes

- `idx_resources_country` on `country` — for filtering by country
- `idx_resources_status` on `resource_status` — for filtering active resources

## ISAR Model Notes

- **Primary query**: filter by `country` + `resource_status = 1` to show active resources for the user's country
- **`social` field**: stored as a JSON string — parse it into a `Map<String, String>` in Dart
- **`title` field**: may contain non-Latin scripts (Arabic, Chinese, Japanese, Korean, Cyrillic, etc.) — ensure UTF-8 support
- **`phone` field**: stored as display-formatted string, not normalized — use as-is for display, strip non-digits for `tel:` links
- **`state`/`city`/`locality`**: only populated for regional/local services — most national services leave these null
- **`resource_status`**: only show records where `resource_status = 1` in the app UI; status 0/2/3 should be hidden

## Sample Record

```json
{
  "id": 71,
  "title": "خط الأمل — Hope Line (MOHAP)",
  "sub_title": "National mental health and crisis support helpline operated by the Ministry of Health and Prevention — free and confidential.",
  "country": "AE",
  "state": null,
  "city": null,
  "locality": null,
  "address": null,
  "phone": "800-HOPE (4673)",
  "email": null,
  "website": "https://www.mohap.gov.ae",
  "social": "[]",
  "resource_status": 1,
  "source": "seeder",
  "language": "en",
  "created_at": "2026-04-10 05:17:50",
  "updated_at": "2026-04-10 05:17:50"
}
```

## Import Strategy

1. On first app install or database upgrade, copy `crisis_resources.sqlite` from app assets
2. Read all rows and insert into the ISAR `CrisisResource` collection
3. On subsequent app updates, compare `updated_at` or ship a new SQLite file and replace
4. The app should filter by the device's locale/country to show relevant resources first
