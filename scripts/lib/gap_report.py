from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from scripts.lib.promotion import normalize_text
from scripts.lib.safety import PROTECTED_CANONICAL_STATUSES, hotline_has_protected_status

SCHEMA_V2 = "2.0"
LOW_HOTLINE_COUNT_THRESHOLD = 2
TOP_QUEUE_LIMIT = 25
KEY_CATEGORY_WEIGHTS = {
    "suicide_crisis": 8,
    "child_protection": 6,
    "domestic_violence": 5,
    "lgbtqia": 2,
    "missing_persons": 2,
}
KEY_CATEGORY_LABELS = {
    "suicide_crisis": "Missing suicide/crisis line",
    "child_protection": "Missing child-protection line",
    "domestic_violence": "Missing domestic-violence line",
    "lgbtqia": "Missing LGBTQIA+ line",
    "missing_persons": "Missing missing-persons line",
}
ENRICHMENT_WEIGHTS = {
    "no_non_legacy_records": 10,
    "no_protected_records": 5,
    "low_hotline_count": 3,
    "missing_general_emergency": 2,
    "no_first_party_sources": 2,
    "no_last_verified": 2,
    "has_reviewable_preview": 3,
}
VERIFICATION_WEIGHTS = {
    "no_first_party_sources": 6,
    "no_last_verified": 6,
    "only_legacy_records": 8,
    "no_protected_records": 3,
    "preview_hotline_bonus": 2,
    "low_hotline_count": 1,
}
PREVIEW_REVIEW_WEIGHTS = {
    "preview_hotline": 3,
    "only_legacy_records": 5,
    "no_protected_records": 3,
    "missing_priority_category": 1,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def build_preview_index(preview_datasets: Iterable[dict]) -> dict[str, dict]:
    index: dict[str, dict] = {}
    for preview in preview_datasets:
        dataset_name = (
            ((preview.get("_preview_metadata") or {}).get("generated_from"))
            or ((preview.get("_preview_metadata") or {}).get("source_dataset"))
            or preview.get("methodology")
            or "preview"
        )
        for country in preview.get("countries", []):
            keys = {
                country.get("alpha-2"),
                normalize_text(country.get("country")),
            }
            for key in keys:
                if not key:
                    continue
                bucket = index.setdefault(
                    key,
                    {
                        "country": country.get("country"),
                        "alpha-2": country.get("alpha-2"),
                        "preview_country_count": 0,
                        "preview_hotline_count": 0,
                        "preview_datasets": [],
                    },
                )
                bucket["preview_country_count"] += 1
                bucket["preview_hotline_count"] += len(country.get("hotlines", []))
                if dataset_name not in bucket["preview_datasets"]:
                    bucket["preview_datasets"].append(dataset_name)
    for bucket in index.values():
        bucket["preview_datasets"].sort()
    return index


def hotline_has_first_party_source(hotline: dict) -> bool:
    if hotline.get("verification_status") == "verified_web":
        return True
    provenance = hotline.get("provenance") or {}
    if provenance.get("source_class") == "first_party":
        return True
    return any((evidence or {}).get("source_type") == "first_party" for evidence in provenance.get("evidence", []))


def hotline_has_last_verified(hotline: dict) -> bool:
    value = hotline.get("last_verified")
    return isinstance(value, str) and bool(value.strip())


def hotline_categories(country: dict) -> set[str]:
    return {hotline.get("category") for hotline in country.get("hotlines", []) if hotline.get("category")}


def category_gap_interpretation(no_protected_records: bool, no_first_party_sources: bool) -> str:
    if no_protected_records or no_first_party_sources:
        return "likely_research_gap"
    return "availability_uncertain"


def score_breakdown(country_gap: dict, mode: str) -> list[dict]:
    breakdown: list[dict] = []
    missing_categories = set(country_gap.get("missing_key_categories", []))

    if mode == "enrichment":
        weights = ENRICHMENT_WEIGHTS
        if country_gap["no_non_legacy_records"]:
            breakdown.append({"reason": "No non-legacy records", "weight": weights["no_non_legacy_records"]})
        if country_gap["no_protected_records"]:
            breakdown.append({"reason": "No protected/richer records", "weight": weights["no_protected_records"]})
        for category, weight in KEY_CATEGORY_WEIGHTS.items():
            if category in missing_categories:
                breakdown.append({"reason": KEY_CATEGORY_LABELS[category], "weight": weight})
        if country_gap["low_hotline_count"]:
            breakdown.append({"reason": f"Low hotline count (≤{LOW_HOTLINE_COUNT_THRESHOLD})", "weight": weights["low_hotline_count"]})
        if country_gap["missing_general_emergency"]:
            breakdown.append({"reason": "Missing general emergency number", "weight": weights["missing_general_emergency"]})
        if country_gap["no_first_party_sources"]:
            breakdown.append({"reason": "No first-party verified coverage", "weight": weights["no_first_party_sources"]})
        if country_gap["no_last_verified"]:
            breakdown.append({"reason": "No last_verified date on any hotline", "weight": weights["no_last_verified"]})
        if country_gap["reviewable_preview_hotline_count"]:
            breakdown.append({"reason": "Has reviewable supplemental preview data", "weight": weights["has_reviewable_preview"]})
        return breakdown

    if mode == "verification":
        weights = VERIFICATION_WEIGHTS
        if country_gap["only_legacy_records"]:
            breakdown.append({"reason": "All hotlines are legacy-unverified", "weight": weights["only_legacy_records"]})
        if country_gap["no_first_party_sources"]:
            breakdown.append({"reason": "No first-party verified coverage", "weight": weights["no_first_party_sources"]})
        if country_gap["no_last_verified"]:
            breakdown.append({"reason": "No last_verified date on any hotline", "weight": weights["no_last_verified"]})
        if country_gap["no_protected_records"]:
            breakdown.append({"reason": "No protected/richer records", "weight": weights["no_protected_records"]})
        if country_gap["reviewable_preview_hotline_count"]:
            bonus = min(country_gap["reviewable_preview_hotline_count"], 3) * weights["preview_hotline_bonus"]
            breakdown.append({"reason": "Supplemental preview rows available to verify", "weight": bonus})
        if country_gap["low_hotline_count"]:
            breakdown.append({"reason": f"Low hotline count (≤{LOW_HOTLINE_COUNT_THRESHOLD})", "weight": weights["low_hotline_count"]})
        return breakdown

    if mode == "preview_review":
        weights = PREVIEW_REVIEW_WEIGHTS
        preview_count = country_gap["reviewable_preview_hotline_count"]
        if preview_count:
            breakdown.append({"reason": "Supplemental preview hotlines waiting for review", "weight": preview_count * weights["preview_hotline"]})
        if country_gap["only_legacy_records"]:
            breakdown.append({"reason": "Canonical country is still legacy-only", "weight": weights["only_legacy_records"]})
        if country_gap["no_protected_records"]:
            breakdown.append({"reason": "Canonical country has no protected/richer records", "weight": weights["no_protected_records"]})
        missing_priority_category_count = len(missing_categories.intersection({"suicide_crisis", "child_protection", "domestic_violence"}))
        if missing_priority_category_count:
            breakdown.append(
                {
                    "reason": "Missing high-priority service categories",
                    "weight": missing_priority_category_count * weights["missing_priority_category"],
                }
            )
        return breakdown

    raise ValueError(f"Unsupported score mode: {mode}")


def total_score(breakdown: list[dict]) -> int:
    return sum(item["weight"] for item in breakdown)


def queue_entry(country_gap: dict, mode: str) -> dict:
    breakdown = score_breakdown(country_gap, mode)
    return {
        "country": country_gap["country"],
        "alpha-2": country_gap["alpha-2"],
        "score": total_score(breakdown),
        "hotline_count": country_gap["hotline_count"],
        "missing_key_categories": country_gap["missing_key_categories"],
        "reviewable_preview_hotline_count": country_gap["reviewable_preview_hotline_count"],
        "research_gap_interpretation": country_gap["research_gap_interpretation"],
        "reasons": breakdown,
    }


def analyze_country(country: dict, preview_index: dict[str, dict] | None = None) -> dict:
    hotlines = country.get("hotlines", [])
    statuses = Counter((hotline.get("verification_status") or "legacy_unverified") for hotline in hotlines)
    categories_present = sorted(hotline_categories(country))
    missing_key_categories = [category for category in KEY_CATEGORY_WEIGHTS if category not in categories_present]
    protected_count = sum(1 for hotline in hotlines if hotline_has_protected_status(hotline))
    non_legacy_count = sum(1 for hotline in hotlines if (hotline.get("verification_status") or "legacy_unverified") != "legacy_unverified")
    first_party_count = sum(1 for hotline in hotlines if hotline_has_first_party_source(hotline))
    last_verified_count = sum(1 for hotline in hotlines if hotline_has_last_verified(hotline))
    preview_stats = None
    if preview_index:
        preview_stats = preview_index.get(country.get("alpha-2")) or preview_index.get(normalize_text(country.get("country")))
    preview_hotline_count = (preview_stats or {}).get("preview_hotline_count", 0)

    no_hotlines = len(hotlines) == 0
    only_legacy_records = bool(hotlines) and set(statuses) == {"legacy_unverified"}
    no_non_legacy_records = non_legacy_count == 0
    no_protected_records = protected_count == 0
    no_first_party_sources = first_party_count == 0
    no_last_verified = last_verified_count == 0
    low_hotline_count = len(hotlines) <= LOW_HOTLINE_COUNT_THRESHOLD
    missing_general_emergency = not bool(country.get("general_emergency"))

    gap_flags = []
    if no_hotlines:
        gap_flags.append("no_hotlines")
    if missing_general_emergency:
        gap_flags.append("missing_general_emergency")
    if only_legacy_records:
        gap_flags.append("only_legacy_records")
    if no_non_legacy_records:
        gap_flags.append("no_non_legacy_records")
    if no_protected_records:
        gap_flags.append("no_protected_records")
    if no_first_party_sources:
        gap_flags.append("no_first_party_sources")
    if no_last_verified:
        gap_flags.append("no_last_verified")
    if low_hotline_count:
        gap_flags.append("low_hotline_count")
    if preview_hotline_count:
        gap_flags.append("has_reviewable_preview")
    gap_flags.extend(f"missing_category:{category}" for category in missing_key_categories)

    country_gap = {
        "country": country.get("country"),
        "alpha-2": country.get("alpha-2"),
        "alpha-3": country.get("alpha-3"),
        "region": country.get("region"),
        "subregion": country.get("subregion"),
        "hotline_count": len(hotlines),
        "general_emergency_count": len(country.get("general_emergency") or []),
        "categories_present": categories_present,
        "missing_key_categories": missing_key_categories,
        "verification_status_counts": dict(sorted(statuses.items())),
        "non_legacy_hotline_count": non_legacy_count,
        "protected_hotline_count": protected_count,
        "first_party_hotline_count": first_party_count,
        "last_verified_hotline_count": last_verified_count,
        "no_hotlines": no_hotlines,
        "only_legacy_records": only_legacy_records,
        "no_non_legacy_records": no_non_legacy_records,
        "no_protected_records": no_protected_records,
        "no_first_party_sources": no_first_party_sources,
        "no_last_verified": no_last_verified,
        "low_hotline_count": low_hotline_count,
        "missing_general_emergency": missing_general_emergency,
        "reviewable_preview_hotline_count": preview_hotline_count,
        "reviewable_preview_datasets": (preview_stats or {}).get("preview_datasets", []),
        "research_gap_interpretation": category_gap_interpretation(no_protected_records, no_first_party_sources),
        "gap_flags": gap_flags,
    }
    country_gap["priority_score"] = total_score(score_breakdown(country_gap, "enrichment"))
    country_gap["verification_priority_score"] = total_score(score_breakdown(country_gap, "verification"))
    country_gap["preview_review_priority_score"] = total_score(score_breakdown(country_gap, "preview_review"))
    return country_gap


def sorted_country_gaps(country_gaps: list[dict]) -> list[dict]:
    return sorted(country_gaps, key=lambda item: (-item["priority_score"], -item["verification_priority_score"], item["country"], item["alpha-2"]))


def build_priority_queues(country_gaps: list[dict], limit: int = TOP_QUEUE_LIMIT) -> dict:
    enrich_queue = sorted((queue_entry(gap, "enrichment") for gap in country_gaps), key=lambda item: (-item["score"], item["country"], item["alpha-2"]))[:limit]
    verify_queue = sorted((queue_entry(gap, "verification") for gap in country_gaps), key=lambda item: (-item["score"], item["country"], item["alpha-2"]))[:limit]
    review_queue = [
        queue_entry(gap, "preview_review")
        for gap in sorted(country_gaps, key=lambda item: (-item["preview_review_priority_score"], item["country"], item["alpha-2"]))
        if gap["reviewable_preview_hotline_count"] > 0
    ][:limit]
    return {
        "top_enrichment_targets": enrich_queue,
        "top_web_verification_targets": verify_queue,
        "top_preview_review_targets": review_queue,
    }


def summarize(country_gaps: list[dict], preview_index: dict[str, dict]) -> dict:
    status_counts = Counter()
    category_gap_counts = Counter()
    for gap in country_gaps:
        status_counts.update(gap["verification_status_counts"])
        category_gap_counts.update(gap["missing_key_categories"])
    preview_countries = {
        bucket.get("alpha-2") or normalize_text(bucket.get("country"))
        for bucket in preview_index.values()
        if bucket.get("alpha-2") or bucket.get("country")
    }
    return {
        "country_count": len(country_gaps),
        "countries_with_no_hotlines": sum(1 for gap in country_gaps if gap["no_hotlines"]),
        "countries_missing_general_emergency": sum(1 for gap in country_gaps if gap["missing_general_emergency"]),
        "countries_with_only_legacy_records": sum(1 for gap in country_gaps if gap["only_legacy_records"]),
        "countries_with_no_non_legacy_records": sum(1 for gap in country_gaps if gap["no_non_legacy_records"]),
        "countries_with_no_protected_records": sum(1 for gap in country_gaps if gap["no_protected_records"]),
        "countries_with_no_first_party_sources": sum(1 for gap in country_gaps if gap["no_first_party_sources"]),
        "countries_with_no_last_verified": sum(1 for gap in country_gaps if gap["no_last_verified"]),
        "countries_with_low_hotline_count": sum(1 for gap in country_gaps if gap["low_hotline_count"]),
        "countries_with_reviewable_preview": sum(1 for gap in country_gaps if gap["reviewable_preview_hotline_count"] > 0),
        "reviewable_preview_country_keys": len(preview_countries),
        "reviewable_preview_hotline_total": sum(gap["reviewable_preview_hotline_count"] for gap in country_gaps),
        "verification_status_counts": dict(sorted(status_counts.items())),
        "missing_key_category_counts": dict(sorted(category_gap_counts.items())),
    }


def build_gap_report(canonical: dict, preview_datasets: Iterable[dict] | None = None, queue_limit: int = TOP_QUEUE_LIMIT) -> dict:
    if canonical.get("$schema_version") != SCHEMA_V2:
        raise ValueError(f"Canonical dataset must use schema {SCHEMA_V2}.")
    preview_list = list(preview_datasets or [])
    preview_index = build_preview_index(preview_list)
    country_gaps = sorted_country_gaps([analyze_country(country, preview_index) for country in canonical.get("countries", [])])
    queues = build_priority_queues(country_gaps, limit=queue_limit)
    return {
        "$schema_version": canonical.get("$schema_version", SCHEMA_V2),
        "generated_at": utc_now(),
        "scoring_model": {
            "enrichment_weights": {
                **ENRICHMENT_WEIGHTS,
                **{f"missing_category:{key}": value for key, value in KEY_CATEGORY_WEIGHTS.items()},
            },
            "verification_weights": VERIFICATION_WEIGHTS,
            "preview_review_weights": PREVIEW_REVIEW_WEIGHTS,
            "low_hotline_count_threshold": LOW_HOTLINE_COUNT_THRESHOLD,
            "protected_statuses": sorted(PROTECTED_CANONICAL_STATUSES),
            "first_party_source_heuristic": "verification_status=verified_web or provenance.source_class/evidence.source_type includes first_party",
            "gap_interpretation": {
                "likely_research_gap": "Country lacks protected coverage or first-party evidence, so missing categories are more likely a research backlog.",
                "availability_uncertain": "Country has some richer coverage; missing categories may reflect true service availability or incomplete research.",
            },
        },
        "summary": summarize(country_gaps, preview_index),
        "queues": queues,
        "category_gap_reports": {
            category: [gap["country"] for gap in country_gaps if category in gap["missing_key_categories"]]
            for category in KEY_CATEGORY_WEIGHTS
        },
        "countries": country_gaps,
    }


def markdown_table(headers: list[str], rows: list[list[object]]) -> list[str]:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(str(cell) for cell in row) + " |")
    return lines


