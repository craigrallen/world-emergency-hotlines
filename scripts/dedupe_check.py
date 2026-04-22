#!/usr/bin/env python3
"""
Exhaustive duplicate check + auto-merger.

Scans every country in hotlines.json and flags likely duplicates within the
same country based on:

  - Identical normalised name (ascii-fold + alphanum)
  - Identical phone-number set (last 7 digits of any number matches another)
  - Identical website host
  - Very high name similarity (SequenceMatcher ratio >= 0.92) AND shared
    category / shared phone / shared host

When a duplicate group is found, the 'keeper' is the one with the richest
verification status (verified_web > verified_authority > verified_knowledge
> cross_referenced > legacy_unverified). The keeper absorbs any unique
data (numbers, websites, emails, sources, notes) from the losers; the
losers are removed.

Report goes to REPORTS/dedupe_<timestamp>.md.
"""
from __future__ import annotations

import json
import pathlib
import re
import unicodedata
from collections import defaultdict
from datetime import datetime
from difflib import SequenceMatcher

ROOT = pathlib.Path(__file__).parent.parent
DATA = ROOT / "hotlines.json"
REPORT_DIR = ROOT / "REPORTS"

STATUS_RANK = {
    "verified_web": 5,
    "verified_authority": 4,
    "verified_knowledge": 3,
    "cross_referenced": 2,
    "legacy_unverified": 1,
    "deprecated": 0,
    "disputed": 1,
    None: 0,
}


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def phone_key(s: str) -> str:
    d = re.sub(r"\D", "", s or "")
    return d[-7:] if len(d) >= 7 else d


def host(url: str) -> str:
    if not url:
        return ""
    m = re.match(r"^(?:https?://)?(?:www\.)?([^/]+)", url.strip(), re.I)
    return (m.group(1).lower() if m else "").strip()


def rank(h: dict) -> int:
    return STATUS_RANK.get(h.get("verification_status"), 0)


def merge(keep: dict, other: dict) -> None:
    """Absorb unique fields from `other` into `keep`."""
    # Union the number lists
    for field in ("voice_numbers", "sms_numbers", "text_numbers", "short_codes"):
        merged = list(keep.get(field) or [])
        seen = {phone_key(n) for n in merged}
        for n in (other.get(field) or []):
            if phone_key(n) not in seen and n:
                merged.append(n)
                seen.add(phone_key(n))
        keep[field] = merged

    # Fill missing scalar fields
    for field in ("chat_url", "email", "website", "hours", "target", "geography", "organization"):
        if not keep.get(field) and other.get(field):
            keep[field] = other[field]

    # Union languages
    langs = list(keep.get("languages") or [])
    for L in (other.get("languages") or []):
        if L and L not in langs:
            langs.append(L)
    keep["languages"] = langs

    # Union sources
    srcs = set(keep.get("sources") or [])
    for s in (other.get("sources") or []):
        if s:
            srcs.add(s)
    keep["sources"] = sorted(srcs)

    # Notes: append other.notes if not already there
    keep_notes = keep.get("notes") or ""
    other_notes = other.get("notes") or ""
    if other_notes and other_notes not in keep_notes:
        keep["notes"] = (keep_notes + ("\n\n" if keep_notes else "") + other_notes).strip()


