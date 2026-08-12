#!/usr/bin/env python3
"""
Stdlib-only, read-only validator for the canonical hotlines dataset.

Checks schema/country/hotline structural invariants (required fields,
verification_status enum, last_verified date format, list-typed fields,
category slug shape, and that every hotline exposes at least one contact
channel). Categories missing from categories_reference and exact-contact
duplicate groups within a country are reported as summarized warnings (not
one line per record/group), and never affect the exit code, since candidate
duplicates are surfaced separately (for manual review) by dedupe_check.py.

This script never writes to disk. Exit code is 0 when there are no errors
(warnings do not affect the exit code), 1 when errors are found, and 2 on
an unreadable/unparsable input file.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from collections import Counter, defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / "hotlines.json"

VALID_VERIFICATION_STATUSES = frozenset(
    {
        "verified_web",
        "verified_authority",
        "verified_knowledge",
        "cross_referenced",
        "legacy_unverified",
        "disputed",
        "deprecated",
    }
)

LIST_FIELDS = (
    "voice_numbers",
    "sms_numbers",
    "text_numbers",
    "short_codes",
    "languages",
    "sources",
)

CONTACT_LIST_FIELDS = ("voice_numbers", "sms_numbers", "text_numbers", "short_codes")
CONTACT_SCALAR_FIELDS = ("chat_url", "email", "website")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CATEGORY_SLUG_RE = re.compile(r"^[a-z0-9]+(_[a-z0-9]+)*$")

MAX_DUPLICATE_SAMPLE = 5


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    @property
    def ok(self) -> bool:
        return not self.errors


def has_contact(hotline: dict) -> bool:
    for field in CONTACT_LIST_FIELDS:
        values = hotline.get(field)
        if isinstance(values, list) and any(isinstance(v, str) and v.strip() for v in values):
            return True
    for field in CONTACT_SCALAR_FIELDS:
        value = hotline.get(field)
        if isinstance(value, str) and value.strip():
            return True
    return False


def contact_key(hotline: dict):
    list_parts = tuple(
        tuple(
            sorted(
                v.strip()
                for v in (hotline.get(field) or [])
                if isinstance(v, str) and v.strip()
            )
        )
        for field in CONTACT_LIST_FIELDS
    )
    scalar_parts = tuple(
        (hotline.get(field) or "").strip().lower() or None for field in CONTACT_SCALAR_FIELDS
    )
    return list_parts + scalar_parts


def is_empty_contact_key(key) -> bool:
    return all(not part for part in key)


def validate_hotline(hotline, country_name: str, index: int, report: Report) -> None:
    where = f"{country_name!r} hotline[{index}]"
    if not isinstance(hotline, dict):
        report.error(f"{where}: hotline entry is not an object")
        return

    name = hotline.get("name")
    if not isinstance(name, str) or not name.strip():
        report.error(f"{where}: missing/empty required field 'name'")
        label = where
    else:
        label = f"{country_name!r} hotline {name!r}"

    category = hotline.get("category")
    if not isinstance(category, str) or not category.strip():
        report.error(f"{label}: missing/empty required field 'category'")
    elif not CATEGORY_SLUG_RE.match(category):
        report.error(
            f"{label}: 'category' {category!r} must be a non-empty lowercase "
            "slug (letters, digits, underscores; e.g. 'mental_health')"
        )

    status = hotline.get("verification_status")
    if status is not None and status not in VALID_VERIFICATION_STATUSES:
        report.error(f"{label}: invalid verification_status {status!r}")

    for field in LIST_FIELDS:
        if field in hotline and hotline[field] is not None and not isinstance(hotline[field], list):
            report.error(
                f"{label}: field '{field}' must be a list, got {type(hotline[field]).__name__}"
            )

    last_verified = hotline.get("last_verified")
    if last_verified is not None and not (
        isinstance(last_verified, str) and DATE_RE.match(last_verified)
    ):
        report.error(f"{label}: 'last_verified' {last_verified!r} is not an ISO date (YYYY-MM-DD) or null")

    if not has_contact(hotline):
        report.error(f"{label}: no contact channel (voice/sms/text/short_code/chat_url/email/website)")


def validate_country(
    country,
    index: int,
    report: Report,
    known_categories,
    unknown_category_counts: Counter,
    duplicate_groups: list,
) -> None:
    where = f"countries[{index}]"
    if not isinstance(country, dict):
        report.error(f"{where}: country entry is not an object")
        return

    name = country.get("country")
    if not isinstance(name, str) or not name.strip():
        report.error(f"{where}: missing/empty required field 'country'")
        name = name if isinstance(name, str) and name else where

    for field in ("alpha-2", "alpha-3", "region", "subregion", "notes"):
        if field in country and country[field] is not None and not isinstance(country[field], str):
            report.error(f"{name!r}: field '{field}' must be a string or null")

    if (
        "general_emergency" in country
        and country["general_emergency"] is not None
        and not isinstance(country["general_emergency"], list)
    ):
        report.error(f"{name!r}: field 'general_emergency' must be a list")

    hotlines = country.get("hotlines")
    if not isinstance(hotlines, list):
        report.error(f"{name!r}: field 'hotlines' must be a list")
        return

    for i, hotline in enumerate(hotlines):
        validate_hotline(hotline, name, i, report)
        if isinstance(hotline, dict) and known_categories is not None:
            category = hotline.get("category")
            if isinstance(category, str) and category and category not in known_categories:
                unknown_category_counts[category] += 1

    groups: dict[tuple, list[int]] = defaultdict(list)
    for i, hotline in enumerate(hotlines):
        if not isinstance(hotline, dict):
            continue
        key = contact_key(hotline)
        if is_empty_contact_key(key):
            continue
        groups[key].append(i)

    for indices in groups.values():
        if len(indices) > 1:
            names = [hotlines[i].get("name", f"[{i}]") for i in indices]
            duplicate_groups.append((name, names))


def validate_dataset(data, report: Report) -> None:
    if not isinstance(data, dict):
        report.error("root: dataset is not a JSON object")
        return

    if "$schema_version" not in data:
        report.error("root: missing required field '$schema_version'")

    categories_reference = data.get("categories_reference")
    known_categories = None
    if categories_reference is not None:
        if isinstance(categories_reference, dict):
            known_categories = set(categories_reference.keys())
        else:
            report.error("root: field 'categories_reference' must be an object")

    countries = data.get("countries")
    if not isinstance(countries, list):
        report.error("root: field 'countries' must be a list")
        return
    if not countries:
        report.error("root: field 'countries' must not be empty")

    unknown_category_counts: Counter = Counter()
    duplicate_groups: list = []
    for i, country in enumerate(countries):
        validate_country(country, i, report, known_categories, unknown_category_counts, duplicate_groups)

    if unknown_category_counts:
        total = sum(unknown_category_counts.values())
        breakdown = ", ".join(
            f"{category!r} ({count})"
            for category, count in sorted(unknown_category_counts.items())
        )
        report.warn(
            f"{total} hotline(s) use a category not listed in categories_reference: {breakdown}"
        )

    if duplicate_groups:
        total_records = sum(len(names) for _, names in duplicate_groups)
        sample = duplicate_groups[:MAX_DUPLICATE_SAMPLE]
        sample_desc = "; ".join(f"{country!r}: {', '.join(names)}" for country, names in sample)
        omitted = len(duplicate_groups) - len(sample)
        suffix = f"; {omitted} more group(s) not shown" if omitted else ""
        report.warn(
            f"exact-contact duplicate groups found: {len(duplicate_groups)} group(s) "
            f"covering {total_records} record(s) — sample: {sample_desc}{suffix}"
        )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Validate the canonical hotlines dataset's structural invariants. "
            "Read-only: this command never writes to disk."
        )
    )
    parser.add_argument(
        "--input",
        type=pathlib.Path,
        default=DEFAULT_INPUT,
        help=f"Path to the dataset JSON file to validate (default: {DEFAULT_INPUT}).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        raw = args.input.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"error: could not read {args.input}: {exc}", file=sys.stderr)
        return 2

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"error: could not parse {args.input} as JSON: {exc}", file=sys.stderr)
        return 2

    report = Report()
    validate_dataset(data, report)

    for warning in report.warnings:
        print(f"WARNING: {warning}")
    for error in report.errors:
        print(f"ERROR: {error}")

    print(f"\n{len(report.errors)} error(s), {len(report.warnings)} warning(s).")
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
