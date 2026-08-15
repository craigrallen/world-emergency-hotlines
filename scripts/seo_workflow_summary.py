#!/usr/bin/env python3
"""Render a small, validated GitHub step summary from bounded monitor artifacts."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    from scripts.monitor_delta import MAX_INPUT_BYTES, validate_result
    from scripts.seo_orchestrator import render_summary
except ModuleNotFoundError:
    from monitor_delta import MAX_INPUT_BYTES, validate_result
    from seo_orchestrator import render_summary

MAX_SUMMARY_BYTES = 8_000
MAX_SAMPLE_ISSUES = 5


def _load(path: Path):
    raw=path.read_bytes()
    if len(raw) > MAX_INPUT_BYTES: raise ValueError("summary input oversized")
    return json.loads(raw.decode("utf-8",errors="strict"))


def render(manifest_path: Path, result_paths: list[Path]) -> str:
    manifest=_load(manifest_path)
    lines=[render_summary(manifest).rstrip(),"","## Monitor counts",""]
    sample=[]
    expected={"public-seo","source-monitor"}
    results={}
    for path in result_paths:
        value=validate_result(_load(path))
        if value["monitor"] not in expected or value["monitor"] in results: raise ValueError("summary monitor identity invalid")
        results[value["monitor"]]=value
    for monitor in sorted(expected):
        value=results.get(monitor)
        if value is None:
            lines.append(f"- {monitor}: unavailable; issues 0")
            continue
        lines.append(f"- {monitor}: {value['status']}; issues {len(value['issues'])}")
        for row in value["issues"]:
            if len(sample) < MAX_SAMPLE_ISSUES: sample.append((monitor,row))
    if sample:
        lines += ["","## Bounded issue sample",""]
        for monitor,row in sample:
            # validate_result bounds all three fields; subjects/details are generated fixed monitor text.
            clean=lambda value:value.replace("`","'").replace("\r"," ").replace("\n"," ")
            lines.append(f"- {monitor} `{clean(row['code'])}` `{clean(row['subject'])}`: {clean(row['detail'])}")
    rendered="\n".join(lines)+"\n"
    if len(rendered.encode("utf-8")) > MAX_SUMMARY_BYTES: raise ValueError("workflow summary oversized")
    return rendered


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest",type=Path,required=True)
    parser.add_argument("--result",type=Path,action="append",default=[])
    args=parser.parse_args(argv)
    try: print(render(args.manifest,args.result),end="")
    except (OSError,UnicodeDecodeError,json.JSONDecodeError,ValueError):
        print("## Monitor outcomes\n\n- Combined: `unavailable`\n- Summary inputs: `invalid or unavailable`\n")
        return 3
    return 0


if __name__ == "__main__": raise SystemExit(main())
