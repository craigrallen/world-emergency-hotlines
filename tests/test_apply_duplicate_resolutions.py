import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "apply_duplicate_resolutions.py"


def hotline(name, number, category="suicide_crisis"):
    return {
        "name": name,
        "organization": name,
        "category": category,
        "voice_numbers": [number],
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
        "sources": ["fixture"],
    }


class DuplicateResolutionTests(unittest.TestCase):
    def run_command(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    def fixture(self, directory: Path):
        canonical = directory / "hotlines.json"
        data = {
            "$schema_version": "2.0",
            "countries": [{"country": "Testland", "hotlines": [
                hotline("Rich line", "123"),
                hotline("Legacy duplicate", "123"),
                hotline("Distinct category", "123", "general_support"),
            ]}],
        }
        canonical.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        bundle = directory / "batch.json"
        payload = {
            "schema_version": "1.0",
            "batch_id": "test",
            "canonical_sha256": hashlib.sha256(canonical.read_bytes()).hexdigest(),
            "review_date": "2026-08-12",
            "resolutions": [{
                "resolution_id": "test-one",
                "country": "Testland",
                "survivor": {"name": "Rich line", "category": "suicide_crisis", "voice_numbers": ["123"]},
                "evidence_url": "https://example.test",
                "remove": [{"name": "Legacy duplicate", "category": "suicide_crisis", "voice_numbers": ["123"]}],
            }],
        }
        bundle.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        return canonical, bundle

    def test_dry_run_never_changes_canonical(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            canonical, bundle = self.fixture(Path(tmpdir))
            before = canonical.read_bytes()
            result = self.run_command("--canonical", str(canonical), "--bundle", str(bundle))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Dry run only", result.stdout)
            self.assertEqual(before, canonical.read_bytes())

    def test_apply_removes_only_exactly_reviewed_record(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            canonical, bundle = self.fixture(Path(tmpdir))
            result = self.run_command(
                "--canonical", str(canonical), "--bundle", str(bundle), "--apply"
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(canonical.read_text(encoding="utf-8"))
            names = [h["name"] for h in data["countries"][0]["hotlines"]]
            self.assertEqual(names, ["Rich line", "Distinct category"])

    def test_sha_drift_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            canonical, bundle = self.fixture(Path(tmpdir))
            canonical.write_text(canonical.read_text() + "\n", encoding="utf-8")
            result = self.run_command("--canonical", str(canonical), "--bundle", str(bundle), "--apply")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SHA-256 mismatch", result.stderr)

    def test_ambiguous_removal_selector_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            canonical, bundle = self.fixture(Path(tmpdir))
            data = json.loads(canonical.read_text())
            data["countries"][0]["hotlines"].append(hotline("Legacy duplicate", "123"))
            canonical.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            payload = json.loads(bundle.read_text())
            payload["canonical_sha256"] = hashlib.sha256(canonical.read_bytes()).hexdigest()
            bundle.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            result = self.run_command("--canonical", str(canonical), "--bundle", str(bundle), "--apply")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("matched 2 records", result.stderr)

    def test_existing_report_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            canonical, bundle = self.fixture(tmp)
            report = tmp / "important.md"
            report.write_text("keep\n", encoding="utf-8")
            result = self.run_command(
                "--canonical", str(canonical), "--bundle", str(bundle), "--report", str(report)
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual("keep\n", report.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
