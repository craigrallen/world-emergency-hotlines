#!/usr/bin/env python3
"""
Merge the Vibbrancy Hotlines.json (atlacord/Naga pinned at 61bec14)
into the enriched hotlines.json without losing any data.

Run order (one-time, when WSL is available):

    1. Place the raw Vibbrancy file at: sources/vibbrancy_hotlines.json
       (download: https://raw.githubusercontent.com/atlacord/Naga/
        61bec140fed8c4c2a9bf65b6d122a9499ee6a08f/src/assets/Hotlines.json )

    2. Have information.json in the project root.

    3. python3 scripts/merge_vibbrancy.py

The script will:
  - Load all three sources.
  - For every country present in either legacy source but not yet in
    hotlines.json, migrate the legacy entry into the v2.0 schema with
    verification_status="legacy_unverified".
  - For countries already in hotlines.json, add any hotline entries
    (by name+number-set) that exist in a legacy source but not in the
    enriched file, also marked "legacy_unverified".
  - Write a merge report to REPORTS/merge_<timestamp>.md.

It will NEVER overwrite an enriched (verified_knowledge / verified_web)
record with a legacy one.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys
import unicodedata
from datetime import datetime
from typing import Any

PROJECT_ROOT = pathlib.Path(__file__).parent.parent
OUT_PATH = PROJECT_ROOT / "hotlines.json"

# Legacy sources. Copy each into the project root (or sources/) before running.
#   - information.json : the originally-uploaded reference dataset.
#   - sources/vibbrancy_hotlines.json : the Vibbrancy/Naga Hotlines.json,
#     downloaded from https://raw.githubusercontent.com/atlacord/Naga/
#     61bec140fed8c4c2a9bf65b6d122a9499ee6a08f/src/assets/Hotlines.json
LEGACY_SOURCES = [
    PROJECT_ROOT / "information.json",
    PROJECT_ROOT / "sources" / "vibbrancy_hotlines.json",
]
REPORT_DIR = PROJECT_ROOT / "REPORTS"


def norm_name(s: str) -> str:
    """Normalise for fuzzy matching: lowercased, unicode-folded, alphanum-only."""
    s = unicodedata.normalize("NFKD", s)
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def norm_number(s: str) -> str:
    return re.sub(r"[^0-9+#*]", "", s)


def load(path: pathlib.Path) -> Any:
    if not path.exists():
        print(f"  (missing — skipping) {path}", file=sys.stderr)
        return None
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def legacy_to_v2(entry: dict, sources: list[str]) -> dict:
    """Migrate a {country, alpha-2, alpha-3, hotlines:[{name, numbers}]} entry
    into the v2.0 shape, marking everything legacy_unverified."""
    today = datetime.utcnow().date().isoformat()
    hotlines = []
    for h in entry.get("hotlines", []):
        hotlines.append({
            "name": h.get("name", ""),
            "organization": h.get("name", ""),
            "category": guess_category(h.get("name", "")),
            "voice_numbers": list(h.get("numbers", [])),
            "sms_numbers": [],
            "text_numbers": [],
            "short_codes": [],
            "chat_url": None,
            "email": None,
            "website": None,
            "hours": None,
            "languages": [],
            "cost": "unknown",
            "target": None,
            "geography": entry.get("country"),
            "notes": "",
            "verification_status": "legacy_unverified",
            "last_verified": None,
            "sources": sources,
            "_legacy": {"name": h.get("name"), "numbers": list(h.get("numbers", []))},
        })
    return {
        "country": entry["country"],
        "alpha-2": entry.get("alpha-2"),
        "alpha-3": entry.get("alpha-3"),
        "region": None,
        "subregion": None,
        "general_emergency": [],
        "notes": "",
        "hotlines": hotlines,
    }


CATEGORY_KEYWORDS = {
    "suicide_crisis": [r"\bsuicid", r"\bcrisis", r"\blifeline", r"samarit", r"prevention.of.(young.)?suicid"],
    "emergency": [r"^emergency$", r"^police$", r"^fire$", r"ambulan", r"112", r"999", r"911"],
    "child_protection": [r"child", r"kids", r"childline", r"junior", r"youth.*abuse"],
    "domestic_violence": [r"domest", r"partner", r"violence against women", r"women'?s? (aid|shelter|helpline)", r"gender.*violence"],
    "sexual_violence": [r"rape", r"sexual assault", r"sexual abuse", r"survivor"],
    "lgbtqia": [r"lgbt", r"queer", r"trans ?(lifeline|life)", r"gay", r"lesbian", r"rainbow"],
    "substance_use": [r"alcohol", r"drug", r"narcot", r"addict", r"frank"],
    "gambling": [r"gambl"],
    "eating_disorders": [r"eating disord", r"anorex", r"bulimi"],
    "bereavement": [r"bereavement", r"grief", r"cruse", r"sands"],
    "self_harm": [r"self.?harm", r"self.?injur"],
    "veterans": [r"veteran", r"armed forces", r"combat stress"],
    "human_trafficking": [r"traffick", r"modern.slavery"],
    "missing_persons": [r"missing", r"runaway"],
    "mental_health": [r"mental", r"mind", r"anxiety", r"depression", r"sane", r"psych"],
    "elder_abuse": [r"elder", r"older people", r"age(ing)? (uk|concern)", r"silver line"],
    "stalking": [r"stalk"],
    "youth": [r"youth", r"teen", r"young people", r"13.25"],
}


def guess_category(name: str) -> str:
    low = name.lower()
    for cat, pats in CATEGORY_KEYWORDS.items():
        for p in pats:
            if re.search(p, low):
                return cat
    return "general_support"


def merge():
    # Load enriched target
    enriched = load(OUT_PATH) or {"$schema_version": "2.0", "countries": []}
    enriched_by_country = {c["country"]: c for c in enriched.get("countries", [])}

    report_lines: list[str] = [
        f"# Merge report — {datetime.utcnow().isoformat(timespec='seconds')}Z",
        "",
        "## Inputs",
    ]

    # Merge each legacy source
    for src in LEGACY_SOURCES:
        legacy = load(src)
        if not legacy:
            continue
        report_lines.append(f"- {src.name}: {len(legacy)} countries")
        for entry in legacy:
            country = entry.get("country")
            if not country:
                continue
            if country not in enriched_by_country:
                # Migrate whole country
                enriched_by_country[country] = legacy_to_v2(entry, [str(src.name)])
                report_lines.append(f"  - migrated new country: {country}")
                continue
            # Country exists — top up any missing hotlines
            dst = enriched_by_country[country]
            dst_index = {
                (norm_name(h["name"]), tuple(sorted(norm_number(n) for n in h.get("voice_numbers", []))))
                for h in dst["hotlines"]
            }
            added = 0
            for h in entry.get("hotlines", []):
                key = (
                    norm_name(h.get("name", "")),
                    tuple(sorted(norm_number(n) for n in h.get("numbers", []))),
                )
                if key in dst_index:
                    continue
                # Add legacy-unverified
                dst["hotlines"].append(legacy_to_v2({"country": country, "hotlines": [h]}, [str(src.name)])["hotlines"][0])
                dst_index.add(key)
                added += 1
            if added:
                report_lines.append(f"  - {country}: +{added} legacy hotlines")

    # Rebuild final
    enriched["countries"] = sorted(enriched_by_country.values(), key=lambda c: c["country"])
    enriched["last_updated"] = datetime.utcnow().date().isoformat()

    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(enriched, f, ensure_ascii=False, indent=2)

    REPORT_DIR.mkdir(exist_ok=True)
    report_path = REPORT_DIR / f"merge_{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}.md"
    with report_path.open("w", encoding="utf-8") as f:
        f.write("\n".join(report_lines))

    print(f"Wrote {OUT_PATH} with {len(enriched['countries'])} countries.")
    print(f"Report: {report_path}")


if __name__ == "__main__":
    merge()
