#!/usr/bin/env python3
"""
Cross-source validator for records that have no website and can't be
confirmed by the web trawler.

Strategy: for every source dataset vendored under `sources/`, build a lookup
keyed by (country_alpha2, phone-digit-suffix, normalised-name). Then for each
record in hotlines.json count how many independent sources corroborate it.

Promotion ladder — conservative, respects the schema's source_class contract:

  - Current status `legacy_unverified`, seen in 2+ aggregator directories
      → promote to `cross_referenced`  (Two-source rule)
  - Current status `legacy_unverified`, record is an `emergency` category
    whose phone matches the Wikipedia list of emergency telephone numbers
      → promote to `verified_authority`
  - Curated statuses (`verified_web`, `verified_authority`, `verified_knowledge`)
    are never downgraded. The script only appends to their `sources` array.

Sources considered:

  1. `helplines_world.json`  (helplines.world)
  2. `findahelpline.json`    (Find A Helpline / ThroughLine)
  3. `crisis_resources.sqlite` (PSC App)
  4. `vibbrancy_hotlines.json` (Vibbrancy / atlacord Naga)
  5. `child_helpline_international/child_helpline_posts.json`  (CHI titles)
  6. `child_helpline_international/child_helpline_directory.json`
  7. `web_verified_crisis_directory/crisis_helplines_by_country.json`
  8. `web_verified_crisis_directory/emergency_numbers_by_country.json` (Wikipedia)

Dry-run by default. Pass `--apply` to write.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sqlite3
import unicodedata
from collections import defaultdict
from datetime import datetime

ROOT = pathlib.Path(__file__).parent.parent
DATA = ROOT / "hotlines.json"
SOURCES = ROOT / "sources"
REPORT_DIR = ROOT / "REPORTS"


# ---------- helpers ----------

def digits(s) -> str:
    return re.sub(r"\D", "", str(s or ""))


def phone_key(s, tail: int = 7) -> str:
    d = digits(s)
    return d[-tail:] if len(d) >= tail else d


def norm_name(s) -> str:
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


# Loose country-name → alpha-2 map for sources that use names rather than codes
COUNTRY_BY_NAME = None


def build_country_lookup(data: dict) -> dict[str, str]:
    """Build a normalised-country-name → alpha-2 lookup using our own dataset."""
    lookup: dict[str, str] = {}
    for c in data["countries"]:
        if c.get("alpha-2"):
            lookup[norm_name(c["country"])] = c["alpha-2"].upper()
    return lookup


def name_to_a2(lookup: dict, name) -> str | None:
    if not name:
        return None
    k = norm_name(name)
    return lookup.get(k)


# ---------- source loaders ----------
# Each loader yields (alpha2, phone_key, name_norm, source_tag).
# `phone_key` may be "" when only a name is available; downstream uses name
# fallback then.

def load_helplines_world(lookup):
    p = SOURCES / "helplines_world.json"
    if not p.exists():
        return []
    d = json.loads(p.read_text(encoding="utf-8"))
    out = []
    for code, rows in d.items():
        for r in rows:
            phone = r.get("phone") or ""
            name = r.get("name") or ""
            out.append((code.upper(), phone_key(phone), norm_name(name), "helplines.world"))
    return out


def load_findahelpline(lookup):
    p = SOURCES / "findahelpline.json"
    if not p.exists():
        return []
    d = json.loads(p.read_text(encoding="utf-8"))
    out = []
    for r in d.get("records", []):
        code = (r.get("country") or "").upper()
        phone = r.get("phone") or ""
        name = r.get("name") or ""
        out.append((code, phone_key(phone), norm_name(name), "findahelpline.com"))
    return out


def load_psc_sqlite(lookup):
    p = SOURCES / "crisis_resources.sqlite"
    if not p.exists():
        return []
    out = []
    conn = sqlite3.connect(str(p))
    for row in conn.execute("SELECT country, title, phone FROM crisis_resources WHERE resource_status = 1"):
        cc = (row[0] or "").upper()
        out.append((cc, phone_key(row[2]), norm_name(row[1]), "psc_app"))
    conn.close()
    return out


def load_vibbrancy(lookup):
    p = SOURCES / "vibbrancy_hotlines.json"
    if not p.exists():
        return []
    d = json.loads(p.read_text(encoding="utf-8"))
    out = []
    for r in d:
        code = (r.get("COUNTRY_CODE") or "").upper()
        emerg = r.get("EMERGENCY_NUMBERS") or ""
        for token in emerg.split():
            out.append((code, phone_key(token), "", "vibbrancy"))
        # Parse CRISIS_RESOURCES free text — pull Hotline:/Helpline: entries
        cr = r.get("CRISIS_RESOURCES") or ""
        if cr:
            # crude block split on blank lines
            for block in re.split(r"\n\s*\n", cr):
                lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
                if not lines:
                    continue
                name = lines[0]
                phones = []
                for ln in lines[1:]:
                    m = re.match(r"(?:Hotline|Helpline|Phone|SMS|TEXT|Mobile)\s*:?\s*(.*)", ln, re.I)
                    if m:
                        phones.append(m.group(1))
                if not phones:
                    continue
                for p_str in phones:
                    num = re.search(r"[+]?\d[\d\s\-()\.]{2,}", p_str)
                    if num:
                        out.append((code, phone_key(num.group(0)), norm_name(name), "vibbrancy"))
    return out


def load_chi_posts(lookup):
    """Child Helpline International WordPress posts with titles like
    'Algeria: Je t'écoute 3033'."""
    p = SOURCES / "child_helpline_international" / "child_helpline_posts.json"
    if not p.exists():
        return []
    d = json.loads(p.read_text(encoding="utf-8"))
    out = []
    for post in d.get("posts", []):
        title = post.get("title") or ""
        # "Country: Name phone-or-shortcode"
        m = re.match(r"([^:]+):\s*(.+)", title)
        if not m:
            continue
        country_name = m.group(1).strip()
        rest = m.group(2).strip()
        code = name_to_a2(lookup, country_name)
        if not code:
            continue
        # Extract a trailing number/shortcode
        num_m = re.search(r"([\d][\d\s\-]{1,}\d|\d{3,5})\s*$", rest)
        phone = num_m.group(1) if num_m else ""
        name_portion = re.sub(r"\s+\d[\d\s\-]*$", "", rest).strip()
        out.append((code, phone_key(phone), norm_name(name_portion), "child_helpline_international"))
    return out


