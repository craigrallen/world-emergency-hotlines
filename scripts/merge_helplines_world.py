#!/usr/bin/env python3
"""
Merge the dataset extracted from helplines.world into hotlines.json.

Source: bundled JS object literal in
  https://helplines.world/_next/static/chunks/app/page-*.js
Extracted to: sources/helplines_world.json   {alpha2: [hotline, ...], ...}

Each helplines.world entry shape:
    {name, description, phone, website, category, hours, languages?}

For each entry, we:
  - Normalise the phone (unicode spaces, NBSP, U+2011 hyphens, split on / comma / " or ")
  - Map their category to our schema's category
  - Fill voice_numbers, sms_numbers (if "text" pattern), website, hours, languages, notes
  - Look up by normalised name; if not already in hotlines.json for that country,
    append it with verification_status="cross_referenced" and
    sources=["helplines.world", ...]

Never overwrites a curated (verified_knowledge/verified_web) record.
"""
from __future__ import annotations

import json
import pathlib
import re
import unicodedata

ROOT = pathlib.Path(__file__).parent.parent
OUT = ROOT / "hotlines.json"
SRC = ROOT / "sources" / "helplines_world.json"

# Their category -> our category
CAT_MAP = {
    "Emergency": "emergency",
    "Public Safety": "emergency",
    "Safety": "emergency",
    "Mental Health": "mental_health",
    "Health": "general_support",
    "Healthcare": "general_support",
    "Medical": "general_support",
    "Legal Aid": "legal_aid",
    "Legal/Financial Help": "legal_aid",
    "Domestic Abuse": "domestic_violence",
    "Child Protection": "child_protection",
    "Child Support": "child_protection",
    "Child Health": "child_protection",
    "Addiction": "substance_use",
    "Elderly Support": "elder_abuse",
    "Disability Support": "disability",
    "LGBTQ+ Support": "lgbtqia",
    "Youth Support": "youth",
    "Family Support": "general_support",
    "Migration": "refugee_migrant",
    "Animal Welfare": "animal_welfare",
    "Human Rights": "human_rights",
    "Financial Aid": "financial_aid",
    "Financial Help": "financial_aid",
    "Human Trafficking": "human_trafficking",
    "Sexual Assault": "sexual_violence",
    "Social Support": "general_support",
    "Eating Disorders": "eating_disorders",
    "Pregnancy": "perinatal",
    "Bereavement": "bereavement",
    "Housing": "housing",
    "Utility": "general_support",
    "Education": "general_support",
}

# Upgrade Mental Health -> suicide_crisis when description signals it
SUICIDE_SIGNALS = [
    "suicid", "crisis", "at risk of", "ending their life", "ending your life",
    "samarit", "prevent suicide", "lifeline",
]


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def normalise_phone_text(s: str) -> str:
    if not s:
        return ""
    # Replace U+2011 (non-breaking hyphen) with normal hyphen, U+202F (narrow NBSP)
    # with space, plus other exotic whitespace.
    s = s.replace("\u2011", "-").replace("\u2010", "-")
    s = re.sub(r"[\u00A0\u202F\u2009\u2007]", " ", s)
    return s.strip()


PHONE_NUMBER_RE = re.compile(r"[+]?\d[\d\s\-\(\)\.]{2,}[\d\)]")


def extract_numbers(raw: str):
    """Return (voice_numbers, sms_numbers, notes).

    Splits on ", " / " or " / "/" / ";" and handles parentheticals. Rough SMS
    detection: if value mentions "text" plus a 5-6 digit shortcode, tag SMS.
    """
    if not raw:
        return [], [], ""
    raw = normalise_phone_text(raw)
    # Split on common separators while preserving segments
    parts = re.split(r"\s*(?:,| or |;|/)\s*", raw)
    voice, sms, notes = [], [], []
    for part in parts:
        if not part:
            continue
        # SMS-shaped?
        m = re.search(r"text\s+\S+\s*(?:to\s*)?([0-9]{3,6})", part, re.I)
        if m:
            sms.append(m.group(1))
            continue
        # Find phone-looking token
        nums = PHONE_NUMBER_RE.findall(part)
        if nums:
            # Use the first number from the part
            num = nums[0].strip()
            # Strip trailing/leading punctuation
            num = re.sub(r"^[\s\-\(\)\.]+|[\s\-\(\)\.]+$", "", num)
            # Compact multiple spaces
            num = re.sub(r"\s+", " ", num)
            if num:
                voice.append(num)
                # Keep any parenthetical tags as a note
                labels = re.findall(r"\(([^)]+)\)", part)
                if labels:
                    notes.append(", ".join(labels))
        else:
            notes.append(part)
    # Dedupe preserving order
    def dedup(xs):
        seen = set(); out = []
        for x in xs:
            if x not in seen:
                seen.add(x); out.append(x)
        return out
    return dedup(voice), dedup(sms), " | ".join(notes)


