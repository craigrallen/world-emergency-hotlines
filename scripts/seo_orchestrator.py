#!/usr/bin/env python3
"""Dependency-free scheduled SEO orchestration policy with injectable artifacts."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import hashlib
import re
import urllib.parse
import tempfile
from pathlib import Path

try:
    from scripts import monitor_delta, prior_artifact, source_monitor_result
    from scripts.artifact_io import coordinated_write
except ModuleNotFoundError:
    import monitor_delta, prior_artifact, source_monitor_result
    from artifact_io import coordinated_write

STATE_NAMES={"public-seo":"monitor-state.json","source-monitor":"source-monitor-state.json"}
ARTIFACT_NAME="seo-monitor-state"
MAX_CANDIDATES=20
MAX_ZIP_BYTES=3 * prior_artifact.MAX_FILE_BYTES
MAX_GITHUB_ID=9_223_372_036_854_775_807
DIGEST_RE=re.compile(r"sha256:[0-9a-f]{64}\Z")
REPOSITORY_RE=re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\Z")
WORKFLOW_RE=re.compile(r"(?:[1-9][0-9]{0,18}|[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.ya?ml)\Z")
REF_RE=re.compile(r"(?!.*(?:\.\.|//|@\{|\\|[\x00-\x20\x7f]))[A-Za-z0-9][A-Za-z0-9._/&%#+-]{0,254}\Z")
OUTCOMES={"baseline","regression","continuing","recovered","unchanged","unavailable"}
COMBINED={"baseline","regression","recovered","stable","unavailable"}

# CLI contract: argparse uses 2 for malformed invocation, 3 is a fatal local
# safety/programming/publication failure, and 4 is the only recoverable result.
EXIT_SUCCESS=0
EXIT_FATAL=3
EXIT_HISTORY_UNAVAILABLE=4


def _positive_int(value):
    return type(value) is int and 0 < value <= MAX_GITHUB_ID


def validate_artifact_metadata(value):
    """Return the download-safe fields from one GitHub artifact object."""
    if not isinstance(value,dict): raise ValueError("artifact metadata must be an object")
    required={"id","name","size_in_bytes","created_at","expired","digest"}
    if not required <= set(value): raise ValueError("artifact metadata fields missing")
    if not _positive_int(value["id"]): raise ValueError("artifact id invalid")
    if not isinstance(value["name"],str) or not value["name"] or len(value["name"]) > 200:
        raise ValueError("artifact name invalid")
    if type(value["size_in_bytes"]) is not int or not 0 <= value["size_in_bytes"] <= MAX_ZIP_BYTES:
        raise ValueError("artifact size invalid")
    if type(value["expired"]) is not bool: raise ValueError("artifact expired flag invalid")
    if not isinstance(value["created_at"],str) or len(value["created_at"]) > 40:
        raise ValueError("artifact creation time invalid")
    try: created=dt.datetime.fromisoformat(value["created_at"].replace("Z","+00:00"))
    except ValueError as exc: raise ValueError("artifact creation time invalid") from exc
    if created.tzinfo is None: raise ValueError("artifact creation time must include timezone")
    if not isinstance(value["digest"],str) or not DIGEST_RE.fullmatch(value["digest"]):
        raise ValueError("artifact digest invalid")
    return {key:value[key] for key in ("id","name","size_in_bytes","created_at","expired","digest")}


def retrieve_newest_compatible(runs, as_of, canonical, download_dir, enumerate_artifacts, downloader):
    """Own pre-download eligibility, bounded downloading, and compatibility fallback."""
    if not isinstance(runs,list): raise ValueError("workflow runs must be an array")
    examined=0
    for run in runs:
        if examined >= MAX_CANDIDATES: break
        if (not isinstance(run,dict) or set(run) != {"id","conclusion"}
                or not _positive_int(run.get("id"))
                or (run.get("conclusion") is not None and (not isinstance(run["conclusion"],str) or len(run["conclusion"]) > 40))):
            continue
        examined += 1
        try: raw=enumerate_artifacts(run["id"])
        except (OSError,ValueError,subprocess.SubprocessError): continue
        if (not isinstance(raw,dict) or set(raw) != {"total_count","artifacts"}
                or type(raw["total_count"]) is not int or not 0 <= raw["total_count"] <= 100
                or not isinstance(raw["artifacts"],list) or len(raw["artifacts"]) != raw["total_count"]):
            continue
        eligible=[]
        for item in raw["artifacts"]:
            try: metadata=validate_artifact_metadata(item)
            except (TypeError,ValueError): continue
            if metadata["name"] == ARTIFACT_NAME and not metadata["expired"]: eligible.append(metadata)
        if len(eligible) != 1: continue
        metadata=eligible[0]
        # Validation above enforces the aggregate ZIP cap before this call.
        archive=download_dir/f"candidate-{run['id']}.zip"
        try:
            downloader(metadata,archive)
            payloads=prior_artifact.extract_candidate(archive,as_of,canonical)
            return run["id"],run["conclusion"],payloads
        except (OSError,TypeError,ValueError,json.JSONDecodeError,subprocess.SubprocessError):
            continue
        finally:
            try: archive.unlink()
            except FileNotFoundError: pass
    return None


def render_summary(manifest):
    """Render only validated enums; no untrusted manifest material is reflected."""
    required={"schema_version","combined","exit_code","outcomes","publication"}
    if not isinstance(manifest,dict) or not required <= set(manifest) or not set(manifest) <= required|{"missing_state"}:
        raise ValueError("publication manifest schema invalid")
    if manifest["schema_version"] != "1.0" or manifest["combined"] not in COMBINED or type(manifest["exit_code"]) is not int or manifest["exit_code"] not in {0,1,2}:
        raise ValueError("publication manifest outcome invalid")
    outcomes=manifest["outcomes"]
    if not isinstance(outcomes,dict) or set(outcomes) != set(STATE_NAMES) or any(type(value) is not str or value not in OUTCOMES for value in outcomes.values()):
        raise ValueError("publication manifest monitor outcomes invalid")
    publication=manifest["publication"]
    expected_publication={"state":[STATE_NAMES[x] for x in sorted(STATE_NAMES)],
                          "reports":["public-seo.json","public-seo.md","source-monitor-result.json","source-report.md","source-snapshot.json"]}
    if publication != expected_publication:
        raise ValueError("publication manifest publication invalid")
    if "missing_state" in manifest and (not isinstance(manifest["missing_state"],list)
            or not all(isinstance(x,str) and x in STATE_NAMES.values() for x in manifest["missing_state"])):
        raise ValueError("publication manifest missing state invalid")
    expected_combined,expected_code=combine(outcomes)
    if manifest.get("missing_state"):
        expected_combined,expected_code="unavailable",2
    if (manifest["combined"],manifest["exit_code"]) != (expected_combined,expected_code):
        raise ValueError("publication manifest combined outcome inconsistent")
    rendered=("## Monitor outcomes\n\n"
              f"- Combined: `{manifest['combined']}`\n"
              f"- Public SEO: `{outcomes['public-seo']}`\n"
              f"- Source monitor: `{outcomes['source-monitor']}`\n")
    if len(rendered.encode("utf-8")) > 1_000: raise ValueError("publication summary oversized")
    return rendered


def combine(outcomes):
    if any(value == "unavailable" for value in outcomes.values()): return "unavailable",2
    if any(value == "regression" for value in outcomes.values()): return "regression",1
    if any(value == "recovered" for value in outcomes.values()): return "recovered",0
    if all(value == "baseline" for value in outcomes.values()): return "baseline",0
    return "stable",0


def _encoded(value):
    return (json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()


def finalize(results, previous, output_dir, as_of=None, source_snapshot=None, previous_source_snapshot=None,
             canonical_path=prior_artifact.source_monitor.CANONICAL):
    run_date=as_of or dt.date.today()
    canonical_raw=Path(canonical_path).read_bytes()
    outcomes={}; writes=[]; baselines={}; current_results={}
    for monitor,path in results.items():
        try:
            current=monitor_delta.validate_result(monitor_delta.load_bounded(Path(path)))
            if current["monitor"] != monitor: raise ValueError("monitor result identity mismatch")
            baseline=None if monitor not in previous else monitor_delta.validate_baseline(monitor_delta.load_bounded(Path(previous[monitor])),monitor)
            if dt.date.fromisoformat(current["as_of"]) != run_date: raise ValueError("monitor result date must equal run date")
            current_results[monitor]=current; baselines[monitor]=baseline
            outcomes[monitor]=monitor_delta.classify(current,baseline)
        except (OSError,KeyError,TypeError,ValueError,json.JSONDecodeError):
            outcomes[monitor]="unavailable"
            try: baselines[monitor]=monitor_delta.validate_baseline(monitor_delta.load_bounded(Path(previous[monitor])),monitor)
            except (OSError,KeyError,TypeError,ValueError,json.JSONDecodeError): baselines[monitor]=None
    # A source state is usable only with its strictly validated matching snapshot.
    source_baseline=baselines.get("source-monitor")
    prior_snapshot_bytes=None
    if source_baseline is not None and source_baseline["latest"] is not None and previous_source_snapshot is not None:
        try:
            prior_snapshot_bytes=Path(previous_source_snapshot).read_bytes()
            snapshot=json.loads(prior_snapshot_bytes)
            prior_artifact.source_monitor.validate_authenticated_previous_snapshot(
                snapshot,run_date,source_baseline["latest"]["as_of"])
        except (OSError,KeyError,TypeError,ValueError,json.JSONDecodeError):
            source_baseline=None; baselines["source-monitor"]=None; prior_snapshot_bytes=None
    if outcomes["source-monitor"] == "unavailable" and baselines.get("source-monitor") is not None and baselines["source-monitor"]["latest"] is not None and prior_snapshot_bytes is None:
        baselines["source-monitor"]=None
    for monitor in sorted(STATE_NAMES):
        baseline=baselines.get(monitor)
        if outcomes[monitor] == "unavailable":
            state=baseline if baseline is not None else monitor_delta.empty_baseline(monitor)
            payload=Path(previous[monitor]).read_bytes() if baseline is not None else _encoded(state)
        else:
            state=monitor_delta.updated_state(current_results[monitor],baseline)
            payload=_encoded(state)
        writes.append((output_dir/STATE_NAMES[monitor],payload))
    source_state=monitor_delta.validate_baseline(json.loads(dict(writes)[output_dir/STATE_NAMES["source-monitor"]]),"source-monitor")
    if outcomes["source-monitor"] == "unavailable":
        snapshot_payload=prior_snapshot_bytes or _encoded(prior_artifact.source_monitor.empty_snapshot(run_date,canonical_raw))
    else:
        if source_snapshot is None: raise ValueError("current source snapshot required")
        snapshot_payload=Path(source_snapshot).read_bytes(); snapshot=json.loads(snapshot_payload)
        prior_artifact.source_monitor.validate_current_snapshot(snapshot,canonical_raw)
        if snapshot["as_of"] != source_state["latest"]["as_of"]: raise ValueError("source result and snapshot dates differ")
        prior_snapshot=json.loads(prior_snapshot_bytes) if prior_snapshot_bytes is not None else None
        if prior_snapshot is not None:
            old_hashes=prior_artifact.source_monitor.validate_population(prior_snapshot["population"])
            new_hashes=prior_artifact.source_monitor.validate_population(snapshot["population"])
            if (snapshot["summary"]["baseline_added"] != len(new_hashes-old_hashes)
                    or snapshot["summary"]["baseline_removed"] != len(old_hashes-new_hashes)
                    or snapshot["metadata"]["population_baseline_unavailable"]):
                raise ValueError("current source snapshot churn is not derived from authenticated prior population")
        elif (snapshot["summary"]["baseline_added"] is not None
                or snapshot["summary"]["baseline_removed"] is not None
                or not snapshot["metadata"]["population_baseline_unavailable"]):
            raise ValueError("current source snapshot invents unavailable population history")
        expected_result=source_monitor_result.build(snapshot,prior_snapshot,canonical_raw)
        if current_results["source-monitor"] != expected_result:
            raise ValueError("source result does not match canonical snapshot recomputation")
    writes.append((output_dir/"source-snapshot.json",snapshot_payload))
    coordinated_write(writes)
    combined,code=combine(outcomes)
    manifest={"schema_version":"1.0","combined":combined,"exit_code":code,"outcomes":dict(sorted(outcomes.items())),
              "publication":{"state":[STATE_NAMES[x] for x in sorted(STATE_NAMES)],
                             "reports":["public-seo.json","public-seo.md","source-monitor-result.json","source-report.md","source-snapshot.json"]}}
    coordinated_write([(output_dir/"publication-manifest.json",(json.dumps(manifest,sort_keys=True,indent=2)+"\n").encode())])
    member_paths={name:output_dir/name for name in prior_artifact.PAYLOAD_NAMES}
    if all(path.is_file() for path in member_paths.values()):
        states={monitor:monitor_delta.validate_baseline(json.loads((output_dir/name).read_bytes()),monitor)
                for monitor,name in STATE_NAMES.items()}
        artifact_manifest={"schema_version":"2.0","run_as_of":run_date.isoformat(),
                           "state_as_of":{monitor:None if state["latest"] is None else state["latest"]["as_of"] for monitor,state in sorted(states.items())},
                           "members":{name:"sha256:"+hashlib.sha256(path.read_bytes()).hexdigest() for name,path in sorted(member_paths.items())}}
        coordinated_write([(output_dir/prior_artifact.MANIFEST_NAME,(json.dumps(artifact_manifest,sort_keys=True,separators=(",",":"))+"\n").encode())])
    return manifest


def _gh_json(path):
    if not isinstance(path,str): raise ValueError("GitHub API path invalid")
    allowed=(re.fullmatch(r"/repos/[^/?#]+/[^/?#]+/actions/workflows/[^/?#]+/runs\?branch=[^#]*&status=completed&per_page=[0-9]+",path)
             or re.fullmatch(r"/repos/[^/?#]+/[^/?#]+/actions/runs/[1-9][0-9]*/artifacts\?per_page=100",path))
    if not allowed:
        raise ValueError("GitHub API path invalid")
    completed=subprocess.run(["gh","api",path],check=True,capture_output=True,text=True)
    if len(completed.stdout.encode("utf-8")) > 2_000_000: raise ValueError("GitHub response oversized")
    return json.loads(completed.stdout)


def _repository_path(repository):
    if not isinstance(repository,str) or not REPOSITORY_RE.fullmatch(repository): raise ValueError("repository invalid")
    return "/".join(urllib.parse.quote(part,safe="") for part in repository.split("/"))


def _workflow_component(workflow):
    if not isinstance(workflow,str) or not WORKFLOW_RE.fullmatch(workflow): raise ValueError("workflow invalid")
    if workflow.isdigit() and not _positive_int(int(workflow)): raise ValueError("workflow invalid")
    return urllib.parse.quote(workflow,safe="")


def _runs_api_path(repository, workflow, branch):
    query=urllib.parse.urlencode({"branch":_validate_ref(branch),"status":"completed","per_page":MAX_CANDIDATES+1})
    return f"/repos/{_repository_path(repository)}/actions/workflows/{_workflow_component(workflow)}/runs?{query}"


def _validate_ref(ref):
    if not isinstance(ref,str) or not REF_RE.fullmatch(ref): raise ValueError("branch invalid")
    return ref


def _gh_download(repository, metadata, path):
    endpoint=f"/repos/{_repository_path(repository)}/actions/artifacts/{metadata['id']}/zip"
    process=subprocess.Popen(["gh","api",endpoint],stdout=subprocess.PIPE)
    size=0; digest=hashlib.sha256()
    try:
        with path.open("xb") as stream:
            while True:
                chunk=process.stdout.read(64*1024)
                if not chunk: break
                size += len(chunk)
                if size > metadata["size_in_bytes"] or size > MAX_ZIP_BYTES:
                    process.kill(); raise ValueError("artifact compressed size exceeded")
                digest.update(chunk); stream.write(chunk)
        if process.wait() != 0: raise subprocess.CalledProcessError(process.returncode,process.args)
        if size != metadata["size_in_bytes"]: raise ValueError("artifact compressed size mismatch")
        if "sha256:"+digest.hexdigest() != metadata["digest"]: raise ValueError("artifact API digest mismatch")
    finally:
        if process.poll() is None: process.kill(); process.wait()


def _validate_retrieve_local(args):
    """Validate every local/identifier input before the first remote operation."""
    if not _positive_int(args.current_run): raise ValueError("current run invalid")
    _repository_path(args.repository); _workflow_component(args.workflow); _validate_ref(args.branch)
    run_date=dt.date.fromisoformat(args.as_of)
    canonical=args.canonical
    if canonical.is_symlink() or not canonical.is_file(): raise ValueError("canonical path must be a regular non-symlink file")
    canonical_resolved=canonical.resolve(strict=True)
    raw=canonical.read_bytes()
    if len(raw) > prior_artifact.MAX_FILE_BYTES: raise ValueError("canonical input oversized")
    value=json.loads(raw)
    if not isinstance(value,dict) or not isinstance(value.get("countries"),list): raise ValueError("canonical schema invalid")
    prior_artifact.source_monitor.eligible_records(value)
    output=args.output_dir
    if output.is_symlink(): raise ValueError("output directory must not be a symlink")
    output.mkdir(parents=True,exist_ok=True)
    if not output.is_dir(): raise ValueError("output path must be a directory")
    if output.resolve(strict=True) == canonical_resolved.parent or canonical_resolved.is_relative_to(output.resolve(strict=True)):
        raise ValueError("input and output paths must not alias")
    destinations=[output/name for name in prior_artifact.PAYLOAD_NAMES]
    if any(path.exists() or path.is_symlink() for path in destinations): raise FileExistsError("prior output already exists")
    if any(output.iterdir()): raise FileExistsError("output directory must be empty")
    return run_date


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__); sub=parser.add_subparsers(dest="command",required=True)
    choose=sub.add_parser("retrieve"); choose.add_argument("--repository",required=True); choose.add_argument("--workflow",required=True)
    choose.add_argument("--branch",required=True); choose.add_argument("--current-run",type=int,required=True); choose.add_argument("--as-of",required=True)
    choose.add_argument("--canonical",type=Path,required=True); choose.add_argument("--output-dir",type=Path,required=True)
    finish=sub.add_parser("finalize"); finish.add_argument("--public-result",type=Path,required=True); finish.add_argument("--source-result",type=Path,required=True)
    finish.add_argument("--public-previous",type=Path); finish.add_argument("--source-previous",type=Path)
    finish.add_argument("--source-snapshot",type=Path); finish.add_argument("--source-previous-snapshot",type=Path)
    finish.add_argument("--canonical",type=Path,required=True)
    finish.add_argument("--as-of",required=True); finish.add_argument("--output-dir",type=Path,required=True)
    summary=sub.add_parser("summary"); summary.add_argument("--manifest",type=Path,required=True)
    args=parser.parse_args(argv)
    if args.command == "retrieve":
        try:
            run_date=_validate_retrieve_local(args)
            repository=_repository_path(args.repository)
        except (OSError,ValueError,json.JSONDecodeError):
            return EXIT_FATAL
        try:
            try:
                response=_gh_json(_runs_api_path(args.repository,args.workflow,args.branch))
            except (OSError,ValueError,json.JSONDecodeError,subprocess.SubprocessError):
                return EXIT_HISTORY_UNAVAILABLE
            if not isinstance(response,dict) or set(response) != {"workflow_runs"} or not isinstance(response["workflow_runs"],list):
                return EXIT_HISTORY_UNAVAILABLE
            runs=[]
            for row in response["workflow_runs"]:
                if isinstance(row,dict) and row.get("id") != args.current_run:
                    runs.append({"id":row.get("id"),"conclusion":row.get("conclusion")})
            with tempfile.TemporaryDirectory(prefix="seo-prior-") as folder:
                selected=retrieve_newest_compatible(
                    runs,run_date,args.canonical,Path(folder),
                    lambda run_id:_gh_json(f"/repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100"),
                    lambda metadata,path:_gh_download(args.repository,metadata,path))
            if selected:
                run_id,conclusion,payloads=selected
                coordinated_write([(args.output_dir/name,payload) for name,payload in payloads.items()])
                print(json.dumps({"selected":run_id,"conclusion":conclusion},sort_keys=True))
                return EXIT_SUCCESS
            return EXIT_HISTORY_UNAVAILABLE
        except (OSError,ValueError,json.JSONDecodeError):
            return EXIT_FATAL
    if args.command == "summary":
        try:
            if args.manifest.stat().st_size > 100_000: raise ValueError("publication manifest oversized")
            print(render_summary(json.loads(args.manifest.read_text(encoding="utf-8"))),end="")
            return 0
        except (OSError,ValueError,json.JSONDecodeError): return 3
    previous={}
    if args.public_previous: previous["public-seo"]=args.public_previous
    if args.source_previous: previous["source-monitor"]=args.source_previous
    manifest=finalize({"public-seo":args.public_result,"source-monitor":args.source_result},previous,args.output_dir,
                      dt.date.fromisoformat(args.as_of),args.source_snapshot,args.source_previous_snapshot,args.canonical)
    print(json.dumps({"combined":manifest["combined"],"outcomes":manifest["outcomes"]},sort_keys=True))
    return manifest["exit_code"]


if __name__ == "__main__": raise SystemExit(main())
