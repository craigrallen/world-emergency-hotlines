import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.lib.safety import PROTECTED_CANONICAL_STATUSES, SUPPLEMENTAL_PREVIEW_ROLE, country_has_protected_hotlines

ROOT = Path(__file__).resolve().parent.parent
CANONICAL_PATH = ROOT / "hotlines.json"
DIRECTORY_PATH = ROOT / "sources" / "child_helpline_international" / "child_helpline_directory.json"
PREVIEW_PATH = ROOT / "sources" / "child_helpline_international" / "child_helpline_international_v2_preview.json"
UNMATCHED_PATH = ROOT / "sources" / "child_helpline_international" / "unmatched_countries.json"
BUILD_PROMOTION_CANDIDATES = ROOT / "scripts" / "build_promotion_candidates.py"


class ChildHelplineInternationalSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.canonical = json.loads(CANONICAL_PATH.read_text(encoding="utf-8"))
        cls.directory = json.loads(DIRECTORY_PATH.read_text(encoding="utf-8"))
        cls.preview = json.loads(PREVIEW_PATH.read_text(encoding="utf-8"))
        cls.unmatched = json.loads(UNMATCHED_PATH.read_text(encoding="utf-8"))

    def test_directory_artifact_has_expected_shape_and_sample_data(self):
        self.assertEqual(self.directory["source_name"], "child_helpline_international")
        self.assertGreaterEqual(self.directory["country_count"], 100)
        self.assertGreaterEqual(self.directory["helpline_count"], 140)
        countries = {country["country_name"]: country for country in self.directory["countries"]}
        self.assertIn("Canada", countries)
        canada_services = {entry["service_name"]: entry for entry in countries["Canada"]["helplines"]}
        self.assertIn("Kids Help Phone", canada_services)
        kids_help_phone = canada_services["Kids Help Phone"]
        self.assertIn("1-800-668-6868", kids_help_phone["voice_numbers"])
        self.assertIn("686868", kids_help_phone["sms_numbers"])
        self.assertIn("https://kidshelpphone.ca/", kids_help_phone["websites"])
        self.assertEqual(kids_help_phone["hours"], "Monday through Sunday 24/7")

    def test_preview_is_non_canonical_and_schema_v2(self):
        self.assertEqual(self.preview["$schema_version"], "2.0")
        self.assertEqual(self.preview["$schema_version"], self.canonical["$schema_version"])
        self.assertEqual(self.preview.get("_preview_metadata", {}).get("dataset_role"), SUPPLEMENTAL_PREVIEW_ROLE)
        self.assertIn("not the canonical dataset", self.preview.get("methodology", ""))
        self.assertGreater(len(self.preview["countries"]), 0)

    def test_preview_includes_matched_countries_even_when_canonical_country_is_protected(self):
        protected_countries = {
            country["country"]
            for country in self.canonical["countries"]
            if country_has_protected_hotlines(country)
        }
        preview_countries = {country["country"] for country in self.preview["countries"]}
        overlap = sorted(protected_countries.intersection(preview_countries))
        self.assertGreater(len(overlap), 0)
        self.assertGreater(self.preview.get("_preview_metadata", {}).get("included_countries_with_existing_rich_records", 0), 0)

    def test_preview_hotlines_remain_legacy_unverified_with_ngo_directory_provenance(self):
        self.assertGreater(len(self.preview["countries"]), 0)
        for country in self.preview["countries"]:
            for hotline in country.get("hotlines", []):
                self.assertEqual(hotline.get("verification_status"), "legacy_unverified")
                self.assertNotIn(hotline.get("verification_status"), PROTECTED_CANONICAL_STATUSES)
                self.assertEqual(hotline.get("category"), "child_protection")
                self.assertEqual(hotline.get("_import_metadata", {}).get("source_dataset"), "child_helpline_international")
                provenance = hotline.get("provenance") or {}
                self.assertEqual(provenance.get("record_status"), "legacy_unverified")
                self.assertEqual(provenance.get("source_class"), "ngo_directory")
                self.assertEqual(provenance.get("verification_method"), "scripted_import")
                self.assertEqual(provenance.get("review_state"), "staged")

    def test_unmatched_countries_are_explicitly_preserved(self):
        self.assertIsInstance(self.unmatched, list)
        self.assertGreaterEqual(len(self.unmatched), 1)
        names = {item["source_country_name"] for item in self.unmatched}
        self.assertIn("Somaliland", names)

    def test_preview_feeds_safe_promotion_candidate_pipeline(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            bundle_path = Path(tmpdir) / "candidates.json"
            report_path = Path(tmpdir) / "report.md"
            result = subprocess.run(
                [
                    sys.executable,
                    str(BUILD_PROMOTION_CANDIDATES),
                    "--canonical",
                    str(CANONICAL_PATH),
                    "--preview",
                    str(PREVIEW_PATH),
                    "--out",
                    str(bundle_path),
                    "--report",
                    str(report_path),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        self.assertGreater(bundle.get("summary", {}).get("candidate_count", 0), 0)
        protected_country_names = {
            country["country"]
            for country in self.canonical["countries"]
            if country_has_protected_hotlines(country)
        }
        for candidate in bundle.get("candidates", []):
            if candidate.get("country") in protected_country_names:
                self.assertIn(candidate.get("candidate_type"), {"append_new_hotline", "merge_missing_fields"})


if __name__ == "__main__":
    unittest.main()
