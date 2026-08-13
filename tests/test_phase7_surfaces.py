import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Phase7SurfaceTests(unittest.TestCase):
    def test_emergency_link_uses_canonical_public_origin(self):
        config = (ROOT / ".github/ISSUE_TEMPLATE/config.yml").read_text()
        self.assertIn("https://worldhotlines.org/", config)
        self.assertNotIn("world-emergency-hotlines-production.up.railway.app", config)
        self.assertNotIn("hotlines.world", config)
        self.assertNotIn("world-emergency-hotlines.org", config)

    def test_issue_forms_have_no_unverified_label_and_supported_prefill_only(self):
        for name in ("hotline-correction.yml", "provider-submission.yml"):
            self.assertNotIn("data-review", (ROOT / ".github/ISSUE_TEMPLATE" / name).read_text())
        issue_js = (ROOT / "web/src/lib/issues.js").read_text()
        self.assertNotIn("record_id:", issue_js)
        self.assertNotIn("country_service:", issue_js)
        self.assertIn("body: context", issue_js)

    def test_workflow_is_read_only_default_branch_prior_artifact_flow(self):
        workflow = (ROOT / ".github/workflows/verification-operations.yml").read_text()
        for text in ("schedule:", "workflow_dispatch:", "actions: read", "status=success", "default_branch", "source-snapshot.json", "--previous", "available=false", "GITHUB_STEP_SUMMARY"):
            self.assertIn(text, workflow)
        for forbidden in ("pull_request:", "issues: write", "pull-requests: write", "gh issue create", "gh pr create"):
            self.assertNotIn(forbidden, workflow)

    def test_legacy_web_verify_flags_fail_without_canonical_mutation(self):
        canonical = ROOT / "hotlines.json"
        before = canonical.read_bytes()
        result = subprocess.run(["python", "scripts/web_verify.py", "--force"], cwd=ROOT, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MIGRATION REQUIRED", result.stderr)
        self.assertIn("scripts/source_monitor.py", result.stderr)
        self.assertEqual(before, canonical.read_bytes())


if __name__ == "__main__": unittest.main()
