import unittest

from scripts.lib.provenance import merge_provenance, normalize_provenance, provenance_issues


class ProvenanceNormalizationTests(unittest.TestCase):
    def test_normalize_imported_aggregator_record(self):
        hotline = {
            "name": "Directory Line",
            "voice_numbers": ["123", "123"],
            "website": "https://example.org/help",
            "verification_status": "legacy_unverified",
            "last_verified": None,
            "sources": ["https://example.org/help"],
            "_import_metadata": {
                "source_dataset": "web_verified_crisis_directory",
                "source_verification_status": "warning",
            },
        }

        provenance = normalize_provenance(hotline)
        self.assertEqual(provenance["record_status"], "legacy_unverified")
        self.assertEqual(provenance["source_class"], "aggregator_directory")
        self.assertEqual(provenance["verification_method"], "scripted_import")
        self.assertEqual(provenance["review_state"], "staged")
        self.assertEqual(provenance["source_dataset"], "web_verified_crisis_directory")
        self.assertEqual(provenance["source_status"], "warning")
        self.assertTrue(any(item["field"] == "voice_numbers" for item in provenance["evidence"]))
        self.assertTrue(any(item.get("source_type") == "aggregator_directory" for item in provenance["evidence"]))

    def test_normalize_existing_provenance_cleans_values(self):
        hotline = {
            "name": "Manual Line",
            "verification_status": "verified_web",
            "sources": ["https://provider.example/help"],
            "provenance": {
                "record_status": "verified web",
                "source_class": "First-Party",
                "verification_method": "manual web review",
                "retrieved_at": "2026-04-22T12:07:32+00:00",
                "review_state": "reviewed",
                "evidence": [
                    {
                        "field": "voice_numbers",
                        "value": ["555"],
                        "source_url": "https://provider.example/help",
                        "source_type": "First-Party",
                        "checked_at": "2026-04-22",
                        "confidence": "HIGH",
                    }
                ],
            },
        }

        normalized = normalize_provenance(hotline)
        self.assertEqual(normalized["record_status"], "verified_web")
        self.assertEqual(normalized["source_class"], "first_party")
        self.assertEqual(normalized["verification_method"], "manual_web_review")
        self.assertEqual(normalized["retrieved_at"], "2026-04-22T12:07:32Z")
        self.assertEqual(normalized["evidence"][0]["source_type"], "first_party")
        self.assertEqual(normalized["evidence"][0]["confidence"], "high")

    def test_merge_provenance_is_additive_and_non_destructive(self):
        existing = {
            "record_status": "verified_web",
            "source_class": "first_party",
            "verification_method": "manual_web_review",
            "review_state": "reviewed",
            "evidence": [
                {
                    "field": "voice_numbers",
                    "value": ["555"],
                    "source_url": "https://provider.example/help",
                    "source_type": "first_party",
                    "checked_at": "2026-04-22",
                    "confidence": "high",
                }
            ],
        }
        proposed = {
            "record_status": "legacy_unverified",
            "source_class": "aggregator_directory",
            "verification_method": "scripted_import",
            "review_state": "staged",
            "source_dataset": "preview_bundle",
            "evidence": [
                {
                    "field": "website",
                    "value": "https://provider.example/help",
                    "source_url": "https://directory.example/help",
                    "source_type": "aggregator_directory",
                    "confidence": "medium",
                }
            ],
        }

        merged = merge_provenance(existing, proposed)
        self.assertEqual(merged["record_status"], "verified_web")
        self.assertEqual(merged["source_class"], "first_party")
        self.assertEqual(merged["review_state"], "reviewed")
        self.assertEqual(merged["source_dataset"], "preview_bundle")
        self.assertEqual(len(merged["evidence"]), 2)

    def test_provenance_issues_reports_inconsistent_status(self):
        hotline = {
            "name": "Bad Line",
            "verification_status": "legacy_unverified",
            "provenance": {
                "record_status": "verified_web",
                "source_class": "bogus",
                "retrieved_at": "not-a-timestamp",
            },
        }
        issues = provenance_issues(hotline)
        self.assertTrue(any("does not match verification_status" in issue for issue in issues))
        self.assertTrue(any("invalid provenance.source_class" in issue for issue in issues))
        self.assertTrue(any("invalid provenance.retrieved_at timestamp" in issue for issue in issues))


if __name__ == "__main__":
    unittest.main()
