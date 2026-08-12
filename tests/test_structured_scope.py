import unittest

from scripts.validate_canonical import Report, validate_hotline


def record():
    return {
        "id": "weh_1234567890abcdef12345678", "name": "Test line", "category": "mental_health",
        "geography": "Testland", "voice_numbers": ["123"], "sms_numbers": [], "text_numbers": [],
        "short_codes": [], "languages": [], "sources": [], "verification_status": "verified_web",
        "last_verified": "2026-08-01",
    }


def evidence(sections):
    return {"evidence": [{
        "field": f"service_scope.{section}", "source_url": "https://provider.example/scope",
        "source_type": "first_party", "checked_at": "2026-08-13", "confidence": "high",
        "note": "Provider-published structured scope",
    } for section in sections]}


class StructuredScopeValidationTests(unittest.TestCase):
    def validate(self, value):
        report = Report(); validate_hotline(value, "Testland", 0, report); return report

    def test_legacy_record_without_structured_scope_remains_valid(self):
        self.assertEqual(self.validate(record()).errors, [])

    def test_each_structured_section_requires_field_evidence(self):
        value = record(); value["service_scope"] = {"geography": {"level": "country", "areas": ["Testland"]}}
        self.assertTrue(any("requires matching provenance evidence" in error for error in self.validate(value).errors))

    def test_valid_full_structured_scope(self):
        value = record(); value["service_scope"] = {
            "geography": {"level": "county", "areas": ["Example County"]},
            "eligibility": {"description": "Residents aged 12 to 24", "minimum_age": 12, "maximum_age": 24, "populations": ["residents"]},
            "availability": {"always_open": False, "timezone": "Europe/Stockholm", "schedule": [{"days": ["monday", "tuesday"], "opens": "09:00", "closes": "17:00"}]},
            "languages": [{"code": "en", "name": "English", "channels": ["phone", "chat"]}],
        }; value["provenance"] = evidence(value["service_scope"])
        self.assertEqual(self.validate(value).errors, [])

    def test_invalid_claim_shapes_are_rejected(self):
        value = record(); value["service_scope"] = {
            "geography": {"level": "planet", "areas": []}, "eligibility": {"minimum_age": 40, "maximum_age": 20},
            "availability": {"always_open": True, "schedule": [{"days": ["funday"], "opens": "9", "closes": "25:00"}]},
            "languages": [{"code": "english", "name": "English", "channels": ["fax"]}],
        }; value["provenance"] = evidence(value["service_scope"])
        errors = "\n".join(self.validate(value).errors)
        for expected in ["invalid service_scope.geography.level", "areas", "minimum_age", "always-open", "invalid weekdays", "opens/closes", ".code is invalid", "invalid channels"]: self.assertIn(expected, errors)

    def test_empty_or_unknown_scope_is_rejected(self):
        value = record(); value["service_scope"] = {}; self.assertTrue(self.validate(value).errors)
        value = record(); value["service_scope"] = {"unknown": {}}; self.assertTrue(any("unknown section" in e for e in self.validate(value).errors))

    def test_structured_evidence_must_be_auditable_and_authoritative(self):
        value = record(); value["service_scope"] = {"geography": {"level": "country", "areas": ["Testland"]}}
        value["provenance"] = {"evidence": [{"field": "service_scope.geography", "source_url": "notes.txt", "source_type": "aggregator_directory", "checked_at": "yesterday", "confidence": "low"}]}
        errors = "\n".join(self.validate(value).errors)
        for expected in ["HTTP(S) source_url", "first_party/government/authority", "ISO checked_at", "medium or high", "claim-binding value or note"]: self.assertIn(expected, errors)

    def test_bogus_url_calendar_date_and_empty_claim_are_rejected(self):
        value = record(); value["service_scope"] = {"geography": {"level": "country", "areas": ["Testland"]}}
        value["provenance"] = {"evidence": [{
            "field": "service_scope.geography", "source_url": "https:///missing-host",
            "source_type": "authority", "checked_at": "2026-02-30", "confidence": "medium",
            "value": [], "note": "   ",
        }]}
        errors = "\n".join(self.validate(value).errors)
        for expected in ["with a hostname", "real ISO", "claim-binding"]: self.assertIn(expected, errors)

    def test_unknown_keys_are_rejected_at_every_nested_level(self):
        value = record(); value["service_scope"] = {
            "geography": {"level": "country", "areas": ["Testland"], "radius": 5},
            "eligibility": {"description": "Anyone", "secret": True},
            "availability": {"always_open": False, "timezone": "UTC", "schedule": [{"days": ["monday"], "opens": "09:00", "closes": "17:00", "label": "day"}], "holiday": None},
            "languages": [{"name": "English", "channels": ["phone"], "dialect": "any"}],
        }; value["provenance"] = evidence(value["service_scope"])
        value["provenance"]["evidence"][0]["extra"] = "no"
        errors = "\n".join(self.validate(value).errors)
        for expected in ["radius", "secret", "holiday", "label", "dialect", "extra"]: self.assertIn(expected, errors)

    def test_fake_timezone_is_rejected_by_zoneinfo(self):
        value = record(); value["service_scope"] = {"availability": {"always_open": True, "timezone": "Mars/Olympus_Mons", "schedule": []}}
        value["provenance"] = evidence(value["service_scope"])
        self.assertTrue(any("available IANA zone" in error for error in self.validate(value).errors))

    def test_nested_unknown_keys_fake_timezone_and_unknown_claim_keys_are_rejected(self):
        value = record(); value["service_scope"] = {
            "availability": {"always_open": False, "timezone": "Mars/Olympus", "schedule": [{"days": ["monday"], "opens": "09:00", "closes": "17:00", "label": "office"}]},
            "languages": [{"name": "English", "channels": ["phone"], "dialect": "all"}],
        }; value["provenance"] = evidence(value["service_scope"])
        value["provenance"]["evidence"][0]["unsupported_claim"] = True
        errors = "\n".join(self.validate(value).errors)
        for expected in ["unknown key", "available IANA zone", "label", "dialect", "unsupported_claim"]: self.assertIn(expected, errors)

    def test_evidence_rejects_malformed_url_impossible_date_and_absent_claim_content(self):
        value = record(); value["service_scope"] = {"geography": {"level": "country", "areas": ["Testland"]}}
        value["provenance"] = {"evidence": [{"field": "service_scope.geography", "source_url": "https:///missing-host", "source_type": "authority", "checked_at": "2026-02-30", "confidence": "medium"}]}
        errors = "\n".join(self.validate(value).errors)
        for expected in ["hostname", "real ISO", "value or note"]: self.assertIn(expected, errors)

    def test_evidence_hostname_validation_accepts_safe_host_forms(self):
        for url in ("https://example.com/path", "http://localhost:8080/scope", "https://127.0.0.1/a", "https://[2001:db8::1]/a", "https://münich.example/a"):
            with self.subTest(url=url):
                value = record(); value["service_scope"] = {"geography": {"level": "country", "areas": ["Testland"]}}
                value["provenance"] = evidence(value["service_scope"]); value["provenance"]["evidence"][0]["source_url"] = url
                self.assertEqual(self.validate(value).errors, [])

    def test_evidence_hostname_validation_rejects_malformed_hosts_and_ports(self):
        bad_urls = ("https://.", "https://bad host/path", "https://example.com:bad/path", "https://example.com:70000/path", "https://.example.com", "https://example.com.", "https://bad_label.example", "https://-bad.example", "https://256.1.1.1", "https://xn--a.com/", "https://exam\u200dple.com/")
        for url in bad_urls:
            with self.subTest(url=url):
                value = record(); value["service_scope"] = {"geography": {"level": "country", "areas": ["Testland"]}}
                value["provenance"] = evidence(value["service_scope"]); value["provenance"]["evidence"][0]["source_url"] = url
                self.assertTrue(any("hostname" in error for error in self.validate(value).errors))


if __name__ == "__main__": unittest.main()
