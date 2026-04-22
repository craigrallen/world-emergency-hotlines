#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.promotion import (
    additive_general_emergency_actions,
    compute_additive_hotline_field_actions,
    hotlines_by_normalized_name,
    normalize_text,
)
from scripts.lib.safety import (
    PROTECTED_CANONICAL_STATUSES,
    country_has_only_legacy_hotlines,
    country_has_protected_hotlines,
    preview_dataset_claims_canonical,
    validate_promotion_candidate,
)

SCHEMA_V2 = "2.0"
DEFAULT_REPORT_DIR = ROOT / "REPORTS"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build safe promotion candidates from preview datasets.")
    parser.add_argument("--canonical", required=True, help="Path to the canonical schema-v2 dataset.")
    parser.add_argument(
        "--preview",
        action="append",
        required=True,
        help="Path to a supplemental preview dataset. May be passed more than once.",
    )
    parser.add_argument("--out", required=True, help="Path to write the candidate bundle JSON.")
    parser.add_argument("--report", required=True, help="Path to write the markdown review report.")
    return parser.parse_args(argv)


def canonical_index(canonical: dict) -> tuple[dict[str, dict], dict[str, dict]]:
    by_alpha2 = {country.get("alpha-2"): country for country in canonical.get("countries", []) if country.get("alpha-2")}
    by_name = {normalize_text(country.get("country")): country for country in canonical.get("countries", [])}
    return by_alpha2, by_name


def build_candidate_id(country: str, hotline_name: str | None, candidate_type: str, preview_name: str, ordinal: int) -> str:
    parts = [normalize_text(country), normalize_text(hotline_name), normalize_text(candidate_type), normalize_text(preview_name), str(ordinal)]
    return "-".join(part or "na" for part in parts)


def safety_flags_for_country(country: dict) -> list[str]:
    flags = []
    if country_has_protected_hotlines(country):
        statuses = sorted({hotline.get("verification_status") for hotline in country.get("hotlines", []) if hotline.get("verification_status") in PROTECTED_CANONICAL_STATUSES})
        flags.append("canonical_country_has_protected_hotlines")
        for status in statuses:
            flags.append(f"protected_status:{status}")
    elif country_has_only_legacy_hotlines(country):
        flags.append("canonical_country_has_only_legacy_records")
    else:
        flags.append("canonical_country_has_no_hotlines")
    return flags


def create_country_level_candidate(existing_country: dict, preview_country: dict, preview_path: Path, ordinal: int) -> dict | None:
    field_actions = additive_general_emergency_actions(existing_country, preview_country)
    if not field_actions:
        return None
    candidate = {
        "candidate_id": build_candidate_id(existing_country["country"], "Emergency metadata", "upgrade_emergency_metadata", preview_path.name, ordinal),
        "country": existing_country["country"],
        "alpha-2": existing_country.get("alpha-2"),
        "candidate_type": "upgrade_emergency_metadata",
        "canonical_match": {
            "country": existing_country["country"],
            "hotline_name": None,
            "match_confidence": 1.0,
        },
        "proposed_hotline": None,
        "proposed_country_updates": {
            "general_emergency": preview_country.get("general_emergency") or [],
            "notes": preview_country.get("notes"),
        },
        "source_artifact": str(preview_path.relative_to(ROOT)) if preview_path.is_absolute() and preview_path.is_relative_to(ROOT) else str(preview_path),
        "field_actions": field_actions,
        "safety_flags": safety_flags_for_country(existing_country),
        "requires_human_review": True,
    }
    return candidate


def create_hotline_candidates(existing_country: dict, preview_country: dict, preview_path: Path, start_ordinal: int) -> list[dict]:
    candidates: list[dict] = []
    existing_by_name = hotlines_by_normalized_name(existing_country)
    ordinal = start_ordinal

    for preview_hotline in preview_country.get("hotlines", []):
        hotline_name = preview_hotline.get("name") or "Unnamed service"
        matched_hotline = existing_by_name.get(normalize_text(hotline_name))
        if matched_hotline is None:
            candidate = {
                "candidate_id": build_candidate_id(existing_country["country"], hotline_name, "append_new_hotline", preview_path.name, ordinal),
                "country": existing_country["country"],
                "alpha-2": existing_country.get("alpha-2"),
                "candidate_type": "append_new_hotline",
                "canonical_match": {
                    "country": existing_country["country"],
                    "hotline_name": None,
                    "match_confidence": 0.0,
                },
                "proposed_hotline": preview_hotline,
                "source_artifact": str(preview_path.relative_to(ROOT)) if preview_path.is_absolute() and preview_path.is_relative_to(ROOT) else str(preview_path),
                "field_actions": {
                    "hotlines": "append_unique",
                },
                "safety_flags": safety_flags_for_country(existing_country),
                "requires_human_review": True,
            }
            validate_promotion_candidate(candidate, {country["country"] for country in [existing_country] if country_has_protected_hotlines(country)})
            candidates.append(candidate)
            ordinal += 1
            continue

        field_actions = compute_additive_hotline_field_actions(matched_hotline, preview_hotline)
        if not field_actions:
            continue
        candidate = {
            "candidate_id": build_candidate_id(existing_country["country"], hotline_name, "merge_missing_fields", preview_path.name, ordinal),
            "country": existing_country["country"],
            "alpha-2": existing_country.get("alpha-2"),
            "candidate_type": "merge_missing_fields",
            "canonical_match": {
                "country": existing_country["country"],
                "hotline_name": matched_hotline.get("name"),
                "match_confidence": 1.0,
            },
            "proposed_hotline": preview_hotline,
            "source_artifact": str(preview_path.relative_to(ROOT)) if preview_path.is_absolute() and preview_path.is_relative_to(ROOT) else str(preview_path),
            "field_actions": field_actions,
            "safety_flags": safety_flags_for_country(existing_country),
            "requires_human_review": True,
        }
        validate_promotion_candidate(candidate, {country["country"] for country in [existing_country] if country_has_protected_hotlines(country)})
        candidates.append(candidate)
        ordinal += 1

    return candidates


