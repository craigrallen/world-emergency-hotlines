#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.gap_report import build_gap_report, load_json



def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build queue slices for the next enrichment/verification/review pass.")
    parser.add_argument("--canonical", required=True, help="Path to canonical hotlines.json")
    parser.add_argument("--preview", action="append", default=[], help="Optional supplemental preview dataset; may be passed more than once.")
    parser.add_argument("--out", required=True, help="Priority queue JSON output path.")
    parser.add_argument("--queue-limit", type=int, default=25, help="Max entries per queue slice.")
    return parser.parse_args(argv)



def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    canonical_path = Path(args.canonical)
    preview_paths = [Path(path) for path in args.preview]
    out_path = Path(args.out)

    canonical = load_json(canonical_path)
    previews = [load_json(path) for path in preview_paths]
    report = build_gap_report(canonical, preview_datasets=previews, queue_limit=args.queue_limit)
    payload = {
        "$schema_version": report["$schema_version"],
        "generated_at": report["generated_at"],
        "canonical_dataset": str(canonical_path),
        "preview_datasets": [str(path) for path in preview_paths],
        "queue_limit": args.queue_limit,
        "scoring_model": report["scoring_model"],
        "summary": report["summary"],
        "queues": report["queues"],
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote priority queue: {out_path}")
    for queue_name, items in payload["queues"].items():
        print(f"- {queue_name}: {len(items)} entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
