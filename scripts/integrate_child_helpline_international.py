#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.child_helpline_international import normalize_name, unique_strings
from scripts.lib.provenance import normalize_provenance
from scripts.lib.safety import SUPPLEMENTAL_PREVIEW_ROLE, country_has_protected_hotlines, protected_statuses_for_country

SCHEMA_V2 = "2.0"
CANONICAL_PATH = ROOT / "hotlines.json"
SOURCE_DIR = ROOT / "sources" / "child_helpline_international"
DIRECTORY_PATH = SOURCE_DIR / "child_helpline_directory.json"
PREVIEW_PATH = SOURCE_DIR / "child_helpline_international_v2_preview.json"
UNMATCHED_PATH = SOURCE_DIR / "unmatched_countries.json"
REPORT_PATH = ROOT / "REPORTS" / "child_helpline_international_integration_report.md"

SOURCE_TO_REPO_COUNTRY = {
    "Bosnia & Herzegovina": "Bosnia and Herzegovina",
    "Brunei Darussalam": "Brunei",
    "Curaçao": "Curaçao",
    "Czechia": "Czech Republic",
    "Côte d’Ivoire": "Ivory Coast",
    "Democratic Republic of Congo": "Democratic Republic of the Congo",
    "Hong Kong (China)": "Hong Kong",
    "Trinidad & Tobago": "Trinidad and Tobago",
    "USA": "United States",
}


def unique_dicts(items: list[dict]) -> list[dict]:
    seen = set()
    output = []
    for item in items:
        marker = json.dumps(item, ensure_ascii=False, sort_keys=True)
        if marker in seen:
            continue
        seen.add(marker)
        output.append(item)
    return output


def build_notes(entry: dict) -> str:
    notes = []
    if entry.get("summary"):
        notes.append(entry["summary"])
    if entry.get("services"):
        notes.append("Services listed by source: " + ", ".join(entry["services"]))
    if entry.get("source_regions"):
        notes.append("Source region tags: " + ", ".join(entry["source_regions"]))
    if entry.get("other_contact_urls"):
        extras = [f"{item['label']}: {item['url']}" for item in entry["other_contact_urls"] if item.get("label") and item.get("url")]
        if extras:
            notes.append("Additional source links: " + "; ".join(extras))
    return " | ".join(notes)


def convert_helpline(entry: dict, repo_country_name: str) -> dict:
    hotline = {
        "name": entry["service_name"],
        "organization": entry["service_name"],
        "category": "child_protection",
        "voice_numbers": entry.get("voice_numbers", []),
        "sms_numbers": entry.get("sms_numbers", []),
        "text_numbers": [],
        "short_codes": [],
        "chat_url": entry.get("chat_urls", [None])[0] if entry.get("chat_urls") else None,
        "email": entry.get("emails", [None])[0] if entry.get("emails") else None,
        "website": entry.get("websites", [None])[0] if entry.get("websites") else None,
        "hours": entry.get("hours"),
        "languages": entry.get("languages", []),
        "cost": "unknown",
        "target": "children and young people seeking support",
        "geography": repo_country_name,
        "notes": build_notes(entry),
        "verification_status": "legacy_unverified",
        "last_verified": None,
        "sources": unique_strings([entry.get("source_url")] + entry.get("websites", [])),
        "_import_metadata": {
            "source_dataset": "child_helpline_international",
            "source_country_name": entry["country_name"],
            "source_post_slug": entry.get("source_post_slug"),
            "source_post_status": entry.get("source_post_status"),
            "retrieved_at": None,
        },
    }
    hotline["provenance"] = normalize_provenance(
        hotline,
        {
            "record_status": "legacy_unverified",
            "source_class": "ngo_directory",
            "verification_method": "scripted_import",
            "review_state": "staged",
            "source_dataset": "child_helpline_international",
            "source_status": entry.get("source_post_status"),
            "evidence": [
                {
                    "field": "voice_numbers",
                    "value": entry.get("voice_numbers", []),
                    "source_url": entry.get("source_url"),
                    "source_type": "ngo_directory",
                    "confidence": "medium",
                },
                {
                    "field": "website",
                    "value": entry.get("websites", [None])[0] if entry.get("websites") else None,
                    "source_url": entry.get("source_url"),
                    "source_type": "ngo_directory",
                    "confidence": "medium",
                },
                {
                    "field": "hours",
                    "value": entry.get("hours"),
                    "source_url": entry.get("source_url"),
                    "source_type": "ngo_directory",
                    "confidence": "medium",
                },
            ],
        },
    )
    return hotline


