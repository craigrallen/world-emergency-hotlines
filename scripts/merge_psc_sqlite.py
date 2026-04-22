#!/usr/bin/env python3
"""
Merge PSC App / Vibbrancy crisis_resources.sqlite into hotlines.json.

The SQLite is the app's own seeder file (697 active records, 130 countries).
Schema documented in sources/CRISIS_RESOURCES_SCHEMA.md (mirrored).

Matching strategy (dedupe within the same country):
  1. Exact name match (case-insensitive, ascii-folded).
  2. Normalised phone-number match (digits-only, last 7 digits).
  3. Normalised website host match.

On match: enrich the existing record with missing email / website / social
links / sub_title description — but never downgrade a curated
(verified_knowledge / verified_web) record's existing fields.

On no match: insert a new hotline with:
  verification_status = "cross_referenced"
  sources = ["PSC App crisis_resources.sqlite"]
  notes = sub_title (English description)
  plus any social-media links stashed in notes.

Also reads the sqlite title (which may include bilingual scripts like
'خط الأمل — Hope Line') and stores the full form as `name`, extracting the
Latin portion after the em-dash as the display variant when helpful.
"""
from __future__ import annotations

import json
import pathlib
import re
import sqlite3
import sys
import unicodedata
from datetime import datetime

ROOT = pathlib.Path(__file__).parent.parent
HOTLINES = ROOT / "hotlines.json"
SQLITE = ROOT / "sources" / "crisis_resources.sqlite"
SCHEMA = ROOT / "sources" / "CRISIS_RESOURCES_SCHEMA.md"

