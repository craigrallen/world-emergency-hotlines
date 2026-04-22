#!/usr/bin/env python3
"""
Merge `information.json` (rich names + numbers) and
`sources/vibbrancy_hotlines.json` (free-text crisis resources + emergency numbers)
into `hotlines.json` (the enriched v2.0 dataset).

Rules:
- Never overwrite an enriched record (verified_web / verified_authority /
  verified_knowledge).
- For countries already in hotlines.json, add any hotlines from the legacy
  sources that are not yet present (match by fuzzy name + number set),
  tagged verification_status="legacy_unverified".
- For countries not yet in hotlines.json, migrate the legacy data into the
  v2.0 schema with verification_status="legacy_unverified".
- Pull general_emergency from the Vibbrancy EMERGENCY_NUMBERS field when
  missing from hotlines.json.
"""
from __future__ import annotations

import json
import pathlib
import re
import unicodedata
from datetime import datetime
from typing import Any

ROOT = pathlib.Path(__file__).parent.parent
OUT_PATH = ROOT / "hotlines.json"
INFO_PATH = ROOT / "information.json"
VIB_PATH = ROOT / "sources" / "vibbrancy_hotlines.json"
REPORT_DIR = ROOT / "REPORTS"


# ---------- helpers ----------

def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def norm_number(s: str) -> str:
    return re.sub(r"[^0-9+#*]", "", s or "")


def number_set(numbers: list[str]) -> frozenset[str]:
    return frozenset(n for n in (norm_number(x) for x in numbers or []) if n)


CATEGORY_KEYWORDS = [
    ("child_protection", [r"\bchildline\b", r"kids? (help|line)", r"\bchild(ren)?['’]?s?\b"]),
    ("suicide_crisis", [r"\bsuicid", r"\blifeline\b", r"\bcrisis\b", r"samarit", r"prevention of (young )?suicid", r"\bhopelin", r"\bcvv\b", r"\b988\b"]),
    ("emergency", [r"^emergency$", r"\bpolice\b", r"\bfire\b", r"ambulan", r"\b(112|999|911|000|110|119)\b"]),
    ("domestic_violence", [r"domest", r"violence against women", r"women'?s? (aid|shelter|helpline|refuge)", r"gender.*(based )?violence", r"gbv\b"]),
    ("sexual_violence", [r"\brape\b", r"sexual assault", r"sexual abuse", r"rainn"]),
    ("lgbtqia", [r"\blgbt", r"queer\b", r"\btrans\b", r"gay\b", r"lesbian", r"rainbow", r"trevor"]),
    ("substance_use", [r"alcohol", r"\bdrug", r"narcot", r"addict", r"\bfrank\b"]),
    ("gambling", [r"gambl"]),
    ("eating_disorders", [r"eating disord", r"anorex", r"bulimi", r"\bbeat\b"]),
    ("bereavement", [r"bereave", r"\bgrief\b", r"\bcruse\b", r"\bsands\b"]),
    ("self_harm", [r"self.?harm", r"self.?injur"]),
    ("veterans", [r"veteran", r"armed forces", r"combat stress", r"open arms"]),
    ("human_trafficking", [r"traffick", r"modern.slavery"]),
    ("missing_persons", [r"missing", r"runaway"]),
    ("elder_abuse", [r"elder", r"\bage(ing)?\b", r"silver line", r"hourglass"]),
    ("stalking", [r"stalk"]),
    ("mental_health", [r"mental", r"\bmind\b", r"anxiety", r"depress", r"\bsane\b", r"psych", r"wellbeing"]),
    ("youth", [r"\byouth\b", r"\bteen\b", r"young people"]),
    ("male_victims", [r"\bmen'?s\b", r"male\s+(victim|advice|helpline)"]),
]


def guess_category(name: str) -> str:
    low = (name or "").lower()
    for cat, pats in CATEGORY_KEYWORDS:
        for p in pats:
            if re.search(p, low):
                return cat
    return "general_support"


# ---------- parse Vibbrancy CRISIS_RESOURCES free-text ----------

NUMBER_KEY_RE = re.compile(
    r"^(hotline|helpline|phone|mobile|sms|text(\s*line)?|toll[- ]free(\s*number)?|"
    r"emergency hotline|government hotline|youth (help|hot)line|crisis line|"
    r"hour hotline|free|counselling|toll[- ]free provincial helpline|prague hotline|"
    r"suicide hotline squad on duty|international|russian service|whatsapp|bbm pins|skype|"
    r"textline|face to face|mobile phone|hotline abroad|amman|fredericton area)\s*:?\s*(.*)$",
    re.I,
)
URL_KEY_RE = re.compile(r"^(website|web|facebook|twitter|link)\s*:\s*(.*)$", re.I)
EMAIL_KEY_RE = re.compile(r"^(e[- ]?mail|hotline e[- ]?mail|email helpline|e-mail helpline)\s*:\s*(.*)$", re.I)


