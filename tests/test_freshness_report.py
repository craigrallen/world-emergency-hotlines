import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "freshness_report.py"


def dataset():
    def hotline(name, category, status, last_verified):
        return {
            "name": name,
            "organization": name,
            "category": category,
            "voice_numbers": ["123456789"],
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
            "verification_status": status,
            "last_verified": last_verified,
            "sources": ["https://example.test"],
        }

    return {
        "$schema_version": "2.0",
        "countries": [
            {
                "country": "Testland",
                "hotlines": [
                    hotline("Current line", "general_support", "verified_web", "2026-08-01"),
                    hotline("Old line", "general_support", "verified_web", "2026-01-01"),
                    hotline("Undated crisis", "suicide_crisis", "legacy_unverified", None),
                    hotline("Old emergency", "emergency", "verified_authority", "2026-04-01"),
                    hotline("Future line", "mental_health", "verified_knowledge", "2026-12-01"),
                ],
            }
        ],
    }


class FreshnessReportTests(unittest.TestCase):
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

    def test_as_of_is_required_for_deterministic_output(self):
        result = self.run_command()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--as-of", result.stderr)

    def test_summary_and_queue_are_deterministic_and_critical_first(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            input_path = tmp / "hotlines.json"
            json_report = tmp / "freshness.json"
            self.write_json(input_path, dataset())
            before = input_path.read_text(encoding="utf-8")

            result = self.run_command(
                "--input", str(input_path),
                "--as-of", "2026-08-12",
                "--stale-days", "90",
                "--json-report", str(json_report),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(json_report.read_text(encoding="utf-8"))
            self.assertEqual(
                report["summary"],
                {
                    "total_records": 5,
                    "current": 1,
                    "stale": 2,
                    "undated": 1,
                    "invalid_date": 0,
                    "future_date": 1,
                    "review_required": 4,
                    "critical_review_required": 2,
                },
            )
            self.assertEqual(
                [row["name"] for row in report["review_queue"][:2]],
                ["Undated crisis", "Old emergency"],
            )
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))

    def test_report_is_byte_stable_for_same_inputs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            input_path = tmp / "hotlines.json"
            self.write_json(input_path, dataset())
            outputs = []
            for suffix in ("a", "b"):
                markdown_path = tmp / f"{suffix}.md"
                json_path = tmp / f"{suffix}.json"
                result = self.run_command(
                    "--input", str(input_path),
                    "--as-of", "2026-08-12",
                    "--report", str(markdown_path),
                    "--json-report", str(json_path),
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                outputs.append((markdown_path.read_bytes(), json_path.read_bytes()))
            self.assertEqual(outputs[0], outputs[1])

    def test_output_cannot_overwrite_input_or_canonical_dataset(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "hotlines.json"
            self.write_json(input_path, dataset())
            before = input_path.read_text(encoding="utf-8")

            same_input = self.run_command(
                "--input", str(input_path),
                "--as-of", "2026-08-12",
                "--json-report", str(input_path),
            )
            self.assertNotEqual(same_input.returncode, 0)
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))

            canonical = self.run_command(
                "--input", str(input_path),
                "--as-of", "2026-08-12",
                "--json-report", str(ROOT / "hotlines.json"),
            )
            self.assertNotEqual(canonical.returncode, 0)
            self.assertEqual(before, input_path.read_text(encoding="utf-8"))

    def test_output_cannot_overwrite_an_existing_non_dataset_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            input_path = tmp / "hotlines.json"
            report_path = tmp / "important.md"
            self.write_json(input_path, dataset())
            report_path.write_text("do not replace\n", encoding="utf-8")

            result = self.run_command(
                "--input", str(input_path),
                "--as-of", "2026-08-12",
                "--report", str(report_path),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("already exists", result.stderr)
            self.assertEqual("do not replace\n", report_path.read_text(encoding="utf-8"))

    def test_invalid_thresholds_are_rejected(self):
        for flag in ("--stale-days", "--review-limit"):
            result = self.run_command("--as-of", "2026-08-12", flag, "0")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(flag, result.stderr)


if __name__ == "__main__":
    unittest.main()
