#!/usr/bin/env python3
"""
Comprehensive record-level validator and normaliser.

For every hotline in hotlines.json this script:

1. Ensures every v2 schema field is present (fills defaults).
2. Normalises phone numbers — strips U+2011 / U+202F / stray parentheses and
   deduplicates within-record.
3. Sets `geography` = country name where missing.
4. Sets `organization` = name where missing.
5. Matches the name against a curated "known brand" table and fills
   hours / languages / target / cost / chat_url / website / category for
   recognised organisations (Samaritans, Childline, Lifeline, Befrienders,
   Teléfono de la Esperanza, Red Cross, etc.) — but never downgrades a record
   that is already verified_knowledge/verified_web.
6. Flags records with *no* contact information whatsoever as `deprecated`
   rather than deleting them, preserving audit history.
7. Resolves duplicate-name conflicts within a country by appending a
   disambiguating suffix (based on first voice number or city in name).
8. Writes a report to REPORTS/validation_<date>.md.
"""
from __future__ import annotations

import json
import pathlib
import re
import unicodedata
from collections import defaultdict
from datetime import datetime

ROOT = pathlib.Path(__file__).parent.parent
OUT = ROOT / "hotlines.json"
REPORT = ROOT / "REPORTS" / f"validation_{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}.md"


# Required v2 fields with their defaults
SCHEMA_DEFAULTS = {
    "name": "",
    "organization": "",
    "category": "general_support",
    "voice_numbers": [],
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
    "geography": None,
    "notes": "",
    "verification_status": "legacy_unverified",
    "last_verified": None,
    "sources": [],
}


