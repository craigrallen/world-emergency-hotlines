#!/usr/bin/env python3
"""
Merge Wikipedia crisis-line records (sources/wikipedia_crisis_lines.json) into
hotlines.json. Dedupes against existing records and adds new ones tagged
cross_referenced with source=Wikipedia.
"""
from __future__ import annotations

import json
import pathlib
import re
import unicodedata
from datetime import datetime

ROOT = pathlib.Path(__file__).parent.parent
DATA = ROOT / "hotlines.json"
WIKI = ROOT / "sources" / "wikipedia_crisis_lines.json"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def phone_key(s: str, tail: int = 7) -> str:
    d = re.sub(r"\D", "", s or "")
    return d[-tail:] if len(d) >= tail else d


def main():
    data = json.loads(DATA.read_text(encoding="utf-8"))
    wiki = json.loads(WIKI.read_text(encoding="utf-8"))
    by_code = {c.get("alpha-2", "").upper(): c for c in data["countries"]}

    added = 0
    enriched = 0
    today = datetime.utcnow().date().isoformat()

    for r in wiki.get("records", []):
        code = r["country"]
        country = by_code.get(code)
        if country is None:
            continue

        name = r.get("name", "")
        phones = r.get("phones") or []
        if not phones:
            continue

        # Dedupe: find existing record matching on phone key OR name
        matched = None
        for h in country["hotlines"]:
            existing_keys = {phone_key(n) for n in (h.get("voice_numbers") or []) + (h.get("sms_numbers") or [])}
            incoming_keys = {phone_key(p) for p in phones}
            if existing_keys & incoming_keys and existing_keys:
                matched = h
                break
            if norm(name) and norm(name) == norm(h.get("name", "")):
                matched = h
                break

        if matched:
            # Just record that Wikipedia corroborates
            srcs = set(matched.get("sources") or [])
            new_tag = f"https://en.wikipedia.org/wiki/{r.get('source_title','')}"
            if new_tag not in srcs:
                srcs.add(new_tag)
                matched["sources"] = sorted(srcs)
                enriched += 1
            if matched.get("verification_status") == "legacy_unverified":
                matched["verification_status"] = "cross_referenced"
                matched["last_verified"] = today
            continue

        # Guess category based on name
        name_l = name.lower()
        if "ambulance" in name_l or "medical" in name_l or "emt" in name_l or "ems" in name_l:
            cat = "emergency"
        elif "police" in name_l:
            cat = "emergency"
        elif "fire" in name_l:
            cat = "emergency"
        elif "emergency" in name_l:
            cat = "emergency"
        elif "suicide" in name_l or "crisis" in name_l or "lifeline" in name_l or "samarit" in name_l:
            cat = "suicide_crisis"
        elif "child" in name_l:
            cat = "child_protection"
        elif "women" in name_l or "domestic" in name_l:
            cat = "domestic_violence"
        else:
            cat = "general_support"

        new = {
            "name": name,
            "organization": name,
            "category": cat,
            "voice_numbers": phones,
            "sms_numbers": [],
            "text_numbers": [],
            "short_codes": [],
            "chat_url": None,
            "email": None,
            "website": None,
            "hours": r.get("hours"),
            "languages": [],
            "cost": "free" if cat == "emergency" else "unknown",
            "target": None,
            "geography": country["country"],
            "notes": r.get("notes") or "",
            "verification_status": "cross_referenced",
            "last_verified": today,
            "sources": [f"https://en.wikipedia.org/wiki/{r.get('source_title','')}"],
        }
        country["hotlines"].append(new)
        added += 1

    data["last_updated"] = today
    tmp = DATA.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA)
    total = sum(len(c["hotlines"]) for c in data["countries"])
    print(f"Added:    {added}")
    print(f"Enriched: {enriched}")
    print(f"Total:    {total}")


if __name__ == "__main__":
    main()
