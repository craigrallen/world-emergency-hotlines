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
import datetime as dt
import ipaddress
import json
import math
import pathlib
import re
import sys
import unicodedata
from urllib.parse import urlsplit
from zoneinfo import available_timezones
from collections import Counter, defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.record_ids import RECORD_ID_RE

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
LANGUAGE_CODE_RE = re.compile(r"^[a-z]{2,3}(?:-[A-Z]{2})?$")
TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

SCOPE_LEVELS = frozenset({"country", "state_region", "county", "city", "local", "multi_area", "remote"})
SCOPE_SECTIONS = frozenset({"geography", "eligibility", "availability", "languages"})
CHANNELS = frozenset({"phone", "text", "chat", "email"})
DAYS = frozenset({"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"})
STRUCTURED_SOURCE_TYPES = frozenset({"first_party", "government", "authority"})
STRUCTURED_CONFIDENCE = frozenset({"medium", "high"})
SCOPE_KEYS = {
    "geography": frozenset({"level", "areas"}),
    "eligibility": frozenset({"description", "minimum_age", "maximum_age", "populations"}),
    "availability": frozenset({"always_open", "timezone", "schedule"}),
}
PERIOD_KEYS = frozenset({"days", "opens", "closes"})
LANGUAGE_KEYS = frozenset({"code", "name", "channels"})
# Other provenance evidence remains backward compatible. Only entries matched
# to service_scope claims are subject to this strict claim contract.
STRUCTURED_EVIDENCE_KEYS = frozenset(
    {"field", "value", "note", "source_url", "source_type", "checked_at", "confidence"}
)

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