def convert_country(source_country: dict, canonical_country: dict, retrieved_at: str | None) -> dict:
    hotlines = []
    for entry in source_country.get("helplines", []):
        converted = convert_helpline(entry, canonical_country["country"])
        converted["_import_metadata"]["retrieved_at"] = retrieved_at
        converted["provenance"] = normalize_provenance(converted, converted.get("provenance"))
        hotlines.append(converted)
    return {
        "country": canonical_country["country"],
        "alpha-2": canonical_country.get("alpha-2"),
        "alpha-3": canonical_country.get("alpha-3"),
        "region": canonical_country.get("region"),
        "subregion": canonical_country.get("subregion"),
        "general_emergency": canonical_country.get("general_emergency", []),
        "notes": (
            "Supplemental preview imported from sources/child_helpline_international/child_helpline_directory.json; "
            f"source country name: {source_country['country_name']}."
        ),
        "hotlines": hotlines,
        "_import_metadata": {
            "source_country_name": source_country["country_name"],
            "repo_country_name": canonical_country["country"],
            "source_regions": source_country.get("source_regions", []),
            "source_url_count": len(source_country.get("source_urls", [])),
            "retrieved_at": retrieved_at,
        },
    }


def main() -> None:
    canonical = json.loads(CANONICAL_PATH.read_text(encoding="utf-8"))
    source = json.loads(DIRECTORY_PATH.read_text(encoding="utf-8"))
    if canonical.get("$schema_version") != SCHEMA_V2:
        raise AssertionError(
            f"Expected canonical dataset schema version {SCHEMA_V2}, got {canonical.get('$schema_version')!r}"
        )

    canonical_by_name = {normalize_name(country["country"]): country for country in canonical["countries"]}
    preview_countries = []
    unmatched = []
    protected_included = []
    exact_matches = 0
    alias_matches = 0
    preview_hotlines = 0
    region_counts = Counter()
    retrieved_at = source.get("retrieved_at")

    for source_country in source.get("countries", []):
        source_name = source_country["country_name"]
        canonical_country = canonical_by_name.get(normalize_name(source_name))
        if canonical_country is not None:
            exact_matches += 1
        else:
            alias = SOURCE_TO_REPO_COUNTRY.get(source_name)
            canonical_country = canonical_by_name.get(normalize_name(alias or ""))
            if canonical_country is not None:
                alias_matches += 1
        if canonical_country is None:
            unmatched.append(
                {
                    "source_country_name": source_name,
                    "source_regions": source_country.get("source_regions", []),
                    "source_urls": source_country.get("source_urls", []),
                    "helpline_count": len(source_country.get("helplines", [])),
                }
            )
            continue
        if country_has_protected_hotlines(canonical_country):
            protected_included.append(
                {
                    "source_country_name": source_name,
                    "repo_country_name": canonical_country["country"],
                    "protected_statuses": protected_statuses_for_country(canonical_country),
                    "source_helpline_count": len(source_country.get("helplines", [])),
                }
            )
        converted = convert_country(source_country, canonical_country, retrieved_at)
        preview_countries.append(converted)
        preview_hotlines += len(converted["hotlines"])
        for region in source_country.get("source_regions", []):
            region_counts[region] += 1

    preview = {
        "$schema_version": canonical["$schema_version"],
        "last_updated": canonical.get("last_updated"),
        "methodology": (
            "Supplemental preview generated from Child Helpline International WordPress directory posts. "
            "This file is intentionally not the canonical dataset, stays schema v2 compatible for review tooling, "
            "preserves Child Helpline International contact details conservatively as legacy_unverified staged records, "
            "and may include countries that already have richer non-legacy canonical hotlines only as append-only or merge-missing review input for the promotion-candidate pipeline."
        ),
        "categories_reference": canonical.get("categories_reference", {}),
        "_preview_metadata": {
            "dataset_role": SUPPLEMENTAL_PREVIEW_ROLE,
            "canonical_dataset_path": str(CANONICAL_PATH.relative_to(ROOT)),
            "generated_from": str(DIRECTORY_PATH.relative_to(ROOT)),
            "guarantees": [
                "does_not_modify_canonical_hotlines_json",
                "does_not_replace_countries_with_existing_non_legacy_canonical_hotlines",
                "protected_canonical_countries_are_included_only_for_append_or_merge_review",
                "preview_hotlines_remain_legacy_unverified",
                "preview_hotlines_preserve_child_helpline_international_source_urls",
            ],
            "included_countries_with_existing_rich_records": len(protected_included),
            "unmatched_source_countries": len(unmatched),
        },
        "countries": sorted(preview_countries, key=lambda item: item["country"]),
    }

    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    PREVIEW_PATH.write_text(json.dumps(preview, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    UNMATCHED_PATH.write_text(json.dumps(unique_dicts(unmatched), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Child Helpline International integration report",
        "",
        f"- Source countries reviewed: {len(source.get('countries', []))}",
        f"- Source helpline posts reviewed: {source.get('helpline_count', 0)}",
        f"- Matched directly by country name: {exact_matches}",
        f"- Matched via explicit alias map: {alias_matches}",
        f"- Unmatched source countries kept out of preview: {len(unmatched)}",
        f"- Matched countries that already have richer non-legacy canonical records but remain in preview for append-only / merge-missing review: {len(protected_included)}",
        f"- Preview countries written: {len(preview_countries)}",
        f"- Preview hotline records written: {preview_hotlines}",
        "",
        "## Source regions represented in preview",
        "",
    ]
    for region, count in sorted(region_counts.items()):
        lines.append(f"- `{region}`: {count}")
    lines.extend([
        "",
        "## Explicit source→repo aliases used",
        "",
    ])
    for source_name, repo_name in sorted(SOURCE_TO_REPO_COUNTRY.items()):
        lines.append(f"- `{source_name}` → `{repo_name}`")
    lines.extend([
        "",
        "## Protected canonical countries still included for append-only / merge review",
        "",
    ])
    for row in protected_included:
        lines.append(
            f"- `{row['source_country_name']}` → `{row['repo_country_name']}` "
            f"({row['source_helpline_count']} source helpline(s); protected statuses: {', '.join(row['protected_statuses'])})"
        )
    lines.extend([
        "",
        "## Unmatched source countries",
        "",
    ])
    for row in unmatched:
        lines.append(
            f"- `{row['source_country_name']}` ({row['helpline_count']} helpline(s); regions: {', '.join(row['source_regions']) or 'n/a'})"
        )
    lines.extend([
        "",
        "## Safety notes",
        "",
        "- The adapter only vendors Child Helpline International source artifacts and a non-canonical schema-v2 preview; it does **not** write to `hotlines.json`.",
        "- Imported Child Helpline International records remain `legacy_unverified` with `provenance.source_class=ngo_directory` and `review_state=staged` until maintainers review and promote them.",
        "- Countries with richer existing canonical records may still appear in this preview, but only as review input for append-only or merge-missing promotion candidates; the preview itself never writes canonical data.",
        "- Unmatched geopolitical entities stay in `unmatched_countries.json` for explicit review instead of being forced into the canonical country list.",
        "- Only contact details explicitly published in the Child Helpline International directory are mapped into structured fields; any remaining detail stays in notes rather than being guessed.",
    ])
    REPORT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {PREVIEW_PATH.relative_to(ROOT)}")
    print(f"Wrote {UNMATCHED_PATH.relative_to(ROOT)}")
    print(f"Wrote {REPORT_PATH.relative_to(ROOT)}")
    print(f"Preview covers {len(preview_countries)} countries / {preview_hotlines} hotline records")


if __name__ == "__main__":
    main()
