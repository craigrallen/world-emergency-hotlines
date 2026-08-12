import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "dedupe_check.py"


def duplicate_dataset():
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
                "hotlines": [
                    {
                        "name": "Test Line A",
                        "organization": "Test Line A",
                        "category": "mental_health",
                        "voice_numbers": ["1234567890"],
                        "sms_numbers": [],
                        "text_numbers": [],
                        "short_codes": [],
                        "chat_url": None,
                        "email": None,
                        "website": None,
                        "hours": "24/7",
                        "languages": [],
                        "cost": "free",
                        "target": None,
                        "geography": "Testland",
                        "notes": "",
                        "verification_status": "verified_web",
                        "last_verified": "2026-04-22",
                        "sources": ["https://example.test/a"],
                    },
                    {
                        "name": "Test Line A Duplicate",
                        "organization": "Test Line A Duplicate",
                        "category": "mental_health",
                        "voice_numbers": ["1234567890"],
                        "sms_numbers": [],
                        "text_numbers": [],
                        "short_codes": [],
                        "chat_url": None,
                        "email": None,
                        "website": None,
                        "hours": None,
                        "languages": [],
                        "cost": "unknown",
                        "target": None,
                        "geography": "Testland",
                        "notes": "",
                        "verification_status": "legacy_unverified",
                        "last_verified": None,
                        "sources": ["information.json"],
                    },
                ],
            }
        ],
    }


def cross_category_duplicate_dataset():
    dataset = duplicate_dataset()
    dataset["countries"][0]["hotlines"][1]["category"] = "suicide_crisis"
    dataset["categories_reference"]["suicide_crisis"] = "Suicide prevention"
    return dataset


def mixed_category_duplicate_dataset():
    dataset = cross_category_duplicate_dataset()
    third = dict(dataset["countries"][0]["hotlines"][0])
    third["name"] = "Test Line A Second Mental Health Record"
    third["organization"] = third["name"]
    third["sources"] = ["https://example.test/third"]
    dataset["countries"][0]["hotlines"].append(third)
    return dataset


