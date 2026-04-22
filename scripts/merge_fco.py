#!/usr/bin/env python3
"""
Merge sources/fco_travel_advice.json (produced by fetch_fco_travel_advice.py)
into hotlines.json. Extracts per-country emergency numbers (ambulance, fire,
police, single emergency number, deaf/TTY) and British embassy contacts from
UK FCDO travel-advice pages.

Dedupes against existing records by phone-key suffix (last-7-digit match) and
by name. New records land with verification_status=verified_authority and the
gov.uk URL as the source.
"""
from __future__ import annotations

import json
import pathlib
import re
import unicodedata
from datetime import datetime

ROOT = pathlib.Path(__file__).parent.parent
DATA = ROOT / "hotlines.json"
FCO = ROOT / "sources" / "fco_travel_advice.json"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def phone_key(s: str, tail: int = 7) -> str:
    d = re.sub(r"\D", "", s or "")
    return d[-tail:] if len(d) >= tail else d


SERVICE_LABELS = {
    "ambulance": ("Ambulance", "emergency", "emergency ambulance number"),
    "fire": ("Fire brigade", "emergency", "emergency fire service number"),
    "police": ("Police", "emergency", "emergency police number"),
    "single": ("Emergency (all services)", "emergency", "single emergency number"),
    "deaf": ("Emergency (Deaf/TTY/SMS)", "emergency", "emergency services for Deaf / hard-of-hearing users"),
    "coastguard": ("Coastguard", "emergency", "maritime / coastguard emergency"),
    "mountain_rescue": ("Mountain rescue", "emergency", "mountain rescue emergency"),
    "medical": ("Medical emergency", "emergency", "medical emergency number"),
}


def make_emergency_record(service, phones, country_name, source_url, today, notes_extra=""):
    title, category, target = SERVICE_LABELS[service]
    phones_clean = [re.sub(r"\s+", " ", p).strip() for p in phones]
    phones_clean = [p for p in phones_clean if re.search(r"\d", p)]
    return {
        "name": f"{title} - {country_name}",
        "organization": "Government / national emergency services",
        "category": category,
        "voice_numbers": phones_clean,
        "sms_numbers": [],
        "text_numbers": [],
        "short_codes": [],
        "chat_url": None,
        "email": None,
        "website": None,
        "hours": "24/7",
        "languages": [],
        "cost": "free",
        "target": target,
        "geography": country_name,
        "notes": (notes_extra + " Sourced from UK FCDO travel advice.").strip(),
        "verification_status": "verified_authority",
        "last_verified": today,
        "sources": [source_url],
    }


def make_embassy_record(post, country_name, source_url, today):
    phones = [re.sub(r"\s+", " ", p).strip() for p in post.get("phones") or []]
    phones = [p for p in phones if re.search(r"\d", p)]
    emails = post.get("emails") or []
    email = emails[0] if emails else None
    return {
        "name": post.get("name") or f"British Embassy / Consulate in {country_name}",
        "organization": "UK Foreign, Commonwealth & Development Office",
        "category": "consular",
        "voice_numbers": phones,
        "sms_numbers": [],
        "text_numbers": [],
        "short_codes": [],
        "chat_url": None,
        "email": email,
        "website": source_url,
        "hours": "office hours; 24/7 consular emergency line",
        "languages": ["English"],
        "cost": "unknown",
        "target": "consular assistance for British nationals in distress",
        "geography": country_name,
        "notes": "British consular post listed on the FCDO travel-advice country page.",
        "verification_status": "verified_authority",
        "last_verified": today,
        "sources": [source_url],
    }


def find_match(country, phones, name_hint):
    in_keys = {phone_key(p) for p in phones if p and p.strip()}
    name_n = norm(name_hint)
    for h in country["hotlines"]:
        ex_phones = (h.get("voice_numbers") or []) + (h.get("sms_numbers") or [])
        ex_keys = {phone_key(p) for p in ex_phones if p and p.strip()}
        if ex_keys and in_keys and (ex_keys & in_keys):
            return h
        if name_n and name_n == norm(h.get("name", "")):
            return h
    return None


def load_data():
    # defensive load: if hotlines.json has trailing junk (OneDrive sync), strip it
    raw = DATA.read_bytes()
    stripped = raw.rstrip(b"\x00 \t\r\n")
    last = stripped.rfind(b"}")
    if last >= 0 and last < len(stripped) - 1:
        stripped = stripped[: last + 1]
    try:
        return json.loads(stripped.decode("utf-8"))
    except Exception:
        # fall back — try slicing to last valid position
        text = stripped.decode("utf-8", errors="replace")
        # binary search for longest valid prefix ending at '}'
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            cut = text.rfind("}", 0, mid) + 1
            try:
                json.loads(text[:cut])
                lo = cut
            except Exception:
                hi = mid - 1
        return json.loads(text[:lo])


def main():
    data = load_data()
    fco = json.loads(FCO.read_text(encoding="utf-8"))
    by_code = {c.get("alpha-2", "").upper(): c for c in data["countries"]}

    today = datetime.utcnow().date().isoformat()
    added = 0
    enriched = 0

    for rec in fco.get("records", []):
        code = rec.get("country")
        country = by_code.get(code)
        if country is None:
            continue
        source_url = rec.get("source_url") or "https://www.gov.uk/foreign-travel-advice"

        svc = rec.get("emergency_services") or {}
        for service, phones in svc.items():
            if service == "single_label":
                continue
            if not phones:
                continue
            notes_extra = ""
            if service == "single" and svc.get("single_label"):
                notes_extra = f"Covers: {svc['single_label']}."
            new = make_emergency_record(service, phones, country["country"], source_url, today, notes_extra)
            if not new["voice_numbers"]:
                continue
            matched = find_match(country, new["voice_numbers"], new["name"])
            if matched:
                srcs = set(matched.get("sources") or [])
                if source_url not in srcs:
                    srcs.add(source_url)
                    matched["sources"] = sorted(srcs)
                    enriched += 1
                if matched.get("verification_status") in (None, "legacy_unverified", "cross_referenced"):
                    matched["verification_status"] = "verified_authority"
                    matched["last_verified"] = today
                if not matched.get("hours"):
                    matched["hours"] = "24/7"
                if not matched.get("target"):
                    matched["target"] = new["target"]
            else:
                country["hotlines"].append(new)
                added += 1

        for post in rec.get("british_embassy") or []:
            new = make_embassy_record(post, country["country"], source_url, today)
            if not new["voice_numbers"] and not new["email"]:
                continue
            matched = find_match(country, new["voice_numbers"], new["name"])
            if matched:
                srcs = set(matched.get("sources") or [])
                if source_url not in srcs:
                    srcs.add(source_url)
                    matched["sources"] = sorted(srcs)
                    enriched += 1
                if matched.get("verification_status") in (None, "legacy_unverified", "cross_referenced"):
                    matched["verification_status"] = "verified_authority"
                    matched["last_verified"] = today
            else:
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
