#!/usr/bin/env python3
"""Build deterministic metadata coverage metrics without scoring service validity.

Presence, specificity, evidence, verification status, freshness, and structured
adoption are reported separately. A populated field is not treated as verified,
and a missing field does not mean the service is unavailable or unsuitable.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import unicodedata
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CANONICAL = ROOT / "hotlines.json"
SOURCE_BACKED = {"verified_web", "verified_authority"}
FIELDS = ("hours", "languages", "target", "geography")
STRUCTURED_SECTIONS = ("geography", "eligibility", "availability", "languages")


def percent(count: int, total: int) -> float:
    """Percentage to one decimal, with exact integer-arithmetic half-up rounding."""
    if not total:
        return 0
    tenths = (2 * count * 1000 + total) // (2 * total)
    return tenths / 10


def evidence_fields(record: dict) -> set[str]:
    provenance = record.get("provenance")
    if not isinstance(provenance, dict):
        return set()
    evidence = provenance.get("evidence")
    if not isinstance(evidence, list):
        return set()
    return {
        field
        for item in evidence
        if isinstance(item, dict)
        and isinstance((field := item.get("field")), str)
        and field.strip()
    }


def present(value: object) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return bool(value)
    return value is not None


def normalized_text(value: object) -> str:
    """NFKC + locale-independent lowercasing and two explicit substitutions."""
    return unicodedata.normalize("NFKC", str(value).strip()).lower().replace("ß", "ss").replace("ς", "σ")


def build_report(data: dict, as_of: dt.date, current_days: int = 365, dataset_version: str | None = None) -> dict:
    records = [
        (country.get("country") or "", hotline)
        for country in data.get("countries", [])
        for hotline in country.get("hotlines", [])
        if isinstance(hotline, dict)
    ]
    total = len(records)
    presence = Counter()
    evidenced = Counter()
    structured = Counter()
    status_counts = Counter()
    current = 0
    dated = 0
    source_backed = 0
    specific_geography = 0

    for country_name, record in records:
        fields = evidence_fields(record)
        for field in FIELDS:
            if present(record.get(field)):
                presence[field] += 1
            if field in fields:
                evidenced[field] += 1
        geography = record.get("geography")
        if isinstance(geography, str) and normalized_text(geography) != normalized_text(country_name):
            specific_geography += 1

        status = record.get("verification_status") or "missing"
        status_counts[status] += 1
        if status in SOURCE_BACKED:
            source_backed += 1
        last_verified = record.get("last_verified")
        if isinstance(last_verified, str) and len(last_verified) == 10:
            try:
                verified_date = dt.date.fromisoformat(last_verified)
                if verified_date.isoformat() != last_verified:
                    continue
                age = (as_of - verified_date).days
                dated += 1
                if 0 <= age <= current_days:
                    current += 1
            except ValueError:
                pass

        scope = record.get("service_scope")
        if isinstance(scope, dict):
            for section in STRUCTURED_SECTIONS:
                if section in scope:
                    structured[section] += 1

    def metric(count: int) -> dict:
        return {"records": count, "percent": percent(count, total)}

    return {
        "schema_version": "1.0",
        "dataset_schema_version": data.get("$schema_version"),
        "dataset_version": dataset_version,
        "as_of": as_of.isoformat(),
        "current_within_days": current_days,
        "total_records": total,
        "field_presence": {field: metric(presence[field]) for field in FIELDS},
        "geography_specificity": {
            "more_specific_than_country_label": metric(specific_geography),
            "country_label_or_equivalent": metric(total - specific_geography),
        },
        "field_level_evidence": {field: metric(evidenced[field]) for field in FIELDS},
        "source_backed_status": metric(source_backed),
        "dated_verification": metric(dated),
        "current_dated_verification": metric(current),
        "structured_scope_adoption": {section: metric(structured[section]) for section in STRUCTURED_SECTIONS},
        "verification_statuses": dict(sorted(status_counts.items())),
        "interpretation": {
            "no_composite_score": True,
            "presence": "A non-empty legacy field is present; this does not prove the claim is current or source-backed.",
            "specificity": "Geography differs from the country label; this does not prove the scope classification is correct.",
            "evidence": "Field-level provenance names the field; consumers must still inspect source type, date, and confidence.",
            "structured_scope": "Optional adoption count for reviewed service_scope sections; zero is valid for legacy records.",
            "safety": "These metrics measure metadata completeness, not service availability, safety, suitability, or eligibility.",
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=CANONICAL)
    parser.add_argument("--as-of", required=True, help="Deterministic report date (YYYY-MM-DD)")
    parser.add_argument("--current-days", type=int, default=365)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        parsed_as_of = dt.date.fromisoformat(args.as_of)
        if parsed_as_of.isoformat() != args.as_of:
            raise ValueError
        args.as_of = parsed_as_of
    except ValueError:
        parser.error("--as-of must be YYYY-MM-DD")
    if args.current_days < 1:
        parser.error("--current-days must be at least 1")
    if args.output and args.output.resolve() in {args.input.resolve(), CANONICAL.resolve()}:
        parser.error("--output must not overwrite a dataset")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    raw = args.input.read_bytes()
    data = json.loads(raw)
    dataset_version = f"sha256:{hashlib.sha256(raw).hexdigest()}"
    report = build_report(data, args.as_of, args.current_days, dataset_version)
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