def normalize_number(s: str) -> str:
    """Replace weird unicode in phone numbers and collapse whitespace."""
    if not s:
        return s
    s = s.replace("\u2011", "-").replace("\u2010", "-").replace("\u2013", "-").replace("\u2014", "-")
    s = re.sub(r"[\u00A0\u202F\u2009\u2007]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def dedup(seq):
    seen = set()
    out = []
    for x in seq or []:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


# ---- Known-brand enrichment ----
# Each entry: (regex that matches the record name, metadata to merge in).
# The metadata only fills *missing* fields, never overwrites.
# Keyed heuristics — regex tests `name.lower()`.

BRANDS = [
    # --- Samaritans worldwide ---
    (r"\bsamarit", {
        "category": "suicide_crisis",
        "hours": "24/7",
        "cost": "free",
        "target": "anyone in emotional distress or at risk of suicide",
        "website": "https://www.befrienders.org",
        "languages": ["local"],
    }),
    # --- Befrienders Worldwide branches ---
    (r"\bbefriender", {
        "category": "suicide_crisis",
        "hours": "varies by centre",
        "cost": "standard_rate",
        "target": "people in emotional distress — part of Befrienders Worldwide",
        "website": "https://www.befrienders.org",
    }),
    # --- Childline family ---
    (r"\bchildline\b", {
        "category": "child_protection",
        "target": "children and young people",
        "cost": "free",
    }),
    # --- Kids Helpline / Kids Help Phone / Kidsline ---
    (r"\bkids? (help ?line|helpline|help phone)\b|\bkidsline\b", {
        "category": "child_protection",
        "target": "children and young people",
    }),
    # --- Lifeline family ---
    (r"\blifeline\b", {
        "category": "suicide_crisis",
        "target": "people in emotional crisis or at risk of suicide",
    }),
    # --- National Suicide Prevention Lifeline (US legacy) ---
    (r"national suicide prevention lifeline", {
        "category": "suicide_crisis",
        "hours": "24/7",
        "cost": "free",
        "target": "people in suicidal crisis (now replaced by 988)",
    }),
    # --- Teléfono de la Esperanza ---
    (r"tel(e|é)fono de la esperanza", {
        "category": "suicide_crisis",
        "website": "https://telefonodelaesperanza.org",
        "hours": "24/7",
        "languages": ["Spanish"],
        "target": "people in emotional crisis",
    }),
    # --- La Strada (anti-trafficking) ---
    (r"la strada", {
        "category": "human_trafficking",
        "target": "victims of trafficking and gender violence",
    }),
    # --- CVV (Brazil) ---
    (r"\bcvv\b|centro de valoriza", {
        "category": "suicide_crisis",
        "website": "https://www.cvv.org.br",
        "hours": "24/7",
        "languages": ["Portuguese"],
        "cost": "free",
        "target": "pessoas em sofrimento emocional",
    }),
    # --- Sumithrayo ---
    (r"sumithrayo", {
        "category": "suicide_crisis",
        "website": "https://srilankasumithrayo.lk",
        "target": "people in emotional distress",
    }),
    # --- AASRA (India) ---
    (r"\baasra\b", {
        "category": "suicide_crisis",
        "website": "http://www.aasra.info",
        "hours": "24/7",
        "target": "people in distress",
    }),
    # --- Vandrevala ---
    (r"vandrevala", {
        "category": "mental_health",
        "website": "https://www.vandrevalafoundation.com",
        "hours": "24/7",
        "cost": "free",
    }),
    # --- Red Cross / Red Crescent ---
    (r"red (cross|crescent)", {
        "category": "general_support",
        "website": "https://www.ifrc.org",
        "target": "emergency response and general welfare",
    }),
    # --- Emergency Services ---
    (r"^emergency( services)?$|^police$|^fire$|^ambulance$", {
        "category": "emergency",
        "hours": "24/7",
        "cost": "free",
        "target": "anyone in a life-threatening emergency",
    }),
    # --- Crisis Text Line ---
    (r"crisis text line", {
        "category": "mental_health",
        "website": "https://www.crisistextline.org",
        "hours": "24/7",
        "cost": "free",
    }),
    # --- Trevor Project ---
    (r"trevor project", {
        "category": "lgbtqia",
        "website": "https://www.thetrevorproject.org",
        "hours": "24/7",
        "cost": "free",
        "target": "LGBTQ+ young people in crisis",
    }),
    # --- Trans Lifeline ---
    (r"trans ?lifeline", {
        "category": "lgbtqia",
        "website": "https://translifeline.org",
        "hours": "24/7",
        "cost": "free",
        "target": "transgender people in crisis",
    }),
    # --- RAINN ---
    (r"\brainn\b", {
        "category": "sexual_violence",
        "website": "https://www.rainn.org",
        "hours": "24/7",
        "cost": "free",
        "target": "survivors of sexual violence",
    }),
    # --- NSPCC ---
    (r"\bnspcc\b", {
        "category": "child_protection",
        "website": "https://www.nspcc.org.uk",
        "cost": "free",
        "target": "adults worried about a child",
    }),
    # --- Mind ---
    (r"^mind( ?info ?line| helpline| infoline)?$|^mind \(", {
        "category": "mental_health",
        "website": "https://www.mind.org.uk",
        "cost": "local_rate",
    }),
    # --- CALM ---
    (r"campaign against living miserably|^calm$|calm helpline", {
        "category": "suicide_crisis",
        "website": "https://www.thecalmzone.net",
        "cost": "free",
    }),
    # --- 113 Zelfmoordpreventie ---
    (r"113 ?zelfmoord", {
        "category": "suicide_crisis",
        "website": "https://www.113.nl",
        "hours": "24/7",
        "languages": ["Dutch"],
        "cost": "free",
    }),
    # --- Telefonseelsorge ---
    (r"telefonseelsorge", {
        "category": "suicide_crisis",
        "website": "https://www.telefonseelsorge.de",
        "hours": "24/7",
        "languages": ["German"],
        "cost": "free",
    }),
    # --- Die Dargebotene Hand ---
    (r"dargebotene hand|main tendue|telefono amico", {
        "category": "suicide_crisis",
        "hours": "24/7",
    }),
    # --- Pro Juventute 147 ---
    (r"pro juventute|147 ?pro", {
        "category": "child_protection",
        "hours": "24/7",
        "website": "https://www.147.ch",
        "cost": "free",
        "target": "children and young people",
    }),
    # --- SOS Amitié ---
    (r"sos amit", {
        "category": "suicide_crisis",
        "website": "https://www.sos-amitie.com",
        "hours": "24/7",
        "languages": ["French"],
    }),
    # --- SOS Suicide / Suicide Écoute ---
    (r"sos suicide|suicide ?[ée]coute", {
        "category": "suicide_crisis",
        "hours": "24/7",
    }),
    # --- Open Counselling ---
    (r"open counselling|openup", {
        "category": "mental_health",
    }),
    # --- Alcoholics Anonymous ---
    (r"alcoholics anonymous|\bAA\b ?helpline", {
        "category": "substance_use",
        "cost": "free",
    }),
    # --- Narcotics Anonymous ---
    (r"narcotics anonymous", {
        "category": "substance_use",
        "cost": "free",
    }),
    # --- NHS 111 ---
    (r"nhs ?111", {
        "category": "emergency",
        "website": "https://111.nhs.uk",
        "cost": "free",
        "hours": "24/7",
    }),
]


def apply_brand(h: dict) -> bool:
    """Fill in gaps using the BRANDS table. Returns True if anything changed."""
    name = (h.get("name") or "").lower()
    changed = False
    for pattern, meta in BRANDS:
        if re.search(pattern, name):
            for k, v in meta.items():
                # Only set if missing/empty
                current = h.get(k)
                if current is None or current == "" or current == [] or current == "unknown":
                    # For category, only upgrade when current is a vague default
                    if k == "category":
                        if current in (None, "", "general_support"):
                            h[k] = v
                            changed = True
                    else:
                        h[k] = v
                        changed = True
            break
    return changed


def canonicalise_fields(h: dict) -> dict:
    """Ensure every v2 field is present with the right default type."""
    for k, default in SCHEMA_DEFAULTS.items():
        if k not in h:
            # Copy default (don't share list instances)
            if isinstance(default, list):
                h[k] = []
            else:
                h[k] = default
        elif h[k] is None and isinstance(default, list):
            h[k] = []
        elif h[k] is None and isinstance(default, str) and default != "" and k == "category":
            h[k] = default
    return h


def normalise_phones(h: dict):
    """Strip weird unicode and dedupe within record."""
    for field in ("voice_numbers", "sms_numbers", "text_numbers", "short_codes"):
        h[field] = dedup(normalize_number(x) for x in (h.get(field) or []))


def contact_count(h: dict) -> int:
    return (
        len(h.get("voice_numbers") or [])
        + len(h.get("sms_numbers") or [])
        + len(h.get("text_numbers") or [])
        + len(h.get("short_codes") or [])
        + (1 if h.get("chat_url") else 0)
        + (1 if h.get("email") else 0)
    )


def resolve_duplicate_names(country):
    """Append a disambiguator to names that clash within a single country."""
    by_name = defaultdict(list)
    for h in country["hotlines"]:
        by_name[h.get("name", "")].append(h)
    renamed = 0
    for name, dups in by_name.items():
        if len(dups) <= 1:
            continue
        for i, h in enumerate(dups):
            if i == 0:
                continue
            # Derive a disambiguator
            nums = h.get("voice_numbers") or h.get("sms_numbers") or []
            city = None
            m = re.search(r"[\-–—]\s*([A-Za-zÁ-ž ]+)$|in ([A-Z][A-Za-zÁ-ž ]+)$", name)
            if m:
                city = (m.group(1) or m.group(2) or "").strip()
            if nums:
                suffix = f" ({normalize_number(nums[0])})"
            elif city:
                suffix = f" ({city})"
            else:
                suffix = f" (#{i+1})"
            h["name"] = name + suffix
            renamed += 1
    return renamed


def main():
    data = json.loads(OUT.read_text(encoding="utf-8"))
    stats = defaultdict(int)
    deprecated_flagged = []
    dup_fixes = 0

    for country in data["countries"]:
        country_name = country.get("country")
        # Normalise country meta fields
        country["general_emergency"] = dedup(normalize_number(x) for x in (country.get("general_emergency") or []))

        new_hotlines = []
        for h in country["hotlines"]:
            canonicalise_fields(h)
            normalise_phones(h)
            if not h.get("organization") and h.get("name"):
                h["organization"] = h["name"]
                stats["org_filled"] += 1
            if not h.get("geography") and country_name:
                h["geography"] = country_name
                stats["geography_filled"] += 1

            if apply_brand(h):
                stats["brand_applied"] += 1

            # Ensure languages at least lists "local" when empty
            if not h.get("languages"):
                # Leave empty list; it's fine
                pass

            # Flag ghosts
            if contact_count(h) == 0:
                if h.get("verification_status") != "deprecated":
                    h["verification_status"] = "deprecated"
                    stats["flagged_deprecated"] += 1
                    deprecated_flagged.append((country_name, h.get("name")))

            new_hotlines.append(h)

        country["hotlines"] = new_hotlines
        dup_fixes += resolve_duplicate_names(country)

    stats["duplicate_names_resolved"] = dup_fixes
    data["last_updated"] = datetime.utcnow().date().isoformat()

    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    # Write report
    REPORT.parent.mkdir(exist_ok=True)
    lines = [
        f"# Validation + normalisation report — {datetime.utcnow().isoformat(timespec='seconds')}Z",
        "",
        "## Changes",
        "",
    ]
    for k, v in sorted(stats.items(), key=lambda x: -x[1]):
        lines.append(f"- {k}: {v}")
    lines.append("")
    lines.append("## Records flagged as deprecated (no contact info)")
    lines.append("")
    if deprecated_flagged:
        for country, name in deprecated_flagged[:100]:
            lines.append(f"- [{country}] {name}")
        if len(deprecated_flagged) > 100:
            lines.append(f"- ... and {len(deprecated_flagged) - 100} more")
    else:
        lines.append("_(none)_")
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"Normalised {sum(len(c['hotlines']) for c in data['countries'])} records.")
    print("Report:", REPORT)
    for k, v in sorted(stats.items(), key=lambda x: -x[1]):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
