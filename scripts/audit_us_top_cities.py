#!/usr/bin/env python3
"""Build a read-only, county-aware coverage audit for large U.S. places."""

import argparse
import csv
import hashlib
import json
import re
from pathlib import Path


def place_name(raw: str) -> str:
    suffix = re.compile(
        r"\s+(city and borough|municipality|metropolitan government|"
        r"consolidated government|urban county|city|town|village|borough)$",
        re.IGNORECASE,
    )
    return suffix.sub("", raw).strip()


def hotline_summary(hotline: dict) -> dict:
    return {
        "name": hotline["name"],
        "category": hotline["category"],
        "geography": hotline.get("geography"),
        "verification_status": hotline["verification_status"],
        "sources": hotline.get("sources") or [],
    }


def city_match(geography: str, city: str, state: str) -> bool:
    if not geography or geography.strip().casefold() == state.casefold():
        return False
    pattern = re.compile(r"(?<![A-Za-z])" + re.escape(city) + r"(?![A-Za-z])", re.I)
    return bool(pattern.search(geography) and state.casefold() in geography.casefold())


def county_match(geography: str, county: str, state: str) -> bool:
    if not geography or geography.strip().casefold() == state.casefold():
        return False
    pattern = re.compile(
        r"(?<![A-Za-z])" + re.escape(county) +
        r"\s+(?:County|Parish|Borough|Census Area|Municipality)(?![A-Za-z])",
        re.I,
    )
    return bool(pattern.search(geography) and state.casefold() in geography.casefold())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--census-csv", type=Path, required=True)
    parser.add_argument("--place-counties", type=Path, required=True)
    parser.add_argument("--canonical", type=Path, default=Path("hotlines.json"))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--as-of", required=True)
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    rows = []
    with args.census_csv.open(encoding="latin-1", newline="") as handle:
        for row in csv.DictReader(handle):
            if row["SUMLEV"] != "162" or row["FUNCSTAT"] not in {"A", "B"}:
                continue
            population = int(row["POPESTIMATE2025"])
            if population > 0:
                rows.append({**row, "population": population})
    rows.sort(key=lambda row: (-row["population"], row["NAME"], row["STNAME"]))
    rows = rows[: args.limit]

    canonical = json.loads(args.canonical.read_text(encoding="utf-8"))
    county_map = json.loads(args.place_counties.read_text(encoding="utf-8"))
    usa = next(country for country in canonical["countries"] if country["country"] == "United States")
    cities = []
    for rank, row in enumerate(rows, 1):
        city = place_name(row["NAME"])
        state = row["STNAME"]
        key = row["STATE"] + row["PLACE"]
        counties = county_map["places"].get(key, [])
        direct = []
        city_or_county = []
        for hotline in usa["hotlines"]:
            geography = hotline.get("geography") or ""
            if city_match(geography, city, state):
                direct.append(hotline_summary(hotline))
            if city_match(geography, city, state) or any(
                county_match(geography, county["name"], state) for county in counties
            ):
                city_or_county.append(hotline_summary(hotline))
        cities.append(
            {
                "rank": rank,
                "city": city,
                "state": state,
                "population_estimate_2025": row["population"],
                "census_state_fips": row["STATE"],
                "census_place_fips": row["PLACE"],
                "counties": counties,
                "existing_local_records": direct,
                "existing_city_or_county_records": city_or_county,
            }
        )

    direct_covered = sum(bool(city["existing_local_records"]) for city in cities)
    county_covered = sum(bool(city["existing_city_or_county_records"]) for city in cities)
    result = {
        "as_of": args.as_of,
        "ranking_source": {
            "publisher": "U.S. Census Bureau",
            "dataset": "Annual Estimates of the Resident Population for Incorporated Places: April 1, 2020 to July 1, 2025",
            "url": "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/cities/totals/sub-est2025.csv",
            "download_sha256": hashlib.sha256(args.census_csv.read_bytes()).hexdigest(),
            "selection": "SUMLEV=162 incorporated places; FUNCSTAT A/B; descending POPESTIMATE2025",
        },
        "county_mapping_source": county_map["source"],
        "summary": {
            "cities": len(cities),
            "cities_with_direct_canonical_locality_match": direct_covered,
            "cities_without_direct_canonical_locality_match": len(cities) - direct_covered,
            "cities_with_city_or_county_canonical_match": county_covered,
            "cities_without_city_or_county_canonical_match": len(cities) - county_covered,
        },
        "cities": cities,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(result["summary"], sort_keys=True))


if __name__ == "__main__":
    main()