def render_gap_report_markdown(report: dict) -> str:
    summary = report["summary"]
    queues = report["queues"]
    top_countries = report["countries"][:25]
    lines = [
        "# Gap report",
        "",
        f"- Generated at: {report['generated_at']}",
        f"- Countries analyzed: {summary['country_count']}",
        f"- Countries with only legacy records: {summary['countries_with_only_legacy_records']}",
        f"- Countries with no protected records: {summary['countries_with_no_protected_records']}",
        f"- Countries with no first-party sources: {summary['countries_with_no_first_party_sources']}",
        f"- Countries with no last_verified date: {summary['countries_with_no_last_verified']}",
        f"- Countries with reviewable preview data: {summary['countries_with_reviewable_preview']}",
        "",
        "## Interpretation",
        "",
        "- `likely_research_gap`: missing categories are probably a backlog problem because the country lacks protected or first-party coverage.",
        "- `availability_uncertain`: the country already has some richer coverage, so a missing category may represent either real service absence or incomplete research.",
        "",
        "## Missing key category counts",
        "",
    ]
    for category, count in summary["missing_key_category_counts"].items():
        lines.append(f"- `{category}`: {count}")
    lines.extend(["", "## Top enrichment targets", ""])
    lines.extend(
        markdown_table(
            ["Country", "Score", "Hotlines", "Missing key categories", "Preview", "Interpretation"],
            [
                [
                    item["country"],
                    item["score"],
                    item["hotline_count"],
                    ", ".join(item["missing_key_categories"]) or "—",
                    item["reviewable_preview_hotline_count"],
                    item["research_gap_interpretation"],
                ]
                for item in queues["top_enrichment_targets"]
            ],
        )
    )
    lines.extend(["", "## Top web-verification targets", ""])
    lines.extend(
        markdown_table(
            ["Country", "Score", "Hotlines", "Preview", "Top reasons"],
            [
                [
                    item["country"],
                    item["score"],
                    item["hotline_count"],
                    item["reviewable_preview_hotline_count"],
                    "; ".join(reason["reason"] for reason in item["reasons"][:3]) or "—",
                ]
                for item in queues["top_web_verification_targets"]
            ],
        )
    )
    lines.extend(["", "## Top supplemental preview review targets", ""])
    preview_rows = [
        [
            item["country"],
            item["score"],
            item["reviewable_preview_hotline_count"],
            ", ".join(item["missing_key_categories"]) or "—",
            "; ".join(reason["reason"] for reason in item["reasons"][:3]) or "—",
        ]
        for item in queues["top_preview_review_targets"]
    ]
    if preview_rows:
        lines.extend(markdown_table(["Country", "Score", "Preview hotlines", "Missing key categories", "Top reasons"], preview_rows))
    else:
        lines.append("No preview-backed review targets were available.")

    lines.extend(["", "## Category gap reports", ""])
    for category, countries in report["category_gap_reports"].items():
        preview = ", ".join(countries[:15])
        suffix = " ..." if len(countries) > 15 else ""
        lines.append(f"- `{category}`: {len(countries)} countries missing ({preview}{suffix})")

    lines.extend(["", "## Highest-priority country details", ""])
    lines.extend(
        markdown_table(
            ["Country", "Priority", "Verification", "Protected", "First-party", "Gap flags"],
            [
                [
                    gap["country"],
                    gap["priority_score"],
                    gap["verification_priority_score"],
                    gap["protected_hotline_count"],
                    gap["first_party_hotline_count"],
                    ", ".join(gap["gap_flags"][:6]) + (" ..." if len(gap["gap_flags"]) > 6 else ""),
                ]
                for gap in top_countries
            ],
        )
    )
    lines.append("")
    return "\n".join(lines)
