#!/usr/bin/env python3
"""Classify bounded monitor results and atomically maintain sanitized state."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import stat
from pathlib import Path

try:
    from scripts.artifact_io import coordinated_write, guard_paths
except ModuleNotFoundError:
    from artifact_io import coordinated_write, guard_paths

MAX_INPUT_BYTES = 1_000_000
MAX_HISTORY = 12
MAX_ISSUES = 100
OUTCOMES = {"baseline", "unchanged", "regression", "continuing", "recovered", "unavailable"}
EXIT_CODES = {"baseline": 0, "unchanged": 0, "regression": 1, "continuing": 0,
              "recovered": 0, "unavailable": 2}
STATE_KEYS = {"schema_version", "monitor", "as_of", "status", "issues", "metrics"}
BASELINE_KEYS = {"schema_version", "monitor", "latest", "history"}


def threshold_crossed(current: float, baseline: float, *, relative_drop: float, minimum_baseline: float) -> bool:
    """Return true at the exact configured decline boundary, never on thin baselines."""
    if baseline < minimum_baseline or baseline <= 0 or not 0 < relative_drop <= 1:
        return False
    return current <= baseline * (1 - relative_drop)


def _plain(value, depth=0):
    if depth > 5:
        raise ValueError("value nesting too deep")
    if value is None or type(value) in {bool, int}:
        return value
    if isinstance(value, float):
        if value != value or abs(value) == float("inf"):
            raise ValueError("non-finite metric")
        return value
    if isinstance(value, str) and len(value) <= 300:
        lowered = value.casefold()
        if any(term in lowered for term in ("authorization:", "access_token", "refresh_token", "client_secret", "query_text")):
            raise ValueError("credential or query-shaped value forbidden")
        return value
    if isinstance(value, list) and len(value) <= 100:
        return [_plain(item, depth + 1) for item in value]
    if isinstance(value, dict) and len(value) <= 100 and all(isinstance(k, str) and 0 < len(k) <= 80 for k in value):
        return {k: _plain(v, depth + 1) for k, v in sorted(value.items())}
    raise ValueError("unbounded or unsupported value")


def validate_result(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) != STATE_KEYS:
        raise ValueError("monitor result schema invalid")
    if value["schema_version"] != "1.0" or not isinstance(value["monitor"], str) or not 0 < len(value["monitor"]) <= 80:
        raise ValueError("monitor result identity invalid")
    try:
        parsed_date = dt.date.fromisoformat(value["as_of"])
    except (TypeError, ValueError) as exc:
        raise ValueError("monitor result date invalid") from exc
    if value["as_of"] != parsed_date.isoformat():
        raise ValueError("monitor result date invalid")
    if value["status"] not in {"ok", "regression", "unavailable"}:
        raise ValueError("monitor status invalid")
    if not isinstance(value["issues"], list) or len(value["issues"]) > MAX_ISSUES:
        raise ValueError("monitor issues invalid")
    issues = []
    for issue in value["issues"]:
        if not isinstance(issue, dict) or set(issue) != {"code", "subject", "detail"}:
            raise ValueError("monitor issue schema invalid")
        clean = _plain(issue)
        if not all(isinstance(clean[k], str) and clean[k] for k in clean):
            raise ValueError("monitor issue invalid")
        issues.append(clean)
    issues.sort(key=lambda row: (row["code"], row["subject"], row["detail"]))
    metrics = _plain(value["metrics"])
    if not isinstance(metrics, dict):
        raise ValueError("monitor metrics invalid")
    if value["status"] == "ok" and issues:
        raise ValueError("ok result cannot contain issues")
    if value["status"] != "ok" and not issues:
        raise ValueError("non-ok result requires an issue")
    return {**value, "issues": issues, "metrics": metrics}


def read_bounded_regular(path: Path, limit: int, label: str = "input") -> bytes:
    """Read an exact, stable regular file without following a hostile symlink."""
    if type(limit) is not int or limit < 0:
        raise ValueError("invalid input size limit")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError(f"{label} missing, unsafe, or oversized")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            payload = stream.read(limit + 1)
        after = os.fstat(descriptor)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)
        if len(payload) > limit or len(payload) != before.st_size or identity(before) != identity(after):
            raise ValueError(f"{label} changed or exceeded size limit while reading")
        return payload
    finally:
        os.close(descriptor)


def json_bytes(payload: bytes, label: str = "JSON input"):
    try:
        return json.loads(payload.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise ValueError(f"{label} is not valid UTF-8") from exc
    except RecursionError as exc:
        raise ValueError(f"{label} JSON nesting too deep") from exc


def load_bounded(path: Path) -> dict:
    return json_bytes(read_bounded_regular(path, MAX_INPUT_BYTES, "artifact"), "artifact")


def validate_baseline(value: dict, monitor: str) -> dict:
    if not isinstance(value, dict) or set(value) != BASELINE_KEYS or value["schema_version"] != "2.0":
        raise ValueError("baseline schema invalid")
    if value["monitor"] != monitor:
        raise ValueError("baseline identity or history invalid")
    if value["latest"] is None:
        if value["history"] != []:
            raise ValueError("empty baseline history invalid")
        return {"schema_version": "2.0", "monitor": monitor, "latest": None, "history": []}
    latest = validate_result(value["latest"])
    if latest["monitor"] != monitor or not isinstance(value["history"], list) or len(value["history"]) > MAX_HISTORY:
        raise ValueError("baseline identity or history invalid")
    history = [validate_result(row) for row in value["history"]]
    if not history or any(row["monitor"] != monitor for row in history):
        raise ValueError("baseline history identity invalid")
    dates = [dt.date.fromisoformat(row["as_of"]) for row in history]
    if dates != sorted(set(dates)) or any(left >= right for left, right in zip(dates, dates[1:])):
        raise ValueError("baseline history must be chronological and unique")
    if latest != history[-1]:
        raise ValueError("baseline latest must equal final history entry")
    if any(row["status"] == "unavailable" for row in history):
        raise ValueError("unavailable results must not be persisted")
    return {"schema_version": "2.0", "monitor": monitor, "latest": latest, "history": history}


def empty_baseline(monitor: str) -> dict:
    if not isinstance(monitor, str) or not monitor:
        raise ValueError("baseline identity invalid")
    return {"schema_version": "2.0", "monitor": monitor, "latest": None, "history": []}


def classify(current: dict, baseline: dict | None) -> str:
    current = validate_result(current)
    if current["status"] == "unavailable":
        return "unavailable"
    if baseline is None:
        return "baseline" if current["status"] == "ok" else "regression"
    previous = validate_baseline(baseline, current["monitor"])["latest"]
    if previous is None:
        return "baseline" if current["status"] == "ok" else "regression"
    if dt.date.fromisoformat(current["as_of"]) < dt.date.fromisoformat(previous["as_of"]):
        raise ValueError("current result must not predate baseline")
    if current["status"] == "ok":
        return "recovered" if previous["status"] != "ok" else "unchanged"
    return "continuing" if previous["status"] == "regression" and previous["issues"] == current["issues"] else "regression"


def outcome_exit_code(outcome: str) -> int:
    """Keep workflow alert/exit policy in one executable production boundary."""
    if outcome not in OUTCOMES:
        raise ValueError("monitor outcome invalid")
    return EXIT_CODES[outcome]


def updated_state(current: dict, baseline: dict | None) -> dict:
    current = validate_result(current)
    old = [] if baseline is None else validate_baseline(baseline, current["monitor"])["history"]
    if old and old[-1]["as_of"] == current["as_of"]:
        old = old[:-1]
    history = (old + [current])[-MAX_HISTORY:]
    return {"schema_version": "2.0", "monitor": current["monitor"], "latest": current, "history": history}


def atomic_write(path: Path, value: dict) -> None:
    payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if len(payload) > MAX_INPUT_BYTES:
        raise ValueError("state exceeds size limit")
    coordinated_write([(path, payload)])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--state-output", type=Path)
    parser.add_argument("--alert-only", action="store_true")
    args = parser.parse_args(argv)
    try:
        inputs = [args.current] + ([args.previous] if args.previous else [])
        outputs = [(args.state_output, ".json")] if args.state_output else []
        guard_paths(inputs, outputs)
        current = validate_result(load_bounded(args.current))
        baseline = validate_baseline(load_bounded(args.previous), current["monitor"]) if args.previous else None
        outcome = classify(current, baseline)
        if args.state_output and current["status"] != "unavailable":
            atomic_write(args.state_output, updated_state(current, baseline))
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"malformed baseline or result: {str(exc)[:200]}")
        return 3
    if not args.alert_only or outcome not in {"unchanged", "continuing"}:
        print(json.dumps({"outcome": outcome, "status": current["status"]}, sort_keys=True))
    return outcome_exit_code(outcome)


if __name__ == "__main__":
    raise SystemExit(main())
