#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.provenance import merge_provenance, normalize_provenance
from scripts.lib.promotion import (
    LIST_APPEND_FIELDS,
    SAFE_CANDIDATE_TYPES,
    SAFE_FIELD_ACTIONS,
    SCALAR_FILL_FIELDS,
    normalize_text,
    prepare_hotline,
    unique_list,
)
from scripts.lib.safety import canonical_write_requested, country_has_protected_hotlines, validate_promotion_candidate, would_downgrade_status

SCHEMA_V2 = "2.0"
DEFAULT_REPORT_DIR = ROOT / "REPORTS"
ALLOWED_APPROVAL_STATES = frozenset({"approved", "rejected", "needs_manual_source_check"})


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply reviewed promotion candidates into the canonical dataset.")
    parser.add_argument("--canonical", required=True, help="Path to the canonical schema-v2 dataset.")
    parser.add_argument("--candidates", required=True, help="Path to the promotion candidate bundle JSON.")
    parser.add_argument("--approvals", help="Optional reviewer approvals JSON. Required for --apply.")
    parser.add_argument("--report", help="Optional explicit path for the apply report markdown.")
    parser.add_argument("--apply", action="store_true", help="Write the updated canonical dataset.")
    return parser.parse_args(argv)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_index(canonical: dict) -> tuple[dict[str, dict], dict[str, dict]]:
    by_alpha2 = {country.get("alpha-2"): country for country in canonical.get("countries", []) if country.get("alpha-2")}
    by_name = {normalize_text(country.get("country")): country for country in canonical.get("countries", [])}
    return by_alpha2, by_name


def build_hotline_index(country: dict) -> dict[str, dict]:
    return {
        normalize_text(hotline.get("name")): hotline
        for hotline in country.get("hotlines", [])
        if hotline.get("name")
    }


def report_path_for(args: argparse.Namespace) -> Path:
    if args.report:
        return Path(args.report)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_REPORT_DIR / f"promotion_apply_{timestamp}.md"


def approvals_by_candidate(approvals_path: Path | None) -> dict[str, dict]:
    if approvals_path is None:
        return {}
    payload = load_json(approvals_path)
    decisions = payload.get("decisions")
    if not isinstance(decisions, list):
        raise ValueError("Approvals file must contain a top-level 'decisions' array.")
    out = {}
    for decision in decisions:
        state = decision.get("state")
        candidate_id = decision.get("candidate_id")
        if state not in ALLOWED_APPROVAL_STATES:
            raise ValueError(f"Unsupported approval state for candidate {candidate_id!r}: {state!r}")
        out[candidate_id] = decision
    return out


def require_safe_candidate(candidate: dict, protected_country_names: set[str]) -> None:
    candidate_type = candidate.get("candidate_type")
    if candidate_type not in SAFE_CANDIDATE_TYPES:
        raise ValueError(f"Unsupported candidate_type {candidate_type!r}")
    validate_promotion_candidate(candidate, protected_country_names)
    for field, action in (candidate.get("field_actions") or {}).items():
        if action not in SAFE_FIELD_ACTIONS and not (candidate_type == "append_new_hotline" and field == "hotlines" and action == "append_unique"):
            raise ValueError(f"Unsupported field action {action!r} for field {field!r} in candidate {candidate.get('candidate_id')}")


def apply_append_unique(target: dict, source: dict, field: str) -> bool:
    before = unique_list(target.get(field) or [])
    after = unique_list(before + list(source.get(field) or []))
    if after == before:
        return False
    target[field] = after
    return True


def apply_fill_if_empty(target: dict, source: dict, field: str) -> bool:
    existing_value = target.get(field)
    proposed_value = source.get(field)
    if existing_value not in (None, "", []):
        if proposed_value not in (None, "", []) and existing_value != proposed_value:
            raise ValueError(f"Candidate attempts destructive overwrite of non-empty field {field!r}")
        return False
    if proposed_value in (None, "", []):
        return False
    target[field] = copy.deepcopy(proposed_value)
    return True


