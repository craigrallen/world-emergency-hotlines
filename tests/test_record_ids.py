import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts.backfill_record_ids import assign_missing_ids, inject_ids_without_reformatting
from scripts.check_record_id_stability import compare
from scripts.lib.record_ids import RECORD_ID_RE


class RecordIdTests(unittest.TestCase):
    def dataset(self):
        return {
            "countries": [
                {
                    "country": "Testland",
                    "alpha-2": "TL",
                    "hotlines": [
                        {"name": "One", "category": "mental_health", "geography": "Testland"},
                        {"name": "Two", "category": "emergency", "geography": "Testland"},
                    ],
                }
            ]
        }

    def test_backfill_is_reproducible_and_preserves_assigned_ids(self):
        first = self.dataset()
        second = self.dataset()
        assigned, preserved = assign_missing_ids(first)
        self.assertEqual((assigned, preserved), (2, 0))
        assign_missing_ids(second)
        ids = [h["id"] for h in first["countries"][0]["hotlines"]]
        self.assertEqual(ids, [h["id"] for h in second["countries"][0]["hotlines"]])
        self.assertEqual(len(set(ids)), 2)
        self.assertTrue(all(RECORD_ID_RE.fullmatch(value) for value in ids))
        assigned, preserved = assign_missing_ids(first)
        self.assertEqual((assigned, preserved), (0, 2))

    def test_stability_guard_allows_content_corrections(self):
        baseline = self.dataset()
        assign_missing_ids(baseline)
        current = copy.deepcopy(baseline)
        current["countries"][0]["hotlines"][0]["name"] = "Renamed service"
        current["countries"][0]["hotlines"][0]["voice_numbers"] = ["123"]
        self.assertEqual(compare(baseline, current), [])

    def test_stability_guard_rejects_removal(self):
        baseline = self.dataset()
        assign_missing_ids(baseline)
        current = copy.deepcopy(baseline)
        removed = current["countries"][0]["hotlines"].pop()["id"]
        self.assertEqual(compare(baseline, current), [f"existing record ID removed: {removed}"])

    def test_stability_guard_rejects_swapped_ids(self):
        baseline = self.dataset()
        assign_missing_ids(baseline)
        current = copy.deepcopy(baseline)
        first, second = current["countries"][0]["hotlines"]
        first["id"], second["id"] = second["id"], first["id"]
        errors = compare(baseline, current)
        self.assertEqual(len(errors), 2)
        self.assertTrue(all("moved or reassigned" in error for error in errors))

    def test_text_injection_preserves_every_non_id_line(self):
        raw = '''{
  "countries": [
    {
      "country": "Testland",
      "alpha-2": "TL",
      "hotlines": [
        {
          "name": "One",
          "notes": "preserve  spacing and unicode: å",
          "category": "mental_health"
        }
      ]
    }
  ]
}
'''
        data = json.loads(raw)
        assign_missing_ids(data)
        updated = inject_ids_without_reformatting(raw, data)
        id_lines = [line for line in updated.splitlines() if line.strip().startswith('"id":')]
        self.assertEqual(len(id_lines), 1)
        self.assertEqual(updated.replace(id_lines[0] + "\n", ""), raw)


if __name__ == "__main__":
    unittest.main()
