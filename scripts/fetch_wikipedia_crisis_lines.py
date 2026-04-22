#!/usr/bin/env python3
"""
Discover new crisis/helpline entries from Wikipedia.

Wikipedia keeps a heavily-maintained "List of suicide crisis lines" article
plus country-specific articles on crisis support. This worker pulls them
through the MediaWiki REST API (no scraping needed) and extracts every line
mentioned — name, country, phone number(s), hours if visible, notes.

Output: sources/wikipedia_crisis_lines.json with one record per line found.

Runs on Windows (sandbox web_fetch is provenance-gated). Polite: 1 req/s,
uses the official API endpoints.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = pathlib.Path(__file__).parent.parent
OUT = ROOT / "sources" / "wikipedia_crisis_lines.json"

UA = "hotlines.world aggregator (https://github.com/craigrallen/world-emergency-hotlines)"
DELAY = 1.0


def fetch_json(url: str) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except Exception as e:
        print(f"  fetch error: {e}", flush=True)
        return None


def fetch_html(url: str) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  fetch error: {e}", flush=True)
        return None


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


# Map country name (as Wikipedia writes it) → alpha-2 using our own dataset
def build_country_lookup() -> dict[str, str]:
    d = json.loads((ROOT / "hotlines.json").read_text(encoding="utf-8"))
    out = {}
    for c in d["countries"]:
        if c.get("alpha-2"):
            out[norm(c["country"])] = c["alpha-2"].upper()
    # Common aliases Wikipedia uses
    aliases = {
        "unitedstates": "US", "unitedstatesofamerica": "US", "usa": "US",
        "unitedkingdom": "GB", "uk": "GB", "greatbritain": "GB",
        "russia": "RU", "russianfederation": "RU",
        "vietnam": "VN", "southkorea": "KR", "northkorea": "KP",
        "czechrepublic": "CZ", "czechia": "CZ",
        "ivorycoast": "CI", "cotedivoire": "CI",
        "burma": "MM", "myanmar": "MM",
        "swaziland": "SZ", "eswatini": "SZ",
        "macedonia": "MK", "northmacedonia": "MK",
        "palestine": "PS", "palestinianterritories": "PS",
        "hongkong": "HK", "taiwan": "TW",
        "democraticrepublicofthecongo": "CD", "drc": "CD", "congo": "CG",
    }
    out.update(aliases)
    return out


# ------------------ "List of suicide crisis lines" ------------------

LIST_TITLE = "List_of_suicide_crisis_lines"


def parse_list_article(html: str, lookup: dict[str, str]) -> list[dict]:
    """Parse the rendered HTML of the list article.

    The article uses a big wiki-table with columns: Country | Organization |
    Phone number | Availability | Notes. Each row yields one record.
    """
    records = []
    # Find every <tr> under any table
    row_re = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.I | re.S)
    cell_re = re.compile(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", re.I | re.S)
    last_country = None
    for row_m in row_re.finditer(html):
        cells = cell_re.findall(row_m.group(1))
        if len(cells) < 3:
            continue
        def clean(c: str) -> str:
            # Strip tags
            c = re.sub(r"<sup\b[^<]*(?:(?!</sup>)<[^<]*)*</sup>", " ", c, flags=re.I)
            c = re.sub(r"<[^>]+>", " ", c)
            c = re.sub(r"&nbsp;", " ", c)
            c = re.sub(r"&amp;", "&", c)
            c = re.sub(r"&#91;[^&]*&#93;", "", c)  # wiki footnote markers
            c = re.sub(r"\s+", " ", c).strip()
            return c

        vals = [clean(c) for c in cells]
        if not vals:
            continue
        # Skip header
        if vals[0].lower() in ("country", "region"):
            continue

        country_raw = vals[0]
        # Row might have rowspan / merged cell — if country cell is empty, reuse last
        if not country_raw and last_country:
            country_raw = last_country
        elif country_raw:
            last_country = country_raw

        alpha2 = lookup.get(norm(country_raw))
        if not alpha2:
            continue

        name = vals[1] if len(vals) > 1 else ""
        phone = vals[2] if len(vals) > 2 else ""
        availability = vals[3] if len(vals) > 3 else ""
        notes = vals[4] if len(vals) > 4 else ""

        if not name and not phone:
            continue

        # Extract phone numbers — can contain multiple
        phones = []
        for m in re.finditer(r"(?:\+\d[\d\s\-()\.]{3,}|\d{3,}(?:[\s\-]\d+)*)", phone):
            t = re.sub(r"\s+", " ", m.group(0)).strip()
            if re.search(r"\d{3,}", t):
                phones.append(t)

        if not phones and not name:
            continue

        records.append({
            "country_name": country_raw,
            "country": alpha2,
            "name": name,
            "phones": phones,
            "hours": availability or None,
            "notes": notes or None,
        })
    return records


# ------------------ "List of emergency telephone numbers" ------------------

EMERG_TITLE = "List_of_emergency_telephone_numbers"


def parse_emergency_article(html: str, lookup: dict[str, str]) -> list[dict]:
    records = []
    row_re = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.I | re.S)
    cell_re = re.compile(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", re.I | re.S)
    for row_m in row_re.finditer(html):
        cells = cell_re.findall(row_m.group(1))
        if len(cells) < 2:
            continue
        def clean(c: str) -> str:
            c = re.sub(r"<sup\b[^<]*(?:(?!</sup>)<[^<]*)*</sup>", " ", c, flags=re.I)
            c = re.sub(r"<[^>]+>", " ", c)
            c = re.sub(r"&nbsp;", " ", c)
            c = re.sub(r"&amp;", "&", c)
            c = re.sub(r"\s+", " ", c).strip()
            return c

        vals = [clean(c) for c in cells]
        if vals[0].lower() in ("country", "region", "territory"):
            continue
        alpha2 = lookup.get(norm(vals[0]))
        if not alpha2:
            continue

        # Usually columns: Country | Ambulance | Fire | Police | Notes
        svc_map = ["country", "ambulance", "fire", "police", "notes"]
        for idx, svc in enumerate(svc_map):
            if svc == "country" or idx >= len(vals):
                continue
            raw = vals[idx]
            if not raw or raw in ("-", "—", "–", "N/A", "none", "None"):
                continue
            for num_m in re.finditer(r"(?:\+\d[\d\s\-()\.]{2,}|\d{2,})", raw):
                num = re.sub(r"\s+", " ", num_m.group(0)).strip()
                if re.search(r"\d{2,}", num):
                    records.append({
                        "country_name": vals[0],
                        "country": alpha2,
                        "name": f"Emergency ({svc.title()})",
                        "phones": [num],
                        "hours": "24/7",
                        "notes": vals[-1] if len(vals) > 4 else None,
                    })
    return records


def main():
    OUT.parent.mkdir(exist_ok=True)
    lookup = build_country_lookup()
    print(f"Loaded country lookup: {len(lookup)} aliases", flush=True)

    all_records = []

    for title in (LIST_TITLE, EMERG_TITLE):
        url = f"https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=text&page={title}&redirects=1"
        print(f"Fetching {title}", flush=True)
        data = fetch_json(url)
        time.sleep(DELAY)
        if not data or "parse" not in data:
            print(f"  failed", flush=True)
            continue
        html = data["parse"]["text"]["*"]
        if title == LIST_TITLE:
            recs = parse_list_article(html, lookup)
        else:
            recs = parse_emergency_article(html, lookup)
        print(f"  {len(recs)} records", flush=True)
        for r in recs:
            r["source_title"] = title
        all_records.extend(recs)

    # Deduplicate within the output (same country + phone + name)
    seen = set()
    dedup = []
    for r in all_records:
        phone_sig = tuple(re.sub(r"\D", "", p)[-7:] for p in r["phones"])
        key = (r["country"], phone_sig, norm(r["name"]))
        if key in seen:
            continue
        seen.add(key)
        dedup.append(r)

    payload = {
        "source": "https://en.wikipedia.org/",
        "scraped_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "article_titles": [LIST_TITLE, EMERG_TITLE],
        "record_count": len(dedup),
        "records": dedup,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote {OUT} with {len(dedup)} unique records from {len(all_records)} raw rows", flush=True)

    # Country breakdown
    from collections import Counter
    cb = Counter(r["country"] for r in dedup)
    print("Top 15 countries:", cb.most_common(15))


if __name__ == "__main__":
    main()