def parse_crisis_resources(text: str) -> list[dict]:
    """Parse the free-text 'CRISIS_RESOURCES' into a list of hotline dicts.

    Each hotline has: name, voice_numbers, sms_numbers, email, website, notes.
    """
    if not text:
        return []

    # Normalise line endings and strip BOM etc.
    text = text.replace("\r\n", "\n").strip()
    # Split into blocks: blank line(s) separate entries
    blocks = re.split(r"\n\s*\n", text)
    hotlines = []
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        lines = [l.rstrip() for l in block.split("\n") if l.strip()]
        if not lines:
            continue
        name = lines[0].strip().strip(".,;:")
        voice: list[str] = []
        sms: list[str] = []
        chat_url: str | None = None
        email: str | None = None
        website: str | None = None
        notes_lines: list[str] = []

        for ln in lines[1:]:
            ln = ln.strip()
            m = NUMBER_KEY_RE.match(ln)
            if m:
                key = m.group(1).lower()
                val = m.group(0).split(":", 1)[1].strip() if ":" in m.group(0) else ""
                # Sometimes value has trailing parentheticals ("(UK - local rate)")
                # Extract numbers + preserve everything else as a side-note
                # Also handle multiple numbers split by "/"
                for part in re.split(r"[/,]", val):
                    part = part.strip()
                    if not part:
                        continue
                    # Extract first chunk that looks like a number
                    num = re.search(r"([+]?[0-9][0-9 ()\-]{2,}[0-9A-Z]*)", part)
                    if not num:
                        continue
                    number_str = num.group(1).strip()
                    if re.search(r"\btext\b|\bsms\b|\btextline\b", key):
                        sms.append(number_str)
                    else:
                        voice.append(number_str)
                # Preserve parenthetical notes
                paren = re.findall(r"\(([^)]+)\)", val)
                if paren:
                    notes_lines.append(f"{key}: {' | '.join(paren)}")
                continue
            m = EMAIL_KEY_RE.match(ln)
            if m:
                email = m.group(2).strip() or email
                continue
            m = URL_KEY_RE.match(ln)
            if m:
                url = m.group(2).strip()
                if "facebook" in (m.group(1) or "").lower() or "twitter" in (m.group(1) or "").lower():
                    notes_lines.append(f"{m.group(1)}: {url}")
                else:
                    website = url or website
                continue
            # Generic "Key: value"
            if ":" in ln:
                notes_lines.append(ln)
            else:
                # Append as additional name line / note
                notes_lines.append(ln)

        if not name and not voice and not sms:
            continue
        if not voice and not sms:
            # Entry had a name but no numbers — still worth recording? Skip.
            continue
        hotlines.append({
            "name": name,
            "organization": name,
            "category": guess_category(name),
            "voice_numbers": _dedup(voice),
            "sms_numbers": _dedup(sms),
            "text_numbers": [],
            "short_codes": [],
            "chat_url": None,
            "email": email,
            "website": website,
            "hours": None,
            "languages": [],
            "cost": "unknown",
            "target": None,
            "geography": None,
            "notes": " | ".join(notes_lines),
            "verification_status": "legacy_unverified",
            "last_verified": None,
            "sources": ["atlacord/Naga Hotlines.json @ 61bec14"],
            "_legacy": {"name": name, "voice": voice, "sms": sms},
        })
    return hotlines


def _dedup(seq):
    seen = set(); out = []
    for x in seq:
        if x and x not in seen:
            seen.add(x); out.append(x)
    return out


# ---------- legacy information.json hotline → v2.0 ----------

def info_hotline_to_v2(h: dict) -> dict:
    name = h.get("name", "")
    return {
        "name": name,
        "organization": name,
        "category": guess_category(name),
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
        "geography": None,
        "notes": "",
        "verification_status": "legacy_unverified",
        "last_verified": None,
        "sources": ["information.json"],
        "_legacy": {"name": name, "numbers": list(h.get("numbers", []))},
    }


REGION_MAP = {
    # minimal region assignment — can be expanded later
}


def new_country_record(alpha2: str, name: str, alpha3: str | None = None,
                       emergency: list[str] | None = None) -> dict:
    return {
        "country": name,
        "alpha-2": alpha2,
        "alpha-3": alpha3,
        "region": None,
        "subregion": None,
        "general_emergency": emergency or [],
        "notes": "",
        "hotlines": [],
    }


# ---------- merge ----------

