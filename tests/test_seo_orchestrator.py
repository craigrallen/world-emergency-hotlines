import importlib.util
import json
import hashlib
import subprocess
import tempfile
import unittest
import io
import os
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
    def test_workflow_runs_envelope_is_exact_bounded_and_pagination_consistent(self):
        rows=[self._run(value+1,f"2026-08-14T12:00:{value:02d}Z") for value in reversed(range(21))]
        self.assertEqual(orch.validate_runs_response({"total_count":21,"workflow_runs":rows}),rows)
        self.assertEqual(orch.validate_runs_response({"total_count":80,"workflow_runs":rows},expected_count=21),rows)
        for bad in (
            {"workflow_runs":[]},
            {"total_count":0,"workflow_runs":[],"unknown":True},
            {"total_count":True,"workflow_runs":[]},
            {"total_count":-1,"workflow_runs":[]},
            {"total_count":2,"workflow_runs":[]},
            {"total_count":80,"workflow_runs":rows[:-1]},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError): orch.validate_runs_response(bad)

    def test_retrieve_cli_exit_classes_and_local_validation_precedes_remote(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical=root/"hotlines.json"; canonical.write_text(json.dumps({"countries":[]}))
            def argv(output):
                return ["retrieve","--repository","owner/repo","--workflow","seo-monitor.yml","--branch","main",
                        "--current-run","10","--as-of","2026-08-15","--canonical",str(canonical),"--output-dir",str(output)]
            with mock.patch.object(orch,"_gh_json",side_effect=subprocess.CalledProcessError(1,["gh"])):
                self.assertEqual(orch.main(argv(root/"remote-failure")),orch.EXIT_FATAL)
            with mock.patch.object(orch,"_gh_json",return_value={"total_count":0,"workflow_runs":[]}):
                self.assertEqual(orch.main(argv(root/"no-runs")),orch.EXIT_HISTORY_UNAVAILABLE)
            with mock.patch.object(orch,"_gh_json",return_value={"total_count":0,"workflow_runs":"untrusted"}):
                self.assertEqual(orch.main(argv(root/"malformed")),orch.EXIT_FATAL)
            unsafe=root/"unsafe"; unsafe.mkdir(); (unsafe/"monitor-state.json").write_text("existing")
            with mock.patch.object(orch,"_gh_json") as remote:
                self.assertEqual(orch.main(argv(unsafe)),orch.EXIT_FATAL); remote.assert_not_called()

    def test_retrieve_cli_success_and_fatal_publication_are_distinct(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self._artifact_fixture(root)
            base=["retrieve","--repository","owner/repo","--workflow","seo-monitor.yml","--branch","main",
                  "--current-run","10","--as-of","2026-08-15","--canonical",str(canonical)]
            selected=(9,"success",payloads)
            response={"total_count":1,"workflow_runs":[self._run(9,"2026-08-14T12:00:00Z")]}
            with mock.patch.object(orch,"_gh_json",return_value=response), mock.patch.object(orch,"retrieve_newest_compatible",return_value=selected):
                self.assertEqual(orch.main(base+["--output-dir",str(root/"success")]),orch.EXIT_SUCCESS)
                self.assertEqual({p.name for p in (root/"success").iterdir()},set(orch.prior_artifact.PAYLOAD_NAMES)|{orch.prior_artifact.MANIFEST_NAME})
            with mock.patch.object(orch,"_gh_json",return_value=response), mock.patch.object(orch,"retrieve_newest_compatible",return_value=selected), mock.patch.object(orch,"coordinated_write",side_effect=OSError("publication")):
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

    def test_finalize_rejects_malformed_explicit_prior(self):
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
            with self.assertRaises(ValueError):
                orch.finalize({"public-seo":root/"missing-public","source-monitor":root/"missing-source"},
                    {"public-seo":public_state,"source-monitor":malformed},out,date,None,snap)
            self.assertEqual(list(out.iterdir()),[])
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
            with self.assertRaisesRegex(ValueError,"artifact size invalid"):
                orch.retrieve_newest_compatible(runs,__import__("datetime").date(2026,8,15),canonical,root,enumerate_artifacts,download)
            self.assertEqual(calls,[])

    def test_safe_same_day_incompatibility_falls_back_to_older_candidate(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,older=self._artifact_fixture(root)
            same=dict(older)
            for name in ("monitor-state.json","source-monitor-state.json"):
                state=json.loads(same[name]); state["latest"]["as_of"]="2026-08-15"; state["history"][-1]["as_of"]="2026-08-15"
                same[name]=json.dumps(state).encode()
            snapshot=json.loads(same["source-snapshot.json"]); snapshot["as_of"]=snapshot["checked_at"]="2026-08-15"
            for row in snapshot["observations"]: row["as_of"]=row["checked_at"]="2026-08-15"
            same["source-snapshot.json"]=json.dumps(snapshot).encode()
            same["artifact-manifest.json"]=json.dumps({"schema_version":"2.0","run_as_of":"2026-08-15",
                "state_as_of":{"public-seo":"2026-08-15","source-monitor":"2026-08-15"},
                "members":{name:"sha256:"+hashlib.sha256(payload).hexdigest() for name,payload in sorted(same.items()) if name != "artifact-manifest.json"}}).encode()
            payload_by_id={30:same,20:older,10:None}; calls=[]
            def enumerate_artifacts(run_id): return {"total_count":1,"artifacts":[self._artifact(run_id,100)]}
            def download(metadata,path):
                calls.append(metadata["id"]); payloads=payload_by_id[metadata["id"]]
                if payloads is None: path.write_bytes(b"malformed")
                else:
                    with ZipFile(path,"w") as archive:
                        for name,payload in payloads.items(): archive.writestr(name,payload)
            runs=[{"id":value,"conclusion":"success"} for value in (30,20)]
            selected=orch.retrieve_newest_compatible(runs,dt.date(2026,8,15),canonical,root,enumerate_artifacts,download)
            self.assertEqual(selected[0],20); self.assertEqual(calls,[30,20])
            self.assertIsNone(orch.retrieve_newest_compatible(runs[:1],dt.date(2026,8,15),canonical,root,enumerate_artifacts,download))

            # Exercise the production main/API boundary with already ordered rows.
            calls.clear()
            rows=[self._run(30,"2026-08-15T10:00:00Z"),self._run(20,"2026-08-14T10:00:00Z")]
            gh_paths=[]
            def gh(path):
                gh_paths.append(path)
                if "/runs?" in path: return {"total_count":2,"workflow_runs":rows}
                run_id=int(path.split("/runs/")[1].split("/")[0])
                return {"total_count":1,"artifacts":[self._artifact(run_id,100)]}
            output=root/"main-output"
            argv=["retrieve","--repository","owner/repo","--workflow","seo-monitor.yml","--branch","main",
                  "--current-run","40","--as-of","2026-08-15","--canonical",str(canonical),"--output-dir",str(output)]
            def main_download(repository,metadata,path): return download(metadata,path)
            with mock.patch.object(orch,"_gh_json",side_effect=gh), mock.patch.object(orch,"_gh_download",side_effect=main_download):
                code=orch.main(argv)
            self.assertEqual((code,calls),(orch.EXIT_SUCCESS,[30,20]),gh_paths)
            self.assertEqual(json.loads((output/"source-snapshot.json").read_text())["as_of"],"2026-08-14")

    def test_production_retrieval_crosses_page_after_many_same_day_runs(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,older=self._artifact_fixture(root)
            same_count=125
            rows=[self._run(1000-index,"2026-08-15T10:00:00Z") for index in range(same_count)]
            rows.append(self._run(700,"2026-08-14T10:00:00Z"))
            def gh(path):
                if "/runs?" in path:
                    page=int(path.rsplit("page=",1)[1]); start=(page-1)*100
                    return {"total_count":len(rows),"workflow_runs":rows[start:start+100]}
                run_id=int(path.split("/runs/",1)[1].split("/",1)[0])
                return {"total_count":1,"artifacts":[self._artifact(run_id,100)]}
            downloads=[]
            def download(repository,metadata,path):
                downloads.append(metadata["id"])
                if metadata["id"] != 700:
                    raise orch.CandidateIncompatible("authenticated same-day fixture")
                with ZipFile(path,"w") as archive:
                    for name,payload in older.items(): archive.writestr(name,payload)
            output=root/"out"
            argv=["retrieve","--repository","owner/repo","--workflow","seo-monitor.yml","--branch","main",
                  "--current-run","2000","--as-of","2026-08-15","--canonical",str(canonical),"--output-dir",str(output)]
            with mock.patch.object(orch,"_gh_json",side_effect=gh), mock.patch.object(orch,"_gh_download",side_effect=download):
                self.assertEqual(orch.main(argv),orch.EXIT_SUCCESS)
            self.assertEqual((len(downloads),downloads[-1]),(same_count+1,700))

            fatal=root/"fatal"
            def later_failure(path):
                if "/runs?" in path and path.endswith("page=2"):
                    raise subprocess.CalledProcessError(70,["gh"])
                return gh(path)
            with mock.patch.object(orch,"_gh_json",side_effect=later_failure):
                self.assertEqual(orch.main(argv[:-1]+[str(fatal)]),orch.EXIT_FATAL)
            self.assertFalse(any(fatal.iterdir()))

    def test_corrupt_authenticated_candidate_is_fatal_without_older_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self._artifact_fixture(root); calls=[]
            def enumerate_artifacts(run_id):
                return {"total_count":1,"artifacts":[self._artifact(run_id,100)]}
            def download(metadata,path):
                calls.append(metadata["id"])
                if metadata["id"] == 30: path.write_bytes(b"malformed")
                else:
                    with ZipFile(path,"w") as archive:
                        for name,payload in payloads.items(): archive.writestr(name,payload)
            runs=[{"id":30,"conclusion":"success"},{"id":20,"conclusion":"success"}]
            with self.assertRaisesRegex(ValueError,"malformed artifact ZIP"):
                orch.retrieve_newest_compatible(
                    runs,dt.date(2026,8,15),canonical,root,enumerate_artifacts,download)
            self.assertEqual(calls,[30])

    def test_workflow_run_order_ties_duplicates_and_impossible_chronology(self):
        tied=[self._run(9,"2026-08-14T12:00:00Z"),self._run(7,"2026-08-14T12:00:00Z")]
        self.assertEqual([row["id"] for row in orch.validate_runs_response({"total_count":2,"workflow_runs":tied})],[9,7])
        bad_rows=[
            [tied[0],dict(tied[0])],
            list(reversed(tied)),
            [{**tied[0],"updated_at":"2026-08-14T11:59:59Z"}],
            [{**tied[0],"created_at":"2026-08-14T12:00:00+00:00"}],
            [{**tied[0],"event":"push"}],
        ]
        for rows in bad_rows:
            with self.assertRaises(ValueError):
                orch.validate_runs_response({"total_count":len(rows),"workflow_runs":rows})

        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical=root/"hotlines.json"; canonical.write_text(json.dumps({"countries":[]}))
            future=self._run(8,"2026-08-16T12:00:00Z")
            argv=["retrieve","--repository","owner/repo","--workflow","seo-monitor.yml","--branch","main",
                  "--current-run","10","--as-of","2026-08-15","--canonical",str(canonical),"--output-dir",str(root/"out")]
            with mock.patch.object(orch,"_gh_json",return_value={"total_count":1,"workflow_runs":[future]}), mock.patch.object(orch,"retrieve_newest_compatible",return_value=None) as retrieve:
                self.assertEqual(orch.main(argv),orch.EXIT_HISTORY_UNAVAILABLE)
                retrieve.assert_called_once()
                self.assertEqual(retrieve.call_args.args[0],[])

    def test_updated_at_is_the_shared_run_tie_breaker(self):
        manual_spec=importlib.util.spec_from_file_location("manual_order",ROOT/"scripts/manual_prior_history.py")
        manual=importlib.util.module_from_spec(manual_spec); manual_spec.loader.exec_module(manual)
        older_update=self._run(9,"2026-08-14T12:00:00Z","2026-08-14T12:01:00Z")
        newer_update=self._run(7,"2026-08-14T12:00:00Z","2026-08-14T12:02:00Z")
        envelope={"total_count":2,"workflow_runs":[newer_update,older_update]}
        self.assertEqual([row["id"] for row in orch.validate_runs_response(envelope)],[7,9])
        self.assertEqual(manual.select_runs(envelope,10,dt.date(2026,8,15)),[7,9])

    def test_direct_run_order_rejects_adjacent_reverse_tie_id_and_page_overlap(self):
        rows=[self._run(10-index,f"2026-08-14T12:00:0{3-index}Z") for index in range(4)]
        adjacent=rows.copy(); adjacent[1],adjacent[2]=adjacent[2],adjacent[1]
        for disorder in (adjacent,list(reversed(rows))):
            with self.subTest(disorder=[row["id"] for row in disorder]), self.assertRaises(ValueError):
                orch.validate_runs_response({"total_count":len(disorder),"workflow_runs":disorder})
        tie_id=[self._run(7,"2026-08-14T12:00:00Z"),self._run(9,"2026-08-14T12:00:00Z")]
        with self.assertRaises(ValueError):
            orch.validate_runs_response({"total_count":2,"workflow_runs":tie_id})

        many=[self._run(1000-index,(dt.datetime(2026,8,15,12,tzinfo=dt.timezone.utc)-dt.timedelta(seconds=index)).isoformat().replace("+00:00","Z"))
              for index in range(101)]
        overlapping=many[99].copy(); overlapping["id"]=2000
        with self.assertRaises(ValueError):
            orch.enumerate_workflow_runs(lambda page:{"total_count":101,"workflow_runs":many[:100] if page == 1 else [overlapping]})

    def test_real_scheduled_and_manual_clis_reject_disordered_fake_gh_pages(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); bindir=root/"bin"; bindir.mkdir()
            fake=bindir/"gh"
            fake.write_text("#!/bin/bash\nendpoint=${!#}\ncase \"$endpoint\" in *page=2) cat \"$FAKE_PAGE_2\";; *'/runs?'*) cat \"$FAKE_PAGE_1\";; *) exit 66;; esac\n")
            fake.chmod(0o755)
            canonical=root/"hotlines.json"; canonical.write_text(json.dumps({"countries":[]}))
            base=[self._run(10-index,f"2026-08-14T12:00:0{3-index}Z") for index in range(4)]
            adjacent=base.copy(); adjacent[1],adjacent[2]=adjacent[2],adjacent[1]
            tied=[self._run(7,"2026-08-14T12:00:00Z"),self._run(9,"2026-08-14T12:00:00Z")]
            many=[self._run(1000-index,(dt.datetime(2026,8,15,12,tzinfo=dt.timezone.utc)-dt.timedelta(seconds=index)).isoformat().replace("+00:00","Z"))
                  for index in range(101)]
            overlap=many[99].copy(); overlap["id"]=2000
            cases={
                "adjacent-swap":(adjacent,[]),
                "reversed-page":(list(reversed(base)),[]),
                "tie-key-id-disorder":(tied,[]),
                "cross-page-overlap":(many[:100],[overlap]),
            }
            for name,(page_one,page_two) in cases.items():
                page1=root/f"{name}-1.json"; page2=root/f"{name}-2.json"
                total=len(page_one)+len(page_two)
                page1.write_text(json.dumps({"total_count":total,"workflow_runs":page_one}))
                page2.write_text(json.dumps({"total_count":total,"workflow_runs":page_two}))
                env={**os.environ,"PATH":str(bindir)+os.pathsep+os.environ["PATH"],
                     "FAKE_PAGE_1":str(page1),"FAKE_PAGE_2":str(page2)}
                commands=(
                    [os.environ.get("PYTHON", "python3"),str(ROOT/"scripts/seo_orchestrator.py"),"retrieve",
                     "--repository","owner/repo","--workflow","seo-monitor.yml","--branch","main",
                     "--current-run","2001","--as-of","2026-08-15","--canonical",str(canonical),
                     "--output-dir",str(root/f"scheduled-{name}")],
                    [os.environ.get("PYTHON", "python3"),str(ROOT/"scripts/manual_prior_history.py"),"retrieve",
                     "--repository","owner/repo","--workflow","verification-operations.yml","--branch","main",
                     "--current-run","2001","--as-of","2026-08-15","--output",str(root/f"manual-{name}.json")],
                )
                for command in commands:
                    with self.subTest(case=name,cli=Path(command[1]).name):
                        completed=subprocess.run(command,cwd=ROOT,env=env,capture_output=True,text=True)
                        self.assertEqual(completed.returncode,orch.EXIT_FATAL,completed.stdout+completed.stderr)

    def test_terminal_dates_fail_before_scheduled_or_manual_remote_calls(self):
        manual_spec=importlib.util.spec_from_file_location("manual_terminal",ROOT/"scripts/manual_prior_history.py")
        manual=importlib.util.module_from_spec(manual_spec); manual_spec.loader.exec_module(manual)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical=root/"hotlines.json"; canonical.write_text(json.dumps({"countries":[]}))
            scheduled=["retrieve","--repository","owner/repo","--workflow","seo-monitor.yml","--branch","main",
                       "--current-run","10","--as-of","9999-12-31","--canonical",str(canonical),"--output-dir",str(root/"scheduled")]
            with mock.patch.object(orch,"_gh_json") as remote:
                self.assertEqual(orch.main(scheduled),orch.EXIT_FATAL); remote.assert_not_called()
            with mock.patch.object(manual.seo_orchestrator,"_gh_json") as remote:
                code=manual.main(["retrieve","--repository","owner/repo","--workflow","seo-monitor.yml","--branch","main",
                                  "--current-run","10","--as-of","9999-12-31","--output",str(root/"manual.json")])
                self.assertEqual(code,orch.EXIT_FATAL); remote.assert_not_called()
            self.assertFalse((root/"scheduled").exists()); self.assertFalse((root/"manual.json").exists())

    def test_finalize_cli_maps_expected_failures_to_fatal_but_regression_remains_one(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self._artifact_fixture(root)
            public=root/"public.json"; source=root/"source.json"; snapshot=root/"snapshot.json"
            public.write_text("{malformed"); source.write_text("{}"); snapshot.write_text("{}")
            def argv(date="2026-08-15",output=None):
                return ["finalize","--public-result",str(public),"--source-result",str(source),"--source-snapshot",str(snapshot),
                        "--canonical",str(canonical),"--as-of",date,"--output-dir",str(output or root/"out")]
            self.assertEqual(orch.main(argv()),orch.EXIT_FATAL)
            self.assertEqual(orch.main(argv("not-a-date",root/"bad-date")),orch.EXIT_FATAL)
            public.unlink(); self.assertEqual(orch.main(argv(output=root/"missing")),orch.EXIT_FATAL)
            public.write_text(json.dumps(result("public-seo","2026-08-15")))
            source.write_text(json.dumps(result("source-monitor","2026-08-15")))
            collision=root/"collision"; collision.mkdir(); (collision/"monitor-state.json").write_text("occupied")
            self.assertEqual(orch.main(argv(output=collision)),orch.EXIT_FATAL)
            with mock.patch.object(orch,"finalize",side_effect=OSError("publication")):
                self.assertEqual(orch.main(argv(output=root/"publication")),orch.EXIT_FATAL)
            # A real result passes production validation, classification and atomic publication.
            day=dt.date(2026,8,15); raw=canonical.read_bytes(); data=json.loads(raw)
            valid_snapshot=orch.prior_artifact.source_monitor.build(data,raw,day,1,None,
                lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"","truncated":False})
            snapshot.write_text(json.dumps(valid_snapshot))
            public.write_text(json.dumps(result("public-seo",day.isoformat(),"regression",
                [{"code":"real_drop","subject":"index","detail":"coverage declined"}])))
            source.write_text(json.dumps(orch.source_monitor_result.build(valid_snapshot,None,raw)))
            regression=root/"regression"
            self.assertEqual(orch.main(argv(output=regression)),1)
            self.assertEqual(set(path.name for path in regression.iterdir()),
                set(orch.prior_artifact.PAYLOAD_NAMES)|{orch.prior_artifact.MANIFEST_NAME,"publication-manifest.json"})
            self.assertEqual(json.loads((regression/"publication-manifest.json").read_text())["combined"],"regression")

    def test_finalize_bounded_inputs_and_invalid_utf8_fail_without_publication(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self._artifact_fixture(root)
            day=dt.date(2026,8,15); raw=canonical.read_bytes(); data=json.loads(raw)
            snapshot_value=orch.prior_artifact.source_monitor.build(data,raw,day,1,None,
                lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"","truncated":False})
            snapshot=root/"snapshot.json"; snapshot.write_text(json.dumps(snapshot_value))
            public=root/"public.json"; public.write_text(json.dumps(result("public-seo",day.isoformat())))
            source=root/"source.json"; source.write_text(json.dumps(orch.source_monitor_result.build(snapshot_value,None,raw)))
            prior_result=result("public-seo","2026-08-14")
            prior=root/"prior.json"; prior.write_text(json.dumps({"schema_version":"2.0","monitor":"public-seo","latest":prior_result,"history":[prior_result]}))
            source_prior=root/"source-prior.json"; source_prior.write_bytes(payloads["source-monitor-state.json"])
            prior_snapshot=root/"prior-snapshot.json"; prior_snapshot.write_bytes(payloads["source-snapshot.json"])
            def argv(output,extra=()):
                return ["finalize","--public-result",str(public),"--source-result",str(source),"--source-snapshot",str(snapshot),
                        "--canonical",str(canonical),"--as-of",day.isoformat(),"--output-dir",str(output),*extra]

            # The primitive accepts the exact boundary and rejects +1 before an unbounded read.
            boundary=root/"boundary.json"; boundary.write_bytes(b" "*orch.monitor_delta.MAX_INPUT_BYTES)
            self.assertEqual(len(orch.monitor_delta.read_bounded_regular(boundary,orch.monitor_delta.MAX_INPUT_BYTES)),orch.monitor_delta.MAX_INPUT_BYTES)
            boundary.write_bytes(b" "*(orch.monitor_delta.MAX_INPUT_BYTES+1))
            with self.assertRaises(ValueError): orch.monitor_delta.read_bounded_regular(boundary,orch.monitor_delta.MAX_INPUT_BYTES)

            cases=[("current",public,()),("canonical",canonical,()),("snapshot",snapshot,()),
                   ("prior",prior,("--public-previous",str(prior))),
                   ("prior snapshot",prior_snapshot,("--source-previous",str(source_prior),
                        "--source-previous-snapshot",str(prior_snapshot)))]
            for index,(label,path,extra) in enumerate(cases):
                original=path.read_bytes(); path.write_bytes(b"\xff")
                output=root/f"utf8-{index}"
                self.assertEqual(orch.main(argv(output,extra)),orch.EXIT_FATAL,label)
                self.assertFalse(output.exists() and any(output.iterdir()),label)
                path.write_bytes(original)
            for index,(label,path,extra,limit) in enumerate((
                ("current",public,(),orch.monitor_delta.MAX_INPUT_BYTES),
                ("canonical",canonical,(),orch.MAX_CANONICAL_BYTES),
                ("snapshot",snapshot,(),orch.prior_artifact.MAX_FILE_BYTES),
                ("prior",prior,("--public-previous",str(prior)),orch.monitor_delta.MAX_INPUT_BYTES))):
                original=path.read_bytes(); path.write_bytes(b" "*(limit+1))
                output=root/f"oversize-{index}"
                self.assertEqual(orch.main(argv(output,extra)),orch.EXIT_FATAL,label)
                self.assertFalse(output.exists() and any(output.iterdir()),label)
                path.write_bytes(original)

    def test_finalize_cli_explicit_prior_and_hostile_nesting_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); day=dt.date(2026,8,15); prior_day=dt.date(2026,8,14)
            canonical=root/"hotlines.json"; raw=json.dumps({"countries":[]}).encode(); canonical.write_bytes(raw)
            snapshot_value=orch.prior_artifact.source_monitor.build({"countries":[]},raw,day,1,None,
                lambda url:self.fail("empty canonical must not fetch"))
            snapshot=root/"snapshot.json"; snapshot.write_text(json.dumps(snapshot_value))
            public=root/"public.json"; public.write_text(json.dumps(result("public-seo",day.isoformat())))
            source=root/"source.json"; source.write_text(json.dumps(orch.source_monitor_result.build(snapshot_value,None,raw)))
            prior_result=result("public-seo",prior_day.isoformat())
            valid_prior=root/"public-prior.json"; valid_prior.write_text(json.dumps({"schema_version":"2.0","monitor":"public-seo","latest":prior_result,"history":[prior_result]}))
            def argv(output,*extra):
                return ["finalize","--public-result",str(public),"--source-result",str(source),"--source-snapshot",str(snapshot),
                        "--canonical",str(canonical),"--as-of",day.isoformat(),"--output-dir",str(output),*map(str,extra)]
            optional=root/"optional"
            self.assertEqual(orch.main(argv(optional)),orch.EXIT_SUCCESS)
            self.assertTrue((optional/"artifact-manifest.json").is_file())

            malformed=root/"malformed-prior.json"; malformed.write_text("{}")
            future_result=result("public-seo",day.isoformat())
            future=root/"future-prior.json"; future.write_text(json.dumps({"schema_version":"2.0","monitor":"public-seo","latest":future_result,"history":[future_result]}))
            wrong=root/"wrong-prior.json"; wrong.write_text(json.dumps({"schema_version":"2.0","monitor":"source-monitor","latest":prior_result,"history":[prior_result]}))
            missing=root/"missing-prior.json"
            alias=root/"alias-prior.json"; os.link(public,alias)
            symlink=root/"symlink-prior.json"; symlink.symlink_to(valid_prior)
            for index,path in enumerate((missing,malformed,future,wrong,alias,symlink)):
                output=root/f"bad-{index}"
                self.assertEqual(orch.main(argv(output,"--public-previous",path)),orch.EXIT_FATAL)
                self.assertFalse(output.exists() and any(output.iterdir()))

            deep=root/"deep.json"; deep.write_text("["*1500+"0"+"]"*1500)
            for index,(flag,path) in enumerate((("--public-previous",deep),("--public-result",deep))):
                output=root/f"deep-{index}"; args=argv(output,"--public-previous",valid_prior)
                position=args.index(flag) if flag in args else None
                if position is None: args.extend((flag,str(path)))
                else: args[position+1]=str(path)
                self.assertEqual(orch.main(args),orch.EXIT_FATAL)
                self.assertFalse(output.exists() and any(output.iterdir()))

            source_prior_result=result("source-monitor",prior_day.isoformat())
            source_prior=root/"source-prior.json"; source_prior.write_text(json.dumps({"schema_version":"2.0","monitor":"source-monitor","latest":source_prior_result,"history":[source_prior_result]}))
            output=root/"bad-source-binding"
            self.assertEqual(orch.main(argv(output,"--source-previous",source_prior)),orch.EXIT_FATAL)
            self.assertFalse(output.exists() and any(output.iterdir()))

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
            "/repos/owner/repo/actions/workflows/seo-monitor.yml/runs?branch=feat%2Fa%26b%23c%2520&status=completed&per_page=100&page=1")
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

    def test_candidate_enumeration_accepts_complete_safe_cap_and_rejects_more(self):
        calls=[]
        runs=[{"id":value,"conclusion":"success"} for value in range(orch.MAX_RUNS,0,-1)]
        selected=orch.retrieve_newest_compatible(runs,__import__("datetime").date(2026,8,15),Path("unused"),Path("unused"),
            lambda run_id:(calls.append(run_id) or {"total_count":0,"artifacts":[]}),
            lambda artifact_id,path:self.fail("no downloader call expected"))
        self.assertIsNone(selected)
        self.assertEqual(len(calls),orch.MAX_RUNS)
        with self.assertRaisesRegex(ValueError,"bounded"):
            orch.retrieve_newest_compatible(runs+[{"id":orch.MAX_RUNS+1,"conclusion":"success"}],
                dt.date(2026,8,15),Path("unused"),Path("unused"),lambda run_id:None,lambda metadata,path:None)

    def test_exhaustive_run_pagination_boundaries_and_contradictions(self):
        rows=[self._run(1000-index,(dt.datetime(2026,8,15,12,tzinfo=dt.timezone.utc)-dt.timedelta(seconds=index)).isoformat().replace("+00:00","Z"))
              for index in range(205)]
        def pages(page,total=205):
            start=(page-1)*orch.RUNS_PER_PAGE
            return {"total_count":total,"workflow_runs":rows[start:start+orch.RUNS_PER_PAGE]}
        calls=[]
        result=orch.enumerate_workflow_runs(lambda page:(calls.append(page) or pages(page)))
        self.assertEqual((calls,len(result),result[0]["id"],result[-1]["id"]),([1,2,3],205,1000,796))
        for count in (20,100,101):
            subset=rows[:count]
            got=orch.enumerate_workflow_runs(lambda page,s=subset:{"total_count":len(s),
                "workflow_runs":s[(page-1)*100:page*100]})
            self.assertEqual(len(got),count)
        bad_cases=[
            lambda page: pages(page,205 if page == 1 else 204),
            lambda page: ({"total_count":205,"workflow_runs":rows[:100]} if page == 1 else
                          {"total_count":205,"workflow_runs":([] if page == 2 else rows[200:205])}),
            lambda page: ({"total_count":205,"workflow_runs":rows[:100]} if page == 1 else
                          {"total_count":205,"workflow_runs":rows[:100] if page == 2 else rows[200:205]}),
            lambda page: ({"total_count":101,"workflow_runs":rows[1:101]} if page == 1 else
                          {"total_count":101,"workflow_runs":[rows[0]]}),
        ]
        for fetch in bad_cases:
            with self.subTest(fetch=fetch), self.assertRaises(ValueError): orch.enumerate_workflow_runs(fetch)
        with self.assertRaisesRegex(ValueError,"safe cap"):
            orch.enumerate_workflow_runs(lambda page:{"total_count":orch.MAX_RUNS+1,"workflow_runs":[]})
        with self.assertRaises(subprocess.CalledProcessError):
            orch.enumerate_workflow_runs(lambda page: pages(page) if page == 1 else (_ for _ in ()).throw(
                subprocess.CalledProcessError(70,["gh"])))

    def test_production_fake_gh_paginates_and_fails_on_later_api_error(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); bindir=root/"bin"; page_dir=root/"pages"
            bindir.mkdir(); page_dir.mkdir(); fake=bindir/"gh"
            fake.write_text("#!/bin/sh\nendpoint=$2\npage=${endpoint##*page=}\ncat \"$FAKE_PAGE_DIR/$page.json\"\n")
            fake.chmod(0o755)
            rows=[self._run(500-index,(dt.datetime(2026,8,15,12,tzinfo=dt.timezone.utc)-dt.timedelta(seconds=index)).isoformat().replace("+00:00","Z"))
                  for index in range(101)]
            (page_dir/"1.json").write_text(json.dumps({"total_count":101,"workflow_runs":rows[:100]}))
            (page_dir/"2.json").write_text(json.dumps({"total_count":101,"workflow_runs":rows[100:]}))
            env={**os.environ,"PATH":str(bindir)+os.pathsep+os.environ["PATH"],"FAKE_PAGE_DIR":str(page_dir)}
            path=lambda page:orch._runs_api_path("owner/repo","seo-monitor.yml","main",page)
            with mock.patch.dict(os.environ,env,clear=True):
                result=orch.enumerate_workflow_runs(lambda page:orch._gh_json(path(page)))
                self.assertEqual((len(result),result[-1]["id"]),(101,400))
                (page_dir/"2.json").unlink()
                with self.assertRaises(subprocess.CalledProcessError):
                    orch.enumerate_workflow_runs(lambda page:orch._gh_json(path(page)))

    @staticmethod
    def _artifact(artifact_id,size):
        return {"id":artifact_id,"name":"seo-monitor-state","size_in_bytes":size,
                "created_at":"2026-08-14T12:00:00Z","expired":False,"digest":"sha256:"+"0"*64,"extra":"allowed"}

    @staticmethod
    def _run(run_id,created,updated=None):
        return {"id":run_id,"status":"completed","conclusion":"success","event":"schedule",
                "created_at":created,"updated_at":updated or created}

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
