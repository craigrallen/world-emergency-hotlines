import unittest

from scripts.lib.gap_report import build_gap_report


class GapReportTests(unittest.TestCase):
    def canonical_fixture(self) -> dict:
        return {
            "$schema_version": "2.0",
            "last_updated": "2026-04-22",
            "methodology": "test canonical",
            "categories_reference": {},
            "countries": [
                {
                    "country": "Legacyland",
                    "alpha-2": "LL",
                    "alpha-3": "LLL",
                    "region": "Test Region",
                    "subregion": "Test Subregion",
                    "general_emergency": [],
                    "notes": "",
                    "hotlines": [
                        {
                            "name": "Legacy Line",
                            "organization": "Legacy Line",
                            "category": "general_support",
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
                            "geography": "Legacyland",
                            "notes": "",
                            "verification_status": "legacy_unverified",
                            "last_verified": None,
                            "sources": ["information.json"],
                        }
                    ],
                },
                {
                    "country": "Verifiedstan",
                    "alpha-2": "VS",
                    "alpha-3": "VST",
                    "region": "Test Region",
                    "subregion": "Test Subregion",
                    "general_emergency": ["112"],
                    "notes": "",
                    "hotlines": [
                        {
                            "name": "Suicide Line",
                            "organization": "Suicide Line",
                            "category": "suicide_crisis",
                            "voice_numbers": ["222"],
                            "sms_numbers": [],
                            "text_numbers": [],
                            "short_codes": [],
                            "chat_url": None,
                            "email": None,
                            "website": "https://verified.example",
                            "hours": "24/7",
                            "languages": ["English"],
                            "cost": "free",
                            "target": None,
                            "geography": "Verifiedstan",
                            "notes": "",
                            "verification_status": "verified_web",
                            "last_verified": "2026-04-22",
                            "sources": ["https://verified.example"],
                            "provenance": {
                                "record_status": "verified_web",
                                "source_class": "first_party",
                                "verification_method": "manual_web_review",
                                "review_state": "reviewed",
                                "evidence": [
                                    {
                                        "field": "voice_numbers",
                                        "value": ["222"],
                                        "source_url": "https://verified.example",
                                        "source_type": "first_party",
                                        "checked_at": "2026-04-22",
                                        "confidence": "high",
                                    }
                                ],
                            },
                        },
                        {
                            "name": "Family Safety",
                            "organization": "Family Safety",
                            "category": "domestic_violence",
                            "voice_numbers": ["333"],
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
                            "geography": "Verifiedstan",
                            "notes": "",
                            "verification_status": "cross_referenced",
                            "last_verified": "2026-04-22",
                            "sources": ["https://directory.example/family"],
                        },
                    ],
                },
            ],
        }

    def preview_fixture(self) -> dict:
        return {
            "$schema_version": "2.0",
            "last_updated": "2026-04-22",
            "methodology": "preview; not the canonical dataset",
            "categories_reference": {},
            "_preview_metadata": {"dataset_role": "supplemental_preview", "generated_from": "test_preview"},
            "countries": [
                {
                    "country": "Legacyland",
                    "alpha-2": "LL",
                    "alpha-3": "LLL",
                    "region": "Test Region",
                    "subregion": "Test Subregion",
                    "general_emergency": ["999"],
                    "notes": "",
                    "hotlines": [
                        {
                            "name": "Preview Crisis",
                            "organization": "Preview Crisis",
                            "category": "suicide_crisis",
                            "voice_numbers": ["444"],
                            "sms_numbers": [],
                            "text_numbers": [],
                            "short_codes": [],
                            "chat_url": None,
                            "email": None,
                            "website": "https://preview.example",
                            "hours": None,
                            "languages": [],
                            "cost": "unknown",
                            "target": None,
                            "geography": "Legacyland",
                            "notes": "",
                            "verification_status": "legacy_unverified",
                            "last_verified": None,
                            "sources": ["preview-source"],
                        }
                    ],
                }
            ],
        }

    def test_gap_report_flags_legacy_only_country_and_preview_signal(self):
        report = build_gap_report(self.canonical_fixture(), preview_datasets=[self.preview_fixture()], queue_limit=10)
        legacyland = next(country for country in report["countries"] if country["country"] == "Legacyland")
        self.assertTrue(legacyland["only_legacy_records"])
        self.assertTrue(legacyland["no_non_legacy_records"])
        self.assertTrue(legacyland["no_protected_records"])
        self.assertTrue(legacyland["no_first_party_sources"])
        self.assertTrue(legacyland["missing_general_emergency"])
        self.assertEqual(legacyland["reviewable_preview_hotline_count"], 1)
        self.assertIn("suicide_crisis", legacyland["missing_key_categories"])
        self.assertEqual(legacyland["research_gap_interpretation"], "likely_research_gap")
        self.assertGreater(legacyland["priority_score"], 0)

    def test_priority_queues_are_deterministic_and_put_worst_gap_first(self):
        report = build_gap_report(self.canonical_fixture(), preview_datasets=[self.preview_fixture()], queue_limit=10)
        enrich = report["queues"]["top_enrichment_targets"]
        verify = report["queues"]["top_web_verification_targets"]
        review = report["queues"]["top_preview_review_targets"]
        self.assertEqual(enrich[0]["country"], "Legacyland")
        self.assertEqual(verify[0]["country"], "Legacyland")
        self.assertEqual(review[0]["country"], "Legacyland")
        self.assertEqual(review[0]["reviewable_preview_hotline_count"], 1)
        self.assertTrue(any(reason["reason"] == "Supplemental preview hotlines waiting for review" for reason in review[0]["reasons"]))

    def test_category_gap_report_counts_missing_categories(self):
        report = build_gap_report(self.canonical_fixture(), preview_datasets=[], queue_limit=10)
        self.assertIn("Legacyland", report["category_gap_reports"]["child_protection"])
        self.assertNotIn("Verifiedstan", report["category_gap_reports"]["domestic_violence"])
        self.assertEqual(report["summary"]["countries_with_no_first_party_sources"], 1)


if __name__ == "__main__":
    unittest.main()
