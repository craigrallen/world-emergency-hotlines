#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.provenance import normalize_provenance, provenance_issues


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate supplemental provenance semantics without rewriting datasets.")
    parser.add_argument("--check", action="append", required=True, help="Dataset JSON file to validate. May be passed more than once.")
    return parser.parse_args(argv)


def iter_hotlines(payload: dict):
    for country in payload.get("countries", []) or []:
        for hotline in country.get("hotlines", []) or []:
            yield country, hotline


def check_dataset(path: Path) -> int:
    payload = json.loads(path.read_text(encoding="utf-8"))
    issue_count = 0
    normalized_count = 0
    hotline_count = 0
    for country, hotline in iter_hotlines(payload):
        hotline_count += 1
        issues = provenance_issues(hotline)
        if issues:
            issue_count += len(issues)
            for issue in issues:
                print(f"{path}: {country.get('country')} / {hotline.get('name')}: {issue}")
        if normalize_provenance(hotline):
            normalized_count += 1
    print(f"{path}: checked {hotline_count} hotlines; normalized provenance available for {normalized_count}; issues={issue_count}")
    return 1 if issue_count else 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    exit_code = 0
    for raw_path in args.check:
        exit_code = max(exit_code, check_dataset(Path(raw_path)))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
