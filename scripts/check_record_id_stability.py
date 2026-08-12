#!/usr/bin/env python3
"""Reject removal or mutation of persisted hotline IDs relative to a baseline."""
from __future__ import annotations

import argparse
import json
import pathlib


def records_by_id(data: dict) -> dict[str, tuple[str, int]]:
    records = {}
    for country in data.get("countries", []):
        for index, hotline in enumerate(country.get("hotlines", [])):
            record_id = hotline.get("id")
            if isinstance(record_id, str):
                records[record_id] = (country.get("alpha-2"), index)
    return records


def compare(baseline: dict, current: dict) -> list[str]:
    errors = []
    old = records_by_id(baseline)
    new = records_by_id(current)
    for record_id in old:
        if record_id not in new:
            errors.append(f"existing record ID removed: {record_id}")
        elif old[record_id] != new[record_id]:
            errors.append(
                f"existing record ID moved or reassigned: {record_id} "
                f"({old[record_id]} -> {new[record_id]})"
            )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=pathlib.Path)
    parser.add_argument("--current", default="hotlines.json", type=pathlib.Path)
    args = parser.parse_args()
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    current = json.loads(args.current.read_text(encoding="utf-8"))
    errors = compare(baseline, current)
    for error in errors:
        print(f"ERROR: {error}")
    print(f"ID stability: {len(errors)} error(s); baseline={len(records_by_id(baseline))}, current={len(records_by_id(current))}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
