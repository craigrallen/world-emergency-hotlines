# Verification Log

A running record of how each country's records were verified, and against which sources. Once the web-verification pass runs, every entry promoted to `verified_web` or `verified_authority` will be logged here with the URL retrieved and the date.

## Pass 1 — Knowledge-based authoring (2026-04-22)

All rich records written in pass 1 carry `verification_status: verified_knowledge`, meaning they were authored from Claude's training knowledge (cutoff end of May 2025). Every record's `sources` array points to the provider's primary website, which should be fetched in the next pass to confirm current numbers, hours and URLs.

Known risks with knowledge-based authoring:

1. **Short-code changes.** Governments occasionally replace three- or four-digit crisis lines. Examples seen recently (all captured in pass 1): UK HOPELine → HOPELINE247 rebrand (2023), Canada 9-8-8 launch (Nov 2023), US 988 launch (Jul 2022), Spain 024 launch (May 2022), France 3114 launch (Oct 2021), Australia 13YARN launch (2022).
2. **Discontinued services.** NEDA helpline closed 2023 — replaced in dataset with National Alliance for Eating Disorders. Any other closures after May 2025 will not be known until web verification.
3. **Service-hour drift.** Listening lines sometimes change hours between crises. Web verification is the only reliable source for current hours.
4. **Regional numbers.** State/province variants (e.g. Australian state-level parent lines, UK regional women's aid) are not exhaustively captured yet.

## Authoritative aggregator sources

When the web-verification pass runs, these should be used as primary corroborating references:

| Source | URL | Scope |
| --- | --- | --- |
| Befrienders Worldwide | https://www.befrienders.org/find-support-now | Global network of emotional-support lines (≈349 centres across ≈32 countries) |
| IASP Crisis Centres | https://www.iasp.info/resources/Crisis_Centres/ | International Association for Suicide Prevention directory |
| Find A Helpline (ThroughLine) | https://findahelpline.com | Curated, human-vetted global directory (13,000+ helplines) |
| International Federation of Red Cross & Red Crescent | https://www.ifrc.org | National societies listing emergency numbers |
| WHO country health profiles | https://www.who.int/countries | Government-level emergency and health lines |
| Wikipedia — List of emergency telephone numbers | https://en.wikipedia.org/wiki/List_of_emergency_telephone_numbers | Good starting index; cross-reference against primary sources |
| European Emergency Number Association | https://eena.org | EU-harmonised short codes (112, 116 111, 116 123, 116 000, 116 016, 116 006) |

## Per-country notes (pass 1)

Any country-specific verification notes not captured inside the JSON's `notes` or `sources` fields are logged here.

### United States
- 988 fully replaced the 1-800-273-TALK number for most callers in 2022; old number still routes.
- NEDA phone helpline discontinued June 2023 — dataset now references National Alliance for Eating Disorders instead.
- Trevor Project "press 3 on 988" specialised routing launched 2022 as a pilot; verify persistence.

### United Kingdom
- Papyrus rebranded HOPELineUK → HOPELINE247 in 2023.
- NHS 111 added mental-health option (press 2) in England under the 2023–24 rollout.
- Rape Crisis E&W 0808 500 2222 launched Oct 2023 as a 24/7 national line.
- CALM helpline hours expanded in 2023; double-check current hours.

### Australia
- 13YARN launched 2022 — first national Indigenous-specific crisis line.
- Lifeline moved to 24/7 text in 2021.
- State-level DV and parent lines not exhaustively captured; add to tier-2 pass.

### Canada
- 9-8-8 launched 30 November 2023; replaces Talk Suicide Canada / Crisis Services Canada network.
- Provinces retain own DV and crisis services — only national/ON entries captured so far.

### France
- 3114 launched Oct 2021; previous reliance on SAMU (15) for psychiatric crisis.
- 3020 (school harassment) and 3018 (cyber harassment) were added under the 2021–22 youth-safety measures.

### Germany
- Hilfetelefon migrated onto the EU-harmonised 116 016 short code in 2024 (from 08000 116 016).
- Hilfetelefon Gewalt an Männern launched 2020.

### Japan
- Yorisoi Hotline expanded multilingual hours during COVID-19.
- Child abuse line 189 (いちはやく) became fully free in 2019.

### Spain
- 024 launched May 2022 following the Spanish national suicide prevention plan.
- 016 coverage expanded in 2022 to cover all forms of gender-based violence, not just intimate partner.

### Brazil
- 188 became toll-free in 2017.
- Disque 100 has been the human rights omnibus line since 2011.

### South Africa
- SADAG operates multiple topic lines (teen suicide, bipolar, OCD, substance, rural, bereavement) — only headline lines captured so far.
- GBV Command Centre launched 2014; added chat/video during COVID-19.
- TEARS *134*7355# USSD service continues to grow — verify current coverage.

### Singapore
- SOS rebranded its 24-hour number to 1767 in 2022.
- National Anti-Violence Helpline renamed in 2024.

### Hong Kong
- Open Up web chat (https://www.openup.hk) launched 2018 for youth — not currently in dataset; add in tier-2.

### South Korea
- 1393 launched 2018 as a national suicide line replacing KSPC short codes.
- 1388 youth line has a cyber counselling equivalent via https://www.cyber1388.kr.

## Open verification items

These should be re-checked first in the next web-verification pass:

- UK Childline chat hours (often change).
- US 988 translation coverage (>200 languages claimed; confirm current list on 988lifeline.org).
- Australia Kids Helpline 24/7 chat availability (confirm on kidshelpline.com.au).
- NEDA replacement recommendation (confirm Alliance for Eating Disorders is still the best referral, not Project HEAL or F.E.A.S.T.).
- India KIRAN number stability (1800-599-0019 — launched 2020, verify active).
- South Africa GBV Command Centre USSD code.

## Vibbrancy Hotlines.json reference (pinned commit 61bec14, user's app source)

URL: https://raw.githubusercontent.com/atlacord/Naga/61bec140fed8c4c2a9bf65b6d122a9499ee6a08f/src/assets/Hotlines.json

Status: Successfully fetched (≈63,000 characters). The file uses the same shape as `information.json` (country / alpha-2 / alpha-3 / hotlines array). Cross-checks performed by string presence:

| Test string | In Vibbrancy file? | In `information.json`? | Implication |
| --- | --- | --- | --- |
| `"988 Suicide"` | ❌ | ✅ | Vibbrancy file is pre-2022 vintage (before 988 US launch) |
| `"National Suicide Prevention Lifeline"` | ✅ | ✅ | Both carry the older US entry; `information.json` has both old and new |
| `"1-800-273-8255"` | ✅ | ✅ | Legacy US number present in both |
| `"HOPELineUK"` | ✅ | ✅ | Old Papyrus name (before 2023 HOPELINE247 rebrand) |
| `"HOPELINE247"` | ❌ | ❌ | Neither has the post-2023 name; dataset lags |
| `"Samaritans"` | ✅ | ✅ | Present in both |

**Conclusion.** The Vibbrancy Hotlines.json is an older snapshot of the same dataset that `information.json` was originally derived from. `information.json` has more recent entries (e.g. the US 988 Suicide & Crisis Lifeline). No country in the Vibbrancy file is expected to be *absent* from `information.json` — it is a subset/predecessor, not a superset. The enriched `hotlines.json` produced in pass 1 already incorporates the newest equivalents (US 988, UK HOPELINE247, Canada 9-8-8, Spain 024, France 3114, Australia 13YARN) which predate neither file.

**Open action.** When the Linux environment comes back online, run a programmatic diff across the three files (`information.json`, `hotlines.json`, Vibbrancy `Hotlines.json`) to identify any country/hotline in the Vibbrancy file that is genuinely missing from `information.json`. If found, migrate those into `hotlines.json`. Script is stubbed out in `scripts/merge_vibbrancy.py` (to be created).

**Note on reading large fetched files.** The Vibbrancy file could not be read in full via file tools in this session because MCP wraps the response in a single-line JSON envelope that exceeds the line-length limit of Read/Grep. Once WSL is up, `jq` or Python will parse it trivially.
