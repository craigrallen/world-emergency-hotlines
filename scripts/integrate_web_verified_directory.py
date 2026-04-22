#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.safety import (
    SUPPLEMENTAL_PREVIEW_ROLE,
    country_has_protected_hotlines,
    protected_statuses_for_country,
)

CANONICAL_PATH = ROOT / "hotlines.json"
SOURCE_DIR = ROOT / "sources" / "web_verified_crisis_directory"
SOURCE_PATH = SOURCE_DIR / "final_countries_crisis_directory.json"
PREVIEW_PATH = SOURCE_DIR / "web_verified_directory_v2_preview.json"
UNMATCHED_PATH = SOURCE_DIR / "unmatched_country_rows.json"
REPORT_PATH = ROOT / "REPORTS" / "web_verified_directory_integration_report.md"

SCHEMA_V2 = "2.0"

SOURCE_TO_REPO_COUNTRY = {
    "Antigua & Barbuda": "Antigua and Barbuda",
    "British Virgin Islands": "Virgin Islands (British)",
    "Brunei Darussalam": "Brunei",
    "Cabo Verde": "Cabo Verde (Cape Verde)",
    "Caribbean Netherlands": "Bonaire, Sint Eustatius and Saba",
    "Cocos Islands": "Cocos (Keeling) Islands",
    "Curacao": "Curaçao",
    "Czechia": "Czech Republic",
    "Côte d'Ivoire": "Ivory Coast",
    "Falkland Islands (Malvinas)": "Falkland Islands",
    "Korea, Democratic People's Republic of": "North Korea",
    "Korea, Republic of": "South Korea",
    "Micronesia, Federated States of": "Federated States of Micronesia",
    "Republic of the Congo": "Congo",
    "Saint Helena": "Saint Helena, Ascension and Tristan da Cunha",
    "Sint Maarten": "Sint Maarten (Dutch part)",
    "São Tomé & Príncipe": "Sao Tome and Principe",
    "U.S. Virgin Islands": "Virgin Islands (U.S.)",
    "Vatican City": "Holy See",
}

SOURCE_STATUS_TO_V2 = {
    "pass": "legacy_unverified",
    "warning": "legacy_unverified",
    "manual_review": "legacy_unverified",
}


def normalize_name(name: str) -> str:
    name = (name or "").lower().strip().replace("&", "and")
    name = "".join(
        ch for ch in unicodedata.normalize("NFKD", name) if not unicodedata.combining(ch)
    )
    name = re.sub(r"[^a-z0-9]+", " ", name)
    return " ".join(name.split())


CATEGORY_MAP = {
    "mental_health": "mental_health",
    "child_helpline": "child_protection",
    "domestic_violence": "domestic_violence",
    None: "general_support",
    "": "general_support",
}


NOTE_LABELS = {
    "phone": "phone",
    "sms": "sms",
    "whatsapp": "whatsapp",
    "text_or_chat": "text/chat",
    "web": "web",
}


EMERGENCY_LABELS = {
    "police": "Police",
    "ambulance": "Ambulance",
    "fire": "Fire",
}


def unique(seq):
    seen = set()
    out = []
    for item in seq:
        marker = json.dumps(item, ensure_ascii=False, sort_keys=True) if isinstance(item, (dict, list)) else item
        if marker in seen:
            continue
        seen.add(marker)
        out.append(item)
    return out


def split_numbers(value: str | None) -> list[str]:
    if not value:
        return []
    parts = re.split(r"\s*(?:/|;|,|\bor\b)\s*", value)
    out = []
    for part in parts:
        clean = " ".join((part or "").split()).strip(" .")
        if clean:
            out.append(clean)
    return unique(out)


def build_emergency_numbers(row: dict) -> list[str]:
    emergency = row.get("emergency") or {}
    numbers = []
    for key in ("police", "ambulance", "fire"):
        numbers.extend(split_numbers(emergency.get(key)))
    for item in emergency.get("other_numbers", []) or []:
        numbers.extend(split_numbers(item))
    return unique(numbers)


def emergency_hotline(row: dict) -> dict:
    emergency = row.get("emergency") or {}
    notes = []
    for key, label in EMERGENCY_LABELS.items():
        value = emergency.get(key)
        if value:
            notes.append(f"{label}: {value}")
    for item in emergency.get("other_numbers", []) or []:
        if item:
            notes.append(f"Other: {item}")
    verification_status = row.get("verification_status") or "warning"
    verification_notes = row.get("verification_notes") or ""
    if verification_notes:
        notes.append(f"Import note ({verification_status}): {verification_notes}")
    return {
        "name": "Emergency",
        "organization": "Local emergency services",
        "category": "emergency",
        "voice_numbers": build_emergency_numbers(row),
        "sms_numbers": [],
        "text_numbers": [],
        "short_codes": [],
        "chat_url": None,
        "email": None,
        "website": None,
        "hours": None,
        "languages": [],
        "cost": "unknown",
        "target": "anyone in a life-threatening emergency",
        "geography": row.get("country_name"),
        "notes": " | ".join(notes),
        "verification_status": SOURCE_STATUS_TO_V2.get(verification_status, "legacy_unverified"),
        "last_verified": None,
        "sources": unique(row.get("source_urls", []) or []),
        "_import_metadata": {
            "source_dataset": "web_verified_crisis_directory",
            "source_country_name": row.get("country_name"),
            "source_verification_status": verification_status,
        },
    }