def build_candidates(canonical: dict, preview_datasets: list[tuple[Path, dict]]) -> tuple[dict, list[str]]:
    by_alpha2, by_name = canonical_index(canonical)
    candidates: list[dict] = []
    notes: list[str] = []
    ordinal = 1

    for preview_path, preview in preview_datasets:
        if preview.get("$schema_version") != SCHEMA_V2:
            raise ValueError(f"Preview dataset {preview_path} must use schema {SCHEMA_V2}.")
        if preview_dataset_claims_canonical(preview):
            raise ValueError(f"Preview dataset {preview_path} incorrectly claims canonical status.")

        for preview_country in preview.get("countries", []):
            existing_country = by_alpha2.get(preview_country.get("alpha-2")) or by_name.get(normalize_text(preview_country.get("country")))
            if existing_country is None:
                notes.append(f"Skipped preview country without canonical match: {preview_country.get('country')}")
                continue

            country_candidate = create_country_level_candidate(existing_country, preview_country, preview_path, ordinal)
            if country_candidate is not None:
                validate_promotion_candidate(country_candidate, {existing_country['country']} if country_has_protected_hotlines(existing_country) else set())
                candidates.append(country_candidate)
                ordinal += 1
            hotline_candidates = create_hotline_candidates(existing_country, preview_country, preview_path, ordinal)
            candidates.extend(hotline_candidates)
            ordinal += len(hotline_candidates)

    candidate_bundle = {
        "$schema_version": canonical.get("$schema_version", SCHEMA_V2),
        "generated_at": utc_now(),
        "canonical_dataset": None,
        "preview_datasets": [],
        "summary": {
            "candidate_count": len(candidates),
            "candidate_types": dict(sorted(Counter(candidate["candidate_type"] for candidate in candidates).items())),
        },
        "candidates": candidates,
    }
    return candidate_bundle, notes


def write_report(report_path: Path, bundle: dict, notes: list[str]) -> None:
    counts = Counter(candidate["candidate_type"] for candidate in bundle.get("candidates", []))
    lines = [
        "# Promotion candidate report",
        "",
        f"- Generated at: {bundle.get('generated_at')}",
        f"- Candidate count: {bundle.get('summary', {}).get('candidate_count', 0)}",
        "",
        "## Candidate types",
        "",
    ]
    for candidate_type, count in sorted(counts.items()):
        lines.append(f"- `{candidate_type}`: {count}")
    if not counts:
        lines.append("- No safe promotion candidates were emitted.")
    lines.extend(["", "## Candidates", ""])
    for candidate in bundle.get("candidates", []):
        lines.append(
            f"- `{candidate['candidate_id']}` | `{candidate['country']}` | `{candidate['candidate_type']}` | "
            f"target=`{candidate['canonical_match'].get('hotline_name') or 'country metadata'}` | "
            f"actions={json.dumps(candidate.get('field_actions', {}), ensure_ascii=False, sort_keys=True)}"
        )
    if notes:
        lines.extend(["", "## Notes", ""])
        for note in notes:
            lines.append(f"- {note}")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    canonical_path = Path(args.canonical)
    preview_paths = [Path(path) for path in args.preview]
    out_path = Path(args.out)
    report_path = Path(args.report)

    canonical = json.loads(canonical_path.read_text(encoding="utf-8"))
    if canonical.get("$schema_version") != SCHEMA_V2:
        raise ValueError(f"Canonical dataset {canonical_path} must use schema {SCHEMA_V2}.")

    preview_datasets = [(path, json.loads(path.read_text(encoding="utf-8"))) for path in preview_paths]
    bundle, notes = build_candidates(canonical, preview_datasets)
    bundle["canonical_dataset"] = str(canonical_path)
    bundle["preview_datasets"] = [str(path) for path, _ in preview_datasets]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(report_path, bundle, notes)
    print(f"Wrote candidate bundle: {out_path}")
    print(f"Wrote report: {report_path}")
    print(f"Emitted {bundle['summary']['candidate_count']} safe promotion candidates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
