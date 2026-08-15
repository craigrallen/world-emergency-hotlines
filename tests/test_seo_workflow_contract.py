import os
import json
import re
import shutil
import subprocess
import unittest
import tempfile
import importlib.util
import datetime as dt
from pathlib import Path
from zipfile import ZipFile
from scripts import source_monitor

ROOT=Path(__file__).resolve().parents[1]
WORKFLOWS=sorted((ROOT/".github/workflows").glob("*.yml"))


def run_blocks(path):
    lines=path.read_text().splitlines()
    blocks=[]; index=0
    while index < len(lines):
        match=re.match(r"^(\s*)run:\s*\|[-+]?\s*$",lines[index])
        if not match:
            index+=1; continue
        parent=len(match.group(1)); index+=1; body=[]
        while index < len(lines):
            line=lines[index]
            if line.strip() and len(line)-len(line.lstrip()) <= parent: break
            body.append(line[parent+2:] if len(line) >= parent+2 else "")
            index+=1
        blocks.append("\n".join(body)+"\n")
    return blocks


def shell_safe_expressions(script):
    return re.sub(r"\$\{\{[^{}]+\}\}","GITHUB_EXPRESSION",script)


class SeoWorkflowContractTests(unittest.TestCase):
    def test_manual_verification_date_shell_validates_before_output(self):
        workflow=ROOT/".github/workflows/verification-operations.yml"
        text=workflow.read_text()
        block=next(value for value in run_blocks(workflow) if "as_of must be an exact ASCII" in value)
        self.assertNotIn("${{",block)
        self.assertIn("REQUESTED_AS_OF: ${{ inputs.as_of }}",text)
        today=dt.datetime.now(dt.timezone.utc).date()
        valid_cases={"default":"", "today":today.isoformat(), "past":"2000-02-29"}
        invalid_cases={
            "whitespace":" 2026-08-15", "trailing whitespace":"2026-08-15 ",
            "multiline":"2026-08-15\nforged=true", "control":"2026-08-15\t",
            "basic ISO":"20260815", "datetime":"2026-08-15T00:00:00Z",
            "impossible":"2026-02-30", "future":(today+dt.timedelta(days=1)).isoformat(),
        }
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/"github-output"
            for name,value in valid_cases.items():
                with self.subTest(name=name):
                    output.unlink(missing_ok=True)
                    env={**os.environ,"REQUESTED_AS_OF":value,"GITHUB_OUTPUT":str(output)}
                    result=subprocess.run(["bash"],input=block,cwd=ROOT,env=env,text=True,capture_output=True)
                    self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                    expected=today.isoformat() if value == "" else value
                    self.assertEqual(output.read_bytes(),f"as_of={expected}\n".encode("ascii"))
            for name,value in invalid_cases.items():
                with self.subTest(name=name):
                    output.unlink(missing_ok=True)
                    env={**os.environ,"REQUESTED_AS_OF":value,"GITHUB_OUTPUT":str(output)}
                    result=subprocess.run(["bash"],input=block,cwd=ROOT,env=env,text=True,capture_output=True)
                    self.assertNotEqual(result.returncode,0)
                    self.assertTrue(not output.exists() or output.read_bytes() == b"")

    def test_seo_workflow_shell_tolerates_only_history_unavailable_and_recovers_baseline(self):
        blocks=run_blocks(ROOT/".github/workflows/seo-monitor.yml")
        script=next(x for x in blocks if "retrieval_status=$?" in x)+next(x for x in blocks if "source_snapshot_previous" in x)
        with tempfile.TemporaryDirectory() as folder:
            temp=Path(folder); (temp/"hotlines.json").write_text('{"countries":[]}\n')
            bindir=temp/"bin"; bindir.mkdir(); python=bindir/"python"; gh=bindir/"gh"
            gh.write_text("#!/bin/bash\nexit \"${FAKE_GH_STATUS:-0}\"\n"); gh.chmod(0o755)
            python.write_text("""#!/bin/bash
set -e
if [[ "$*" == *"seo_orchestrator.py retrieve"* ]]; then
  if [ "${RETRIEVAL_STATUS:-0}" -eq 3 ]; then exit 3; fi
  gh api /fake || exit "${RETRIEVAL_STATUS:-4}"
  if [ "${RETRIEVAL_STATUS:-0}" -eq 4 ]; then exit 4; fi
  mkdir -p prior
  for f in monitor-state.json source-monitor-state.json source-snapshot.json artifact-manifest.json; do printf '{}\\n' > "prior/$f"; done
  printf '{"selected":9}\\n'; exit 0
fi
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  *freshness_report.py*) touch output/freshness.json output/freshness.md;;
  *source_monitor.py*) touch output/source-snapshot-current.json output/source-report.md;;
  *source_monitor_result.py*) touch output/source-monitor-result.json;;
  *verification_workbench.py*) touch output/workbench.json output/workbench.md;;
  *public_seo_monitor.py*) touch output/public-seo.json output/public-seo.md;;
  *"seo_orchestrator.py finalize"*) for f in monitor-state.json source-monitor-state.json source-snapshot.json artifact-manifest.json publication-manifest.json; do touch "output/$f"; done;;
esac
exit 0
"""); python.chmod(0o755)
            env={**os.environ,"PATH":str(bindir)+os.pathsep+os.environ["PATH"],"GITHUB_REPOSITORY":"owner/repo","DEFAULT_BRANCH":"main","CURRENT_RUN_ID":"10","GITHUB_STEP_SUMMARY":str(temp/"summary"),"CALLS":str(temp/"calls")}
            completed=subprocess.run(["bash"],input=script,cwd=temp,env={**env,"RETRIEVAL_STATUS":"4","FAKE_GH_STATUS":"1"},text=True,capture_output=True)
            self.assertEqual(completed.returncode,0,completed.stdout+completed.stderr)
            calls=(temp/"calls").read_text()
            self.assertIn("public_seo_monitor.py",calls); self.assertTrue((temp/"output/artifact-manifest.json").exists())
            self.assertNotIn("--previous",calls)
            self.assertNotIn("--public-previous",calls)
            self.assertNotIn("--source-previous",calls)
            self.assertFalse(any((temp/"prior"/name).exists() for name in ("monitor-state.json","source-monitor-state.json","source-snapshot.json","artifact-manifest.json")))
            shutil.rmtree(temp/"prior"); shutil.rmtree(temp/"output"); (temp/"calls").unlink()
            completed=subprocess.run(["bash"],input=script,cwd=temp,env={**env,"RETRIEVAL_STATUS":"4","FAKE_GH_STATUS":"0"},text=True,capture_output=True)
            self.assertEqual(completed.returncode,0,completed.stdout+completed.stderr)
            self.assertNotIn("--previous",(temp/"calls").read_text())
            shutil.rmtree(temp/"prior"); shutil.rmtree(temp/"output"); (temp/"calls").unlink()
            completed=subprocess.run(["bash"],input=script,cwd=temp,env={**env,"RETRIEVAL_STATUS":"3"},text=True,capture_output=True)
            self.assertEqual(completed.returncode,3); self.assertFalse((temp/"calls").exists())
            completed=subprocess.run(["bash"],input=script,cwd=temp,env=env,text=True,capture_output=True)
            self.assertEqual(completed.returncode,0,completed.stdout+completed.stderr)
            calls=(temp/"calls").read_text()
            self.assertEqual(calls.count("--previous prior/source-snapshot.json"),2)
            self.assertIn("--public-previous prior/monitor-state.json",calls)
            self.assertIn("--source-previous prior/source-monitor-state.json",calls)
            self.assertIn("--source-snapshot output/source-snapshot-current.json",calls)
            self.assertIn("--source-previous-snapshot prior/source-snapshot.json",calls)

    def test_optional_workflow_arrays_are_executable_under_nounset(self):
        block=next(x for x in run_blocks(ROOT/".github/workflows/seo-monitor.yml") if "source_snapshot_previous" in x)
        self.assertNotIn('--limit 25 "${source_previous[@]}"',block)
        self.assertNotIn('  "${previous[@]}" "${source_state_previous[@]}"',block)
        self.assertIn('${source_previous[@]+"${source_previous[@]}"}',block)
        for populated in (False,True):
            with self.subTest(populated=populated), tempfile.TemporaryDirectory() as folder:
                temp=Path(folder); (temp/"hotlines.json").write_text('{"countries":[]}\n')
                (temp/"prior").mkdir(); (temp/"output").mkdir(); bindir=temp/"bin"; bindir.mkdir()
                if populated:
                    for name in ("monitor-state.json","source-monitor-state.json","source-snapshot.json"):
                        (temp/"prior"/name).write_text('{}\n')
                python=bindir/"python"
                python.write_text("#!/bin/bash\nset -euo pipefail\nprintf '%s\\n' \"$*\" >> \"$CALLS\"\ncase \"$*\" in *freshness_report.py*) touch output/freshness.json output/freshness.md;; *source_monitor.py*) touch output/source-snapshot-current.json output/source-report.md;; *source_monitor_result.py*) touch output/source-monitor-result.json;; *verification_workbench.py*) touch output/workbench.json output/workbench.md;; *public_seo_monitor.py*) touch output/public-seo.json output/public-seo.md;; *\"seo_orchestrator.py finalize\"*) touch output/{monitor-state,source-monitor-state,source-snapshot,artifact-manifest,publication-manifest}.json;; esac\n")
                python.chmod(0o755)
                env={**os.environ,"PATH":str(bindir)+os.pathsep+os.environ["PATH"],"CALLS":str(temp/"calls")}
                completed=subprocess.run(["bash"],input=block,cwd=temp,env=env,text=True,capture_output=True)
                self.assertEqual(completed.returncode,0,completed.stdout+completed.stderr)
                calls=(temp/"calls").read_text()
                if populated:
                    self.assertEqual(calls.count("--previous prior/source-snapshot.json"),2)
                    self.assertIn("--public-previous prior/monitor-state.json",calls)
                    self.assertIn("--source-previous prior/source-monitor-state.json",calls)
                    self.assertIn("--source-previous-snapshot prior/source-snapshot.json",calls)
                else:
                    self.assertNotIn("--previous",calls)
                    self.assertNotIn("--public-previous",calls)
                    self.assertNotIn("--source-previous",calls)

    def test_manual_history_parser_returns_bounded_newest_successful_runs(self):
        spec=importlib.util.spec_from_file_location("manual_prior_history",ROOT/"scripts/manual_prior_history.py")
        helper=importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
        def run(run_id, conclusion, event, stamp):
            return {"id":run_id,"status":"completed","conclusion":conclusion,"event":event,
                    "created_at":stamp,"updated_at":stamp}
        runs={"workflow_runs":[run(7,"success","workflow_dispatch","2026-08-14T10:00:00Z"),
            run(9,"failure","workflow_dispatch","2026-08-14T12:00:00Z"),
            run(5,"success","schedule","2026-08-13T10:00:00Z"),
            run(11,"success","schedule","2026-08-16T10:00:00Z")]}
        self.assertEqual(helper.select_runs(runs,10,__import__("datetime").date(2026,8,15)),[7,5])
        with self.assertRaises(ValueError): helper.select_runs({"workflow_runs":"bad"},10,__import__("datetime").date(2026,8,15))
        artifact={"total_count":1,"artifacts":[{"id":3,"name":"verification-operations-2026-08-14",
            "size_in_bytes":10,"created_at":"2026-08-14T12:00:00Z","expired":False,"digest":"sha256:"+"a"*64}]}
        self.assertEqual(helper.select_artifact(artifact)["id"],3)
        text=(ROOT/".github/workflows/verification-operations.yml").read_text()
        self.assertNotIn("--argjson",text); self.assertNotIn("--jq",text)
        self.assertIn("manual_prior_history.py retrieve",text)

    def test_manual_history_actual_shell_with_strict_fake_gh(self):
        block=next(value for value in run_blocks(ROOT/".github/workflows/verification-operations.yml")
                   if "manual_prior_history.py retrieve" in value)
        with tempfile.TemporaryDirectory() as folder:
            temp=Path(folder); (temp/"scripts").symlink_to(ROOT/"scripts",target_is_directory=True)
            canonical=temp/"hotlines.json"; canonical.write_bytes((ROOT/"hotlines.json").read_bytes())
            raw=canonical.read_bytes(); data=json.loads(raw)
            snapshot=source_monitor.build(data,raw,__import__("datetime").date(2026,8,14),1,None,
                lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"","truncated":False})
            snapshot_payload=json.dumps(snapshot).encode()
            archive=temp/"artifact.zip"
            member_manifest=json.dumps({"schema_version":"1.0","run_as_of":"2026-08-14","members":{
                "source-snapshot.json":"sha256:"+__import__("hashlib").sha256(snapshot_payload).hexdigest()}})
            with ZipFile(archive,"w") as zipped:
                zipped.writestr("source-snapshot.json",snapshot_payload)
                zipped.writestr("source-snapshot-manifest.json",member_manifest)
            digest=__import__("hashlib").sha256(archive.read_bytes()).hexdigest()
            runs=temp/"runs.json"; runs.write_text(json.dumps({"workflow_runs":[
                {"id":8,"status":"completed","conclusion":"success","event":"workflow_dispatch","created_at":"2026-08-14T12:00:00Z","updated_at":"2026-08-14T12:00:00Z"},
                {"id":7,"status":"completed","conclusion":"success","event":"schedule","created_at":"2026-08-13T12:00:00Z","updated_at":"2026-08-13T12:00:00Z"}]}))
            artifacts=temp/"artifacts.json"; artifacts.write_text(json.dumps({"total_count":1,"artifacts":[{
                "id":3,"name":"verification-operations-2026-08-14","size_in_bytes":archive.stat().st_size,"created_at":"2026-08-14T12:00:00Z",
                "expired":False,"digest":"sha256:"+digest}]}))
            malformed_artifacts=temp/"malformed-artifacts.json"; malformed_artifacts.write_text(json.dumps({"total_count":2,"artifacts":[]}))
            bindir=temp/"bin"; bindir.mkdir(); fake=bindir/"gh"
            fake.write_text("#!/bin/bash\nset -e\nendpoint=${!#}\nprintf '%s\\n' \"$endpoint\" >> \"$FAKE_CALLS\"\ncase \"$endpoint\" in *'/runs?'*) cat \"$FAKE_RUNS\";; *'/runs/8/artifacts?'*) cat \"$FAKE_BAD_ARTIFACTS\";; *'/artifacts?per_page=100') cat \"$FAKE_ARTIFACTS\";; *'/zip') cat \"$FAKE_ZIP\";; *) exit 65;; esac\n")
            fake.chmod(0o755); github_output=temp/"output"; summary=temp/"summary"
            env={**os.environ,"PATH":str(bindir)+os.pathsep+os.environ["PATH"],"GITHUB_REPOSITORY":"owner/repo",
                 "DEFAULT_BRANCH":"main","CURRENT_RUN_ID":"10","REPORT_AS_OF":"2026-08-15","GH_TOKEN":"fake",
                 "GITHUB_OUTPUT":str(github_output),"GITHUB_STEP_SUMMARY":str(summary),"FAKE_RUNS":str(runs),
                 "FAKE_ARTIFACTS":str(artifacts),"FAKE_BAD_ARTIFACTS":str(malformed_artifacts),
                 "FAKE_ZIP":str(archive),"FAKE_CALLS":str(temp/"gh-calls")}
            completed=subprocess.run(["bash"],input=block,cwd=temp,env=env,text=True,capture_output=True)
            self.assertEqual(completed.returncode,0,completed.stdout+completed.stderr)
            self.assertIn("available=true",github_output.read_text())
            calls=(temp/"gh-calls").read_text(); self.assertIn("/runs/8/artifacts",calls); self.assertIn("/runs/7/artifacts",calls)
            # Remote API failure and malformed JSON exhaust history safely.
            fake.write_text("#!/bin/bash\nexit 70\n"); fake.chmod(0o755)
            for payload in (None,b"{malformed"):
                if payload is not None: runs.write_bytes(payload); fake.write_text("#!/bin/bash\ncat \"$FAKE_RUNS\"\n"); fake.chmod(0o755)
                for path in (temp/"prior",github_output,summary):
                    if path.is_dir(): shutil.rmtree(path)
                    elif path.exists(): path.unlink()
                completed=subprocess.run(["bash"],input=block,cwd=temp,env=env,text=True,capture_output=True)
                self.assertEqual(completed.returncode,0); self.assertIn("available=false",github_output.read_text())
    def test_monitor_test_command_includes_every_monitoring_boundary_module(self):
        scripts=json.loads((ROOT/"web/package.json").read_text())["scripts"]
        command=scripts["test:monitor:seo"]
        included=set(re.findall(r"tests\.(test_[a-z0-9_]+)",command))
        expected={
            "test_monitor_delta", "test_public_seo_monitor", "test_search_console_monitor",
            "test_source_monitor", "test_source_monitor_result", "test_prior_artifact",
            "test_seo_orchestrator", "test_seo_workflow_contract", "test_verification_workbench",
        }
        present={path.stem for path in (ROOT/"tests").glob("test_*.py") if path.stem in expected}
        self.assertEqual(present,expected,"update the monitoring boundary inventory when modules change")
        self.assertEqual(included,present,"test:monitor:seo must include every monitoring boundary module")

    def test_monitor_workflow_structure_is_bounded_read_only_and_secretless(self):
        text=(ROOT/".github/workflows/seo-monitor.yml").read_text()
        top_level=[line.rstrip(":") for line in text.splitlines() if line and not line[0].isspace()]
        self.assertEqual(top_level,["name: Sustainable SEO Monitoring","on","permissions","concurrency","jobs"])
        self.assertRegex(text,r"(?m)^  workflow_dispatch:\s*$")
        self.assertRegex(text,r'(?m)^    - cron: "41 7 \* \* 1"$')
        self.assertRegex(text,r"(?ms)^permissions:\n  contents: read\n  actions: read\n")
        self.assertRegex(text,r"(?ms)^concurrency:\n  group: seo-monitor-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true\n")
        self.assertRegex(text,r"(?m)^    timeout-minutes: 10$")
        uploads=re.findall(r"(?ms)^      - uses: actions/upload-artifact@v6\n(.*?)(?=^      - |\Z)",text)
        self.assertEqual(len(uploads),2)
        self.assertTrue(all("        if: always()\n" in block and "          retention-days: 90\n" in block for block in uploads))
        self.assertIn("          if-no-files-found: error\n",uploads[0])
        folded=text.casefold()
        for forbidden in ("secrets.","search_console_monitor","contents: write","id-token: write","pull-requests: write"):
            self.assertNotIn(forbidden,folded)
        summary_block=next(block for block in run_blocks(ROOT/".github/workflows/seo-monitor.yml") if "scripts/seo_workflow_summary.py" in block)
        self.assertNotRegex(summary_block,r"\bcat\b")
        self.assertIn("scripts/seo_workflow_summary.py",summary_block)

    def test_workflow_summary_bounds_and_malformed_fallback(self):
        spec=importlib.util.spec_from_file_location("workflow_summary",ROOT/"scripts/seo_workflow_summary.py")
        module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); manifest=root/"manifest.json"; result=root/"result.json"
            manifest.write_text(json.dumps({"schema_version":"1.0","combined":"unavailable","exit_code":2,
                "outcomes":{"public-seo":"regression","source-monitor":"unavailable"},
                "publication":{"state":["monitor-state.json","source-monitor-state.json"],"reports":["public-seo.json","public-seo.md","source-monitor-result.json","source-report.md","source-snapshot.json"]}}))
            result.write_text(json.dumps({"schema_version":"1.0","monitor":"public-seo","as_of":"2026-08-15","status":"regression",
                "issues":[{"code":"fixed","subject":"/","detail":"bounded"}],"metrics":{}}))
            rendered=module.render(manifest,[result]); self.assertLess(len(rendered.encode()),module.MAX_SUMMARY_BYTES); self.assertIn("issues 1",rendered)
            result.write_bytes(b"\xff"); self.assertEqual(module.main(["--manifest",str(manifest),"--result",str(result)]),3)
            result.write_bytes(b"x"*(module.MAX_INPUT_BYTES+1)); self.assertEqual(module.main(["--manifest",str(manifest),"--result",str(result)]),3)

    def test_duplicate_freshness_workflows_are_manual_only(self):
        for name in ("freshness-review.yml","verification-operations.yml"):
            text=(ROOT/".github/workflows"/name).read_text()
            trigger_block=re.search(r"(?ms)^on:\n(.*?)(?=^[^ \n][^\n]*:\n)",text)
            self.assertIsNotNone(trigger_block)
            self.assertRegex(trigger_block.group(1),r"(?m)^  workflow_dispatch:")
            self.assertNotRegex(trigger_block.group(1),r"(?m)^  (schedule|push|pull_request):")

    def test_every_literal_run_block_has_no_expression_injection_and_is_valid_bash(self):
        checked=0
        for workflow in WORKFLOWS:
            for block in run_blocks(workflow):
                checked+=1
                self.assertNotIn("${{",block,f"{workflow.name}: expressions must enter scripts through env")
                result=subprocess.run(["bash","-n"],input=block,text=True,capture_output=True)
                self.assertEqual(result.returncode,0,f"{workflow.name}: {result.stderr}")
        self.assertGreater(checked,0)

    def test_actionlint_gate_is_structural_and_local_validation_is_strict_in_ci(self):
        text=(ROOT/".github/workflows/data-ci.yml").read_text()
        gates=re.findall(r"(?ms)^      - name: Validate GitHub Actions workflows\n        env:\n          ACTIONLINT_VERSION: 1\.7\.12\n          ACTIONLINT_SHA256: [0-9a-f]{64}\n        run: \|\n.*?(?=^      - name:)",text)
        self.assertEqual(len(gates),1)
        self.assertNotIn("docker://",gates[0]); self.assertNotRegex(gates[0],r"curl[^\n]*\|")
        self.assertIn("sha256sum --check --strict",gates[0])
        direct_run='          "$RUNNER_TEMP/actionlint" -color\n'
        path_handoff='          printf \'%s\\n\' "$RUNNER_TEMP" >> "$GITHUB_PATH"\n'
        self.assertIn(direct_run,gates[0]); self.assertIn(path_handoff,gates[0])
        self.assertLess(gates[0].index(direct_run),gates[0].index(path_handoff))
        executable=shutil.which("actionlint")
        if executable is None:
            if os.environ.get("CI"): self.fail("actionlint must be available in the CI validation gate")
            self.skipTest("local actionlint is optional; dependency-free contract tests remain portable")
        result=subprocess.run([executable],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_protected_files_have_no_added_diff(self):
        protected=["hotlines.json","information.json","docs/dataset-releases.json","docs/dataset-release-snapshots","LICENSE","sources"]
        result=subprocess.run(["git","diff","--name-only","origin/main","--",*protected],cwd=ROOT,capture_output=True,text=True,check=True)
        self.assertEqual(result.stdout.splitlines(),[])
        untracked=subprocess.run(["git","ls-files","--others","--exclude-standard"],cwd=ROOT,capture_output=True,text=True,check=True)
        def protected_path(path): return any(path==item or path.startswith(item.rstrip("/")+"/") for item in protected)
        self.assertEqual([path for path in untracked.stdout.splitlines() if protected_path(path)],[])


if __name__=="__main__": unittest.main()
