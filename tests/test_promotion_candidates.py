import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD_SCRIPT = ROOT / "scripts" / "build_promotion_candidates.py"
APPLY_SCRIPT = ROOT / "scripts" / "apply_promotion_candidates.py"


class PromotionCandidateWorkflowTests(unittest.TestCase):
    def write_json(self, path: Path, payload: dict) -> None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def base_canonical(self) -> dict:
        return {
            "$schema_version": "2.0",
            "last_updated": "2026-04-22",
            "methodology": "test canonical",
            "categories_reference": {},
            "countries": [
                {
                    "country": "Testland",
                    "alpha-2": "TL",
                    "alpha-3": "TST",
                    "region": "Test Region",
                    "subregion": "Test Subregion",
                    "general_emergency": [],
                    "notes": "",
                    "hotlines": [
                        {
                            "name": "Legacy Line",
                            "organization": "Legacy Line",
                            "category": "mental_health",
                            "voice_numbers": ["111"],
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
                            "sources": ["legacy-source"]
                        }
                    ]
                },
                {
                    "country": "Shieldland",
                    "alpha-2": "SL",
                    "alpha-3": "SHD",
                    "region": "Test Region",
                    "subregion": "Test Subregion",
                    "general_emergency": ["999"],
                    "notes": "",
                    "hotlines": [
                        {
                            "name": "Protected Line",
                            "organization": "Protected Line",
                            "category": "mental_health",
                            "voice_numbers": ["999"],
                            "sms_numbers": [],
                            "text_numbers": [],
                            "short_codes": [],
                            "chat_url": None,
                            "email": None,
                            "website": "https://shield.example",
                            "hours": None,
                            "languages": [],
                            "cost": "free",
                            "target": None,
                            "geography": "Shieldland",
                            "notes": "",
                            "verification_status": "verified_web",
                            "last_verified": "2026-04-22",
                            "sources": ["https://shield.example"]
                        }
                    ]
                }
            ]
        }

    def base_preview(self) -> dict:
        return {
            "$schema_version": "2.0",
            "last_updated": "2026-04-22",
            "methodology": "test preview; not the canonical dataset",
            "categories_reference": {},
            "_preview_metadata": {"dataset_role": "supplemental_preview"},
            "countries": [
                {
                    "country": "Testland",
                    "alpha-2": "TL",
                    "alpha-3": "TST",
                    "region": "Test Region",
                    "subregion": "Test Subregion",
                    "general_emergency": ["112"],
                    "notes": "preview notes",
                    "hotlines": [
                        {
                            "name": "Legacy Line",
                            "organization": "Legacy Line",
                            "category": "mental_health",
                            "voice_numbers": ["111", "222"],
                            "sms_numbers": [],
                            "text_numbers": [],
                            "short_codes": [],
                            "chat_url": None,
                            "email": None,
                            "website": "https://legacy.example",
                            "hours": "24/7",
                            "languages": ["English"],
                            "cost": "unknown",
                            "target": None,
                            "geography": "Testland",
                            "notes": "",
                            "verification_status": "legacy_unverified",
                            "last_verified": None,
                            "sources": ["preview-source"]
                        },
                        {
                            "name": "New Line",
                            "organization": "New Line",
                            "category": "mental_health",
                            "voice_numbers": ["333"],
                            "sms_numbers": [],
                            "text_numbers": [],
                            "short_codes": [],
                            "chat_url": None,
                            "email": None,
                            "website": "https://new.example",
                            "hours": None,
                            "languages": [],
                            "cost": "free",
                            "target": None,
                            "geography": "Testland",
                            "notes": "",
                            "verification_status": "legacy_unverified",
                            "last_verified": None,
                            "sources": ["preview-source"]
                        }
                    ]
                }
            ]
        }

    def run_command(self, args, cwd=ROOT):
        return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)

    def test_build_emits_additive_candidates_for_legacy_only_country(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            canonical_path = tmp / "canonical.json"
            preview_path = tmp / "preview.json"
            out_path = tmp / "candidates.json"
            report_path = tmp / "report.md"
            self.write_json(canonical_path, self.base_canonical())
            self.write_json(preview_path, self.base_preview())

            result = self.run_command(
                [
                    sys.executable,
                    str(BUILD_SCRIPT),
                    "--canonical",
                    str(canonical_path),
                    "--preview",
                    str(preview_path),
                    "--out",
                    str(out_path),
                    "--report",
                    str(report_path),
                ]
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            bundle = json.loads(out_path.read_text(encoding="utf-8"))
            candidate_types = [candidate["candidate_type"] for candidate in bundle["candidates"]]
            self.assertIn("merge_missing_fields", candidate_types)
            self.assertIn("append_new_hotline", candidate_types)
            merge_candidate = next(candidate for candidate in bundle["candidates"] if candidate["candidate_type"] == "merge_missing_fields")
            self.assertEqual(merge_candidate["country"], "Testland")
            self.assertEqual(merge_candidate["field_actions"]["voice_numbers"], "append_unique")
            self.assertEqual(merge_candidate["field_actions"]["website"], "fill_if_empty")
            self.assertIn("canonical_country_has_only_legacy_records", merge_candidate["safety_flags"])

    def test_apply_rejects_destructive_overwrite_attempt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            canonical_path = tmp / "canonical.json"
            candidates_path = tmp / "candidates.json"
            approvals_path = tmp / "approvals.json"
            report_path = tmp / "apply_report.md"
            self.write_json(canonical_path, self.base_canonical())
            self.write_json(
                candidates_path,
                {
                    "$schema_version": "2.0",
                    "generated_at": "2026-04-22T00:00:00Z",
                    "candidates": [
                        {
                            "candidate_id": "bad-replace",
                            "country": "Testland",
                            "alpha-2": "TL",
                            "candidate_type": "merge_missing_fields",
                            "canonical_match": {"country": "Testland", "hotline_name": "Legacy Line", "match_confidence": 1.0},
                            "proposed_hotline": {
                                "name": "Legacy Line",
                                "voice_numbers": ["777"],
                                "verification_status": "legacy_unverified"
                            },
                            "source_artifact": "preview.json",
                            "field_actions": {"voice_numbers": "replace"},
                            "safety_flags": ["canonical_country_has_only_legacy_records"],
                            "requires_human_review": True
                        }
                    ]
                },
            )
            self.write_json(approvals_path, {"decisions": [{"candidate_id": "bad-replace", "state": "approved"}]})
            before = canonical_path.read_text(encoding="utf-8")

            result = self.run_command(
                [
                    sys.executable,
                    str(APPLY_SCRIPT),
                    "--canonical",
                    str(canonical_path),
                    "--candidates",
                    str(candidates_path),
                    "--approvals",
                    str(approvals_path),
                    "--report",
                    str(report_path),
                    "--apply",
                ]
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Unsupported field action 'replace'", report_path.read_text(encoding="utf-8"))
            self.assertEqual(before, canonical_path.read_text(encoding="utf-8"))

    def test_apply_rejects_status_downgrade_attempt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            canonical_path = tmp / "canonical.json"
            candidates_path = tmp / "candidates.json"
            approvals_path = tmp / "approvals.json"
            report_path = tmp / "apply_report.md"
            canonical = self.base_canonical()
            self.write_json(canonical_path, canonical)
            self.write_json(
                candidates_path,
                {
                    "$schema_version": "2.0",
                    "generated_at": "2026-04-22T00:00:00Z",
                    "candidates": [
                        {
                            "candidate_id": "bad-downgrade",
                            "country": "Shieldland",
                            "alpha-2": "SL",
                            "candidate_type": "merge_missing_fields",
                            "canonical_match": {"country": "Shieldland", "hotline_name": "Protected Line", "match_confidence": 1.0},
                            "proposed_hotline": {
                                "name": "Protected Line",
                                "website": "https://shield.example/other",
                                "verification_status": "legacy_unverified"
                            },
                            "source_artifact": "preview.json",
                            "field_actions": {"website": "fill_if_empty"},
                            "safety_flags": ["canonical_country_has_protected_hotlines"],
                            "requires_human_review": True
                        }
                    ]
                },
            )
            self.write_json(approvals_path, {"decisions": [{"candidate_id": "bad-downgrade", "state": "approved"}]})

            result = self.run_command(
                [
                    sys.executable,
                    str(APPLY_SCRIPT),
                    "--canonical",
                    str(canonical_path),
                    "--candidates",
                    str(candidates_path),
                    "--approvals",
                    str(approvals_path),
                    "--report",
                    str(report_path),
                    "--apply",
                ]
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("would downgrade verification status", report_path.read_text(encoding="utf-8"))

    def test_apply_respects_dry_run_and_apply(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            canonical_path = tmp / "canonical.json"
            preview_path = tmp / "preview.json"
            candidates_path = tmp / "candidates.json"
            build_report_path = tmp / "build_report.md"
            approvals_path = tmp / "approvals.json"
            apply_report_path = tmp / "apply_report.md"
            self.write_json(canonical_path, self.base_canonical())
            self.write_json(preview_path, self.base_preview())

            build_result = self.run_command(
                [
                    sys.executable,
                    str(BUILD_SCRIPT),
                    "--canonical",
                    str(canonical_path),
                    "--preview",
                    str(preview_path),
                    "--out",
                    str(candidates_path),
                    "--report",
                    str(build_report_path),
                ]
            )
            self.assertEqual(build_result.returncode, 0, build_result.stderr)
            candidate_bundle = json.loads(candidates_path.read_text(encoding="utf-8"))
            approvals = {"decisions": [{"candidate_id": candidate["candidate_id"], "state": "approved"} for candidate in candidate_bundle["candidates"]]}
            self.write_json(approvals_path, approvals)
            before = canonical_path.read_text(encoding="utf-8")

            dry_run_result = self.run_command(
                [
                    sys.executable,
                    str(APPLY_SCRIPT),
                    "--canonical",
                    str(canonical_path),
                    "--candidates",
                    str(candidates_path),
                    "--approvals",
                    str(approvals_path),
                    "--report",
                    str(apply_report_path),
                ]
            )
            self.assertEqual(dry_run_result.returncode, 0, dry_run_result.stderr)
            self.assertIn("Dry run only", dry_run_result.stdout)
            self.assertEqual(before, canonical_path.read_text(encoding="utf-8"))

            apply_result = self.run_command(
                [
                    sys.executable,
                    str(APPLY_SCRIPT),
                    "--canonical",
                    str(canonical_path),
                    "--candidates",
                    str(candidates_path),
                    "--approvals",
                    str(approvals_path),
                    "--report",
                    str(apply_report_path),
                    "--apply",
                ]
            )
            self.assertEqual(apply_result.returncode, 0, apply_result.stderr)
            updated = json.loads(canonical_path.read_text(encoding="utf-8"))
            testland = next(country for country in updated["countries"] if country["country"] == "Testland")
            merged_hotline = next(h for h in testland["hotlines"] if h["name"] == "Legacy Line")
            self.assertIn("222", merged_hotline["voice_numbers"])
            self.assertEqual(merged_hotline["website"], "https://legacy.example")
            self.assertTrue(any(h["name"] == "New Line" for h in testland["hotlines"]))
            self.assertIn("112", testland["general_emergency"])


if __name__ == "__main__":
    unittest.main()
