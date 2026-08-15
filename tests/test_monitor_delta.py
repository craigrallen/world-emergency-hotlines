import importlib.util
import json
import os
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("monitor_delta", ROOT / "scripts/monitor_delta.py")
md = importlib.util.module_from_spec(spec); spec.loader.exec_module(md)
from scripts import artifact_io


def result(status="ok", issues=None, metric=10):
    return {"schema_version": "1.0", "monitor": "fixture", "as_of": "2026-08-15", "status": status,
            "issues": issues or [], "metrics": {"count": metric}}


def state(latest):
    return {"schema_version": "2.0", "monitor": latest["monitor"], "latest": latest, "history": [latest]}


class MonitorDeltaTests(unittest.TestCase):
    def test_all_outcomes(self):
        issue = [{"code": "bad", "subject": "/", "detail": "failed"}]
        good, bad, down = result(), result("regression", issue), result("unavailable", issue)
        self.assertEqual(md.classify(good, None), "baseline")
        self.assertEqual(md.classify(good, state(good)), "unchanged")
        self.assertEqual(md.classify(bad, state(good)), "regression")
        self.assertEqual(md.classify(bad, state(bad)), "continuing")
        self.assertEqual(md.classify(good, state(bad)), "recovered")
        self.assertEqual(md.classify(down, state(good)), "unavailable")
        changed = result("regression", [{"code": "bad", "subject": "/x", "detail": "failed"}])
        self.assertEqual(md.classify(changed, state(bad)), "regression")

    def test_strict_schema_sanitization_and_exact_limits(self):
        bad = result(); bad["extra"] = True
        with self.assertRaisesRegex(ValueError, "schema"):
            md.validate_result(bad)
        credential = result("regression", [{"code": "x", "subject": "/", "detail": "Authorization: secret"}])
        with self.assertRaisesRegex(ValueError, "forbidden"):
            md.validate_result(credential)
        exact = state(result())
        exact["history"] = [{**result(), "as_of": f"2026-07-{day:02d}"} for day in range(1, md.MAX_HISTORY + 1)]
        exact["latest"] = exact["history"][-1]
        md.validate_baseline(exact, "fixture")
        exact["history"].append(result())
        with self.assertRaisesRegex(ValueError, "history"):
            md.validate_baseline(exact, "fixture")

    def test_threshold_exact_boundary_and_minimum_sample(self):
        self.assertFalse(md.threshold_crossed(74.999, 99, relative_drop=.25, minimum_baseline=100))
        self.assertTrue(md.threshold_crossed(75, 100, relative_drop=.25, minimum_baseline=100))
        self.assertFalse(md.threshold_crossed(75.001, 100, relative_drop=.25, minimum_baseline=100))

    def test_dates_latest_history_and_identity_are_strict(self):
        bad=result(); bad["as_of"]="2026-02-30"
        with self.assertRaisesRegex(ValueError,"date"): md.validate_result(bad)
        first={**result(),"as_of":"2026-08-13"}; second={**result(),"as_of":"2026-08-14"}
        baseline={"schema_version":"2.0","monitor":"fixture","latest":first,"history":[first,second]}
        with self.assertRaisesRegex(ValueError,"latest"): md.validate_baseline(baseline,"fixture")
        baseline={"schema_version":"2.0","monitor":"fixture","latest":first,"history":[second,first]}
        with self.assertRaisesRegex(ValueError,"chronological"): md.validate_baseline(baseline,"fixture")
        other={**second,"monitor":"other"}; baseline={"schema_version":"2.0","monitor":"fixture","latest":other,"history":[other]}
        with self.assertRaisesRegex(ValueError,"identity"): md.validate_baseline(baseline,"fixture")

    def test_oversized_and_malformed_baseline_exit_three(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); current = root / "current.json"; previous = root / "prior.json"
            current.write_text(json.dumps(result()))
            previous.write_bytes(b"{" + b"x" * md.MAX_INPUT_BYTES)
            self.assertEqual(md.main(["--current", str(current), "--previous", str(previous)]), 3)
            previous.write_text("{}")
            self.assertEqual(md.main(["--current", str(current), "--previous", str(previous)]), 3)

    def test_atomic_state_only_for_complete_available_run(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); current = root / "current.json"; output = root / "state.json"
            current.write_text(json.dumps(result()))
            self.assertEqual(md.main(["--current", str(current), "--state-output", str(output), "--alert-only"]), 0)
            self.assertEqual(json.loads(output.read_text())["latest"]["status"], "ok")
            down = result("unavailable", [{"code": "timeout", "subject": "monitor", "detail": "deadline"}])
            current.write_text(json.dumps(down)); before = output.read_bytes()
            self.assertEqual(md.main(["--current", str(current), "--state-output", str(output)]), 3)
            self.assertEqual(output.read_bytes(), before)

    def test_path_collisions_symlinks_hardlinks_and_partial_publish_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); current=root/"current.json"; current.write_text(json.dumps(result()))
            self.assertEqual(md.main(["--current",str(current),"--state-output",str(current)]),3)
            link=root/"link.json"; link.symlink_to(current)
            self.assertEqual(md.main(["--current",str(current),"--state-output",str(link)]),3)
            hard=root/"hard.json"; os.link(current,hard)
            self.assertEqual(md.main(["--current",str(current),"--previous",str(hard)]),3)
            one=root/"one.json"; two=root/"two.md"
            def fail_second(index,path):
                if index==1: raise OSError("injected")
            with self.assertRaises(OSError):
                artifact_io.coordinated_write([(one,b"one"),(two,b"two")],before_publish=fail_second)
            self.assertFalse(one.exists()); self.assertFalse(two.exists())

    def test_publication_races_fail_closed_without_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); one=root/"one.json"; two=root/"two.md"
            def create_destination(index,path):
                if index == 0: path.write_bytes(b"racer")
            with self.assertRaises(FileExistsError):
                artifact_io.coordinated_write([(one,b"ours"),(two,b"two")],before_publish=create_destination)
            self.assertEqual(one.read_bytes(),b"racer"); self.assertFalse(two.exists())

    def test_parent_replacement_and_symlink_swap_are_detected(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); parent=root/"out"; parent.mkdir(); moved=root/"old"
            target=parent/"one.json"
            def replace_parent(index,path):
                parent.rename(moved); parent.mkdir()
            with self.assertRaisesRegex(OSError,"parent changed"):
                artifact_io.coordinated_write([(target,b"one")],before_publish=replace_parent)
            self.assertFalse(target.exists()); self.assertEqual(list(moved.iterdir()),[])
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); parent=root/"out"; parent.mkdir(); moved=root/"old"
            target=parent/"one.json"
            def swap_parent(index,path):
                parent.rename(moved); parent.symlink_to(moved, target_is_directory=True)
            with self.assertRaisesRegex(OSError,"parent changed"):
                artifact_io.coordinated_write([(target,b"one")],before_publish=swap_parent)
            self.assertFalse((moved/"one.json").exists()); self.assertEqual(list(moved.iterdir()),[])

    def test_staging_failure_removes_temporary_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); target=root/"one.json"
            with mock.patch.object(artifact_io.os,"fsync",side_effect=OSError("injected")):
                with self.assertRaises(OSError): artifact_io.coordinated_write([(target,b"one")])
            self.assertEqual(list(root.iterdir()),[])

    def test_state_publication_race_parent_swap_symlink_and_hardlink_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); current=root/"current.json"; current.write_text(json.dumps(result()))
            for mode in ("race","parent","symlink","hardlink"):
                parent=root/mode; parent.mkdir(); output=parent/"state.json"; moved=root/(mode+"-old")
                def injected(payloads,mode=mode):
                    def before(index,path):
                        if mode=="race": path.write_bytes(b"racer")
                        elif mode=="parent": path.parent.rename(moved); path.parent.mkdir()
                        elif mode=="symlink": path.symlink_to(current)
                        else: os.link(current,path)
                    return artifact_io.coordinated_write(payloads,before_publish=before)
                with mock.patch.object(md,"coordinated_write",side_effect=injected):
                    self.assertEqual(md.main(["--current",str(current),"--state-output",str(output)]),3)
                if mode in {"race","symlink","hardlink"}: self.assertTrue(output.exists())
                else: self.assertFalse(output.exists())
                self.assertFalse(any(p.name.endswith(".tmp") for p in (moved if moved.exists() else parent).iterdir()))


if __name__ == "__main__": unittest.main()
