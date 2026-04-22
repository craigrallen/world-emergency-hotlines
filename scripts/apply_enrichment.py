#!/usr/bin/env python3
"""
Apply enrichment files from `scripts/enrichment/*.json` into `hotlines.json`.

Each enrichment file is a list of objects shaped like:

    {
      "country": "Finland",
      "alpha-2": "FI",
      "alpha-3": "FIN",
      "region": "Europe",
      "subregion": "Northern Europe",
      "general_emergency": ["112"],
      "notes": "...",
      "hotlines": [
        { "name": "...", "category": "...", "voice_numbers": [...], ... },
        ...
      ]
    }

For each country in the enrichment file:
  - Merge with the existing entry in hotlines.json (matched by alpha-2).
  - Replace any matching hotline (by normalised name) with the enriched version.
  - Add any new hotline not already present.
  - Preserve any unmatched legacy_unverified hotlines — enrichment is additive.

Defaults are filled in for any missing fields so the output conforms to the
v2.0 schema documented in SCHEMA.md.

By default this command performs a dry run. Pass `--apply` to write the
canonical dataset.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import unicodedata
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.safety import canonical_write_requested

OUT = ROOT / "hotlines.json"
ENRICH_DIR = ROOT / "scripts" / "enrichment"

DEFAULTS = {
    "organization": None,
    "category": "general_support",
    "voice_numbers": [],
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
    "geography": None,
    "notes": "",
    "verification_status": "verified_knowledge",
    "last_verified": datetime.utcnow().date().isoformat(),
    "sources": [],
}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def apply_hotline_defaults(h: dict, country_name: str) -> dict:
    out = {}
    for k, v in DEFAULTS.items():
        out[k] = h.get(k, v)
    out["name"] = h["name"]
    if not out["organization"]:
        out["organization"] = h["name"]
    if not out["geography"]:
        out["geography"] = country_name
    return out


def apply_country(existing: dict, enrich: dict) -> dict:
    # Meta fields: only overwrite if provided in enrichment
    for key in ("region", "subregion", "general_emergency", "notes", "alpha-3"):
        if enrich.get(key) not in (None, "", []):
            existing[key] = enrich[key]
    if not existing.get("alpha-2"):
        existing["alpha-2"] = enrich.get("alpha-2")

    # Build an index of existing hotlines by normalised name
    by_name: dict[str, dict] = {norm(h["name"]): h for h in existing["hotlines"]}

    for h in enrich.get("hotlines", []):
        h_full = apply_hotline_defaults(h, existing["country"])
        key = norm(h_full["name"])
        if key in by_name:
            # Replace with enriched version, but preserve `_legacy` block if useful
            legacy = by_name[key].get("_legacy")
            by_name[key].clear()
            by_name[key].update(h_full)
            if legacy:
                by_name[key]["_legacy"] = legacy
        else:
            existing["hotlines"].append(h_full)
            by_name[key] = existing["hotlines"][-1]
    return existing


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge scripts/enrichment/*.json into hotlines.json. Dry run by default; pass --apply to write."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write the merged canonical dataset back to hotlines.json.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    data = json.loads(OUT.read_text(encoding="utf-8"))
    by_alpha2 = {c.get("alpha-2"): c for c in data["countries"] if c.get("alpha-2")}
    by_name = {c["country"]: c for c in data["countries"]}

    files = sorted(ENRICH_DIR.glob("*.json"))
    if not files:
        print("No enrichment files found.", file=sys.stderr)
        return 1

    total_countries = 0
    total_hotlines = 0
    for f in files:
        countries = json.loads(f.read_text(encoding="utf-8"))
        print(f"--- {f.name}: {len(countries)} countries ---")
        for enrich in countries:
            a2 = enrich.get("alpha-2")
            existing = by_alpha2.get(a2) or by_name.get(enrich["country"])
            if existing is None:
                new_country = {
                    "country": enrich["country"],
                    "alpha-2": a2,
                    "alpha-3": enrich.get("alpha-3"),
                    "region": enrich.get("region"),
                    "subregion": enrich.get("subregion"),
                    "general_emergency": enrich.get("general_emergency", []),
                    "notes": enrich.get("notes", ""),
                    "hotlines": [],
                }
                data["countries"].append(new_country)
                by_alpha2[a2] = new_country
                by_name[enrich["country"]] = new_country
                existing = new_country
                print(f"  + new country: {enrich['country']}")
            apply_country(existing, enrich)
            total_countries += 1
            total_hotlines += len(enrich.get("hotlines", []))

    data["countries"].sort(key=lambda c: c["country"])
    data["last_updated"] = datetime.utcnow().date().isoformat()

    effective_argv = argv if argv is not None else sys.argv[1:]
    if not canonical_write_requested(effective_argv):
        print("\nDry run only: canonical dataset was not modified. Re-run with --apply to write hotlines.json.")
        print(f"Would apply {total_countries} country-blocks, {total_hotlines} enriched hotlines.")
        print(
            f"Resulting dataset would have {len(data['countries'])} countries, "
            f"{sum(len(c['hotlines']) for c in data['countries'])} hotlines."
        )
        return 0

    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nApplied {total_countries} country-blocks, {total_hotlines} enriched hotlines.")
    print(
        f"hotlines.json now has {len(data['countries'])} countries, "
        f"{sum(len(c['hotlines']) for c in data['countries'])} hotlines."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