def build_hotline_notes(entry: dict, row: dict) -> str:
    notes = []
    for key, label in NOTE_LABELS.items():
        value = entry.get(key)
        if value and key not in {"phone", "sms"}:
            notes.append(f"{label}: {value}")
    if entry.get("notes"):
        notes.append(entry["notes"])
    verification_status = row.get("verification_status") or "warning"
    verification_notes = row.get("verification_notes") or ""
    if verification_notes:
        notes.append(f"Import note ({verification_status}): {verification_notes}")
    return " | ".join(unique(notes))


def convert_entry(row: dict, entry: dict, kind: str) -> dict:
    source_category = entry.get("category")
    category = CATEGORY_MAP.get(source_category, "general_support")
    website = entry.get("web")
    text_or_chat = entry.get("text_or_chat")
    chat_url = text_or_chat if text_or_chat and str(text_or_chat).startswith(("http://", "https://")) else None
    voice_numbers = split_numbers(entry.get("phone"))
    sms_numbers = split_numbers(entry.get("sms")) + split_numbers(entry.get("whatsapp"))
    verification_status = row.get("verification_status") or "warning"
    return {
        "name": entry.get("name") or "Unnamed service",
        "organization": entry.get("name") or "Unnamed service",
        "category": "mental_health" if kind == "mental_health_helplines" else category,
        "voice_numbers": unique(voice_numbers),
        "sms_numbers": unique(sms_numbers),
        "text_numbers": [],
        "short_codes": [],
        "chat_url": chat_url,
        "email": None,
        "website": website,
        "hours": None,
        "languages": [],
        "cost": "unknown",
        "target": None,
        "geography": row.get("country_name"),
        "notes": build_hotline_notes(entry, row),
        "verification_status": SOURCE_STATUS_TO_V2.get(verification_status, "legacy_unverified"),
        "last_verified": None,
        "sources": unique([entry.get("source_url")] + (row.get("source_urls", []) or [])),
        "_import_metadata": {
            "source_dataset": "web_verified_crisis_directory",
            "source_country_name": row.get("country_name"),
            "source_verification_status": verification_status,
            "source_kind": kind,
            "source_category": source_category,
        },
    }


def convert_row(row: dict, canonical_country: dict) -> dict:
    hotlines = []
    if row.get("emergency"):
        hotlines.append(emergency_hotline(row))
    for kind in ("mental_health_helplines", "specialist_helplines"):
        for entry in row.get(kind, []) or []:
            hotlines.append(convert_entry(row, entry, kind))
    hotlines = [h for h in hotlines if h["voice_numbers"] or h["sms_numbers"] or h["chat_url"] or h["website"]]
    return {
        "country": canonical_country["country"],
        "alpha-2": canonical_country.get("alpha-2"),
        "alpha-3": canonical_country.get("alpha-3"),
        "region": canonical_country.get("region"),
        "subregion": canonical_country.get("subregion"),
        "general_emergency": build_emergency_numbers(row),
        "notes": f"Supplemental preview imported from sources/web_verified_crisis_directory/final_countries_crisis_directory.json; source country name: {row['country_name']}.",
        "hotlines": hotlines,
        "_import_metadata": {
            "source_country_name": row["country_name"],
            "repo_country_name": canonical_country["country"],
            "source_verification_status": row.get("verification_status"),
            "source_presence": row.get("merge_metadata", {}).get("source_presence"),
        },
    }