def to_v2_hotline(code: str, country_name: str, h: dict) -> dict:
    name = (h.get("name") or "").strip()
    cat = CAT_MAP.get(h.get("category") or "", "general_support")
    desc = (h.get("description") or "").lower()
    if cat == "mental_health" and any(s in desc for s in SUICIDE_SIGNALS):
        cat = "suicide_crisis"

    voice, sms, num_notes = extract_numbers(h.get("phone") or "")

    website = (h.get("website") or "").strip()
    if website and not website.startswith("http"):
        website = "https://" + website

    langs = h.get("languages") or []
    if isinstance(langs, str):
        langs = [langs]

    notes = h.get("description") or ""
    if num_notes:
        notes = (notes + "\n\n(phone notes: " + num_notes + ")").strip()

    return {
        "name": name,
        "organization": name,
        "category": cat,
        "voice_numbers": voice,
        "sms_numbers": sms,
        "text_numbers": [],
        "short_codes": [],
        "chat_url": None,
        "email": None,
        "website": website or None,
        "hours": h.get("hours") or None,
        "languages": langs,
        "cost": "unknown",
        "target": None,
        "geography": country_name,
        "notes": notes,
        "verification_status": "cross_referenced",
        "last_verified": "2026-04-22",
        "sources": ["https://helplines.world/"],
        "_legacy": {"name": name, "phone": h.get("phone"), "source": "helplines.world"},
    }


def main():
    data = json.loads(OUT.read_text(encoding="utf-8"))
    helplines = json.loads(SRC.read_text(encoding="utf-8"))

    # Expand category reference if the file carries it
    if "categories_reference" in data:
        data["categories_reference"].setdefault("legal_aid", "Legal aid / civil legal advice")
        data["categories_reference"].setdefault("animal_welfare", "Animal welfare / RSPCA-type services")
        data["categories_reference"].setdefault("human_rights", "Human rights reporting / ombudsperson")
        data["categories_reference"].setdefault("financial_aid", "Financial hardship / debt / fraud")
        data["categories_reference"].setdefault("housing", "Housing, homelessness, shelter")

    by_code = {c["alpha-2"]: c for c in data["countries"] if c.get("alpha-2")}
    added_total = 0
    cross_ref_added = 0
    updated_countries = []

    for code, entries in helplines.items():
        country = by_code.get(code)
        if country is None:
            # Shouldn't happen for this dataset's 23 countries but be safe
            continue

        existing_names = {norm_name(h["name"]) for h in country["hotlines"]}
        added_here = 0
        for h in entries:
            v2 = to_v2_hotline(code, country["country"], h)
            key = norm_name(v2["name"])
            if not v2["name"]:
                continue
            if key in existing_names:
                # Check if the existing record lacks a website/description we can add
                existing = next(x for x in country["hotlines"] if norm_name(x.get("name","")) == key)
                if existing.get("verification_status") in ("verified_knowledge", "verified_web"):
                    # Don't touch curated records
                    continue
                # Opportunistically top up legacy record with website/hours/languages/notes
                dirty = False
                if not existing.get("website") and v2.get("website"):
                    existing["website"] = v2["website"]; dirty = True
                if not existing.get("hours") and v2.get("hours"):
                    existing["hours"] = v2["hours"]; dirty = True
                if not existing.get("languages") and v2.get("languages"):
                    existing["languages"] = v2["languages"]; dirty = True
                if not existing.get("notes") and v2.get("notes"):
                    existing["notes"] = v2["notes"]; dirty = True
                if dirty:
                    srcs = set(existing.get("sources") or [])
                    srcs.add("https://helplines.world/")
                    existing["sources"] = sorted(srcs)
                    cross_ref_added += 1
                continue
            country["hotlines"].append(v2)
            existing_names.add(key)
            added_here += 1
            added_total += 1
        if added_here:
            updated_countries.append((country["country"], added_here))

    data["last_updated"] = "2026-04-22"
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Added {added_total} new hotlines from helplines.world")
    print(f"Enriched {cross_ref_added} existing legacy records with extra metadata")
    print()
    print("Per-country additions:")
    for name, n in sorted(updated_countries, key=lambda x: -x[1]):
        print(f"  {name}: +{n}")


if __name__ == "__main__":
    main()