def apply_hotline_provenance(target: dict, source: dict, field: str) -> bool:
    if field != "provenance":
        raise ValueError(f"Unsupported provenance merge field {field!r}")
    proposed = normalize_provenance(source, source.get(field))
    if not proposed:
        return False
    existing = normalize_provenance(target, target.get(field)) if target.get(field) else target.get(field)
    merged = merge_provenance(existing, proposed)
    if merged == existing:
        return False
    target[field] = merged
    return True


def apply_country_metadata(country: dict, candidate: dict) -> bool:
    changed = False
    proposed = candidate.get("proposed_country_updates") or {}
    for field, action in (candidate.get("field_actions") or {}).items():
        if field in LIST_APPEND_FIELDS:
            changed = apply_append_unique(country, proposed, field) or changed
        elif field in SCALAR_FILL_FIELDS:
            changed = apply_fill_if_empty(country, proposed, field) or changed
        else:
            raise ValueError(f"Unsupported country-level field {field!r}")
    return changed


def ensure_no_status_downgrade(existing_hotline: dict, proposed_hotline: dict, candidate: dict) -> None:
    if "verification_status" in (candidate.get("field_actions") or {}):
        raise ValueError("Promotion candidates may not modify verification_status")
    if would_downgrade_status(existing_hotline.get("verification_status"), proposed_hotline.get("verification_status")):
        raise ValueError(
            f"Candidate {candidate.get('candidate_id')} would downgrade verification status from "
            f"{existing_hotline.get('verification_status')!r} to {proposed_hotline.get('verification_status')!r}"
        )


def apply_hotline_merge(country: dict, candidate: dict) -> bool:
    hotline_name = (candidate.get("canonical_match") or {}).get("hotline_name")
    if not hotline_name:
        raise ValueError(f"Candidate {candidate.get('candidate_id')} is missing canonical_match.hotline_name")
    proposed = candidate.get("proposed_hotline") or {}
    by_name = build_hotline_index(country)
    existing = by_name.get(normalize_text(hotline_name))
    if existing is None:
        raise ValueError(f"Candidate {candidate.get('candidate_id')} target hotline {hotline_name!r} was not found")
    ensure_no_status_downgrade(existing, proposed, candidate)

    changed = False
    for field, action in (candidate.get("field_actions") or {}).items():
        if field in LIST_APPEND_FIELDS:
            changed = apply_append_unique(existing, proposed, field) or changed
        elif field in SCALAR_FILL_FIELDS:
            changed = apply_fill_if_empty(existing, proposed, field) or changed
        elif action == "merge_provenance":
            changed = apply_hotline_provenance(existing, proposed, field) or changed
        else:
            raise ValueError(f"Unsupported hotline field {field!r}")
    return changed


def apply_append_hotline(country: dict, candidate: dict) -> bool:
    proposed = candidate.get("proposed_hotline") or {}
    proposed_name = proposed.get("name")
    if not proposed_name:
        raise ValueError(f"Candidate {candidate.get('candidate_id')} append_new_hotline is missing proposed_hotline.name")
    existing = build_hotline_index(country)
    if normalize_text(proposed_name) in existing:
        raise ValueError(f"Candidate {candidate.get('candidate_id')} would overwrite existing hotline {proposed_name!r}")
    country.setdefault("hotlines", []).append(prepare_hotline(proposed, country["country"]))
    return True


def apply_candidate(canonical: dict, candidate: dict, protected_country_names: set[str]) -> bool:
    require_safe_candidate(candidate, protected_country_names)
    by_alpha2, by_name = canonical_index(canonical)
    country = by_alpha2.get(candidate.get("alpha-2")) or by_name.get(normalize_text(candidate.get("country")))
    if country is None:
        raise ValueError(f"Candidate {candidate.get('candidate_id')} does not match a canonical country")

    candidate_type = candidate.get("candidate_type")
    if candidate_type == "append_new_hotline":
        return apply_append_hotline(country, candidate)
    if candidate_type == "merge_missing_fields":
        return apply_hotline_merge(country, candidate)
    if candidate_type == "upgrade_emergency_metadata":
        return apply_country_metadata(country, candidate)
    raise ValueError(f"Unsupported candidate_type {candidate_type!r}")


