#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.gap_report import build_gap_report, load_json, render_gap_report_markdown



def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a deterministic gap report from canonical schema-v2 data.")
    parser.add_argument("--canonical", required=True, help="Path to canonical hotlines.json")
    parser.add_argument("--preview", action="append", default=[], help="Optional supplemental preview dataset; may be passed more than once.")
    parser.add_argument("--out-md", required=True, help="Markdown report output path.")
    parser.add_argument("--out-json", required=True, help="JSON report output path.")
    parser.add_argument("--queue-limit", type=int, default=25, help="Max entries per priority queue slice.")
    return parser.parse_args(argv)



def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    canonical_path = Path(args.canonical)
    preview_paths = [Path(path) for path in args.preview]
    out_md = Path(args.out_md)
    out_json = Path(args.out_json)

    canonical = load_json(canonical_path)
    previews = [load_json(path) for path in preview_paths]
    report = build_gap_report(canonical, preview_datasets=previews, queue_limit=args.queue_limit)
    report["canonical_dataset"] = str(canonical_path)
    report["preview_datasets"] = [str(path) for path in preview_paths]

    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(render_gap_report_markdown(report), encoding="utf-8")
    out_json.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote markdown report: {out_md}")
    print(f"Wrote JSON report: {out_json}")
    print(f"Analyzed {report['summary']['country_count']} countries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