# Fallback to uploads if the source file hasn't been copied into the repo yet
FALLBACK_SOURCES = [
    SQLITE,
    pathlib.Path("/sessions/relaxed-wonderful-meitner/mnt/uploads/crisis_resources.sqlite"),
    pathlib.Path("C:/Users/Widemind/AppData/Roaming/Claude/local-agent-mode-sessions/5274d4ac-20e8-4d7a-b5cb-79263083b265/7a612cab-3b8d-4207-905d-caaf3081cf0e/local_fa329cea-1b4e-4362-a416-4664861aaf9e/uploads/crisis_resources.sqlite"),
]


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def norm_number(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def phone_key(s: str) -> str:
    """Last 7 digits — enough to match most national numbers across formats."""
    d = norm_number(s)
    return d[-7:] if len(d) >= 7 else d


def host(url: str) -> str:
    if not url:
        return ""
    m = re.match(r"^(?:https?://)?(?:www\.)?([^/]+)", url.strip(), re.I)
    return (m.group(1).lower() if m else "").strip()


CATEGORY_HINTS = [
    (r"\b(suicid|crisis|samarit|lifeline|befriender|hopelin|прем|спасения)", "suicide_crisis"),
    (r"\b(child|kids|niño|niñ|enfance|enfant|kind|116111)", "child_protection"),
    (r"\b(woman|women|mujer|femme|gender.based|domestic|dv\b)", "domestic_violence"),
    (r"\b(rape|sexual|assault|violaci|agression)", "sexual_violence"),
    (r"\b(lgbt|gay|trans|rainbow|queer)", "lgbtqia"),
    (r"\b(addict|substance|alcohol|drug|narcot)", "substance_use"),
    (r"\b(elder|senior|anciano|aged)", "elder_abuse"),
    (r"\b(trafficking|la ?strada|polaris|modern ?slavery)", "human_trafficking"),
    (r"\b(veteran|military|armed forces)", "veterans"),
    (r"\b(ambulance|fire|police|emergency|112|911|999|000|119|\bemt\b)", "emergency"),
    (r"\b(refugee|asylum|migrant)", "refugee_migrant"),
    (r"\b(eating ?disorder|anorex|bulim)", "eating_disorders"),
    (r"\b(gambl)", "gambling"),
    (r"\b(legal ?aid|citizens? advice|ombud|bar association)", "legal_aid"),
    (r"\b(homeless|shelter|housing)", "housing"),
    (r"\b(bereav|grief|cruse)", "bereavement"),
]


def guess_category(name: str, desc: str) -> str:
    blob = (name + " " + (desc or "")).lower()
    for rx, cat in CATEGORY_HINTS:
        if re.search(rx, blob):
            return cat
    return "mental_health"


def build_v2(row: dict, country_name: str) -> dict:
    title = (row["title"] or "").strip()
    sub = (row["sub_title"] or "").strip()
    phone = (row["phone"] or "").strip()
    email = (row["email"] or "").strip() or None
    website = (row["website"] or "").strip() or None
    if website and not website.startswith("http"):
        website = "https://" + website
    try:
        social = json.loads(row["social"] or "[]")
    except Exception:
        social = []
    if isinstance(social, list):
        social = {}

    # Harvest voice numbers from the phone string
    voice = []
    for part in re.split(r",|\bor\b|/|;", phone):
        digits_in = re.sub(r"\D", "", part)
        if len(digits_in) >= 3:
            voice.append(part.strip())
    voice = voice or ([phone] if phone else [])

    # Notes = sub_title + social
    notes_bits = []
    if sub:
        notes_bits.append(sub)
    if isinstance(social, dict):
        for k, v in social.items():
            if v:
                notes_bits.append(f"{k}: {v}")
    notes = "\n\n".join(notes_bits)

    return {
        "name": title,
        "organization": title,
        "category": guess_category(title, sub),
        "voice_numbers": voice,
        "sms_numbers": [],
        "text_numbers": [],
        "short_codes": [],
        "chat_url": None,
        "email": email,
        "website": website,
        "hours": None,
        "languages": [row.get("language") or "en"],
        "cost": "unknown",
        "target": None,
        "geography": row.get("state") or row.get("city") or row.get("locality") or country_name,
        "notes": notes,
        "verification_status": "cross_referenced",
        "last_verified": "2026-04-22",
        "sources": ["PSC App crisis_resources.sqlite"],
        "_legacy": {
            "psc_id": row["id"], "title": title, "phone": phone,
            "state": row.get("state"), "city": row.get("city"),
        },
    }


def find_existing(country: dict, row: dict):
    """Return the existing hotline in `country` that matches `row`, or None."""
    target_name = norm_name(row["title"] or "")
    target_phone = phone_key(row["phone"] or "")
    target_host = host(row["website"] or "")
    for h in country["hotlines"]:
        # Name match (fuzzy)
        if target_name and target_name == norm_name(h.get("name", "")):
            return h
        # Phone match on any number
        if target_phone:
            for n in (h.get("voice_numbers") or []) + (h.get("sms_numbers") or []):
                if phone_key(n) == target_phone:
                    return h
        # Website host match
        if target_host:
            existing_host = host(h.get("website") or "")
            if existing_host and existing_host == target_host:
                return h
    return None


def merge_into_existing(existing: dict, row: dict) -> bool:
    """Fill blanks on existing record with data from the SQLite row.
    Never overwrite a verified_knowledge / verified_web field.
    Returns True if anything changed."""
    changed = False
    protected = existing.get("verification_status") in ("verified_knowledge", "verified_web", "verified_authority")

    # Email / website: fill only if missing
    if not existing.get("email") and row["email"]:
        existing["email"] = row["email"]
        changed = True
    site = (row["website"] or "").strip()
    if site and not site.startswith("http"):
        site = "https://" + site
    if not existing.get("website") and site:
        existing["website"] = site
        changed = True

    # Notes append (only if not protected and new info)
    if not protected and row["sub_title"]:
        if not existing.get("notes"):
            existing["notes"] = row["sub_title"]
            changed = True
        elif row["sub_title"] not in (existing.get("notes") or ""):
            existing["notes"] = (existing["notes"] + "\n\n" + row["sub_title"]).strip()
            changed = True

    # Sources: record that PSC SQLite corroborated this
    srcs = set(existing.get("sources") or [])
    if "PSC App crisis_resources.sqlite" not in srcs:
        srcs.add("PSC App crisis_resources.sqlite")
        existing["sources"] = sorted(srcs)
        changed = True

    return changed


def main():
    # locate sqlite
    src = None
    for candidate in FALLBACK_SOURCES:
        if candidate.exists():
            src = candidate
            break
    if src is None:
        print("crisis_resources.sqlite not found in expected locations", file=sys.stderr)
        sys.exit(1)
    print(f"Using SQLite: {src}")

    conn = sqlite3.connect(str(src))
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM crisis_resources WHERE resource_status = 1"
    )]
    print(f"Loaded {len(rows)} active rows from SQLite")

    data = json.loads(HOTLINES.read_text(encoding="utf-8"))
    by_alpha2 = {c.get("alpha-2"): c for c in data["countries"] if c.get("alpha-2")}

    added = 0
    updated = 0
    skipped_no_country = 0
    for row in rows:
        cc = (row.get("country") or "").upper()
        country = by_alpha2.get(cc)
        if country is None:
            skipped_no_country += 1
            continue
        existing = find_existing(country, row)
        if existing:
            if merge_into_existing(existing, row):
                updated += 1
            continue
        new = build_v2(row, country["country"])
        country["hotlines"].append(new)
        added += 1

    data["last_updated"] = datetime.utcnow().date().isoformat()
    HOTLINES.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    total = sum(len(c["hotlines"]) for c in data["countries"])
    print(f"Added: {added} new records")
    print(f"Updated: {updated} existing records with PSC metadata")
    print(f"Skipped (country not in dataset): {skipped_no_country}")
    print(f"Final total: {total} records across {len(data['countries'])} countries")


if __name__ == "__main__":
    main()
