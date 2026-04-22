import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CANONICAL_PATH = ROOT / "hotlines.json"
PREVIEW_PATH = ROOT / "sources" / "web_verified_crisis_directory" / "web_verified_directory_v2_preview.json"

PROTECTED_CANONICAL_STATUSES = {
    "verified_web",
    "verified_authority",
    "verified_knowledge",
    "disputed",
    "deprecated",
}


class WebVerifiedDirectoryPreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.canonical = json.loads(CANONICAL_PATH.read_text(encoding="utf-8"))
        cls.preview = json.loads(PREVIEW_PATH.read_text(encoding="utf-8"))

    def test_preview_uses_schema_v2_but_is_marked_non_canonical(self):
        self.assertEqual(self.preview["$schema_version"], self.canonical["$schema_version"])
        self.assertEqual(self.preview["$schema_version"], "2.0")
        self.assertEqual(self.preview.get("_preview_metadata", {}).get("dataset_role"), "supplemental_preview")
        self.assertIn("not the canonical dataset", self.preview.get("methodology", ""))

    def test_preview_excludes_countries_with_protected_canonical_records(self):
        protected_countries = {
            country["country"]
            for country in self.canonical["countries"]
            if any(
                hotline.get("verification_status") in PROTECTED_CANONICAL_STATUSES
                for hotline in country.get("hotlines", [])
            )
        }
        preview_countries = {country["country"] for country in self.preview["countries"]}
        overlap = sorted(protected_countries.intersection(preview_countries))
        self.assertEqual(overlap, [], f"preview overlaps protected canonical countries: {overlap}")
        excluded_count = self.preview.get("_preview_metadata", {}).get("excluded_countries_with_existing_rich_records")
        self.assertIsInstance(excluded_count, int)
        self.assertGreater(excluded_count, 0)
        self.assertLessEqual(excluded_count, len(protected_countries))

    def test_preview_hotlines_stay_legacy_unverified(self):
        bad_statuses = []
        for country in self.preview["countries"]:
            for hotline in country.get("hotlines", []):
                if hotline.get("verification_status") != "legacy_unverified":
                    bad_statuses.append(
                        (country["country"], hotline.get("name"), hotline.get("verification_status"))
                    )
        self.assertEqual(bad_statuses, [])


if __name__ == "__main__":
    unittest.main()
