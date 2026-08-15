#!/usr/bin/env python3
"""Derive a strict sanitized monitor result from a bounded source snapshot."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

try:
    from scripts.artifact_io import coordinated_write, guard_paths
    from scripts.monitor_delta import json_bytes, read_bounded_regular, validate_result
    from scripts.source_monitor import CANONICAL, eligible_records, load_snapshot, rotating_selection, validate_current_snapshot, validate_previous
except ModuleNotFoundError:
    from artifact_io import coordinated_write, guard_paths
    from monitor_delta import json_bytes, read_bounded_regular, validate_result
    from source_monitor import CANONICAL, eligible_records, load_snapshot, rotating_selection, validate_current_snapshot, validate_previous


def identity(row):
    raw=(row["record_id"]+"\0"+row["source_url"]).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def build(snapshot: dict, previous: dict | None, canonical_raw: bytes) -> dict:
    validate_current_snapshot(snapshot, canonical_raw)
    if previous is not None:
        data=json.loads(canonical_raw)
        ids={row.get("id") for country in data.get("countries",[]) for row in country.get("hotlines",[])}
        eligible,_=eligible_records(data)
        validate_previous(previous, snapshot["canonical_hash"], dt.date.fromisoformat(snapshot["as_of"]), ids,
            {(row[0],row[3]) for row in eligible})
        if previous["as_of"] >= snapshot["as_of"]:
            raise ValueError("previous source snapshot must predate current snapshot")
    summary=snapshot["summary"]; observations=snapshot["observations"]
    critical_count=snapshot["policy"]["critical_cohort"]
    data=json.loads(canonical_raw)
    eligible,_=eligible_records(data)
    selected,_,_=rotating_selection(eligible,snapshot["url_limit"],dt.date.fromisoformat(snapshot["as_of"]))
    critical_keys={(row[0],row[3]) for row in selected[:critical_count]}
    issues=[]
    if summary["degraded"]:
        issues.append({"code":"source_total_degradation","subject":"selected-sources","detail":"every selected source observation failed or was blocked"})
    for row in observations:
        if (row["record_id"],row["source_url"]) not in critical_keys:
            continue
        if previous is not None and row["outcome"] in {"fetch_failure","blocked"}:
            issues.append({"code":"source_critical_"+row["outcome"],"subject":"source:"+identity(row),
                           "detail":"a deterministic critical-cohort observation is failed or blocked"})
    result={"schema_version":"1.0","monitor":"source-monitor","as_of":snapshot["as_of"],
            "status":"regression" if issues else "ok","issues":issues,
            "metrics":{"selected":summary["selected"],"ok":summary["ok"],"failure":summary["failure"],
                       "blocked":summary["blocked"],"all_degraded":summary["degraded"],
                       "review_changes":summary["changed"],"critical_cohort":critical_count}}
    return validate_result(result)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot",type=Path,required=True); parser.add_argument("--previous",type=Path)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args(argv)
    try:
        guard_paths([args.snapshot]+([args.previous] if args.previous else []),[(args.output,".json")])
        snapshot=load_snapshot(args.snapshot); previous=load_snapshot(args.previous) if args.previous else None
        if previous is not None and previous.get("schema_version") == "3.0-empty-baseline":
            previous=None
        canonical_raw=read_bounded_regular(CANONICAL,8_000_000,"canonical input")
        # Decode here so invalid UTF-8 is an expected local/schema failure.
        json_bytes(canonical_raw,"canonical input")
        report=build(snapshot,previous,canonical_raw)
        coordinated_write([(args.output,(json.dumps(report,sort_keys=True,indent=2)+"\n").encode())])
    except (OSError,TypeError,KeyError,ValueError,json.JSONDecodeError) as exc:
        print("source result unavailable: "+str(exc)[:200]); return 2
    print(json.dumps({"status":report["status"],"issues":len(report["issues"])},sort_keys=True))
    return 1 if report["status"] == "regression" else 0


if __name__ == "__main__": raise SystemExit(main())
