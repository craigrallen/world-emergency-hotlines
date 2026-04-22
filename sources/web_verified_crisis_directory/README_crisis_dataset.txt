Crisis helplines by country dataset

Files:
- crisis_helplines_by_country.json: normalized country-by-country JSON dataset
- verification_report.json: verification counts and scrape diagnostics

Source coverage used live during dataset build:
- Wikipedia suicide crisis lines: https://en.wikipedia.org/wiki/List_of_suicide_crisis_lines
- Child Helpline International list and country/member pages: https://childhelplineinternational.org/helplines/
- HotPeach countries index plus regional country sections: https://www.hotpeachpages.net/a/countries.html
- Befrienders members page checked live for availability/limitations: https://befrienders.org/members/

Caveats:
- Mental-health entries sourced from Wikipedia are conservative summaries of each country row; some rows mix hotline numbers with emergency services or explanatory text.
- Child Helpline International pages are structured pages, but some fields render inconsistently; when contact details were unclear, the script omitted guesses and preserved context in notes.
- HotPeach entries were extracted conservatively from live regional country sections and are often web-resource listings for domestic/sexual violence support rather than a single hotline number.
- Befrienders publicly exposed page/API did not provide a stable country-by-country machine-readable directory without geolocated nearest-centre behaviour, so no country-level Befrienders entries were auto-added.
- Outbound third-party agency websites listed by source pages were not exhaustively revalidated beyond live-source-page retrieval unless directly obvious in the source markup.