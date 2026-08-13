#!/usr/bin/env python3
"""Build a deterministic, read-only freshness review report for hotlines.json.

The report is operational triage, not verification. It never changes
verification_status, last_verified, sources, or any other canonical field.
A record remains stale or undated until a human reviews current evidence and
applies a separate canonical-data change.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import hashlib
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CANONICAL = ROOT / "hotlines.json"
CRITICAL_CATEGORIES = {"emergency", "suicide_crisis"}
DEFAULT_STALE_DAYS = 90
DEFAULT_REVIEW_LIMIT = 100


def iso_date(value: str, label: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(f"{label} must be YYYY-MM-DD, got {value!r}") from exc


def record_age(last_verified: object, as_of: dt.date) -> tuple[str, int | None]:
    if not last_verified:
        return "undated", None
    try:
        checked = dt.date.fromisoformat(str(last_verified))
    except ValueError:
        return "invalid_date", None
    age = (as_of - checked).days
    if age < 0:
        return "future_date", age
    return "dated", age


def build_report(data: dict, as_of: dt.date, stale_days: int, review_limit: int, dataset_version: str | None = None) -> dict:
    status_counts: Counter[str] = Counter()
    category_counts: Counter[str] = Counter()
    freshness_counts: Counter[str] = Counter()
    stale_by_status: Counter[str] = Counter()
    critical_review = []
    general_review = []
    total = 0

    for country in data.get("countries", []):
        country_name = country.get("country") or ""
        for index, hotline in enumerate(country.get("hotlines", [])):
            total += 1
            status = hotline.get("verification_status") or "missing"
            category = hotline.get("category") or "missing"
            status_counts[status] += 1
            category_counts[category] += 1

            date_state, age = record_age(hotline.get("last_verified"), as_of)
            if date_state == "undated":
                freshness = "undated"
            elif date_state == "dated" and age is not None and age >= stale_days:
                freshness = "stale"
            elif date_state == "dated":
                freshness = "current"
            else:
                freshness = date_state
            freshness_counts[freshness] += 1

            if freshness not in {"undated", "stale", "invalid_date", "future_date"}:
                continue
            stale_by_status[status] += 1
            row = {
                "record_id": hotline.get("id"),
                "country": country_name,
                "record_index": index,
                "name": hotline.get("name") or "",
                "category": category,
                "geography": hotline.get("geography") or "",
                "verification_status": status,
                "last_verified": hotline.get("last_verified"),
                "age_days": age,
                "freshness": freshness,
            }
            if category in CRITICAL_CATEGORIES:
                critical_review.append(row)
            else:
                general_review.append(row)

    def priority(row: dict) -> tuple:
        state_rank = {"invalid_date": 0, "future_date": 1, "undated": 2, "stale": 3}
        age_rank = -(row["age_days"] or 0)
        return (
            state_rank.get(row["freshness"], 9),
            age_rank,
            row["country"].casefold(),
            row["category"],
            row["name"].casefold(),
            row["record_index"],
        )

    critical_review.sort(key=priority)
    general_review.sort(key=priority)
    review_records = critical_review + general_review
    review_queue = review_records[:review_limit]

    return {
        "schema_version": "1.0",
        "canonical_hash": dataset_version,
        "as_of": as_of.isoformat(),
        "stale_after_days": stale_days,
        "review_limit": review_limit,
        "summary": {
            "total_records": total,
            "current": freshness_counts["current"],
            "stale": freshness_counts["stale"],
            "undated": freshness_counts["undated"],
            "invalid_date": freshness_counts["invalid_date"],
            "future_date": freshness_counts["future_date"],
            "review_required": sum(
                freshness_counts[key]
                for key in ("stale", "undated", "invalid_date", "future_date")
            ),
            "critical_review_required": len(critical_review),
        },
        "review_required_by_status": dict(sorted(stale_by_status.items())),
        "all_records_by_status": dict(sorted(status_counts.items())),
        "all_records_by_category": dict(sorted(category_counts.items())),
        "review_queue": review_queue,
        "review_records": review_records,
        "review_queue_total": len(review_records),
        "review_queue_omitted": max(0, len(review_records) - len(review_queue)),
        "review_queue_truncated": len(review_records) > review_limit,
        "policy": {
            "critical_categories_first": sorted(CRITICAL_CATEGORIES),
            "meaning": "Freshness flags are review prompts, not evidence that a service is invalid.",
            "mutation": "This report does not modify canonical data or verification metadata.",
        },
    }


def markdown(report: dict) -> str:
    summary = report["summary"]
    lines = [
        "# Hotline freshness review",
        "",
        f"- As of: `{report['as_of']}`",
        f"- Stale after: {report['stale_after_days']} days",
        f"- Total records: {summary['total_records']}",
        f"- Current: {summary['current']}",
        f"- Stale: {summary['stale']}",
        f"- Undated: {summary['undated']}",
        f"- Invalid dates: {summary['invalid_date']}",
        f"- Future dates: {summary['future_date']}",
        f"- Review required: {summary['review_required']}",
        f"- Crisis-critical review required: {summary['critical_review_required']}",
        "",
        "> Freshness flags are review prompts, not evidence that a service is invalid. This report never modifies canonical data.",
        "",
        "## Review required by verification status",
        "",
    ]
    for status, count in report["review_required_by_status"].items():
        lines.append(f"- `{status}`: {count}")

    lines += [
        "",
        f"## Deterministic review queue (first {report['review_limit']})",
        "",
        "Crisis-critical categories (`emergency`, `suicide_crisis`) are listed before all other categories. Within each section, malformed/future dates, undated records, and then oldest stale records are prioritized.",
        "",
        "| Country | Record | Category | Status | Last verified | Age | Freshness |",
        "| --- | --- | --- | --- | --- | ---: | --- |",
    ]
    for row in report["review_queue"]:
        last_verified = row["last_verified"] or "—"
        age = "—" if row["age_days"] is None else str(row["age_days"])
        name = str(row["name"]).replace("|", "\\|")
        country = str(row["country"]).replace("|", "\\|")
        lines.append(
            f"| {country} | {name} | `{row['category']}` | "
            f"`{row['verification_status']}` | {last_verified} | {age} | "
            f"`{row['freshness']}` |"
        )
    if report["review_queue_truncated"]:
        lines += ["", f"Queue preview omitted {report['review_queue_omitted']} records. The JSON `review_records` array contains all {report['review_queue_total']} review-required records."]
    return "\n".join(lines) + "\n"


def guard_output(path: Path, input_path: Path, suffix: str) -> None:
    resolved = path.resolve()
    if resolved in {input_path.resolve(), CANONICAL.resolve()}:
        raise SystemExit(f"report output must not overwrite a dataset: {resolved}")
    if path.suffix.lower() != suffix:
        raise SystemExit(f"report output must end in {suffix}: {path}")
    if resolved.exists():
        raise SystemExit(f"report output already exists; choose a new path: {resolved}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=CANONICAL)
    parser.add_argument("--as-of", required=True, help="Deterministic report date (YYYY-MM-DD)")
    parser.add_argument("--stale-days", type=int, default=DEFAULT_STALE_DAYS)
    parser.add_argument("--review-limit", type=int, default=DEFAULT_REVIEW_LIMIT)
    parser.add_argument("--report", type=Path, help="Optional Markdown report path")
    parser.add_argument("--json-report", type=Path, help="Optional JSON report path")
    args = parser.parse_args(argv)
    if args.stale_days < 1:
        parser.error("--stale-days must be at least 1")
    if args.review_limit < 1:
        parser.error("--review-limit must be at least 1")
    try:
        args.as_of = iso_date(args.as_of, "--as-of")
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))
    if args.report:
        guard_output(args.report, args.input, ".md")
    if args.json_report:
        guard_output(args.json_report, args.input, ".json")
    if args.report and args.json_report and args.report.resolve() == args.json_report.resolve():
        parser.error("--report and --json-report must not alias each other")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    raw = args.input.read_bytes()
    data = json.loads(raw)
    report = build_report(data, args.as_of, args.stale_days, args.review_limit, "sha256:" + hashlib.sha256(raw).hexdigest())
    print(json.dumps(report["summary"], sort_keys=True))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(markdown(report), encoding="utf-8")
        print(f"Markdown report: {args.report}")
    if args.json_report:
        args.json_report.parent.mkdir(parents=True, exist_ok=True)
        args.json_report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"JSON report: {args.json_report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
