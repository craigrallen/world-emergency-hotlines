import datetime as dt
import importlib.util
import json
import hashlib
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("prior_artifact",ROOT/"scripts/prior_artifact.py")
prior=importlib.util.module_from_spec(spec); spec.loader.exec_module(prior)
delta_spec=importlib.util.spec_from_file_location("monitor_delta_sequence",ROOT/"scripts/monitor_delta.py")
delta=importlib.util.module_from_spec(delta_spec); delta_spec.loader.exec_module(delta)


class PriorArtifactTests(unittest.TestCase):
    def fixture(self,root):
        canonical=root/"hotlines.json"
        data={"countries":[{"country":"X","hotlines":[{"id":"weh_1","name":"Help","category":"emergency","website":"https://example.org/","sources":[],"voice_numbers":[]}]}]}
        raw=json.dumps(data).encode(); canonical.write_bytes(raw)
        source=prior.source_monitor.build(data,raw,dt.date(2026,8,14),1,None,lambda url:{"outcome":"ok","http_status":200,"final_url":url,"text":"","truncated":False})
        result={"schema_version":"1.0","monitor":"public-seo","as_of":"2026-08-14","status":"ok","issues":[],"metrics":{}}
        state={"schema_version":"2.0","monitor":"public-seo","latest":result,"history":[result]}
        source_result={**result,"monitor":"source-monitor"}
        source_state={"schema_version":"2.0","monitor":"source-monitor","latest":source_result,"history":[source_result]}
        return canonical,{"source-snapshot.json":json.dumps(source).encode(),"monitor-state.json":json.dumps(state).encode(),
                          "source-monitor-state.json":json.dumps(source_state).encode()}

    def write_zip(self,path,payloads):
        payloads=list(payloads)
        values=dict(payloads)
        if prior.MANIFEST_NAME not in values and set(values) == prior.PAYLOAD_NAMES:
            def state_date(name):
                try: return json.loads(values[name])["latest"]["as_of"]
                except (KeyError,TypeError,json.JSONDecodeError): return "2026-08-14"
            manifest={"schema_version":"2.0","run_as_of":"2026-08-14","state_as_of":{"public-seo":state_date("monitor-state.json"),"source-monitor":state_date("source-monitor-state.json")},"members":{name:"sha256:"+hashlib.sha256(payload).hexdigest() for name,payload in sorted(values.items())}}
            payloads.append((prior.MANIFEST_NAME,json.dumps(manifest).encode()))
        with ZipFile(path,"w") as archive:
            for name,payload in payloads: archive.writestr(name,payload)

    def test_valid_candidate_and_no_artifact_condition(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self.fixture(root); archive=root/"valid.zip"
            self.write_zip(archive,payloads.items())
            extracted=prior.extract_candidate(archive,dt.date(2026,8,15),canonical)
            self.assertEqual(set(extracted),prior.PAYLOAD_NAMES)
            self.assertFalse((root/"absent.zip").exists())

    def test_cli_main_extracts_only_payloads_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self.fixture(root); archive=root/"valid.zip"
            self.write_zip(archive,payloads.items()); output=root/"output"
            self.assertEqual(prior.main(["--artifact",str(archive),"--output-dir",str(output),
                "--as-of","2026-08-15","--canonical",str(canonical)]),0)
            self.assertEqual({path.name for path in output.iterdir()},prior.PAYLOAD_NAMES)
            for name in prior.PAYLOAD_NAMES: self.assertEqual((output/name).read_bytes(),payloads[name])
            self.assertEqual(prior.main(["--artifact",str(archive),"--output-dir",str(output),
                "--as-of","2026-08-15","--canonical",str(canonical)]),3)
            tampered=root/"tampered.zip"; values=dict(payloads)
            values["artifact-manifest.json"]=b'{"schema_version":"2.0"}'
            self.write_zip(tampered,values.items()); fresh=root/"fresh"
            self.assertEqual(prior.main(["--artifact",str(tampered),"--output-dir",str(fresh),
                "--as-of","2026-08-15","--canonical",str(canonical)]),3)
            self.assertFalse(fresh.exists())

    def test_malformed_multiple_and_oversized_candidates_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self.fixture(root)
            malformed=root/"malformed.zip"; malformed.write_bytes(b"not zip")
            with self.assertRaisesRegex(ValueError,"malformed"): prior.extract_candidate(malformed,dt.date(2026,8,15),canonical)
            duplicate=root/"duplicate.zip"
            self.write_zip(duplicate,list(payloads.items())+[("nested/monitor-state.json",payloads["monitor-state.json"])])
            with self.assertRaisesRegex(ValueError,"exactly one"): prior.extract_candidate(duplicate,dt.date(2026,8,15),canonical)
            oversized=root/"oversized.zip"
            values=dict(payloads); values["monitor-state.json"]=b"x"*(prior.MAX_FILE_BYTES+1)
            self.write_zip(oversized,values.items())
            with self.assertRaisesRegex(ValueError,"oversized"): prior.extract_candidate(oversized,dt.date(2026,8,15),canonical)

    def test_workflow_iterates_newest_to_oldest_past_failures(self):
        text=(ROOT/".github/workflows/seo-monitor.yml").read_text()
        self.assertIn("scripts/seo_orchestrator.py retrieve",text)
        self.assertNotIn("actions/artifacts/${artifact_id}/zip",text)
        self.assertIn("authenticated bounded enumeration confirmed no compatible older artifact",text)
        self.assertIn("scripts/seo_workflow_summary.py",text)

    def test_mixed_observation_dates_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self.fixture(root)
            state=json.loads(payloads["source-monitor-state.json"]); state["latest"]["as_of"]="2026-08-13"; state["history"][0]["as_of"]="2026-08-13"
            payloads["source-monitor-state.json"]=json.dumps(state).encode(); archive=root/"mixed.zip"; self.write_zip(archive,payloads.items())
            with self.assertRaisesRegex(ValueError,"state dates inconsistent|state and snapshot dates differ"): prior.extract_candidate(archive,dt.date(2026,8,15),canonical)

    def test_manifest_binds_snapshot_and_exact_member_set(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self.fixture(root); archive=root/"bound.zip"
            values=dict(payloads); manifest={"schema_version":"2.0","run_as_of":"2026-08-14","state_as_of":{"public-seo":"2026-08-14","source-monitor":"2026-08-14"},"members":{name:"sha256:"+hashlib.sha256(payload).hexdigest() for name,payload in sorted(values.items())}}
            values[prior.MANIFEST_NAME]=json.dumps(manifest).encode()
            values["source-snapshot.json"]+=b" "
            self.write_zip(archive,values.items())
            with self.assertRaisesRegex(ValueError,"member hash mismatch"):
                prior.extract_candidate(archive,dt.date(2026,8,15),canonical)

    def test_unknown_authenticated_versions_are_fatal(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); canonical,payloads=self.fixture(root)
            archive=root/"unknown-publication.zip"
            values=dict(payloads)
            manifest={"schema_version":"3.0","run_as_of":"2026-08-14",
                "state_as_of":{"public-seo":"2026-08-14","source-monitor":"2026-08-14"},
                "members":{name:"sha256:"+hashlib.sha256(payload).hexdigest()
                           for name,payload in sorted(values.items())}}
            values[prior.MANIFEST_NAME]=json.dumps(manifest).encode(); self.write_zip(archive,values.items())
            with self.assertRaisesRegex(ValueError,"publication manifest invalid"):
                prior.extract_candidate(archive,dt.date(2026,8,15),canonical)

            source_archive=root/"unknown-source.zip"; snapshot=payloads["source-snapshot.json"]
            source_manifest={"schema_version":"2.0","run_as_of":"2026-08-14","members":{
                "source-snapshot.json":"sha256:"+hashlib.sha256(snapshot).hexdigest()}}
            with ZipFile(source_archive,"w") as zipped:
                zipped.writestr("source-snapshot.json",snapshot)
                zipped.writestr(prior.SOURCE_MANIFEST_NAME,json.dumps(source_manifest))
            with self.assertRaisesRegex(ValueError,"member manifest invalid"):
                prior.extract_authenticated_source_snapshot(source_archive,dt.date(2026,8,15))

    def test_failed_regression_artifact_drives_continuing_then_recovery(self):
        issue=[{"code":"broken","subject":"/","detail":"fixture"}]
        healthy={"schema_version":"1.0","monitor":"public-seo","as_of":"2026-08-11","status":"ok","issues":[],"metrics":{}}
        regression={**healthy,"as_of":"2026-08-12","status":"regression","issues":issue}
        continuing={**regression,"as_of":"2026-08-13"}
        recovery={**healthy,"as_of":"2026-08-14"}
        def state(value): return {"schema_version":"2.0","monitor":value["monitor"],"latest":value,"history":[value]}
        self.assertEqual(delta.classify(healthy,None),"baseline")
        self.assertEqual(delta.outcome_exit_code("baseline"),0)
        self.assertEqual(delta.classify(regression,state(healthy)),"regression")
        self.assertEqual(delta.outcome_exit_code("regression"),1)
        # The failed workflow's complete artifact is the next acceptance baseline.
        self.assertEqual(delta.classify(continuing,state(regression)),"continuing")
        self.assertEqual(delta.outcome_exit_code("continuing"),0)
        self.assertEqual(delta.classify(recovery,state(continuing)),"recovered")
        self.assertEqual(delta.outcome_exit_code("recovered"),0)

if __name__=="__main__": unittest.main()
