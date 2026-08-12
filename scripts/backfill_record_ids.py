#!/usr/bin/env python3
"""Assign persisted opaque IDs to canonical hotline records.

Dry-run by default. Existing IDs are preserved. Missing IDs are generated once
from a deterministic migration seed so the reviewed migration is reproducible;
consumers must treat the persisted value as immutable and must never recompute it.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.record_ids import RECORD_ID_RE, backfill_seed, record_id_from_seed


DEFAULT_INPUT = ROOT / "hotlines.json"
HOTLINE_NAME_LINE_RE = re.compile(r'^( {10})"name":')


def assign_missing_ids(data: dict) -> tuple[int, int]:
    seen: set[str] = set()
    assigned = 0
    preserved = 0
    for country in data.get("countries", []):
        for ordinal, hotline in enumerate(country.get("hotlines", [])):
            existing = hotline.get("id")
            if existing is not None:
                if not isinstance(existing, str) or not RECORD_ID_RE.fullmatch(existing):
                    raise ValueError(f"Invalid existing hotline ID {existing!r}")
                if existing in seen:
                    raise ValueError(f"Duplicate existing hotline ID {existing!r}")
                seen.add(existing)
                preserved += 1
                continue
            candidate = record_id_from_seed(backfill_seed(country, hotline, ordinal))
            if candidate in seen:
                raise ValueError(f"Generated duplicate hotline ID {candidate!r}")
            hotline["id"] = candidate
            seen.add(candidate)
            assigned += 1
    return assigned, preserved


def inject_ids_without_reformatting(raw: str, data: dict) -> str:
    """Insert missing IDs before canonical hotline name lines, preserving all other bytes."""
    record_ids = [
        hotline["id"]
        for country in data.get("countries", [])
        for hotline in country.get("hotlines", [])
    ]
    lines = raw.splitlines(keepends=True)
    output: list[str] = []
    record_index = 0
    for line in lines:
        match = HOTLINE_NAME_LINE_RE.match(line)
        if match:
            if record_index >= len(record_ids):
                raise ValueError("Found more canonical hotline name lines than parsed records")
            previous = output[-1] if output else ""
            if not re.match(r'^ {10}"id":', previous):
                output.append(f'{match.group(1)}"id": "{record_ids[record_index]}",\n')
            record_index += 1
        output.append(line)
    if record_index != len(record_ids):
        raise ValueError(
            f"Found {record_index} canonical hotline name lines for {len(record_ids)} parsed records"
        )
    return "".join(output)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill immutable hotline IDs; dry-run by default.")
    parser.add_argument("--input", type=pathlib.Path, default=DEFAULT_INPUT)
    parser.add_argument("--apply", action="store_true", help="Write IDs to the input file.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    raw = args.input.read_text(encoding="utf-8")
    data = json.loads(raw)
    assigned, preserved = assign_missing_ids(data)
    if args.apply:
        args.input.write_text(inject_ids_without_reformatting(raw, data), encoding="utf-8")
        print(f"Assigned {assigned} ID(s); preserved {preserved}; wrote {args.input}")
    else:
        print(f"Dry run: would assign {assigned} ID(s); would preserve {preserved}; no file written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
