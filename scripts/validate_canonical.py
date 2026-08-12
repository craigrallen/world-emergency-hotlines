#!/usr/bin/env python3
"""
Stdlib-only, read-only validator for the canonical hotlines dataset.

Checks schema/country/hotline structural invariants (required fields,
verification_status enum, last_verified date format, list-typed fields,
category slug shape, geography non-empty, and that every hotline exposes at
least one contact channel). Categories missing from categories_reference and
exact-contact duplicate groups within a country are reported as summarized
warnings (not one line per record/group), and never affect the exit code,
since candidate duplicates are surfaced separately (for manual review) by
dedupe_check.py.

"Exact contact" means an identical, complete normalized set of every
contact field (voice/sms/text/short_codes + chat_url/email/website) — see
contact_key() below. Per docs/service-record-contract.md, country +
geography + category is a service-*scope* descriptor, not an identity key,
so even an exact-contact match is only ever a manual-review candidate, never
a confirmed duplicate or a distinctness determination. Each exact-contact
group is classified by its category composition into exactly one of three
mutually exclusive labels — same_category_duplicate_candidate,
cross_category_shared_contact_candidate, or
mixed_scope_and_duplicate_candidate (see classify_group() below) — plus an
orthogonal cross-geography count. This classification is read-only
reporting: it never merges, deletes, or otherwise mutates records, and never
asserts that a group is confirmed distinct or a confirmed duplicate.

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

# Three mutually exclusive group-level classifications for an exact-contact
# group, keyed by category composition (see classify_group()). Order here
# also fixes the order of the reported breakdown.
GROUP_CLASSIFICATION_LABELS = {
    "same_category_duplicate_candidate": "same-category duplicate candidate(s)",
    "cross_category_shared_contact_candidate": "cross-category shared-contact candidate(s)",
    "mixed_scope_and_duplicate_candidate": "mixed scope-and-duplicate candidate(s)",
}


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


def classify_group(category_counts) -> str:
    """Classify an exact-contact group by its category composition.

    Three mutually exclusive classifications (see
    docs/service-record-contract.md §3):

    - same_category_duplicate_candidate: exactly one category is
      represented in the group.
    - cross_category_shared_contact_candidate: more than one category is
      represented, and every one of them occurs exactly once.
    - mixed_scope_and_duplicate_candidate: more than one category is
      represented, and at least one occurs more than once — a
      same-category duplicate candidate may be hiding inside an otherwise
      mixed group, so this must never be folded into the cross-category
      label above.

    A category subset match is still only a candidate for human review; no
    classification here asserts a confirmed duplicate or confirmed
    distinctness.
    """
    if len(category_counts) <= 1:
        return "same_category_duplicate_candidate"
    if all(count == 1 for count in category_counts.values()):
        return "cross_category_shared_contact_candidate"
    return "mixed_scope_and_duplicate_candidate"


def _geo_value(hotline: dict):
    geography = hotline.get("geography")
    return geography.strip() if isinstance(geography, str) else geography


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

    geography = hotline.get("geography")
    if not isinstance(geography, str) or not geography.strip():
        report.error(
            f"{label}: missing/empty required field 'geography' — every hotline must "
            "declare a non-empty published service area "
            "(see docs/service-record-contract.md)"
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
            category_counts = Counter(hotlines[i].get("category") for i in indices)
            geographies = {_geo_value(hotlines[i]) for i in indices}
            duplicate_groups.append(
                {
                    "country": name,
                    "names": names,
                    "category_counts": category_counts,
                    "geographies": geographies,
                }
            )


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
        total_records = sum(len(g["names"]) for g in duplicate_groups)
        sample = duplicate_groups[:MAX_DUPLICATE_SAMPLE]
        sample_desc = "; ".join(
            f"{g['country']!r}: {', '.join(g['names'])}" for g in sample
        )
        omitted = len(duplicate_groups) - len(sample)
        suffix = f"; {omitted} more group(s) not shown" if omitted else ""
        report.warn(
            f"exact-contact duplicate groups found: {len(duplicate_groups)} group(s) "
            f"covering {total_records} record(s) — sample: {sample_desc}{suffix}"
        )

        # Classification only, per docs/service-record-contract.md: country +
        # geography + category is a scope descriptor, not an identity key,
        # so shared contact channels are never more than a manual-review
        # candidate. Three mutually exclusive classifications, by category
        # composition within the group (see classify_group()): a
        # same-category group is a duplicate candidate; a group where every
        # represented category occurs exactly once is a cross-category
        # shared-contact candidate; a group with more than one category
        # where at least one repeats is a mixed group — a same-category
        # duplicate candidate can be hiding inside it, so it is reported as
        # its own bucket rather than being folded into (and hidden by) the
        # cross-category bucket. Cross-geography is tracked as an
        # orthogonal count, not a distinctness signal. This is bounded,
        # read-only reporting — it never mutates records and never asserts
        # a group is confirmed distinct or a confirmed duplicate.
        classification_counts = Counter(
            classify_group(g["category_counts"]) for g in duplicate_groups
        )
        cross_geography_groups = [g for g in duplicate_groups if len(g["geographies"]) > 1]
        breakdown = ", ".join(
            f"{classification_counts.get(key, 0)} {label}"
            for key, label in GROUP_CLASSIFICATION_LABELS.items()
        )
        report.warn(
            "exact-contact groups by classification (manual review candidates "
            "only; no automatic merge/delete, and none of these is a "
            "distinctness or duplicate determination — see "
            f"docs/service-record-contract.md): {breakdown}; "
            f"{len(cross_geography_groups)} cross-geography candidate(s) "
            "(orthogonal count, not a distinctness signal)"
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