def load_chi_directory(lookup):
    p = SOURCES / "child_helpline_international" / "child_helpline_directory.json"
    if not p.exists():
        return []
    d = json.loads(p.read_text(encoding="utf-8"))
    out = []
    # We don't know the exact shape; walk recursively for any (country_code, phone)
    def walk(obj):
        if isinstance(obj, dict):
            cc = obj.get("country_code") or obj.get("alpha-2") or obj.get("countryCode")
            phone = obj.get("phone") or obj.get("number") or obj.get("helpline_number")
            name = obj.get("name") or obj.get("title") or obj.get("helpline_name")
            if cc and (phone or name):
                out.append((str(cc).upper(), phone_key(phone), norm_name(name), "child_helpline_international"))
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for v in obj:
                walk(v)
    walk(d)
    return out


def load_web_verified_crisis(lookup):
    p = SOURCES / "web_verified_crisis_directory" / "crisis_helplines_by_country.json"
    if not p.exists():
        return []
    d = json.loads(p.read_text(encoding="utf-8"))
    out = []
    for entry in d:
        country_name = entry.get("country") or ""
        code = name_to_a2(lookup, country_name)
        if not code:
            continue
        for list_key in ("mental_health_helplines", "specialist_helplines"):
            for r in entry.get(list_key) or []:
                phone = r.get("phone") or ""
                name = r.get("name") or ""
                out.append((code, phone_key(phone), norm_name(name), "web_verified_crisis_directory"))
    return out


