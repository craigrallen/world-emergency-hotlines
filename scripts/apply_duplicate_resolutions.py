#!/usr/bin/env python3
"""Apply an explicitly reviewed, exact-match duplicate-resolution batch.

Dry-run is the default. Canonical data is written only with --apply. The
bundle pins the expected input SHA-256 and every survivor/removal selector must
match exactly once, so dataset drift or ambiguous selectors fail closed.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CANONICAL = ROOT / "hotlines.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selector_matches(record: dict, selector: dict) -> bool:
    return all(record.get(key) == value for key, value in selector.items())


def find_country(data: dict, name: str) -> dict:
    matches = [country for country in data.get("countries", []) if country.get("country") == name]
    if len(matches) != 1:
        raise ValueError(f"country selector {name!r} matched {len(matches)} countries")
    return matches[0]


def resolve(data: dict, bundle: dict) -> tuple[dict, list[dict]]:
    updated = copy.deepcopy(data)
    outcomes = []
    removed_objects: set[int] = set()

    for resolution in bundle.get("resolutions", []):
        country = find_country(updated, resolution["country"])
        survivor_matches = [
            record for record in country.get("hotlines", [])
            if selector_matches(record, resolution["survivor"])
        ]
        if len(survivor_matches) != 1:
            raise ValueError(
                f"{resolution['resolution_id']}: survivor selector matched "
                f"{len(survivor_matches)} records"
            )

        resolved_removals = []
        for selector in resolution.get("remove", []):
            matches = [
                record for record in country.get("hotlines", [])
                if selector_matches(record, selector)
            ]
            if len(matches) != 1:
                raise ValueError(
                    f"{resolution['resolution_id']}: removal selector {selector!r} "
                    f"matched {len(matches)} records"
                )
            record = matches[0]
            marker = id(record)
            if marker in removed_objects:
                raise ValueError(f"{resolution['resolution_id']}: record selected for removal twice")
            removed_objects.add(marker)
            resolved_removals.append(record)

        survivor = survivor_matches[0]
        for record in resolved_removals:
            if record == survivor:
                raise ValueError(f"{resolution['resolution_id']}: survivor selected for removal")
            country["hotlines"].remove(record)

        outcomes.append(
            {
                "resolution_id": resolution["resolution_id"],
                "country": resolution["country"],
                "survivor": resolution["survivor"]["name"],
                "removed": [record.get("name") for record in resolved_removals],
                "evidence_url": resolution["evidence_url"],
            }
        )
    return updated, outcomes


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canonical", type=Path, default=CANONICAL)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    actual_sha = sha256(args.canonical)
    expected_sha = bundle.get("canonical_sha256")
    if actual_sha != expected_sha:
        raise SystemExit(
            f"canonical SHA-256 mismatch: expected {expected_sha}, got {actual_sha}; rebuild/review the batch"
        )

    data = json.loads(args.canonical.read_text(encoding="utf-8"))
    updated, outcomes = resolve(data, bundle)
    before_count = sum(len(c.get("hotlines", [])) for c in data.get("countries", []))
    after_count = sum(len(c.get("hotlines", [])) for c in updated.get("countries", []))
    removed_count = sum(len(item["removed"]) for item in outcomes)
    if before_count - after_count != removed_count:
        raise SystemExit("record-count guard failed")

    lines = [
        f"# Duplicate resolution: {bundle.get('batch_id')}",
        "",
        f"- Review date: `{bundle.get('review_date')}`",
        f"- Mode: `{'apply' if args.apply else 'dry-run'}`",
        f"- Canonical SHA-256 before: `{actual_sha}`",
        f"- Records before: {before_count}",
        f"- Records after: {after_count}",
        f"- Records removed: {removed_count}",
        "",
        "No verification status or survivor metadata is changed by this operation.",
        "",
        "## Reviewed resolutions",
        "",
    ]
    for item in outcomes:
        lines.append(
            f"- `{item['resolution_id']}` ({item['country']}): keep **{item['survivor']}**; "
            f"remove {', '.join(item['removed'])}; evidence: {item['evidence_url']}"
        )

    if args.report:
        if args.report.exists():
            raise SystemExit(f"report already exists; choose a new path: {args.report}")
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text("\n".join(lines) + "\n", encoding="utf-8")

    if args.apply:
        args.canonical.write_text(
            json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"Applied {len(outcomes)} reviewed resolutions; removed {removed_count} records")
    else:
        print(f"Dry run only; would remove {removed_count} records across {len(outcomes)} resolutions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