def detect_duplicates_for_country(country: dict) -> list[list[int]]:
    """Return list of index-groups within the country that are duplicates."""
    hs = country["hotlines"]
    n = len(hs)
    if n < 2:
        return []

    # Build quick indexes
    name_idx = defaultdict(list)
    phone_idx = defaultdict(list)
    host_idx = defaultdict(list)

    # Hosts that are shared across MANY distinct services (e.g. government
    # umbrella domains) can't be used alone to call duplicates.
    GENERIC_HOSTS = {
        "gov.uk", "gov.ie", "gov.za", "gov.au", "gov.it", "gov.lv", "gov.sg",
        "gob.cl", "gob.mx", "gob.pe", "gob.es", "gob.ar", "gob.do", "gob.ec", "gob.gt",
        "argentina.gob.ar", "gob.cl", "gov.br", "gov.in", "gov.ph", "gov.sa",
        "gob.pa", "gob.pe", "gob.cr", "gov.hk", "health.gov.au", "nhs.uk",
        "ec.europa.eu", "who.int", "ifrc.org", "befrienders.org",
    }

    for i, h in enumerate(hs):
        name_idx[norm_name(h.get("name", ""))].append(i)
        for num in (h.get("voice_numbers") or []) + (h.get("sms_numbers") or []):
            k = phone_key(num)
            # Only group on LONG number keys (>= 7 digits); 3/4-digit short
            # codes are shared by many different services and must not drive
            # deduplication on their own.
            if k and len(k) >= 7:
                phone_idx[k].append(i)
        hh = host(h.get("website") or "")
        if hh and hh not in GENERIC_HOSTS:
            host_idx[hh].append(i)

    # Group by first key hit; use union-find
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb: parent[ra] = rb

    for group in list(name_idx.values()) + list(phone_idx.values()) + list(host_idx.values()):
        if len(group) > 1:
            for j in group[1:]:
                union(group[0], j)

    # Also catch very similar names if they share a phone or host (transitivity above already handles shared phone/host; here we add high-ratio name matches in same category)
    for i in range(n):
        for j in range(i + 1, n):
            if find(i) == find(j):
                continue
            ni, nj = hs[i].get("name", ""), hs[j].get("name", "")
            if not ni or not nj:
                continue
            if hs[i].get("category") != hs[j].get("category"):
                continue
            ratio = SequenceMatcher(None, norm_name(ni), norm_name(nj)).ratio()
            if ratio >= 0.92:
                # Require they also share at least a phone-key segment or a host to be safe
                shares_phone = any(
                    phone_key(a) and phone_key(a) == phone_key(b)
                    for a in (hs[i].get("voice_numbers") or [])
                    for b in (hs[j].get("voice_numbers") or [])
                )
                shares_host = (host(hs[i].get("website") or "")
                               and host(hs[i].get("website") or "") == host(hs[j].get("website") or ""))
                if shares_phone or shares_host:
                    union(i, j)

    # Collect groups with more than one element
    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    return [g for g in groups.values() if len(g) > 1]


def main():
    data = json.loads(DATA.read_text(encoding="utf-8"))
    REPORT_DIR.mkdir(exist_ok=True)
    report_path = REPORT_DIR / f"dedupe_{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}.md"
    rep = [f"# Deduplication report — {datetime.utcnow().isoformat(timespec='seconds')}Z", ""]

    total_groups = 0
    total_merged = 0
    before = sum(len(c["hotlines"]) for c in data["countries"])

    for country in data["countries"]:
        groups = detect_duplicates_for_country(country)
        if not groups:
            continue
        rep.append(f"## {country['country']}")
        rep.append("")
        hs = country["hotlines"]
        # Mark all indices to remove after merging
        to_remove: set[int] = set()
        for group in sorted(groups, key=lambda g: -len(g)):
            total_groups += 1
            keeper_idx = max(
                group,
                key=lambda i: (
                    rank(hs[i]),
                    len(hs[i].get("voice_numbers") or []),
                    len((hs[i].get("notes") or "")),
                ),
            )
            rep.append(f"- group of {len(group)} (keeper: '{hs[keeper_idx].get('name','?')}' [{hs[keeper_idx].get('verification_status')}]):")
            for i in group:
                if i == keeper_idx:
                    continue
                rep.append(f"    • absorbed: '{hs[i].get('name','?')}' [{hs[i].get('verification_status')}] -> {(hs[i].get('voice_numbers') or [None])[0]}")
                merge(hs[keeper_idx], hs[i])
                to_remove.add(i)
        # Drop absorbed records
        country["hotlines"] = [h for idx, h in enumerate(hs) if idx not in to_remove]
        total_merged += len(to_remove)
        rep.append("")

    after = sum(len(c["hotlines"]) for c in data["countries"])
    rep.insert(0, "")
    rep.insert(0, f"- Duplicate groups found: {total_groups}")
    rep.insert(0, f"- Records merged away: {total_merged}")
    rep.insert(0, f"- Records after: {after}")
    rep.insert(0, f"- Records before: {before}")
    rep.insert(0, "## Summary")
    rep.insert(0, "")

    data["last_updated"] = datetime.utcnow().date().isoformat()
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    report_path.write_text("\n".join(rep), encoding="utf-8")
    print(f"Before: {before}, After: {after}, Groups: {total_groups}, Merged: {total_merged}")
    print(f"Report: {report_path}")


if __name__ == "__main__":
    main()