def load_emergency_wiki(lookup):
    p = SOURCES / "web_verified_crisis_directory" / "emergency_numbers_by_country.json"
    if not p.exists():
        return []
    d = json.loads(p.read_text(encoding="utf-8"))
    out = []
    for entry in d:
        country_name = entry.get("country") or ""
        code = name_to_a2(lookup, country_name)
        if not code:
            continue
        e = entry.get("emergency") or {}
        for svc in ("police", "ambulance", "fire", "coast_guard"):
            v = e.get(svc)
            if v:
                out.append((code, phone_key(v), "", "wikipedia_emergency"))
        for extra in e.get("other_numbers") or []:
            out.append((code, phone_key(extra), "", "wikipedia_emergency"))
    return out


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Write promotions to hotlines.json")
    ap.add_argument("--min-sources", type=int, default=2,
                    help="Minimum number of independent aggregator sources for promotion")
    args = ap.parse_args()

    data = json.loads(DATA.read_text(encoding="utf-8"))
    lookup = build_country_lookup(data)

    all_rows = (
        load_helplines_world(lookup)
        + load_findahelpline(lookup)
        + load_psc_sqlite(lookup)
        + load_vibbrancy(lookup)
        + load_chi_posts(lookup)
        + load_chi_directory(lookup)
        + load_web_verified_crisis(lookup)
        + load_emergency_wiki(lookup)
    )

    # Build lookup tables
    by_phone: dict[tuple, set[str]] = defaultdict(set)  # (alpha2, phone-key) -> {sources}
    by_name: dict[tuple, set[str]] = defaultdict(set)   # (alpha2, name-norm) -> {sources}
    # Wikipedia short-code lookup keeps the full digits so 112/911/100 match exactly
    by_shortcode: dict[tuple, set[str]] = defaultdict(set)
    for code, pkey, nname, tag in all_rows:
        if not code:
            continue
        if pkey:
            if len(pkey) >= 4:
                by_phone[(code, pkey)].add(tag)
            # Short-code indexing (3+ digits, country-scoped so 112 in US ≠ 112 in UK conceptually)
            if len(pkey) >= 3:
                by_shortcode[(code, pkey)].add(tag)
        if nname and len(nname) >= 4:
            by_name[(code, nname)].add(tag)

    print(f"Indexed {len(all_rows)} source rows across {len(by_phone)} phone-keys and {len(by_name)} names")
    print(f"Source coverage: {sorted({t for s in by_phone.values() for t in s})}")
    print()

    # Track what Wikipedia's emergency list says, by (alpha2, digit-sequence)
    wiki_emerg = {key for key, srcs in by_shortcode.items() if "wikipedia_emergency" in srcs}

    promoted_to_cr = []
    promoted_to_authority = []
    sources_enriched = 0

    for c in data["countries"]:
        a2 = (c.get("alpha-2") or "").upper()
        if not a2:
            continue
        for h in c["hotlines"]:
            status = h.get("verification_status")
            if status in ("verified_web", "verified_authority", "deprecated"):
                # Still enrich sources list for auditability, but don't change status
                sources_to_add = set()
                for num in (h.get("voice_numbers") or []) + (h.get("sms_numbers") or []):
                    pkey = phone_key(num)
                    if pkey and len(pkey) >= 4:
                        sources_to_add.update(by_phone.get((a2, pkey), set()))
                for src in sources_to_add:
                    tag = f"xref:{src}"
                    if tag not in (h.get("sources") or []):
                        h.setdefault("sources", []).append(tag)
                        sources_enriched += 1
                continue

            # Gather matching sources for this record
            matching: set[str] = set()
            for num in (h.get("voice_numbers") or []) + (h.get("sms_numbers") or []):
                pkey = phone_key(num)
                if pkey and len(pkey) >= 4:
                    matching.update(by_phone.get((a2, pkey), set()))
            nname = norm_name(h.get("name"))
            if nname and len(nname) >= 5:
                matching.update(by_name.get((a2, nname), set()))

            # Exclude "wikipedia_emergency" when counting aggregator corroboration
            agg_sources = matching - {"wikipedia_emergency"}

            promoted = False
            # Wikipedia-confirmed emergency record? (match on full digit sequence, so 911/112/etc. work)
            is_emergency = h.get("category") == "emergency"
            if is_emergency and status == "legacy_unverified":
                for num in (h.get("voice_numbers") or []) + (h.get("sms_numbers") or []):
                    # Use the WHOLE digit string, not just the last 7, so short codes match exactly
                    d = digits(num)
                    if (a2, d) in wiki_emerg or (a2, phone_key(num)) in wiki_emerg:
                        h["verification_status"] = "verified_authority"
                        h["last_verified"] = datetime.utcnow().date().isoformat()
                        promoted_to_authority.append((c["country"], h.get("name")))
                        promoted = True
                        break

            if not promoted and len(agg_sources) >= args.min_sources and status == "legacy_unverified":
                h["verification_status"] = "cross_referenced"
                h["last_verified"] = datetime.utcnow().date().isoformat()
                promoted_to_cr.append((c["country"], h.get("name"), sorted(agg_sources)))

            # Always append corroborating source tags
            for src in matching:
                tag = f"xref:{src}"
                if tag not in (h.get("sources") or []):
                    h.setdefault("sources", []).append(tag)
                    sources_enriched += 1

    print(f"Promoted to cross_referenced: {len(promoted_to_cr)}")
    for country, name, srcs in promoted_to_cr[:15]:
        print(f"  [{country}] {name[:50]:<50} {srcs}")
    if len(promoted_to_cr) > 15:
        print(f"  ... and {len(promoted_to_cr) - 15} more")

    print(f"\nPromoted to verified_authority (Wikipedia emergency list): {len(promoted_to_authority)}")
    for country, name in promoted_to_authority[:10]:
        print(f"  [{country}] {name}")
    if len(promoted_to_authority) > 10:
        print(f"  ... and {len(promoted_to_authority) - 10} more")

    print(f"\nTotal source-tag entries added: {sources_enriched}")

    if not args.apply:
        print("\nDry run. Pass --apply to write.")
        return

    data["last_updated"] = datetime.utcnow().date().isoformat()
    tmp = DATA.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA)

    REPORT_DIR.mkdir(exist_ok=True)
    report = REPORT_DIR / f"cross_source_validate_{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}.md"
    lines = [
        f"# Cross-source validation — {datetime.utcnow().isoformat(timespec='seconds')}Z",
        "",
        f"- Indexed {len(all_rows)} rows across {len({t for s in by_phone.values() for t in s})} source datasets",
        f"- Promoted to `cross_referenced`: {len(promoted_to_cr)}",
        f"- Promoted to `verified_authority` (Wikipedia emergency list): {len(promoted_to_authority)}",
        f"- Source-tag entries added (audit trail on curated records): {sources_enriched}",
        "",
        "## New `cross_referenced` records",
        "",
    ]
    for country, name, srcs in promoted_to_cr:
        lines.append(f"- [{country}] {name} — {', '.join(srcs)}")
    lines.append("")
    lines.append("## New `verified_authority` records (Wikipedia-confirmed emergency lines)")
    lines.append("")
    for country, name in promoted_to_authority:
        lines.append(f"- [{country}] {name}")
    report.write_text("\n".join(lines), encoding="utf-8")
    print(f"Report: {report}")


if __name__ == "__main__":
    main()
