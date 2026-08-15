import datetime as dt
import importlib.util
import json
import tempfile
import unittest
import copy
from pathlib import Path
from scripts import source_monitor as sm

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("verification_workbench", ROOT / "scripts/verification_workbench.py")
wb = importlib.util.module_from_spec(spec); spec.loader.exec_module(wb)


class WorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.data = {"countries": [{"country": "X", "alpha-2": "XX", "hotlines": [{"id": "weh_critical", "name": "Emergency", "category": "emergency", "sources":["https://example.org/"], "last_verified": "2026-01-01"}, {"id": "weh_other", "name": "Other", "category": "general_support"}]}]}
        self.raw = json.dumps(self.data).encode(); self.ver = wb.version(self.raw); self.day = dt.date(2026, 8, 13)

    def freshness(self):
        return wb.build_freshness_report(self.data, self.day, 90, 1, self.ver)

    def monitor(self):
        return sm.build(self.data,self.raw,self.day,1,None,
            lambda url:{"outcome":"fetch_failure","http_status":None,"final_url":url,"text":"","truncated":False,"error":"OSError"})

    def candidates(self):
        common = {"country": "X", "alpha-2": "XX", "source_artifact": "preview.json", "safety_flags": [], "requires_human_review": True}
        values = [
            dict(common, candidate_id="a", candidate_type="append_new_hotline", canonical_match={"country": "X", "hotline_name": None, "match_confidence": 0.0}, proposed_hotline={"name": "A", "website": "https://a.example/"}, field_actions={"hotlines": "append_unique"}),
            dict(common, candidate_id="m", candidate_type="merge_missing_fields", canonical_match={"country": "X", "hotline_name": "Emergency", "match_confidence": 1.0}, proposed_hotline={"name": "Emergency", "website": "https://emergency.example/"}, field_actions={"website": "fill_if_empty"}),
            dict(common, candidate_id="u", candidate_type="upgrade_emergency_metadata", canonical_match={"country": "X", "hotline_name": None, "match_confidence": 1.0}, proposed_hotline=None, proposed_country_updates={"notes": "x"}, field_actions={"notes": "fill_if_empty"})]
        return {"$schema_version": "2.0", "canonical_hash": self.ver, "generated_at": "2026-08-13T00:00:00Z",
                "canonical_dataset": "hotlines.json", "preview_datasets": [], "candidates": values,
                "summary": {"candidate_count": 3, "candidate_types": {"append_new_hotline": 1, "merge_missing_fields": 1, "upgrade_emergency_metadata": 1}}}

    def test_full_freshness_and_candidate_actions_propagate(self):
        candidates = self.candidates(); digest = wb.bundle_hash(candidates)
        approvals = {"schema_version": "1.0", "canonical_hash": self.ver, "candidate_bundle_hash": digest, "review_date": "2026-08-13",
                     "decisions": [{"candidate_id": "a", "state": "approved"}]}
        report = wb.build(self.data, self.raw, self.day, self.freshness(), self.monitor(), candidates, approvals)
        self.assertEqual(len(report["record_queue"]), 2)
        self.assertEqual(report["freshness_queue"], {"total": 2, "preview": 1, "truncated": True, "omitted": 1})
        self.assertEqual({row["candidate_type"]: row["next_action"] for row in report["candidate_queue"]},
                         {"append_new_hotline": "candidate_approval_review", "merge_missing_fields": "duplicate_scope_review", "upgrade_emergency_metadata": "candidate_approval_review"})

    def test_rejects_unbound_duplicate_unknown_and_invalid_artifacts(self):
        bad = self.freshness(); bad.pop("canonical_hash")
        with self.assertRaisesRegex(ValueError, "schema|hash"):
            wb.build(self.data, self.raw, self.day, bad)
        candidates = self.candidates(); candidates["candidates"].append(dict(candidates["candidates"][0]))
        with self.assertRaisesRegex(ValueError, "unique"):
            wb.build(self.data, self.raw, self.day, self.freshness(), candidates=candidates)
        candidates = self.candidates(); approvals = {"schema_version": "1.0", "canonical_hash": self.ver,
            "candidate_bundle_hash": wb.bundle_hash(candidates), "review_date": "2026-08-13", "decisions": [{"candidate_id": "unknown", "state": "approved"}]}
        with self.assertRaisesRegex(ValueError, "unknown"):
            wb.build(self.data, self.raw, self.day, self.freshness(), candidates=candidates, approvals=approvals)

    def test_markdown_escapes_untrusted_fields_and_links(self):
        report = wb.build(self.data, self.raw, self.day, self.freshness(), self.monitor())
        report["record_queue"][0]["name"] = "x|[]\n<script>"
        rendered = wb.markdown(report)
        self.assertNotIn("<script>", rendered)
        self.assertIn("&lt;script&gt;", rendered)

    def test_freshness_is_recomputed_exactly(self):
        for mutate in (
            lambda value: value["review_records"][0].update(freshness="current"),
            lambda value: value["review_records"][0].update(age_days=1),
            lambda value: value["review_records"].pop(),
            lambda value: value["review_records"].append(dict(value["review_records"][0])),
            lambda value: value.update(stale_after_days=1000),
            lambda value: value["summary"].update(stale=0, current=1),
            lambda value: value["review_required_by_status"].update(missing=1),
            lambda value: value["all_records_by_category"].update(emergency=0),
        ):
            forged = copy.deepcopy(self.freshness())
            mutate(forged)
            with self.subTest(forged=forged):
                with self.assertRaises(ValueError):
                    wb.build(self.data, self.raw, self.day, forged)
        forged = self.freshness(); forged["stale_after_days"] = 0
        with self.assertRaisesRegex(ValueError, "stale_after_days"):
            wb.build(self.data, self.raw, self.day, forged)

    def test_source_snapshot_is_bound_to_canonical_population_selection_and_labels(self):
        original=self.monitor()
        for mutate in (
            lambda x:x["observations"][0].update(source_url="https://forged.example/"),
            lambda x:x["observations"][0].update(country="Forged"),
            lambda x:x["policy"].update(cursor=x["policy"]["cursor"]+1),
            lambda x:x["policy"].update(critical_cohort=0),
        ):
            bad=copy.deepcopy(original); mutate(bad)
            with self.assertRaises(ValueError): wb.build(self.data,self.raw,self.day,self.freshness(),bad)
        drift=json.dumps({**self.data,"extra":"byte drift"}).encode(); drift_data=json.loads(drift)
        with self.assertRaises(ValueError): wb.build(drift_data,drift,self.day,
            wb.build_freshness_report(drift_data,self.day,90,1,wb.version(drift)),original)

    def test_candidate_additive_contract_rejects_forgery(self):
        cases = []
        value = self.candidates(); value["candidates"][1]["proposed_hotline"].pop("website"); cases.append(value)
        value = self.candidates(); value["candidates"][1]["proposed_hotline"]["website"] = ""; cases.append(value)
        value = self.candidates(); value["candidates"][1]["field_actions"] = {"voice_numbers": "append_unique"}; cases.append(value)
        value = self.candidates(); value["candidates"][0]["proposed_hotline"]["name"] = "Emergency"; cases.append(value)
        value = self.candidates(); value["candidates"][2]["proposed_country_updates"]["notes"] = ""; cases.append(value)
        value = self.candidates(); value["candidates"][1]["canonical_match"]["hotline_name"] = "Other"; cases.append(value)
        for candidates in cases:
            with self.subTest(candidate=candidates["candidates"]):
                with self.assertRaises(ValueError):
                    wb.build(self.data, self.raw, self.day, self.freshness(), candidates=candidates)

        self.data["countries"][0]["hotlines"][0]["website"] = "https://already.example/"
        self.raw = json.dumps(self.data).encode(); self.ver = wb.version(self.raw)
        candidates = self.candidates()
        with self.assertRaises(ValueError):
            wb.build(self.data, self.raw, self.day, self.freshness(), candidates=candidates)

    def test_markdown_table_metacharacters_are_inert(self):
        report = wb.build(self.data, self.raw, self.day, self.freshness(), candidates=self.candidates())
        payload = "x|[click](https://evil.invalid)!`<b>\r\n\x01"
        report["record_queue"][0].update(record_id=payload, country=payload, name=payload)
        report["candidate_queue"][0].update(candidate_id=payload, country=payload, name=payload)
        rendered = wb.markdown(report)
        rows = [line for line in rendered.splitlines() if "&#91;click&#93;" in line]
        self.assertEqual([row.count("|") for row in rows], [7, 7])
        self.assertNotIn("[click](", rendered)
        self.assertNotIn("![", rendered)
        self.assertNotIn("<b>", rendered)

    def test_outputs_cannot_alias_and_canonical_unchanged(self):
        before = (ROOT / "hotlines.json").read_bytes()
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "out"
            with self.assertRaisesRegex(SystemExit, "alias"):
                wb.guard_outputs(target, target, [])
        self.assertEqual(before, (ROOT / "hotlines.json").read_bytes())


if __name__ == "__main__": unittest.main()
