import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path

from scripts.lib.safety import (
    ALLOWED_PROTECTED_PROMOTION_ACTIONS,
    SUPPLEMENTAL_PREVIEW_ROLE,
    country_has_protected_hotlines,
    preview_dataset_claims_canonical,
    validate_promotion_candidate,
)

ROOT = Path(__file__).resolve().parent.parent
CANONICAL_PATH = ROOT / "hotlines.json"
PREVIEW_PATH = ROOT / "sources" / "web_verified_crisis_directory" / "web_verified_directory_v2_preview.json"
APPLY_ENRICHMENT = ROOT / "scripts" / "apply_enrichment.py"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class CanonicalPromotionSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.canonical = json.loads(CANONICAL_PATH.read_text(encoding="utf-8"))
        cls.preview = json.loads(PREVIEW_PATH.read_text(encoding="utf-8"))
        cls.protected_countries = {
            country["country"]
            for country in cls.canonical["countries"]
            if country_has_protected_hotlines(country)
        }

    def test_preview_dataset_is_non_canonical(self):
        self.assertEqual(self.preview.get("_preview_metadata", {}).get("dataset_role"), SUPPLEMENTAL_PREVIEW_ROLE)
        self.assertFalse(preview_dataset_claims_canonical(self.preview))
        self.assertNotEqual(PREVIEW_PATH.resolve(), CANONICAL_PATH.resolve())
        self.assertIn("not the canonical dataset", self.preview.get("methodology", ""))

    def test_protected_countries_allow_only_additive_promotion_candidates(self):
        protected_country = next(iter(self.protected_countries))
        allowed_candidate = {
            "country": protected_country,
            "candidate_type": next(iter(ALLOWED_PROTECTED_PROMOTION_ACTIONS)),
        }
        validate_promotion_candidate(allowed_candidate, self.protected_countries)

        disallowed_candidate = {
            "country": protected_country,
            "candidate_type": "upgrade_emergency_metadata",
        }
        with self.assertRaisesRegex(ValueError, "Protected canonical country"):
            validate_promotion_candidate(disallowed_candidate, self.protected_countries)

    def test_canonical_write_command_requires_apply(self):
        before_hash = sha256(CANONICAL_PATH)
        result = subprocess.run(
            [sys.executable, str(APPLY_ENRICHMENT)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        after_hash = sha256(CANONICAL_PATH)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before_hash, after_hash, "hotlines.json changed without --apply")
        self.assertIn("Dry run only", result.stdout)
        self.assertIn("--apply", result.stdout)


if __name__ == "__main__":
    unittest.main()
