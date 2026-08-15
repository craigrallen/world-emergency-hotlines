#!/usr/bin/env python3
"""Bounded fallback retrieval for manual verification history."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import tempfile
from pathlib import Path

try:
    from scripts import prior_artifact, seo_orchestrator
    from scripts.artifact_io import coordinated_write
except ModuleNotFoundError:
    import prior_artifact, seo_orchestrator
    from artifact_io import coordinated_write

MAX_JSON_BYTES = 2_000_000
RUN_KEYS = {"id", "status", "conclusion", "event", "created_at", "updated_at"}
ARTIFACT_NAME = re.compile(r"verification-operations-[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")


def load(path: Path) -> dict:
    value = seo_orchestrator._json_bytes(
        seo_orchestrator.monitor_delta.read_bounded_regular(path, MAX_JSON_BYTES, "GitHub response"),
        "GitHub response")
    if not isinstance(value, dict):
        raise ValueError("GitHub response must be an object")
    return value


def _timestamp(value: object) -> dt.datetime:
    return seo_orchestrator._canonical_utc(value, "manual")


def select_runs(value: dict, current_run: int, as_of: dt.date) -> list[int]:
    if type(current_run) is not int or not 0 < current_run <= seo_orchestrator.MAX_GITHUB_ID:
        raise ValueError("current run ID must be a positive bounded integer")
    # This helper also receives the fully enumerated aggregate from retrieve;
    # the shared paginator has already enforced each 100-row page boundary.
    rows = seo_orchestrator.validate_runs_response(value,seo_orchestrator.MAX_RUNS)
    # Validate the same required arithmetic before any selection or retrieval.
    seo_orchestrator._run_date(as_of.isoformat())
    end = dt.datetime.combine(as_of + dt.timedelta(days=1), dt.time(), dt.timezone.utc)
    candidates = []
    for row in rows:
        run_id = row["id"]
        created, updated = _timestamp(row["created_at"]), _timestamp(row["updated_at"])
        if (row["event"] in {"workflow_dispatch", "schedule"} and row["conclusion"] == "success"
                and run_id < current_run and created < end and updated < end):
            candidates.append(run_id)
    # rows already carry the single validated production ordering key.
    return candidates


def select_artifact(value: dict) -> dict | None:
    if (not isinstance(value, dict) or set(value) != {"total_count", "artifacts"}
            or type(value["total_count"]) is not int or not 0 <= value["total_count"] <= 100
            or not isinstance(value["artifacts"], list) or value["total_count"] != len(value["artifacts"])):
        raise ValueError("artifact response invalid")
    matches = []
    for row in value["artifacts"]:
        metadata = seo_orchestrator.validate_artifact_metadata(row)
        if ARTIFACT_NAME.fullmatch(metadata["name"]) and not metadata["expired"]:
            matches.append(metadata)
    if len(matches) > 1:
        raise ValueError("ambiguous usable prior artifacts")
    return matches[0] if matches else None


def retrieve(repository: str, workflow: str, branch: str, current_run: int,
             as_of: dt.date, output: Path) -> int | None:
    # All local paths/identifiers are rejected before the first remote call.
    seo_orchestrator._repository_path(repository)
    seo_orchestrator._workflow_component(workflow)
    seo_orchestrator._validate_ref(branch)
    seo_orchestrator._run_date(as_of.isoformat())
    if (output.exists() or output.is_symlink() or output.parent.is_symlink()
            or not output.parent.is_dir()):
        raise ValueError("unsafe or existing output path")
    rows = seo_orchestrator.enumerate_workflow_runs(
        lambda page: seo_orchestrator._gh_json(
            seo_orchestrator._runs_api_path(repository, workflow, branch, page)))
    runs = select_runs({"total_count":len(rows),"workflow_runs":rows}, current_run, as_of)
    repository_path = seo_orchestrator._repository_path(repository)
    with tempfile.TemporaryDirectory(prefix="manual-prior-") as folder:
        stage = Path(folder)
        for run_id in runs:
            archive = stage / f"candidate-{run_id}.zip"
            metadata = select_artifact(seo_orchestrator._gh_json(
                f"/repos/{repository_path}/actions/runs/{run_id}/artifacts?per_page=100"))
            if metadata is None:
                continue
            try:
                seo_orchestrator._gh_download(repository, metadata, archive)
                payload = prior_artifact.extract_authenticated_source_snapshot(archive, as_of)
                snapshot_date = prior_artifact._json(payload, "source snapshot")["as_of"]
                if dt.date.fromisoformat(snapshot_date) >= as_of:
                    raise seo_orchestrator.CandidateIncompatible("prior source snapshot must predate current run")
                if metadata["name"] != f"verification-operations-{snapshot_date}":
                    raise ValueError("artifact name does not match authenticated snapshot date")
                coordinated_write([(output, payload)])
                return run_id
            except seo_orchestrator.CandidateIncompatible:
                continue
            finally:
                try: archive.unlink()
                except FileNotFoundError: pass
    return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    runs = sub.add_parser("runs"); runs.add_argument("--json", type=Path, required=True); runs.add_argument("--current-run", type=int, required=True); runs.add_argument("--as-of", required=True)
    artifacts = sub.add_parser("artifact"); artifacts.add_argument("--json", type=Path, required=True)
    get = sub.add_parser("retrieve"); get.add_argument("--repository", required=True); get.add_argument("--workflow", required=True); get.add_argument("--branch", required=True); get.add_argument("--current-run", type=int, required=True); get.add_argument("--as-of", required=True); get.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "runs":
            print("\n".join(map(str, select_runs(load(args.json), args.current_run, seo_orchestrator._run_date(args.as_of)))))
        elif args.command == "artifact":
            item = select_artifact(load(args.json)); print(item["id"], item["size_in_bytes"], item["digest"])
        else:
            selected = retrieve(args.repository, args.workflow, args.branch, args.current_run,
                                seo_orchestrator._run_date(args.as_of), args.output)
            if selected is None: return seo_orchestrator.EXIT_CONFIRMED_NO_HISTORY
            print(json.dumps({"selected": selected}, sort_keys=True))
        return 0
    except (OSError, TypeError, ValueError, json.JSONDecodeError, subprocess.SubprocessError):
        return seo_orchestrator.EXIT_FATAL


if __name__ == "__main__":
    raise SystemExit(main())