def _nonempty_string(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _real_iso_date(value) -> bool:
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return False
    try:
        return dt.date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _http_url_with_hostname(value) -> bool:
    if not isinstance(value, str) or not value or any(
        char.isspace() or unicodedata.category(char) in {"Cc", "Cf"} for char in value
    ):
        return False
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        if parsed.scheme not in {"http", "https"} or not hostname or hostname.startswith(".") or hostname.endswith("."):
            return False
        # Accessing port validates its syntax and range.
        parsed.port
        if ":" in hostname or re.fullmatch(r"[0-9.]+", hostname):
            ipaddress.ip_address(hostname)
            return True
        if hostname == "localhost":
            return True
        ascii_labels = []
        for label in hostname.split("."):
            if not label:
                return False
            if label.startswith("xn--"):
                unicode_label = label.encode("ascii").decode("idna")
                ascii_label = unicode_label.encode("idna").decode("ascii")
                if ascii_label != label:
                    return False
            else:
                ascii_label = label.encode("idna").decode("ascii")
                unicode_label = ascii_label.encode("ascii").decode("idna")
                normalized_original = unicodedata.normalize("NFC", label).casefold()
                normalized_roundtrip = unicodedata.normalize("NFC", unicode_label).casefold()
                if normalized_roundtrip != normalized_original:
                    return False
            if (
                len(ascii_label) > 63
                or ascii_label.startswith("-")
                or ascii_label.endswith("-")
                or not re.fullmatch(r"[A-Za-z0-9-]+", ascii_label)
            ):
                return False
            ascii_labels.append(ascii_label)
        ascii_host = ".".join(ascii_labels)
        return len(ascii_host) <= 253
    except (UnicodeError, ValueError):
        return False


def _claim_content(value) -> bool:
    """Accept a non-blank note or a non-empty JSON value (false and zero are claims)."""
    if isinstance(value, str):
        return bool(value.strip())
    if value is None:
        return False
    if isinstance(value, (list, dict)):
        return bool(value)
    return isinstance(value, (bool, int)) or (isinstance(value, float) and math.isfinite(value))


def _reject_unknown_keys(value: dict, allowed: frozenset[str], path: str, label: str, report: Report) -> None:
    unknown = set(value) - allowed
    if unknown:
        report.error(f"{label}: '{path}' has unknown key(s): {', '.join(sorted(unknown))}")


def _evidence_fields(hotline: dict) -> set[str]:
    provenance = hotline.get("provenance")
    if not isinstance(provenance, dict):
        return set()
    evidence = provenance.get("evidence")
    if not isinstance(evidence, list):
        return set()
    fields: set[str] = set()
    for item in evidence:
        if isinstance(item, dict):
            field = item.get("field")
            if isinstance(field, str) and field.strip():
                fields.add(field)
    return fields


def _structured_evidence(hotline: dict, field: str) -> list[dict]:
    provenance = hotline.get("provenance")
    evidence = provenance.get("evidence") if isinstance(provenance, dict) else None
    return [item for item in (evidence or []) if isinstance(item, dict) and item.get("field") == field]


def validate_service_scope(scope, hotline: dict, label: str, report: Report) -> None:
    """Validate optional, source-backed structured scope without requiring it on legacy records."""
    if not isinstance(scope, dict) or not scope:
        report.error(f"{label}: 'service_scope' must be a non-empty object when present")
        return
    unknown = set(scope) - SCOPE_SECTIONS
    if unknown:
        report.error(f"{label}: 'service_scope' has unknown section(s): {', '.join(sorted(unknown))}")

    for section in SCOPE_SECTIONS:
        if section not in scope:
            continue
        field = f"service_scope.{section}"
        evidence = _structured_evidence(hotline, field)
        if not evidence:
            report.error(f"{label}: populated '{field}' requires matching provenance evidence")
            continue
        for i, item in enumerate(evidence):
            _reject_unknown_keys(item, STRUCTURED_EVIDENCE_KEYS, f"{field} evidence[{i}]", label, report)
            source_url = item.get("source_url")
            if not _http_url_with_hostname(source_url):
                report.error(f"{label}: {field} evidence[{i}] requires a parseable HTTP(S) source_url with a hostname")
            if item.get("source_type") not in STRUCTURED_SOURCE_TYPES:
                report.error(f"{label}: {field} evidence[{i}] requires first_party/government/authority source_type")
            if not _real_iso_date(item.get("checked_at")):
                report.error(f"{label}: {field} evidence[{i}] requires a real ISO checked_at date")
            if item.get("confidence") not in STRUCTURED_CONFIDENCE:
                report.error(f"{label}: {field} evidence[{i}] confidence must be medium or high")
            if not (_claim_content(item.get("value")) or _nonempty_string(item.get("note"))):
                report.error(f"{label}: {field} evidence[{i}] requires non-empty claim-binding value or note")

    geography = scope.get("geography")
    if geography is not None:
        if not isinstance(geography, dict):
            report.error(f"{label}: 'service_scope.geography' must be an object")
        else:
            _reject_unknown_keys(geography, SCOPE_KEYS["geography"], "service_scope.geography", label, report)
            if geography.get("level") not in SCOPE_LEVELS:
                report.error(f"{label}: invalid service_scope.geography.level {geography.get('level')!r}")
            areas = geography.get("areas")
            if not isinstance(areas, list) or not areas or not all(_nonempty_string(v) for v in areas):
                report.error(f"{label}: 'service_scope.geography.areas' must be a non-empty string list")

    eligibility = scope.get("eligibility")
    if eligibility is not None:
        if not isinstance(eligibility, dict):
            report.error(f"{label}: 'service_scope.eligibility' must be an object")
        else:
            _reject_unknown_keys(eligibility, SCOPE_KEYS["eligibility"], "service_scope.eligibility", label, report)
            description = eligibility.get("description")
            populations = eligibility.get("populations", [])
            if description is not None and not _nonempty_string(description):
                report.error(f"{label}: service_scope.eligibility.description must be a non-empty string")
            if not isinstance(populations, list) or not all(_nonempty_string(v) for v in populations):
                report.error(f"{label}: service_scope.eligibility.populations must be a string list")
            ages = [eligibility.get("minimum_age"), eligibility.get("maximum_age")]
            if any(v is not None and (not isinstance(v, int) or isinstance(v, bool) or v < 0 or v > 130) for v in ages):
                report.error(f"{label}: eligibility ages must be integer years from 0 to 130")
            minimum_age = eligibility.get("minimum_age")
            maximum_age = eligibility.get("maximum_age")
            if isinstance(minimum_age, int) and isinstance(maximum_age, int) and minimum_age > maximum_age:
                report.error(f"{label}: eligibility minimum_age must not exceed maximum_age")
            if description is None and not populations and all(v is None for v in ages):
                report.error(f"{label}: 'service_scope.eligibility' must contain a claim")

    availability = scope.get("availability")
    if availability is not None:
        if not isinstance(availability, dict):
            report.error(f"{label}: 'service_scope.availability' must be an object")
        else:
            _reject_unknown_keys(availability, SCOPE_KEYS["availability"], "service_scope.availability", label, report)
            always_open = availability.get("always_open")
            if not isinstance(always_open, bool):
                report.error(f"{label}: service_scope.availability.always_open must be boolean")
            timezone = availability.get("timezone")
            if timezone is not None and (
                not _nonempty_string(timezone)
                or (timezone not in {"UTC", "GMT"} and timezone not in available_timezones())
            ):
                report.error(f"{label}: service_scope.availability.timezone {timezone!r} must be an available IANA zone (UTC/GMT explicitly allowed)")
            schedule = availability.get("schedule", [])
            if not isinstance(schedule, list):
                report.error(f"{label}: service_scope.availability.schedule must be a list")
            else:
                for i, period in enumerate(schedule):
                    if not isinstance(period, dict):
                        report.error(f"{label}: availability.schedule[{i}] must be an object")
                        continue
                    _reject_unknown_keys(period, PERIOD_KEYS, f"service_scope.availability.schedule[{i}]", label, report)
                    days = period.get("days")
                    if not isinstance(days, list) or not days or any(day not in DAYS for day in days):
                        report.error(f"{label}: availability.schedule[{i}].days contains invalid weekdays")
                    if not TIME_RE.fullmatch(str(period.get("opens", ""))) or not TIME_RE.fullmatch(str(period.get("closes", ""))):
                        report.error(f"{label}: availability.schedule[{i}] opens/closes must use HH:MM")
            if always_open is True and schedule:
                report.error(f"{label}: always-open availability must not also define a schedule")
            if always_open is False and not schedule:
                report.error(f"{label}: non-24/7 availability requires a schedule")

    languages = scope.get("languages")
    if languages is not None:
        if not isinstance(languages, list) or not languages:
            report.error(f"{label}: 'service_scope.languages' must be a non-empty list")
        else:
            for i, language in enumerate(languages):
                if not isinstance(language, dict) or not _nonempty_string(language.get("name")):
                    report.error(f"{label}: service_scope.languages[{i}] requires a name")
                    continue
                _reject_unknown_keys(language, LANGUAGE_KEYS, f"service_scope.languages[{i}]", label, report)
                code = language.get("code")
                if code is not None and (not isinstance(code, str) or not LANGUAGE_CODE_RE.fullmatch(code)):
                    report.error(f"{label}: service_scope.languages[{i}].code is invalid")
                channels = language.get("channels")
                if not isinstance(channels, list) or not channels or any(v not in CHANNELS for v in channels):
                    report.error(f"{label}: service_scope.languages[{i}].channels contains invalid channels")


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

    record_id = hotline.get("id")
    if not isinstance(record_id, str) or not RECORD_ID_RE.fullmatch(record_id):
        report.error(f"{label}: missing or invalid immutable 'id' (expected weh_ plus 24 lowercase hex characters)")

    replaced_by = hotline.get("replaced_by")
    if replaced_by is not None and (
        not isinstance(replaced_by, str) or not RECORD_ID_RE.fullmatch(replaced_by)
    ):
        report.error(f"{label}: invalid 'replaced_by' record ID {replaced_by!r}")
    if replaced_by == record_id:
        report.error(f"{label}: 'replaced_by' must not reference the same record")
    if replaced_by is not None and hotline.get("verification_status") != "deprecated":
        report.error(f"{label}: 'replaced_by' is only valid when verification_status is 'deprecated'")

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
    if last_verified is not None and not _real_iso_date(last_verified):
        report.error(f"{label}: 'last_verified' {last_verified!r} is not an ISO date (YYYY-MM-DD) or null")

    if "service_scope" in hotline:
        validate_service_scope(hotline["service_scope"], hotline, label, report)

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
    record_locations: dict[str, str] = {}
    replacement_refs: list[tuple[str, str, str]] = []
    for i, country in enumerate(countries):
        validate_country(country, i, report, known_categories, unknown_category_counts, duplicate_groups)
        if not isinstance(country, dict):
            continue
        for j, hotline in enumerate(country.get("hotlines", [])):
            if not isinstance(hotline, dict):
                continue
            record_id = hotline.get("id")
            where = f"{country.get('country', f'countries[{i}]')!r} hotline[{j}]"
            if isinstance(record_id, str) and RECORD_ID_RE.fullmatch(record_id):
                if record_id in record_locations:
                    report.error(f"{where}: duplicate immutable 'id' {record_id!r}; first used by {record_locations[record_id]}")
                else:
                    record_locations[record_id] = where
            replaced_by = hotline.get("replaced_by")
            if isinstance(replaced_by, str) and RECORD_ID_RE.fullmatch(replaced_by):
                replacement_refs.append((where, record_id if isinstance(record_id, str) else "", replaced_by))

    for where, _record_id, replaced_by in replacement_refs:
        if replaced_by not in record_locations:
            report.error(f"{where}: 'replaced_by' references unknown record ID {replaced_by!r}")

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
