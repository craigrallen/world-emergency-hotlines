import importlib.util
import json
import hashlib
import subprocess
import tempfile
import unittest
import io
import datetime as dt
from unittest import mock
from pathlib import Path
from zipfile import ZipFile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("orchestrator",ROOT/"scripts/seo_orchestrator.py")
orch=importlib.util.module_from_spec(spec); spec.loader.exec_module(orch)


def result(monitor,date,status="ok",issues=None):
    return {"schema_version":"1.0","monitor":monitor,"as_of":date,"status":status,"issues":issues or [],"metrics":{}}


class SeoOrchestratorTests(unittest.TestCase):
    def test_retrieve_cli_exit_classes_and_local_validation_precedes_remote(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical=root/"hotlines.json"; canonical.write_text(json.dumps({"countries":[]}))
            def argv(output):
                return ["retrieve","--repository","owner/repo","--workflow","seo-monitor.yml","--branch","main",
                        "--current-run","10","--as-of","2026-08-15","--canonical",str(canonical),"--output-dir",str(output)]
            with mock.patch.object(orch,"_gh_json",side_effect=subprocess.CalledProcessError(1,["gh"])):
                self.assertEqual(orch.main(argv(root/"remote-failure")),orch.EXIT_HISTORY_UNAVAILABLE)
            with mock.patch.object(orch,"_gh_json",return_value={"workflow_runs":[]}):
                self.assertEqual(orch.main(argv(root/"no-runs")),orch.EXIT_HISTORY_UNAVAILABLE)
            with mock.patch.object(orch,"_gh_json",return_value={"workflow_runs":"untrusted"}):
                self.assertEqual(orch.main(argv(root/"malformed")),orch.EXIT_HISTORY_UNAVAILABLE)
            unsafe=root/"unsafe"; unsafe.mkdir(); (unsafe/"monitor-state.json").write_text("existing")
            with mock.patch.object(orch,"_gh_json") as remote:
                self.assertEqual(orch.main(argv(unsafe)),orch.EXIT_FATAL); remote.assert_not_called()

    def test_retrieve_cli_success_and_fatal_publication_are_distinct(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self._artifact_fixture(root)
            base=["retrieve","--repository","owner/repo","--workflow","seo-monitor.yml","--branch","main",
                  "--current-run","10","--as-of","2026-08-15","--canonical",str(canonical)]
            selected=(9,"success",payloads)
            with mock.patch.object(orch,"_gh_json",return_value={"workflow_runs":[{"id":9,"conclusion":"success"}]}), mock.patch.object(orch,"retrieve_newest_compatible",return_value=selected):
                self.assertEqual(orch.main(base+["--output-dir",str(root/"success")]),orch.EXIT_SUCCESS)
                self.assertEqual({p.name for p in (root/"success").iterdir()},set(orch.prior_artifact.PAYLOAD_NAMES)|{orch.prior_artifact.MANIFEST_NAME})
            with mock.patch.object(orch,"_gh_json",return_value={"workflow_runs":[{"id":9,"conclusion":"success"}]}), mock.patch.object(orch,"retrieve_newest_compatible",return_value=selected), mock.patch.object(orch,"coordinated_write",side_effect=OSError("publication")):
                self.assertEqual(orch.main(base+["--output-dir",str(root/"publication-failure")]),orch.EXIT_FATAL)

    def test_finalize_rejects_forged_source_result(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); out=root/"out"; out.mkdir()
            data={"countries":[{"country":"X","hotlines":[{"id":"weh_1","name":"Help","category":"emergency","website":"https://example.org/","sources":[],"voice_numbers":[]}]}]}
            raw=json.dumps(data).encode(); canonical=root/"hotlines.json"; canonical.write_bytes(raw)
            snap=orch.prior_artifact.source_monitor.build(data,raw,dt.date(2026,8,15),1,None,
                lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"","truncated":False})
            snapshot=root/"snapshot.json"; snapshot.write_text(json.dumps(snap))
            public=root/"public.json"; public.write_text(json.dumps(result("public-seo","2026-08-15")))
            forged=orch.source_monitor_result.build(snap,None,raw); forged["metrics"]={}
            source=root/"source.json"; source.write_text(json.dumps(forged))
            with self.assertRaises(ValueError): orch.finalize({"public-seo":public,"source-monitor":source},{},out,
                dt.date(2026,8,15),snapshot,None,canonical)
    def test_complete_independent_continuity_across_more_than_candidate_window(self):
        issue=[{"code":"broken","subject":"fixed","detail":"fixture"}]
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); data={"countries":[{"country":"X","hotlines":[{"id":"weh_1","name":"Help","category":"emergency","website":"https://example.org/","sources":[],"voice_numbers":[]}]}]}; raw=json.dumps(data).encode()
            canonical=root/"hotlines.json"; canonical.write_bytes(raw)
            previous={}; previous_snapshot=None; prior_public_bytes=None; prior_source_bytes=None; prior_snapshot_bytes=None
            def run(day,public_status="ok",source_status="ok",public_issues=None,source_issues=None,missing_public=False,missing_source=False):
                nonlocal previous,previous_snapshot
                date=(dt.date(2026,8,1)+dt.timedelta(days=day)).isoformat(); out=root/f"out-{day}"; out.mkdir()
                pub=root/f"pub-{day}.json"; src=root/f"src-{day}.json"; snap=root/f"snap-{day}.json"
                if not missing_public: pub.write_text(json.dumps(result("public-seo",date,public_status,public_issues)))
                prior_value=json.loads(Path(previous_snapshot).read_text()) if previous_snapshot else None
                snapshot=orch.prior_artifact.source_monitor.build(data,raw,dt.date.fromisoformat(date),1,prior_value,
                    lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"","truncated":False})
                snap.write_text(json.dumps(snapshot))
                if not missing_source:
                    src.write_text(json.dumps(orch.source_monitor_result.build(snapshot,prior_value,raw)))
                manifest=orch.finalize({"public-seo":pub,"source-monitor":src},previous,out,dt.date.fromisoformat(date),snap,previous_snapshot,canonical)
                previous={"public-seo":out/"monitor-state.json","source-monitor":out/"source-monitor-state.json"}; previous_snapshot=out/"source-snapshot.json"
                self.assertTrue(all((out/name).is_file() for name in orch.prior_artifact.EXPECTED))
                return manifest,out
            first,out=run(0); self.assertEqual(first["combined"],"baseline")
            prior_public_bytes=(out/"monitor-state.json").read_bytes()
            # One monitor advances while public is unavailable, then both carry for 21 runs.
            manifest,out=run(1,missing_public=True)
            self.assertEqual(manifest["outcomes"],{"public-seo":"unavailable","source-monitor":"unchanged"})
            self.assertEqual((out/"monitor-state.json").read_bytes(),prior_public_bytes)
            prior_source_bytes=(out/"source-monitor-state.json").read_bytes(); prior_snapshot_bytes=(out/"source-snapshot.json").read_bytes()
            for day in range(2,23):
                manifest,out=run(day,missing_public=True,missing_source=True)
                self.assertEqual((out/"monitor-state.json").read_bytes(),prior_public_bytes)
                self.assertEqual((out/"source-monitor-state.json").read_bytes(),prior_source_bytes)
                self.assertEqual((out/"source-snapshot.json").read_bytes(),prior_snapshot_bytes)
            # Exercise the generated artifact boundary, not just in-memory state paths.
            archive=root/"unavailable-run.zip"
            with ZipFile(archive,"w") as zipped:
                for name in orch.prior_artifact.EXPECTED: zipped.writestr(name,(out/name).read_bytes())
            extracted=orch.prior_artifact.extract_candidate(archive,dt.date(2026,8,24),canonical)
            retrieved=root/"retrieved"; retrieved.mkdir()
            for name,payload in extracted.items(): (retrieved/name).write_bytes(payload)
            previous={"public-seo":retrieved/"monitor-state.json","source-monitor":retrieved/"source-monitor-state.json"}
            previous_snapshot=retrieved/"source-snapshot.json"
            manifest,_=run(23)
            self.assertEqual(manifest["outcomes"],{"public-seo":"unchanged","source-monitor":"unchanged"})

    def test_authenticated_artifact_continues_across_canonical_membership_churn(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); day_a=dt.date(2026,8,14); day_b=dt.date(2026,8,15)
            def row(rid,url,category="general_support"):
                return {"id":rid,"name":rid,"category":category,"website":url,"sources":[],"voice_numbers":[]}
            data_a={"countries":[{"country":"X","hotlines":[
                row("stable","https://stable.example/"), row("deleted","https://deleted.example/"),
                row("changed","https://old.example/"), row("category","https://category.example/")]}]}
            raw_a=json.dumps(data_a).encode(); canonical=root/"hotlines.json"; canonical.write_bytes(raw_a)
            ok=lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"stable", "truncated":False}
            snapshot_a=orch.prior_artifact.source_monitor.build(data_a,raw_a,day_a,20,None,ok)
            public_a=result("public-seo",day_a.isoformat()); source_a=orch.source_monitor_result.build(snapshot_a,None,raw_a)
            payloads={"source-snapshot.json":json.dumps(snapshot_a).encode(),
                "monitor-state.json":json.dumps({"schema_version":"2.0","monitor":"public-seo","latest":public_a,"history":[public_a]}).encode(),
                "source-monitor-state.json":json.dumps({"schema_version":"2.0","monitor":"source-monitor","latest":source_a,"history":[source_a]}).encode()}
            payloads[orch.prior_artifact.MANIFEST_NAME]=json.dumps({"schema_version":"2.0","run_as_of":day_a.isoformat(),
                "state_as_of":{"public-seo":day_a.isoformat(),"source-monitor":day_a.isoformat()},
                "members":{name:"sha256:"+hashlib.sha256(value).hexdigest() for name,value in sorted(payloads.items())}}).encode()
            archive=root/"a.zip"
            with ZipFile(archive,"w") as zipped:
                for name,value in payloads.items(): zipped.writestr(name,value)

            data_b={"countries":[{"country":"X","hotlines":[
                row("stable","https://stable.example/"), row("changed","https://new.example/"),
                row("category","https://category.example/","emergency"), row("added","https://added.example/")]}]}
            raw_b=json.dumps(data_b).encode(); canonical.write_bytes(raw_b)
            extracted=orch.prior_artifact.extract_candidate(archive,day_b,canonical)
            prior_dir=root/"prior"; prior_dir.mkdir()
            for name,value in extracted.items(): (prior_dir/name).write_bytes(value)
            calls=[]
            def fetch_b(url): calls.append(url); return ok(url)
            snapshot_b=orch.prior_artifact.source_monitor.build(data_b,raw_b,day_b,20,snapshot_a,fetch_b)
            self.assertNotIn("https://deleted.example/",calls); self.assertNotIn("https://old.example/",calls)
            self.assertEqual(snapshot_b["summary"]["baseline_added"],2)
            self.assertEqual(snapshot_b["summary"]["baseline_removed"],2)
            stable=next(item for item in snapshot_b["observations"] if item["record_id"]=="stable")
            self.assertEqual(stable["changes"],[])
            current_snapshot=root/"current.json"; current_snapshot.write_text(json.dumps(snapshot_b))
            public_result=root/"public.json"; public_result.write_text(json.dumps(result("public-seo",day_b.isoformat())))
            source_result=root/"source.json"; source_result.write_text(json.dumps(orch.source_monitor_result.build(snapshot_b,snapshot_a,raw_b)))
            output=root/"out"; output.mkdir()
            manifest=orch.finalize({"public-seo":public_result,"source-monitor":source_result},
                {"public-seo":prior_dir/"monitor-state.json","source-monitor":prior_dir/"source-monitor-state.json"},
                output,day_b,current_snapshot,prior_dir/"source-snapshot.json",canonical)
            self.assertEqual(manifest["outcomes"]["source-monitor"],"unchanged")
            state=json.loads((output/"source-monitor-state.json").read_text())
            self.assertEqual([item["as_of"] for item in state["history"]],[day_a.isoformat(),day_b.isoformat()])

    def test_regression_survives_unavailable_runs_and_malformed_prior_is_not_carried(self):
        issue=[{"code":"broken","subject":"fixed","detail":"fixture"}]
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); out=root/"out"; out.mkdir(); date=dt.date(2026,8,15)
            regression=result("public-seo","2026-08-14","regression",issue)
            good_source=result("source-monitor","2026-08-14")
            public_state=root/"public-state.json"; source_state=root/"source-state.json"
            public_state.write_text(json.dumps({"schema_version":"2.0","monitor":"public-seo","latest":regression,"history":[regression]}))
            source_state.write_text(json.dumps({"schema_version":"2.0","monitor":"source-monitor","latest":good_source,"history":[good_source]}))
            malformed=root/"malformed.json"; malformed.write_text('{"schema_version":"2.0","secret":"do-not-carry"}')
            src_snapshot=orch.prior_artifact.source_monitor.empty_snapshot(dt.date(2026,8,14),orch.prior_artifact.source_monitor.CANONICAL.read_bytes())
            # A malformed source pair invalidates only that monitor; malformed public cannot be republished.
            snap=root/"prior-snapshot.json"; snap.write_text(json.dumps(src_snapshot))
            manifest=orch.finalize({"public-seo":root/"missing-public","source-monitor":root/"missing-source"},
                {"public-seo":public_state,"source-monitor":malformed},out,date,None,snap)
            self.assertEqual(manifest["outcomes"],{"public-seo":"unavailable","source-monitor":"unavailable"})
            self.assertEqual((out/"monitor-state.json").read_bytes(),public_state.read_bytes())
            self.assertNotIn("do-not-carry",(out/"source-monitor-state.json").read_text())
            self.assertIsNone(json.loads((out/"source-monitor-state.json").read_text())["latest"])
    def test_combined_outcomes(self):
        self.assertEqual(orch.combine({"a":"baseline","b":"baseline"}),("baseline",0))
        self.assertEqual(orch.combine({"a":"continuing","b":"unchanged"}),("stable",0))
        self.assertEqual(orch.combine({"a":"recovered","b":"unchanged"}),("recovered",0))
        self.assertEqual(orch.combine({"a":"regression","b":"unchanged"}),("regression",1))
        self.assertEqual(orch.combine({"a":"regression","b":"unavailable"}),("unavailable",2))

    def test_healthy_public_and_source_sequences_and_manifest(self):
        issue=[{"code":"broken","subject":"fixed","detail":"fixture"}]
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); sequence=0; prior_snapshot=None
            data={"countries":[{"country":"X","hotlines":[{"id":"weh_1","name":"Help","category":"emergency","website":"https://example.org/","sources":[],"voice_numbers":[]}]}]}
            raw=json.dumps(data).encode()
            canonical=root/"hotlines.json"; canonical.write_bytes(raw)
            def run(date,pstatus="ok",sstatus="ok",pissues=None,sissues=None,previous=None):
                nonlocal sequence
                sequence+=1; out=root/f"out-{sequence}"; out.mkdir()
                pub=root/f"public-{sequence}.json"; src=root/f"source-{sequence}.json"; snap=root/f"snapshot-{sequence}.json"
                pub.write_text(json.dumps(result("public-seo",date,pstatus,pissues)))
                previous_snapshot=None if previous is None else previous["source-monitor"].parent/"source-snapshot.json"
                prior_value=json.loads(previous_snapshot.read_text()) if previous_snapshot else None
                snapshot=orch.prior_artifact.source_monitor.build(data,raw,dt.date.fromisoformat(date),1,prior_value,
                    lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"","truncated":False})
                snap.write_text(json.dumps(snapshot))
                src.write_text(json.dumps(orch.source_monitor_result.build(snapshot,prior_value,raw)))
                return orch.finalize({"public-seo":pub,"source-monitor":src},previous or {},out,
                    dt.date.fromisoformat(date),snap,previous_snapshot,canonical),out
            first,out=run("2026-08-11"); self.assertEqual(first["combined"],"baseline")
            previous={"public-seo":out/"monitor-state.json","source-monitor":out/"source-monitor-state.json"}
            second,out=run("2026-08-12","regression","ok",issue,None,previous); self.assertEqual(second["combined"],"regression"); previous={"public-seo":out/"monitor-state.json","source-monitor":out/"source-monitor-state.json"}
            third,out=run("2026-08-13","regression","ok",issue,None,previous); self.assertEqual(third["outcomes"]["public-seo"],"continuing"); previous={"public-seo":out/"monitor-state.json","source-monitor":out/"source-monitor-state.json"}
            fourth,out=run("2026-08-14","ok","ok",None,None,previous); self.assertEqual(fourth["combined"],"recovered"); previous={"public-seo":out/"monitor-state.json","source-monitor":out/"source-monitor-state.json"}
            fifth,out=run("2026-08-15","ok","ok",None,None,previous); self.assertEqual(fifth["outcomes"]["source-monitor"],"unchanged"); previous={"public-seo":out/"monitor-state.json","source-monitor":out/"source-monitor-state.json"}
            sixth,out=run("2026-08-16","ok","ok",None,None,previous); self.assertEqual(sixth["combined"],"stable")
            self.assertEqual(set(sixth["publication"]["state"]),{"monitor-state.json","source-monitor-state.json"})

    def test_first_run_unavailable_publishes_complete_empty_baseline(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); out=root/"out"; out.mkdir(); pub=root/"public.json"; src=root/"missing.json"
            pub.write_text(json.dumps(result("public-seo","2026-08-15")))
            manifest=orch.finalize({"public-seo":pub,"source-monitor":src},{},out,dt.date(2026,8,15))
            self.assertEqual((manifest["combined"],manifest["exit_code"]),("unavailable",2))
            self.assertEqual(set(path.name for path in out.iterdir()),{"monitor-state.json","source-monitor-state.json","source-snapshot.json","publication-manifest.json","artifact-manifest.json"})
            self.assertIsNone(json.loads((out/"source-monitor-state.json").read_text())["latest"])

    def test_manifest_summary_exact_for_every_monitor_outcome_and_combined_case(self):
        publication={"state":["monitor-state.json","source-monitor-state.json"],
                     "reports":["public-seo.json","public-seo.md","source-monitor-result.json","source-report.md","source-snapshot.json"]}
        cases=[
            ("baseline","baseline","baseline"),("regression","regression","regression"),
            ("continuing","continuing","stable"),("recovered","recovered","recovered"),
            ("unchanged","unchanged","stable"),("unavailable","unavailable","unavailable"),
        ]
        for public,source,combined in cases:
            manifest={"schema_version":"1.0","combined":combined,"exit_code":{"regression":1,"unavailable":2}.get(combined,0),
                      "outcomes":{"public-seo":public,"source-monitor":source},"publication":publication}
            self.assertEqual(orch.render_summary(manifest),
                f"## Monitor outcomes\n\n- Combined: `{combined}`\n- Public SEO: `{public}`\n- Source monitor: `{source}`\n")

    def test_manifest_summary_rejects_malformed_and_never_reflects_unsafe_material(self):
        manifest={"schema_version":"1.0","combined":"stable","exit_code":0,
                  "outcomes":{"public-seo":"unchanged","source-monitor":"unchanged"},
                  "publication":{"state":["monitor-state.json","source-monitor-state.json"],
                                 "reports":["public-seo.json","public-seo.md","source-monitor-result.json","source-report.md","source-snapshot.json"]}}
        for mutate in (
            lambda x:x.update(combined="https://example.test/?token=secret"),
            lambda x:x["outcomes"].update({"public-seo":"Traceback: credential=secret"}),
            lambda x:x.update(exception="raw secret"),
        ):
            bad=json.loads(json.dumps(manifest)); mutate(bad)
            with self.assertRaises(ValueError): orch.render_summary(bad)

    def test_pre_download_metadata_bounds_and_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self._artifact_fixture(root); calls=[]
            artifacts={
                50:self._artifact(500,orch.MAX_ZIP_BYTES+1),
                40:self._artifact(400,-1),
                30:self._artifact(300,True),
                20:self._artifact(200,orch.MAX_ZIP_BYTES),
                10:self._artifact(100,100),
            }
            def enumerate_artifacts(run_id): return {"total_count":1,"artifacts":[artifacts[run_id]]}
            def download(artifact_id,path):
                calls.append(artifact_id["id"])
                if artifact_id["id"] == 200: path.write_bytes(b"malformed")
                else:
                    with ZipFile(path,"w") as archive:
                        for name,payload in payloads.items(): archive.writestr(name,payload)
            runs=[{"id":value,"conclusion":"success"} for value in (50,40,30,20,10)]
            selected=orch.retrieve_newest_compatible(runs,__import__("datetime").date(2026,8,15),canonical,root,enumerate_artifacts,download)
            self.assertEqual(calls,[200,100])
            self.assertEqual(selected[0],10)

    def test_artifact_metadata_rejects_missing_malformed_negative_and_boolean_sizes(self):
        valid=self._artifact(1,orch.MAX_ZIP_BYTES)
        self.assertEqual(orch.validate_artifact_metadata(valid)["size_in_bytes"],orch.MAX_ZIP_BYTES)
        bad_values=[{k:v for k,v in valid.items() if k != "size_in_bytes"},
                    {**valid,"size_in_bytes":-1},{**valid,"size_in_bytes":True},
                    {**valid,"size_in_bytes":"1"},{**valid,"created_at":"yesterday"},
                    {**valid,"expired":0}]
        for value in bad_values:
            with self.assertRaises(ValueError): orch.validate_artifact_metadata(value)

    def test_old_no_digest_metadata_falls_back_without_download(self):
        value=self._artifact(1,100); del value["digest"]
        with self.assertRaisesRegex(ValueError,"fields missing"): orch.validate_artifact_metadata(value)

    def test_repository_workflow_and_ref_validation_and_exact_encoding(self):
        self.assertEqual(orch._runs_api_path("owner/repo","seo-monitor.yml","feat/a&b#c%20"),
            "/repos/owner/repo/actions/workflows/seo-monitor.yml/runs?branch=feat%2Fa%26b%23c%2520&status=completed&per_page=21")
        for repository in ("owner","owner/repo/extra","../repo","owner/..","owner/re po"):
            with self.assertRaises(ValueError): orch._repository_path(repository)
        for workflow in ("../x.yml","dir/x.yml","x?y.yml","0",str(orch.MAX_GITHUB_ID+1)):
            with self.assertRaises(ValueError): orch._workflow_component(workflow)
        for ref in ("../main","bad ref","a//b","a@{b","a\\b",""):
            with self.assertRaises(ValueError): orch._validate_ref(ref)

    def test_streamed_download_enforces_declared_size_and_api_digest(self):
        class Process:
            def __init__(self,payload): self.stdout=io.BytesIO(payload); self.returncode=0; self.args=[]
            def wait(self): return self.returncode
            def poll(self): return self.returncode
            def kill(self): self.returncode=-9
        payload=b"authenticated zip bytes"
        valid={"id":1,"size_in_bytes":len(payload),"digest":"sha256:"+hashlib.sha256(payload).hexdigest()}
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for metadata,message in (({**valid,"size_in_bytes":len(payload)-1},"exceeded"),
                                     ({**valid,"size_in_bytes":len(payload)+1},"size mismatch"),
                                     ({**valid,"digest":"sha256:"+"0"*64},"digest mismatch")):
                with mock.patch.object(orch.subprocess,"Popen",return_value=Process(payload)):
                    with self.assertRaisesRegex(ValueError,message): orch._gh_download("owner/repo",metadata,root/(message.replace(" ","-")+".zip"))

    def test_candidate_enumeration_is_capped(self):
        calls=[]
        runs=[{"id":value,"conclusion":"success"} for value in range(100,70,-1)]
        selected=orch.retrieve_newest_compatible(runs,__import__("datetime").date(2026,8,15),Path("unused"),Path("unused"),
            lambda run_id:(calls.append(run_id) or {"total_count":0,"artifacts":[]}),
            lambda artifact_id,path:self.fail("no downloader call expected"))
        self.assertIsNone(selected)
        self.assertEqual(len(calls),orch.MAX_CANDIDATES)

    @staticmethod
    def _artifact(artifact_id,size):
        return {"id":artifact_id,"name":"seo-monitor-state","size_in_bytes":size,
                "created_at":"2026-08-14T12:00:00Z","expired":False,"digest":"sha256:"+"0"*64,"extra":"allowed"}

    @staticmethod
    def _artifact_fixture(root):
        canonical=root/"hotlines.json"
        data={"countries":[{"country":"X","hotlines":[{"id":"weh_1","name":"Help","category":"emergency","website":"https://example.org/","sources":[],"voice_numbers":[]}]}]}
        raw=json.dumps(data).encode(); canonical.write_bytes(raw)
        source=orch.prior_artifact.source_monitor.build(data,raw,__import__("datetime").date(2026,8,14),1,None,
            lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"","truncated":False})
        base=result("public-seo","2026-08-14"); source_result=result("source-monitor","2026-08-14")
        payloads={"source-snapshot.json":json.dumps(source).encode(),
            "monitor-state.json":json.dumps({"schema_version":"2.0","monitor":"public-seo","latest":base,"history":[base]}).encode(),
            "source-monitor-state.json":json.dumps({"schema_version":"2.0","monitor":"source-monitor","latest":source_result,"history":[source_result]}).encode()}
        payloads["artifact-manifest.json"]=json.dumps({"schema_version":"2.0","run_as_of":"2026-08-14","state_as_of":{"public-seo":"2026-08-14","source-monitor":"2026-08-14"},"members":{name:"sha256:"+hashlib.sha256(payload).hexdigest() for name,payload in sorted(payloads.items())}}).encode()
        return canonical,payloads


if __name__=="__main__": unittest.main()