def write_report(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    canonical_path = Path(args.canonical)
    candidates_path = Path(args.candidates)
    approvals_path = Path(args.approvals) if args.approvals else None
    effective_argv = argv if argv is not None else sys.argv[1:]

    canonical = load_json(canonical_path)
    bundle = load_json(candidates_path)
    approvals = approvals_by_candidate(approvals_path)
    if canonical.get("$schema_version") != SCHEMA_V2:
        raise ValueError(f"Canonical dataset {canonical_path} must use schema {SCHEMA_V2}.")
    if bundle.get("$schema_version") != SCHEMA_V2:
        raise ValueError(f"Candidate bundle {candidates_path} must use schema {SCHEMA_V2}.")
    if canonical_write_requested(effective_argv) and approvals_path is None:
        raise ValueError("--apply requires --approvals so canonical writes remain explicitly reviewed.")

    protected_country_names = {
        country["country"]
        for country in canonical.get("countries", [])
        if country_has_protected_hotlines(country)
    }

    lines = [
        "# Promotion candidate apply report",
        "",
        f"- Generated at: {utc_now()}",
        f"- Canonical dataset: {canonical_path}",
        f"- Candidate bundle: {candidates_path}",
        f"- Approvals file: {approvals_path if approvals_path else 'none'}",
        f"- Mode: {'apply' if canonical_write_requested(effective_argv) else 'dry-run'}",
        "",
        "## Candidate outcomes",
        "",
    ]

    changed = False
    applied_ids: list[str] = []
    rejected_ids: list[str] = []
    skipped_ids: list[str] = []

    for candidate in bundle.get("candidates", []):
        candidate_id = candidate.get("candidate_id")
        decision = approvals.get(candidate_id)
        state = decision.get("state") if decision else "pending_review"

        if approvals_path is not None and state != "approved":
            skipped_ids.append(candidate_id)
            lines.append(f"- `{candidate_id}`: skipped ({state})")
            continue

        try:
            changed_now = apply_candidate(canonical, candidate, protected_country_names)
        except Exception as exc:
            rejected_ids.append(candidate_id)
            lines.append(f"- `{candidate_id}`: rejected ({exc})")
            continue

        if changed_now:
            applied_ids.append(candidate_id)
            lines.append(f"- `{candidate_id}`: {'would apply' if not canonical_write_requested(effective_argv) else 'applied'}")
            changed = True or changed
        else:
            skipped_ids.append(candidate_id)
            lines.append(f"- `{candidate_id}`: no-op")

    canonical["countries"].sort(key=lambda country: country["country"])
    if changed and canonical_write_requested(effective_argv):
        canonical["last_updated"] = datetime.now(timezone.utc).date().isoformat()
        canonical_path.write_text(json.dumps(canonical, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines.extend(
        [
            "",
            "## Summary",
            "",
            f"- Applied candidates: {len(applied_ids)}",
            f"- Rejected candidates: {len(rejected_ids)}",
            f"- Skipped candidates: {len(skipped_ids)}",
            f"- Candidate type counts: {dict(sorted(Counter(candidate.get('candidate_type') for candidate in bundle.get('candidates', [])).items()))}",
        ]
    )

    report_path = report_path_for(args)
    write_report(report_path, lines)

    if not canonical_write_requested(effective_argv):
        print("Dry run only: canonical dataset was not modified. Re-run with --apply --approvals to write hotlines.json.")
        print(f"WouldApply={len(applied_ids)} Rejected={len(rejected_ids)} Skipped={len(skipped_ids)}")
    else:
        print(f"Applied reviewed promotion candidates to {canonical_path}")
        print(f"Applied={len(applied_ids)} Rejected={len(rejected_ids)} Skipped={len(skipped_ids)}")
    print(f"Wrote report: {report_path}")
    return 0 if not rejected_ids else 1


if __name__ == "__main__":
    raise SystemExit(main())
