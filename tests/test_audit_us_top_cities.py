import unittest

from scripts.audit_us_top_cities import city_match, county_match, place_name


class AuditUsTopCitiesTests(unittest.TestCase):
    def test_place_name_removes_census_legal_suffix(self):
        self.assertEqual(place_name("New York city"), "New York")
        self.assertEqual(place_name("Anchorage municipality"), "Anchorage")

    def test_city_match_requires_state_and_rejects_statewide_label(self):
        self.assertTrue(city_match("New York City, New York", "New York", "New York"))
        self.assertFalse(city_match("New York", "New York", "New York"))
        self.assertFalse(city_match("York County, Pennsylvania", "New York", "New York"))

    def test_county_match_requires_county_type_suffix(self):
        self.assertTrue(county_match("Oklahoma County, Oklahoma", "Oklahoma", "Oklahoma"))
        self.assertFalse(county_match("Tulsa County, Oklahoma", "Oklahoma", "Oklahoma"))
        self.assertTrue(county_match("Orleans Parish, Louisiana", "Orleans", "Louisiana"))


if __name__ == "__main__":
    unittest.main()
