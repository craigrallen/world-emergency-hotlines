import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "validate_canonical.py"
CANONICAL_PATH = ROOT / "hotlines.json"


def base_hotline(**overrides):
    hotline = {
        "name": "Test Line",
        "organization": "Test Line",
        "category": "mental_health",
        "voice_numbers": ["111 222"],
        "sms_numbers": [],
        "text_numbers": [],
        "short_codes": [],
        "chat_url": None,
        "email": None,
        "website": None,
        "hours": "24/7",
        "languages": ["English"],
        "cost": "free",
        "target": None,
        "geography": "Testland",
        "notes": "",
        "verification_status": "verified_web",
        "last_verified": "2026-04-22",
        "sources": ["https://example.test"],
    }
    hotline.update(overrides)
    return hotline


def base_dataset(hotlines):
    return {
        "$schema_version": "2.0",
        "last_updated": "2026-04-22",
        "methodology": "test canonical",
        "categories_reference": {"mental_health": "General mental health support"},
        "countries": [
            {
                "country": "Testland",
                "alpha-2": "TL",
                "alpha-3": "TST",
                "region": "Test Region",
                "subregion": "Test Subregion",
                "general_emergency": ["100"],
                "notes": "",
                "hotlines": hotlines,
            }
        ],
    }


class ValidateCanonicalTests(unittest.TestCase):
    def write_json(self, path: Path, payload: dict) -> None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def run_validator(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_help(self):
        result = self.run_validator("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("usage", result.stdout.lower())

    def test_valid_dataset_passes_with_no_errors(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline()]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("0 error(s)", result.stdout)

    def test_missing_name_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            hotline = base_hotline()
            del hotline["name"]
            self.write_json(path, base_dataset([hotline]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("required field 'name'", result.stdout)

    def test_missing_category_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline(category="")]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("required field 'category'", result.stdout)

    def test_invalid_verification_status_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline(verification_status="not_a_real_status")]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("invalid verification_status", result.stdout)

    def test_non_list_field_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline(voice_numbers="111 222")]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("field 'voice_numbers' must be a list", result.stdout)

    def test_bad_last_verified_date_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline(last_verified="22 April 2026")]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("is not an ISO date", result.stdout)

    def test_no_contact_channel_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(
                path,
                base_dataset(
                    [
                        base_hotline(
                            voice_numbers=[],
                            sms_numbers=[],
                            text_numbers=[],
                            short_codes=[],
                            chat_url=None,
                            email=None,
                            website=None,
                        )
                    ]
                ),
            )
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("no contact channel", result.stdout)

    def test_exact_contact_duplicate_is_a_warning_not_a_failure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(
                path,
                base_dataset(
                    [
                        base_hotline(name="Line One"),
                        base_hotline(name="Line Two"),
                    ]
                ),
            )
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("WARNING", result.stdout)
            self.assertIn("exact-contact duplicate", result.stdout)
            self.assertIn("0 error(s)", result.stdout)

    def test_category_not_slug_shaped_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline(category="Mental Health")]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("must be a non-empty lowercase", result.stdout)

    def test_category_not_in_reference_is_a_warning_not_a_failure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline(category="consular")]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("WARNING", result.stdout)
            self.assertIn("not listed in categories_reference", result.stdout)

    def test_unknown_categories_are_summarized_not_one_warning_per_record(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            hotlines = [
                base_hotline(name=f"Consular Line {i}", category="consular") for i in range(20)
            ]
            self.write_json(path, base_dataset(hotlines))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 0, result.stdout)
            category_lines = [
                line for line in result.stdout.splitlines() if "categories_reference" in line
            ]
            self.assertEqual(len(category_lines), 1)
            self.assertIn("20 hotline(s)", category_lines[0])
            self.assertIn("'consular' (20)", category_lines[0])

    def test_exact_contact_duplicates_are_summarized_with_bounded_sample(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            hotlines = []
            for i in range(20):
                pair_number = f"{1000000 + i}"
                hotlines.append(base_hotline(name=f"Line {i}A", voice_numbers=[pair_number]))
                hotlines.append(base_hotline(name=f"Line {i}B", voice_numbers=[pair_number]))
            self.write_json(path, base_dataset(hotlines))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 0, result.stdout)
            duplicate_lines = [
                line for line in result.stdout.splitlines() if "exact-contact duplicate" in line
            ]
            self.assertEqual(len(duplicate_lines), 1)
            self.assertIn("20 group(s)", duplicate_lines[0])
            self.assertIn("more group(s) not shown", duplicate_lines[0])

    def test_unparsable_json_exits_two(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            path.write_text("{not valid json", encoding="utf-8")
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 2)

    def test_never_writes_to_input_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline()]))
            before = path.read_text(encoding="utf-8")
            self.run_validator("--input", str(path))
            self.assertEqual(before, path.read_text(encoding="utf-8"))

    def test_default_input_validates_repo_canonical_dataset(self):
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_missing_geography_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            hotline = base_hotline()
            del hotline["geography"]
            self.write_json(path, base_dataset([hotline]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("required field 'geography'", result.stdout)

    def test_blank_geography_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline(geography="   ")]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("required field 'geography'", result.stdout)

    def test_non_string_geography_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline(geography=["Testland"])]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 1)
            self.assertIn("required field 'geography'", result.stdout)

    def test_country_wide_geography_matching_country_name_is_valid(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, base_dataset([base_hotline(geography="Testland")]))
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("0 error(s)", result.stdout)

    def test_subnational_geography_label_is_valid(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(
                path, base_dataset([base_hotline(geography="Rural Testland Province")])
            )
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("0 error(s)", result.stdout)

    def test_cross_category_exact_contact_group_is_a_shared_contact_candidate(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            dataset = base_dataset(
                [
                    base_hotline(name="Suicide Line", category="mental_health"),
                    base_hotline(name="Crisis Line", category="suicide_crisis"),
                ]
            )
            dataset["categories_reference"]["suicide_crisis"] = "Suicide prevention"
            before = json.dumps(dataset, ensure_ascii=False, indent=2)
            self.write_json(path, dataset)
            result = self.run_validator("--input", str(path))
            # Shared contact across distinct categories is a review candidate,
            # not a validation failure.
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("1 cross-category shared-contact candidate(s)", result.stdout)
            self.assertIn("0 same-category duplicate candidate(s)", result.stdout)
            self.assertEqual(before, path.read_text(encoding="utf-8"))

    def test_same_category_exact_contact_group_is_a_duplicate_candidate(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            dataset = base_dataset(
                [
                    base_hotline(name="Line One"),
                    base_hotline(name="Line Two"),
                ]
            )
            before = json.dumps(dataset, ensure_ascii=False, indent=2)
            self.write_json(path, dataset)
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("0 cross-category shared-contact candidate(s)", result.stdout)
            self.assertIn("1 same-category duplicate candidate(s)", result.stdout)
            self.assertEqual(before, path.read_text(encoding="utf-8"))

    def test_mixed_group_repeated_category_not_hidden_by_cross_category_row(self):
        # Three records share one exact contact: two are "mental_health"
        # (a same-category duplicate candidate pair) and a third is
        # "suicide_crisis". A whole-group binary cross-category/same-category
        # classification would misreport this 3-member group as purely
        # cross-category, hiding the repeated same-category pair inside it.
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            dataset = base_dataset(
                [
                    base_hotline(name="Line One"),
                    base_hotline(name="Line Two"),
                    base_hotline(name="Line Three", category="suicide_crisis"),
                ]
            )
            dataset["categories_reference"]["suicide_crisis"] = "Suicide prevention"
            before = json.dumps(dataset, ensure_ascii=False, indent=2)
            self.write_json(path, dataset)
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("1 mixed scope-and-duplicate candidate(s)", result.stdout)
            self.assertIn("0 same-category duplicate candidate(s)", result.stdout)
            self.assertIn("0 cross-category shared-contact candidate(s)", result.stdout)
            self.assertEqual(before, path.read_text(encoding="utf-8"))

    def test_cross_geography_exact_contact_group_is_flagged_separately(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            dataset = base_dataset(
                [
                    base_hotline(name="Line One", geography="Testland"),
                    base_hotline(name="Line Two", geography="Rural Testland Province"),
                ]
            )
            self.write_json(path, dataset)
            result = self.run_validator("--input", str(path))
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("1 cross-geography candidate(s)", result.stdout)

    def test_classification_never_writes_to_input_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(
                path,
                base_dataset(
                    [
                        base_hotline(name="Line One"),
                        base_hotline(name="Line Two"),
                    ]
                ),
            )
            before = path.read_text(encoding="utf-8")
            self.run_validator("--input", str(path))
            self.assertEqual(before, path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
