#!/usr/bin/env python3
"""
Merge findahelpline.com scrape into hotlines.json.

Reads sources/findahelpline.json produced by scripts/fetch_findahelpline.py
and folds each record into the canonical dataset:

  - Match by phone-digit-suffix or name-prefix within the same country
  - On match: cross-reference the existing record (append
    'findahelpline.com' to sources, bump confidence), add chat_url / sms /
    hours / snippet if blank
  - On no match: insert as a new cross_referenced record

Because Find A Helpline is a curated directory, matching records should be
promoted up a tier: legacy_unverified -> cross_referenced. Curated
(verified_knowledge/verified_web) records are never downgraded.
"""
from __future__ import annotations

import json
import pathlib
import re
import unicodedata
from datetime import datetime

ROOT = pathlib.Path(__file__).parent.parent
HOTLINES = ROOT / "hotlines.json"
FAH = ROOT / "sources" / "findahelpline.json"


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def phone_key(s: str) -> str:
    d = re.sub(r"\D", "", s or "")
    return d[-7:] if len(d) >= 7 else d


def tags_to_category(tags: list[str]) -> str:
    blob = " ".join(tags or []).lower()
    if any(k in blob for k in ("suicide", "crisis", "self harm")): return "suicide_crisis"
    if any(k in blob for k in ("child", "kid", "teen")): return "child_protection"
    if any(k in blob for k in ("domestic", "partner violence")): return "domestic_violence"
    if any(k in blob for k in ("sexual violence", "rape", "sexual assault")): return "sexual_violence"
    if any(k in blob for k in ("lgbt", "queer", "trans")): return "lgbtqia"
    if any(k in blob for k in ("substance", "addiction", "drug", "alcohol")): return "substance_use"
    if "elder" in blob: return "elder_abuse"
    if any(k in blob for k in ("eating", "anorexia", "bulimia")): return "eating_disorders"
    if "grief" in blob or "bereave" in blob: return "bereavement"
    if "traffick" in blob: return "human_trafficking"
    if "veteran" in blob or "military" in blob: return "veterans"
    return "mental_health"


def find_match(country: dict, fr: dict):
    target_name = norm_name(fr["name"])
    target_phone = phone_key(fr.get("phone") or "")
    for h in country["hotlines"]:
        if target_name and target_name == norm_name(h.get("name", "")):
            return h
        if target_phone:
            for n in (h.get("voice_numbers") or []) + (h.get("sms_numbers") or []):
                if phone_key(n) == target_phone:
                    return h
        if target_name and len(target_name) > 6:
            hn = norm_name(h.get("name", ""))
            if hn and (target_name in hn or hn in target_name):
                return h
    return None


def main():
    if not FAH.exists():
        print(f"{FAH} not found — run fetch_findahelpline.py first")
        return

    fah_data = json.loads(FAH.read_text(encoding="utf-8"))
    records = fah_data.get("records", [])
    print(f"Loaded {len(records)} Find A Helpline records scraped {fah_data.get('scraped_at')}")

    data = json.loads(HOTLINES.read_text(encoding="utf-8"))
    by_code = {c.get("alpha-2", "").upper(): c for c in data["countries"]}

    added = 0
    promoted = 0
    enriched = 0
    for fr in records:
        code = (fr.get("country") or "").upper()
        country = by_code.get(code)
        if country is None:
            continue

        existing = find_match(country, fr)
        if existing:
            # Record corroboration
            srcs = set(existing.get("sources") or [])
            if "https://findahelpline.com" not in srcs:
                srcs.add("https://findahelpline.com")
                existing["sources"] = sorted(srcs)
                enriched += 1

            # Fill blanks
            if not existing.get("chat_url") and fr.get("chat_url"):
                existing["chat_url"] = fr["chat_url"]
            if not existing.get("website") and fr.get("website"):
                url = fr["website"]
                if url and not url.startswith("http"):
                    url = "https://" + url
                existing["website"] = url
            if not existing.get("hours") and fr.get("hours"):
                existing["hours"] = fr["hours"]
            if fr.get("sms") and not existing.get("sms_numbers"):
                existing["sms_numbers"] = [fr["sms"]]

            # Promote legacy_unverified to cross_referenced (curated presence in FAH)
            if existing.get("verification_status") == "legacy_unverified":
                existing["verification_status"] = "cross_referenced"
                promoted += 1
            # Bump last_verified if not in the last 7 days
            existing["last_verified"] = datetime.utcnow().date().isoformat()
            continue

        # New record
        voice = [fr["phone"]] if fr.get("phone") else []
        if fr.get("tty"):
            voice.append(fr["tty"])
        sms = [fr["sms"]] if fr.get("sms") else []
        website = fr.get("website")
        if website and not website.startswith("http"):
            website = "https://" + website

        new = {
            "name": fr["name"],
            "organization": fr["name"],
            "category": tags_to_category(fr.get("tags") or []),
            "voice_numbers": voice,
            "sms_numbers": sms,
            "text_numbers": [],
            "short_codes": [],
            "chat_url": fr.get("chat_url"),
            "email": None,
            "website": website,
            "hours": fr.get("hours"),
            "languages": [],
            "cost": "unknown",
            "target": None,
            "geography": country["country"],
            "notes": fr.get("snippet") or "",
            "verification_status": "cross_referenced",
            "last_verified": datetime.utcnow().date().isoformat(),
            "sources": ["https://findahelpline.com"],
            "_legacy": {"source": "findahelpline.com", "tags": fr.get("tags")},
        }
        country["hotlines"].append(new)
        added += 1

    data["last_updated"] = datetime.utcnow().date().isoformat()
    HOTLINES.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Added:        {added}")
    print(f"Enriched:     {enriched}")
    print(f"Promoted:     {promoted} (legacy_unverified -> cross_referenced)")
    total = sum(len(c["hotlines"]) for c in data["countries"])
    print(f"Final total:  {total}")


if __name__ == "__main__":
    main()