def main():
    info = json.loads(INFO_PATH.read_text(encoding="utf-8"))
    vib = json.loads(VIB_PATH.read_text(encoding="utf-8"))
    out_data = json.loads(OUT_PATH.read_text(encoding="utf-8"))
    countries_by_code: dict[str, dict] = {
        c["alpha-2"]: c for c in out_data["countries"] if c.get("alpha-2")
    }
    countries_by_name = {c["country"]: c for c in out_data["countries"]}

    report: list[str] = [
        f"# Merge report — {datetime.utcnow().isoformat(timespec='seconds')}Z",
        "",
        f"Starting enriched countries: {len(out_data['countries'])}",
        "",
    ]

    # Pass 1: migrate information.json entries
    for entry in info:
        a2 = entry.get("alpha-2")
        if not a2:
            continue
        country_rec = countries_by_code.get(a2) or countries_by_name.get(entry["country"])
        if country_rec is None:
            country_rec = new_country_record(a2, entry["country"], entry.get("alpha-3"))
            out_data["countries"].append(country_rec)
            countries_by_code[a2] = country_rec
            countries_by_name[entry["country"]] = country_rec
            report.append(f"- Migrated new country from info.json: {entry['country']} ({a2})")

        existing = {(norm_name(h["name"]), number_set(h.get("voice_numbers", []))) for h in country_rec["hotlines"]}
        added = 0
        for h in entry.get("hotlines", []):
            key = (norm_name(h["name"]), number_set(h.get("numbers", [])))
            if key in existing:
                continue
            country_rec["hotlines"].append(info_hotline_to_v2(h))
            existing.add(key)
            added += 1
        if added:
            report.append(f"  - {country_rec['country']}: +{added} from info.json")

    # Pass 2: migrate Vibbrancy entries
    for entry in vib:
        a2 = entry.get("COUNTRY_CODE")
        if not a2:
            continue
        name = entry.get("COMMON_NAME") or a2
        emergency = [n.strip() for n in (entry.get("EMERGENCY_NUMBERS") or "").split() if n.strip()]
        crisis_resources = entry.get("CRISIS_RESOURCES") or ""

        country_rec = countries_by_code.get(a2) or countries_by_name.get(name)
        if country_rec is None:
            country_rec = new_country_record(a2, name, None, emergency)
            out_data["countries"].append(country_rec)
            countries_by_code[a2] = country_rec
            countries_by_name[name] = country_rec
            report.append(f"- Migrated new country from Vibbrancy: {name} ({a2})")
        else:
            # Fill general_emergency if empty
            if not country_rec.get("general_emergency") and emergency:
                country_rec["general_emergency"] = emergency

        # Add a dedicated emergency hotline record if none exists and we have numbers
        if emergency and not any(h.get("category") == "emergency" for h in country_rec["hotlines"]):
            country_rec["hotlines"].append({
                "name": "Emergency",
                "organization": "Local emergency services",
                "category": "emergency",
                "voice_numbers": emergency,
                "sms_numbers": [], "text_numbers": [], "short_codes": [],
                "chat_url": None, "email": None, "website": None,
                "hours": "24/7", "languages": [], "cost": "free",
                "target": "anyone in a life-threatening emergency",
                "geography": name, "notes": "",
                "verification_status": "legacy_unverified",
                "last_verified": None,
                "sources": ["atlacord/Naga Hotlines.json @ 61bec14"],
            })

        # Parse CRISIS_RESOURCES → hotlines
        parsed = parse_crisis_resources(crisis_resources)
        existing = {(norm_name(h["name"]), number_set(h.get("voice_numbers", []) + h.get("sms_numbers", [])))
                    for h in country_rec["hotlines"]}
        added = 0
        for h in parsed:
            key = (norm_name(h["name"]), number_set(h["voice_numbers"] + h["sms_numbers"]))
            if key in existing:
                continue
            h["geography"] = name
            country_rec["hotlines"].append(h)
            existing.add(key)
            added += 1
        if added:
            report.append(f"  - {country_rec['country']}: +{added} from Vibbrancy")

    # Sort countries by name
    out_data["countries"].sort(key=lambda c: c["country"])
    out_data["last_updated"] = datetime.utcnow().date().isoformat()

    OUT_PATH.write_text(json.dumps(out_data, ensure_ascii=False, indent=2), encoding="utf-8")

    REPORT_DIR.mkdir(exist_ok=True)
    report.append("")
    total_hotlines = sum(len(c["hotlines"]) for c in out_data["countries"])
    report.append(f"Final countries: {len(out_data['countries'])}")
    report.append(f"Total hotline records: {total_hotlines}")
    (REPORT_DIR / f"merge_{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}.md").write_text(
        "\n".join(report), encoding="utf-8"
    )
    print(f"Wrote {OUT_PATH}")
    print(f"Countries: {len(out_data['countries'])}  |  Hotlines: {total_hotlines}")


if __name__ == "__main__":
    main()