def main() -> None:
    canonical = json.loads(CANONICAL_PATH.read_text(encoding="utf-8"))
    source_rows = json.loads(SOURCE_PATH.read_text(encoding="utf-8"))

    if canonical.get("$schema_version") != SCHEMA_V2:
        raise AssertionError(
            f"Expected canonical dataset schema version {SCHEMA_V2}, got {canonical.get('$schema_version')!r}"
        )

    canonical_by_norm = {normalize_name(country["country"]): country for country in canonical["countries"]}
    exact_matches = 0
    alias_matches = 0
    unmatched_rows = []
    protected_rows = []
    preview_countries = []
    source_status_counts = Counter()
    preview_hotline_count = 0

    for row in source_rows:
        source_status_counts[row.get("verification_status") or "unknown"] += 1
        source_name = row["country_name"]
        canonical_country = canonical_by_norm.get(normalize_name(source_name))
        if canonical_country is not None:
            exact_matches += 1
        else:
            repo_name = SOURCE_TO_REPO_COUNTRY.get(source_name)
            canonical_country = canonical_by_norm.get(normalize_name(repo_name or ""))
            if canonical_country is not None:
                alias_matches += 1
        if canonical_country is None:
            unmatched_rows.append(row)
            continue
        if country_has_protected_hotlines(canonical_country):
            protected_rows.append({
                "source_country_name": source_name,
                "repo_country_name": canonical_country["country"],
                "protected_statuses": protected_statuses_for_country(canonical_country),
            })
            continue
        converted = convert_row(row, canonical_country)
        preview_hotline_count += len(converted["hotlines"])
        preview_countries.append(converted)

    protected_country_names = {row["repo_country_name"] for row in protected_rows}
    preview_country_names = {country["country"] for country in preview_countries}
    overlap = sorted(protected_country_names.intersection(preview_country_names))
    if overlap:
        raise AssertionError(
            "Preview generation would overwrite or downgrade canonical rich records for: "
            + ", ".join(overlap)
        )
    for country in preview_countries:
        statuses = {hotline.get("verification_status") for hotline in country.get("hotlines", [])}
        if statuses - {"legacy_unverified"}:
            raise AssertionError(
                f"Preview country {country['country']} contains unexpected verification statuses: {sorted(statuses)}"
            )

    preview = {
        "$schema_version": canonical.get("$schema_version", SCHEMA_V2),
        "last_updated": canonical.get("last_updated"),
        "methodology": "Supplemental preview generated from the web_verified_crisis_directory source artifacts. This file is intentionally not the canonical dataset, remains schema v2 compatible for review tooling, excludes countries that already have richer non-legacy canonical records, and preserves conservative legacy_unverified verification statuses pending maintainers' review.",
        "categories_reference": canonical.get("categories_reference", {}),
        "_preview_metadata": {
            "dataset_role": SUPPLEMENTAL_PREVIEW_ROLE,
            "canonical_dataset_path": str(CANONICAL_PATH.relative_to(ROOT)),
            "generated_from": str(SOURCE_PATH.relative_to(ROOT)),
            "guarantees": [
                "does_not_modify_canonical_hotlines_json",
                "does_not_replace_countries_with_existing_non_legacy_canonical_hotlines",
                "preview_hotlines_remain_legacy_unverified",
            ],
            "excluded_countries_with_existing_rich_records": len(protected_rows),
        },
        "countries": sorted(preview_countries, key=lambda item: item["country"]),
    }

    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    PREVIEW_PATH.write_text(json.dumps(preview, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    UNMATCHED_PATH.write_text(json.dumps(unmatched_rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Web-verified directory integration report",
        "",
        f"- Source rows reviewed: {len(source_rows)}",
        f"- Matched directly by country name: {exact_matches}",
        f"- Matched via explicit alias map: {alias_matches}",
        f"- Unmatched rows kept out of preview: {len(unmatched_rows)}",
        f"- Matched rows skipped because canonical v2 already has richer non-legacy records: {len(protected_rows)}",
        f"- Preview countries written: {len(preview_countries)}",
        f"- Preview hotline records written: {preview_hotline_count}",
        "",
        "## Source verification-status counts",
        "",
    ]
    for status, count in sorted(source_status_counts.items()):
        lines.append(f"- `{status}`: {count}")
    lines.extend([
        "",
        "## Explicit source→repo aliases used",
        "",
    ])
    for source_name, repo_name in sorted(SOURCE_TO_REPO_COUNTRY.items()):
        lines.append(f"- `{source_name}` → `{repo_name}`")
    lines.extend([
        "",
        "## Protected canonical countries skipped from preview",
        "",
    ])
    for row in protected_rows:
        lines.append(
            f"- `{row['source_country_name']}` → `{row['repo_country_name']}` "
            f"(protected statuses: {', '.join(row['protected_statuses'])})"
        )
    lines.extend([
        "",
        "## Unmatched source rows",
        "",
    ])
    for row in unmatched_rows:
        lines.append(f"- `{row['country_name']}` (`{row.get('verification_status', 'unknown')}`)")
    lines.extend([
        "",
        "## Safety notes",
        "",
        "- The preview intentionally does **not** overwrite `hotlines.json`.",
        "- The preview writes schema-`2.0` records so review tooling can validate them against the canonical v2 shape, but `_preview_metadata.dataset_role` and the filename make clear that the output is non-canonical.",
        "- Countries that already contain richer non-legacy canonical hotlines are **excluded** from the preview to avoid any chance of downgrade-by-confusion.",
        "- Imported hotline records are marked `legacy_unverified` in v2 preview output even when the source row passed its own QA, because the generated directory mixes Wikipedia, Child Helpline International, and HotPeach-derived data rather than only first-party provider pages.",
        "- `unmatched_country_rows.json` preserves disputed or out-of-scope political entities for manual review instead of forcing them into the canonical country list.",
    ])
    REPORT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {PREVIEW_PATH}")
    print(f"Wrote {UNMATCHED_PATH}")
    print(f"Wrote {REPORT_PATH}")
    print(f"Matched {len(preview_countries)} / {len(source_rows)} source rows")


if __name__ == "__main__":
    main()
