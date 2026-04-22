Emergency numbers by country dataset

Source
- Primary source page: https://en.wikipedia.org/wiki/List_of_emergency_telephone_numbers
- Retrieval method: live HTTP GET with a browser-like User-Agent, parsed from all continent/region wikitable rows on 2026-04-22T11:49:43.298431+00:00Z.
- Row-level source_urls always include the Wikipedia page and, when present in rendered references, linked citation URLs from that row's footnotes.

Parsing notes
- All country rows were extracted from the continent/region tables: Africa, Caribbean, Central America, North America, South America, Antarctica, Asia, Europe, and Oceania.
- Africa uses an 'Other numbers' column; the other regional tables use a 'Notes' column. Both were normalized into emergency.other_numbers as a list of labeled strings when possible.
- Primary service fields (police, ambulance, fire) were cleaned to remove inline citation markers like [1].
- Some entries are territories or partially recognized states because the source page includes them.
- Some note text contains free-form guidance; splitting into other_numbers is best-effort and preserves the raw note text inside verification_notes.

Verification snapshot
- Total records: 251
- Records with any missing primary emergency field: 3
- Missing police values: 0
- Missing ambulance values: 2
- Missing fire values: 1
- Records with parsed other_numbers entries: 153
- Records with at least one row-specific citation URL beyond Wikipedia: 88
- Duplicate country names after normalization: 0
- Countries with obvious missing primary fields: Democratic Republic of Congo, Republic of Congo, Tokelau

Caveats
- This dataset is derived from a maintained public reference page, not direct government APIs. Use source_urls for follow-up verification before operational use.
- Row footnotes do not always expose a clean external citation URL in the rendered HTML, so some source_urls lists only contain the Wikipedia page.
