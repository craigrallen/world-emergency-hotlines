import datetime as dt
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

from scripts.metadata_coverage_report import build_report


def hotline(record_id, **overrides):
    value = {
        "id": record_id, "name": record_id, "geography": "Testland", "hours": None,
        "languages": [], "target": None, "verification_status": "legacy_unverified",
        "last_verified": None,
    }
    value.update(overrides); return value


class MetadataCoverageReportTests(unittest.TestCase):
    def js_report(self, data, as_of="2026-08-13", current_days=365, dataset_version="sha256:test"):
        module = Path(__file__).resolve().parents[1] / "web/scripts/metadata-coverage.mjs"
        script = "const {buildMetadataCoverage:b}=await import(process.argv[1]);let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(b(JSON.parse(s),process.argv[2],Number(process.argv[3]),process.argv[4])))"
        result = subprocess.run(["node", "--input-type=module", "-e", script, module.as_uri(), as_of, str(current_days), dataset_version], input=json.dumps(data), text=True, capture_output=True, check=True)
        return json.loads(result.stdout)

    def test_metrics_separate_presence_specificity_evidence_and_structure(self):
        data = {"$schema_version": "2.0", "countries": [{"country": "Testland", "hotlines": [
            hotline("a", hours="24/7", languages=["English"], target="Adults", geography="Example County", verification_status="verified_web", last_verified="2026-07-01", provenance={"evidence": [{"field": "hours"}, {"field": "service_scope.geography"}]}, service_scope={"geography": {"level": "county", "areas": ["Example County"]}}),
            hotline("b", hours="office hours", geography="Testland", verification_status="verified_authority", last_verified="2024-01-01"),
            hotline("c", geography="Testland"),
        ]}]}
        report = build_report(data, dt.date(2026, 8, 13), 365, "sha256:test")
        self.assertEqual(report["total_records"], 3)
        self.assertEqual(report["field_presence"]["hours"], {"records": 2, "percent": 66.7})
        self.assertEqual(report["field_level_evidence"]["hours"], {"records": 1, "percent": 33.3})
        self.assertEqual(report["geography_specificity"]["more_specific_than_country_label"]["records"], 1)
        self.assertEqual(report["source_backed_status"]["records"], 2)
        self.assertEqual(report["dated_verification"]["records"], 2)
        self.assertEqual(report["current_dated_verification"]["records"], 1)
        self.assertEqual(report["structured_scope_adoption"]["geography"]["records"], 1)
        self.assertTrue(report["interpretation"]["no_composite_score"])
        self.assertNotIn("score", {key for key in report if key != "interpretation"})

    def test_report_is_deterministic(self):
        data = {"$schema_version": "2.0", "countries": []}
        self.assertEqual(build_report(data, dt.date(2026, 8, 13)), build_report(data, dt.date(2026, 8, 13)))

    def test_python_and_js_have_exact_unicode_and_date_semantic_parity(self):
        data = {"$schema_version": "2.0", "countries": [{"country": "ＴＥＳＴİ", "hotlines": [
            hotline("z", geography="TESTİ", verification_status="ž-status", last_verified="2024-02-29"),
            hotline("a", geography="Elsewhere", verification_status="Ä-status", last_verified="2026-02-30"),
            hotline("b", geography="Elsewhere", verification_status="a-status", last_verified="2026-08-14"),
        ]}]}
        py = build_report(data, dt.date(2026, 8, 13), 365, "sha256:test")
        self.assertEqual(py, self.js_report(data))
        self.assertEqual(py["dated_verification"]["records"], 2)
        self.assertEqual(py["current_dated_verification"]["records"], 0)
        self.assertEqual(py["geography_specificity"]["more_specific_than_country_label"]["records"], 2)

    def test_exact_half_up_percentage_parity_including_one_sixteenth(self):
        data = {"$schema_version": "2.0", "countries": [{"country": "Testland", "hotlines": [
            hotline(str(i), hours="24/7" if i == 0 else None) for i in range(16)
        ]}]}
        py = build_report(data, dt.date(2026, 8, 13), dataset_version="sha256:test")
        self.assertEqual(py["field_presence"]["hours"]["percent"], 6.3)
        self.assertEqual(py, self.js_report(data))

    def test_current_canonical_all_shared_fields_match_js(self):
        path = Path(__file__).resolve().parents[1] / "hotlines.json"
        raw = path.read_bytes(); data = json.loads(raw)
        version = "sha256:" + hashlib.sha256(raw).hexdigest()
        py = build_report(data, dt.date.fromisoformat(data["last_updated"]), 365, version)
        self.assertEqual(py, self.js_report(data, data["last_updated"], 365, version))

    def test_js_rejects_bogus_as_of_date(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.js_report({"$schema_version": "2.0", "countries": []}, "2026-02-30")

    def test_js_iso_year_and_calendar_boundaries_match_python(self):
        empty = {"$schema_version": "2.0", "countries": []}
        for valid in ("0001-01-01", "0099-12-31", "2000-02-29"):
            self.assertEqual(self.js_report(empty, valid)["as_of"], valid)
        for invalid in ("0000-01-01", "0001-02-29", "0099-04-31", "1900-02-29"):
            with self.subTest(invalid=invalid), self.assertRaises(subprocess.CalledProcessError):
                self.js_report(empty, invalid)

    def test_legacy_coverage_date_fallback_is_stable(self):
        module = Path(__file__).resolve().parents[1] / "web/scripts/metadata-coverage.mjs"
        script = "const {coverageAsOf:f}=await import(process.argv[1]);console.log(f(null));console.log(f('2026-08-13'))"
        result = subprocess.run(["node", "--input-type=module", "-e", script, module.as_uri()], text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout.splitlines(), ["1970-01-01", "2026-08-13"])

    def test_modest_normalization_handles_apostrophe_n_without_casefold_claim(self):
        data = {"$schema_version": "2.0", "countries": [{"country": "ŉ", "hotlines": [hotline("a", geography="ʼN")]}]}
        py = build_report(data, dt.date(2026, 8, 13), dataset_version="sha256:test")
        self.assertEqual(py, self.js_report(data))
        self.assertEqual(py["geography_specificity"]["more_specific_than_country_label"]["records"], 0)

    def test_future_added_records_change_counts_without_baselines(self):
        data = {"$schema_version": "2.0", "countries": [{"country": "Testland", "hotlines": [hotline("a")]}]}
        before = build_report(data, dt.date(2026, 8, 13))
        data["countries"][0]["hotlines"].append(hotline("b", hours="24/7"))
        after = build_report(data, dt.date(2026, 8, 13))
        self.assertEqual(after["total_records"], before["total_records"] + 1)
        self.assertEqual(after["field_presence"]["hours"]["records"], before["field_presence"]["hours"]["records"] + 1)

    def test_unicode_casefold_real_dates_and_dataset_version(self):
        data = {"$schema_version": "2.0", "countries": [{"country": "Straße", "hotlines": [
            hotline("a", geography="STRASSE", last_verified="2026-02-30"),
            hotline("b", geography="Elsewhere", last_verified="2024-02-29"),
        ]}]}
        report = build_report(data, dt.date(2026, 8, 13), dataset_version="sha256:test")
        self.assertEqual(report["dataset_version"], "sha256:test")
        self.assertEqual(report["geography_specificity"]["more_specific_than_country_label"]["records"], 1)
        self.assertEqual(report["dated_verification"]["records"], 1)


if __name__ == "__main__": unittest.main()