class DedupeCheckTests(unittest.TestCase):
    def write_json(self, path: Path, payload: dict) -> None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def run_command(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_help(self):
        result = self.run_command("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("usage", result.stdout.lower())

    def test_default_invocation_prints_summary_and_leaves_input_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "hotlines.json"
            self.write_json(input_path, duplicate_dataset())
            before = input_path.read_text(encoding="utf-8")

            result = self.run_command("--input", str(input_path))

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("candidate duplicate groups", result.stdout)
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))

    def test_report_flag_writes_markdown_and_leaves_input_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            input_path = tmp / "hotlines.json"
            report_path = tmp / "report.md"
            self.write_json(input_path, duplicate_dataset())
            before = input_path.read_text(encoding="utf-8")

            result = self.run_command(
                "--input", str(input_path),
                "--report", str(report_path),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))
            self.assertTrue(report_path.exists())
            self.assertIn("Duplicate detection findings", report_path.read_text(encoding="utf-8"))

    def test_report_flag_requires_an_explicit_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "hotlines.json"
            self.write_json(input_path, duplicate_dataset())

            result = self.run_command("--input", str(input_path), "--report")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--report", result.stderr)

    def test_without_report_flag_nothing_is_written_to_disk(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            input_path = tmp / "hotlines.json"
            self.write_json(input_path, duplicate_dataset())
            before_listing = set(tmp.iterdir())

            result = self.run_command("--input", str(input_path))

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(before_listing, set(tmp.iterdir()))

    def test_apply_flag_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "hotlines.json"
            self.write_json(input_path, duplicate_dataset())

            result = self.run_command("--input", str(input_path), "--apply")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unrecognized arguments", result.stderr)

    def test_output_flag_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "hotlines.json"
            self.write_json(input_path, duplicate_dataset())

            result = self.run_command("--input", str(input_path), "--output", "/tmp/out.json")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unrecognized arguments", result.stderr)

    def test_report_same_path_as_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "hotlines.json"
            self.write_json(path, duplicate_dataset())
            before = path.read_text(encoding="utf-8")

            result = self.run_command("--input", str(path), "--report", str(path))

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("same file as --input", result.stderr)
            self.assertEqual(before, path.read_text(encoding="utf-8"))

    def test_report_targeting_canonical_dataset_is_rejected_even_with_other_input(self):
        canonical = ROOT / "hotlines.json"
        before = canonical.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "other_dataset.json"
            self.write_json(input_path, duplicate_dataset())

            # --report points straight at the canonical dataset by an
            # unresolved-but-equivalent path, while --input is a harmless temp
            # file, to prove the canonical-dataset guard doesn't rely on
            # --report matching --input.
            sneaky_report = ROOT / "scripts" / ".." / "hotlines.json"
            result = self.run_command(
                "--input", str(input_path),
                "--report", str(sneaky_report),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("canonical dataset", result.stderr)
            self.assertEqual(before, canonical.read_text(encoding="utf-8"))

    def test_report_without_md_extension_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            input_path = tmp / "hotlines.json"
            report_path = tmp / "report.json"
            self.write_json(input_path, duplicate_dataset())
            before = input_path.read_text(encoding="utf-8")

            result = self.run_command(
                "--input", str(input_path),
                "--report", str(report_path),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn(".md", result.stderr)
            self.assertFalse(report_path.exists())
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))

    def test_same_category_group_is_labeled_a_duplicate_candidate(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "hotlines.json"
            self.write_json(input_path, duplicate_dataset())
            before = input_path.read_text(encoding="utf-8")

            result = self.run_command("--input", str(input_path))

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("1 same-category duplicate candidate(s)", result.stdout)
            self.assertIn("0 cross-category shared-contact candidate(s)", result.stdout)
            self.assertIn("0 mixed scope-and-duplicate candidate(s)", result.stdout)
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))

    def test_cross_category_group_is_labeled_shared_contact_not_duplicate(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "hotlines.json"
            self.write_json(input_path, cross_category_duplicate_dataset())
            before = input_path.read_text(encoding="utf-8")

            result = self.run_command("--input", str(input_path))

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("0 same-category duplicate candidate(s)", result.stdout)
            self.assertIn("1 cross-category shared-contact candidate(s)", result.stdout)
            self.assertIn("0 mixed scope-and-duplicate candidate(s)", result.stdout)
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))

    def test_mixed_group_repeated_category_not_hidden_by_cross_category_row(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "hotlines.json"
            self.write_json(input_path, mixed_category_duplicate_dataset())
            before = input_path.read_text(encoding="utf-8")

            result = self.run_command("--input", str(input_path))

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("0 same-category duplicate candidate(s)", result.stdout)
            self.assertIn("0 cross-category shared-contact candidate(s)", result.stdout)
            self.assertIn("1 mixed scope-and-duplicate candidate(s)", result.stdout)
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))

    def test_cross_geography_group_is_flagged_orthogonally(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "hotlines.json"
            dataset = duplicate_dataset()
            dataset["countries"][0]["hotlines"][1]["geography"] = "Testland North"
            self.write_json(input_path, dataset)
            before = input_path.read_text(encoding="utf-8")

            result = self.run_command("--input", str(input_path))

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("1 same-category duplicate candidate(s)", result.stdout)
            self.assertIn("1 cross-geography candidate(s)", result.stdout)
            self.assertIn("orthogonal count, not a distinctness signal", result.stdout)
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))

    def test_report_body_labels_same_category_group_as_duplicate_candidate(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            input_path = tmp / "hotlines.json"
            report_path = tmp / "report.md"
            self.write_json(input_path, duplicate_dataset())

            result = self.run_command(
                "--input", str(input_path),
                "--report", str(report_path),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            report_text = report_path.read_text(encoding="utf-8")
            self.assertIn("same-category duplicate candidate", report_text)
            self.assertNotIn("shared-contact, distinct service scopes", report_text)

    def test_report_body_labels_cross_category_group_as_shared_contact_candidate(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            input_path = tmp / "hotlines.json"
            report_path = tmp / "report.md"
            self.write_json(input_path, cross_category_duplicate_dataset())

            result = self.run_command(
                "--input", str(input_path),
                "--report", str(report_path),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            report_text = report_path.read_text(encoding="utf-8")
            self.assertIn("cross-category shared-contact candidate — requires review", report_text)
            self.assertNotIn("same-category duplicate candidate", report_text)

    def test_report_valid_separate_md_path_still_works_and_input_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            input_path = tmp / "hotlines.json"
            report_path = tmp / "findings.md"
            self.write_json(input_path, duplicate_dataset())
            before = input_path.read_text(encoding="utf-8")

            result = self.run_command(
                "--input", str(input_path),
                "--report", str(report_path),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(report_path.exists())
            self.assertIn("Duplicate detection findings", report_path.read_text(encoding="utf-8"))
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
