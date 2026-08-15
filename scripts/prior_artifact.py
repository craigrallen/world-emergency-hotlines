#!/usr/bin/env python3
"""Strictly validate and extract one compatible SEO state artifact."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import hashlib
import io
from pathlib import Path
from zipfile import BadZipFile, ZipFile

try:
    from scripts.artifact_io import coordinated_write
    from scripts import monitor_delta, source_monitor
except ModuleNotFoundError:
    from artifact_io import coordinated_write
    import monitor_delta
    import source_monitor

MAX_FILE_BYTES = 1_000_000
# Manual verification ZIPs contain one <=1 MiB snapshot plus one <=1 MiB
# manifest, so 3 MiB leaves format overhead without permitting a large input.
MAX_SOURCE_ZIP_BYTES = 3 * MAX_FILE_BYTES
PAYLOAD_NAMES = {"monitor-state.json", "source-monitor-state.json", "source-snapshot.json"}
MANIFEST_NAME = "artifact-manifest.json"
EXPECTED = PAYLOAD_NAMES | {MANIFEST_NAME}
SOURCE_MANIFEST_NAME = "source-snapshot-manifest.json"


def _json(payload: bytes, label: str):
    return monitor_delta.json_bytes(payload, label)


def source_snapshot_manifest(snapshot_path: Path, run_as_of: dt.date) -> bytes:
    payload = monitor_delta.read_bounded_regular(snapshot_path, MAX_FILE_BYTES, "source snapshot")
    snapshot = _json(payload, "source snapshot")
    canonical = monitor_delta.read_bounded_regular(source_monitor.CANONICAL, 8_000_000, "canonical input")
    source_monitor.validate_current_snapshot(snapshot, canonical)
    if snapshot["as_of"] != run_as_of.isoformat():
        raise ValueError("source snapshot run date mismatch")
    return (json.dumps({"schema_version": "1.0", "run_as_of": run_as_of.isoformat(),
                        "members": {"source-snapshot.json": "sha256:" + hashlib.sha256(payload).hexdigest()}},
                       sort_keys=True, separators=(",", ":")) + "\n").encode()


def extract_authenticated_source_snapshot(archive_path: Path, as_of: dt.date) -> bytes:
    """Extract a manifest-bound historical snapshot from a manual-run artifact."""
    archive_payload = monitor_delta.read_bounded_regular(archive_path, MAX_SOURCE_ZIP_BYTES, "artifact ZIP")
    try:
        with ZipFile(io.BytesIO(archive_payload)) as archive:
            files = [item for item in archive.infolist() if not item.is_dir()]
            matches = {name: [item for item in files if item.filename == name]
                       for name in ("source-snapshot.json", SOURCE_MANIFEST_NAME)}
            if any(len(items) != 1 for items in matches.values()):
                raise ValueError("artifact must contain one exact snapshot and manifest")
            payloads = {}
            for name, items in matches.items():
                item = items[0]
                if item.file_size > MAX_FILE_BYTES:
                    raise ValueError("artifact state file oversized")
                with archive.open(item) as stream:
                    payloads[name] = stream.read(MAX_FILE_BYTES + 1)
                if len(payloads[name]) != item.file_size:
                    raise ValueError("artifact extraction size inconsistent")
    except BadZipFile as exc:
        raise ValueError("malformed artifact ZIP") from exc
    manifest = _json(payloads[SOURCE_MANIFEST_NAME], "source snapshot manifest")
    if (not isinstance(manifest, dict)
            or set(manifest) != {"schema_version", "run_as_of", "members"}
            or manifest.get("schema_version") != "1.0"
            or manifest.get("members") != {"source-snapshot.json": "sha256:" + hashlib.sha256(payloads["source-snapshot.json"]).hexdigest()}):
        raise ValueError("source snapshot member manifest invalid")
    run_date = dt.date.fromisoformat(manifest["run_as_of"])
    if run_date > as_of or manifest["run_as_of"] != run_date.isoformat():
        raise ValueError("artifact run date invalid")
    snapshot = _json(payloads["source-snapshot.json"], "source snapshot")
    source_monitor.validate_authenticated_previous_snapshot(snapshot, run_date, snapshot.get("as_of"))
    return payloads["source-snapshot.json"]


def extract_candidate(archive_path: Path, as_of: dt.date, canonical_path: Path) -> dict[str, bytes]:
    archive_payload = monitor_delta.read_bounded_regular(archive_path, 3 * MAX_FILE_BYTES, "artifact ZIP")
    try:
        with ZipFile(io.BytesIO(archive_payload)) as archive:
            files = [item for item in archive.infolist() if not item.is_dir()]
            names = [Path(item.filename).name for item in files]
            if (len(files) != len(EXPECTED) or set(names) != EXPECTED or len(names) != len(set(names))
                    or any(item.filename != name for item,name in zip(files,names))):
                raise ValueError("artifact must contain exactly one of each expected state file")
            if any(item.file_size > MAX_FILE_BYTES for item in files):
                raise ValueError("artifact state file oversized")
            payloads = {}
            for item, name in zip(files, names):
                with archive.open(item) as stream:
                    payload = stream.read(MAX_FILE_BYTES + 1)
                if len(payload) > MAX_FILE_BYTES or len(payload) != item.file_size:
                    raise ValueError("artifact extraction size inconsistent")
                payloads[name] = payload
        manifest = _json(payloads[MANIFEST_NAME], "artifact manifest")
        expected_manifest_keys = {"schema_version", "run_as_of", "state_as_of", "members"}
        if not isinstance(manifest, dict) or set(manifest) != expected_manifest_keys or manifest["schema_version"] != "2.0":
            raise ValueError("artifact publication manifest invalid")
        members = manifest["members"]
        if not isinstance(members, dict) or set(members) != PAYLOAD_NAMES:
            raise ValueError("artifact publication manifest member list invalid")
        for name in PAYLOAD_NAMES:
            if members[name] != "sha256:" + hashlib.sha256(payloads[name]).hexdigest():
                raise ValueError("artifact publication manifest member hash mismatch")
    except BadZipFile as exc:
        raise ValueError("malformed artifact ZIP") from exc
    monitor = _json(payloads["monitor-state.json"], "public monitor state")
    monitor_delta.validate_baseline(monitor, "public-seo")
    source_state = _json(payloads["source-monitor-state.json"], "source monitor state")
    monitor_delta.validate_baseline(source_state, "source-monitor")
    run_date=dt.date.fromisoformat(manifest["run_as_of"])
    if run_date > as_of or manifest["run_as_of"] != run_date.isoformat():
        raise ValueError("artifact run date invalid")
    snapshot=_json(payloads["source-snapshot.json"], "source snapshot")
    state_dates=manifest["state_as_of"]
    if not isinstance(state_dates,dict) or set(state_dates) != {"public-seo","source-monitor"}:
        raise ValueError("artifact state dates invalid")
    expected_dates={"public-seo":None if monitor["latest"] is None else monitor["latest"]["as_of"],
                    "source-monitor":None if source_state["latest"] is None else source_state["latest"]["as_of"]}
    if state_dates != expected_dates:
        raise ValueError("artifact state dates inconsistent")
    for value in state_dates.values():
        if value is not None and dt.date.fromisoformat(value) > run_date:
            raise ValueError("artifact state date is after run date")
    if source_state["latest"] is None:
        if snapshot.get("schema_version") != "3.0-empty-baseline":
            raise ValueError("source state requires empty snapshot")
        source_monitor.validate_empty_snapshot(snapshot,snapshot.get("canonical_hash", ""),run_date)
    else:
        source_monitor.validate_authenticated_previous_snapshot(
            snapshot, run_date, source_state["latest"]["as_of"])
    return {name: payloads[name] for name in PAYLOAD_NAMES}


def main(argv=None) -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact",type=Path); parser.add_argument("--output-dir",type=Path)
    parser.add_argument("--source-snapshot",type=Path); parser.add_argument("--source-manifest-output",type=Path)
    parser.add_argument("--as-of",required=True); parser.add_argument("--canonical",type=Path,default=source_monitor.CANONICAL)
    args=parser.parse_args(argv)
    try:
        if args.source_snapshot or args.source_manifest_output:
            if not args.source_snapshot or not args.source_manifest_output or args.artifact or args.output_dir:
                raise ValueError("source manifest mode arguments invalid")
            coordinated_write([(args.source_manifest_output,source_snapshot_manifest(args.source_snapshot,dt.date.fromisoformat(args.as_of)))])
            return 0
        if not args.artifact or not args.output_dir:
            raise ValueError("artifact extraction arguments required")
        payloads=extract_candidate(args.artifact,dt.date.fromisoformat(args.as_of),args.canonical)
        outputs=[(args.output_dir/name,payloads[name]) for name in sorted(PAYLOAD_NAMES)]
        if any(path.exists() for path,_ in outputs): raise ValueError("prior outputs already exist")
        coordinated_write(outputs)
    except (OSError,KeyError,TypeError,ValueError,json.JSONDecodeError):
        print("incompatible candidate")
        return 3
    return 0


if __name__ == "__main__": raise SystemExit(main())
