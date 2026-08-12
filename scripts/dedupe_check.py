#!/usr/bin/env python3
"""
Read-only duplicate detector for the canonical hotlines dataset.

Scans every country in a hotlines dataset and flags likely duplicates within
the same country based on:

  - Identical normalised name (ascii-fold + alphanum)
  - Identical phone-number set (last 7 digits of any number matches another)
  - Identical website host
  - Very high name similarity (SequenceMatcher ratio >= 0.92) AND shared
    category / shared phone / shared host

This script never merges, mutates, or writes the input dataset. It only
detects candidate duplicate groups and reports them: by default a summary is
printed to stdout; with --report, a markdown findings report is additionally
written to disk (still read-only with respect to the input). Automatic
merging of these groups is not implemented here, since the same detection
heuristics that find duplicates within one category also match a large
fraction of unrelated records across different categories (e.g. a national
government hotline shared by several distinct services) — merging on this
signal alone would destroy legitimate distinct records. Any future merge
tooling needs a separate, more conservative review process.

Unlike validate_canonical.py's exact-contact classification (an identical,
complete normalized set of every contact field), this detector groups
heuristically and transitively (union-find over normalized-name, phone-key,
and website-host matches, plus a name-similarity fallback). A single
reported group can therefore chain records together through *different*
pairwise signals and does not guarantee every member shares contact, or any
other single attribute, with every other member.

Per docs/service-record-contract.md, each reported group is classified into
one of three mutually exclusive labels by category composition:
same_category_duplicate_candidate (exactly one represented category — the
strongest candidate signal), cross_category_shared_contact_candidate (more
than one represented category, each occurring exactly once), or
mixed_scope_and_duplicate_candidate (more than one represented category,
with at least one occurring more than once — a same-category duplicate
candidate can be hiding inside an otherwise mixed group, and must be
surfaced rather than folded into the cross-category label). None of these
labels changes detection behavior or asserts a confirmed duplicate or
confirmed distinctness; they are candidate labels for manual review only.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "hotlines.json"

# Three mutually exclusive group-level classifications for a candidate
# group, keyed by category composition (see classify_group()). Order here
# also fixes the order of the reported breakdown.
GROUP_CLASSIFICATION_LABELS = {
    "same_category_duplicate_candidate": "same-category duplicate candidate(s)",
    "cross_category_shared_contact_candidate": "cross-category shared-contact candidate(s)",
    "mixed_scope_and_duplicate_candidate": "mixed scope-and-duplicate candidate(s)",
}

# Per-group inline note used in the findings report body.
GROUP_CLASSIFICATION_NOTES = {
    "same_category_duplicate_candidate": "same-category duplicate candidate",
    "cross_category_shared_contact_candidate": "cross-category shared-contact candidate — requires review",
    "mixed_scope_and_duplicate_candidate": "mixed scope-and-duplicate candidate — requires review",
}


def classify_group(category_counts) -> str:
    """Classify a candidate group by its category composition.

    Three mutually exclusive classifications (see
    docs/service-record-contract.md §3):

    - same_category_duplicate_candidate: exactly one category is
      represented in the group.
    - cross_category_shared_contact_candidate: more than one category is
      represented, and every one of them occurs exactly once.
    - mixed_scope_and_duplicate_candidate: more than one category is
      represented, and at least one occurs more than once — a
      same-category duplicate candidate may be hiding inside an otherwise
      mixed group, so this must never be folded into the cross-category
      label above.

    A category match is still only a candidate for human review; no
    classification here asserts a confirmed duplicate or confirmed
    distinctness.
    """
    if len(category_counts) <= 1:
        return "same_category_duplicate_candidate"
    if all(count == 1 for count in category_counts.values()):
        return "cross_category_shared_contact_candidate"
    return "mixed_scope_and_duplicate_candidate"


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def phone_key(s: str) -> str:
    d = re.sub(r"\D", "", s or "")
    return d[-7:] if len(d) >= 7 else d


def host(url: str) -> str:
    if not url:
        return ""
    m = re.match(r"^(?:https?://)?(?:www\.)?([^/]+)", url.strip(), re.I)
    return (m.group(1).lower() if m else "").strip()


def detect_duplicates_for_country(country: dict) -> list[list[int]]:
    """Return list of index-groups within the country that are candidate duplicates."""
    hs = country["hotlines"]
    n = len(hs)
    if n < 2:
        return []

    # Build quick indexes
    name_idx = defaultdict(list)
    phone_idx = defaultdict(list)
    host_idx = defaultdict(list)

    # Hosts that are shared across MANY distinct services (e.g. government
    # umbrella domains) can't be used alone to call duplicates.
    GENERIC_HOSTS = {
        "gov.uk", "gov.ie", "gov.za", "gov.au", "gov.it", "gov.lv", "gov.sg",
        "gob.cl", "gob.mx", "gob.pe", "gob.es", "gob.ar", "gob.do", "gob.ec", "gob.gt",
        "argentina.gob.ar", "gob.cl", "gov.br", "gov.in", "gov.ph", "gov.sa",
        "gob.pa", "gob.pe", "gob.cr", "gov.hk", "health.gov.au", "nhs.uk",
        "ec.europa.eu", "who.int", "ifrc.org", "befrienders.org",
    }

    for i, h in enumerate(hs):
        name_idx[norm_name(h.get("name", ""))].append(i)
        for num in (h.get("voice_numbers") or []) + (h.get("sms_numbers") or []):
            k = phone_key(num)
            # Only group on LONG number keys (>= 7 digits); 3/4-digit short
            # codes are shared by many different services and must not drive
            # duplicate detection on their own.
            if k and len(k) >= 7:
                phone_idx[k].append(i)
        hh = host(h.get("website") or "")
        if hh and hh not in GENERIC_HOSTS:
            host_idx[hh].append(i)

    # Group by first key hit; use union-find
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb: parent[ra] = rb

    for group in list(name_idx.values()) + list(phone_idx.values()) + list(host_idx.values()):
        if len(group) > 1:
            for j in group[1:]:
                union(group[0], j)

    # Also catch very similar names if they share a phone or host (transitivity above already handles shared phone/host; here we add high-ratio name matches in same category)
    for i in range(n):
        for j in range(i + 1, n):
            if find(i) == find(j):
                continue
            ni, nj = hs[i].get("name", ""), hs[j].get("name", "")
            if not ni or not nj:
                continue
            if hs[i].get("category") != hs[j].get("category"):
                continue
            ratio = SequenceMatcher(None, norm_name(ni), norm_name(nj)).ratio()
            if ratio >= 0.92:
                # Require they also share at least a phone-key segment or a host to be safe
                shares_phone = any(
                    phone_key(a) and phone_key(a) == phone_key(b)
                    for a in (hs[i].get("voice_numbers") or [])
                    for b in (hs[j].get("voice_numbers") or [])
                )
                shares_host = (host(hs[i].get("website") or "")
                               and host(hs[i].get("website") or "") == host(hs[j].get("website") or ""))
                if shares_phone or shares_host:
                    union(i, j)

    # Collect groups with more than one element
    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    return [g for g in groups.values() if len(g) > 1]


def find_duplicates(data: dict) -> tuple[list[str], int, int, Counter, int]:
    """Detect candidate duplicate groups in `data` without modifying it.

    Returns (report_body_lines, total_records, total_groups,
    classification_counts, cross_geography_groups). `classification_counts`
    is a Counter keyed by the three mutually exclusive labels in
    GROUP_CLASSIFICATION_LABELS (see classify_group()). This is classification
    for report text only; it never merges or mutates records.
    """
    rep: list[str] = []
    total_groups = 0
    classification_counts: Counter = Counter()
    cross_geography_groups = 0
    total_records = sum(len(c["hotlines"]) for c in data["countries"])

    for country in data["countries"]:
        groups = detect_duplicates_for_country(country)
        if not groups:
            continue
        rep.append(f"## {country['country']}")
        rep.append("")
        hs = country["hotlines"]
        for group in sorted(groups, key=lambda g: -len(g)):
            total_groups += 1
            category_counts = Counter(hs[i].get("category") for i in group)
            classification = classify_group(category_counts)
            classification_counts[classification] += 1
            note = GROUP_CLASSIFICATION_NOTES[classification]
            geographies = {
                (hs[i].get("geography") or "").strip()
                for i in group
                if isinstance(hs[i].get("geography"), str)
            }
            if len(geographies) > 1:
                cross_geography_groups += 1
                note += " + cross-geography candidate (orthogonal review flag)"
            if len(category_counts) > 1:
                note += f" (categories: {', '.join(sorted(category_counts))})"
            rep.append(f"- candidate group of {len(group)} — {note}:")
            for i in group:
                rep.append(
                    f"    • '{hs[i].get('name', '?')}' "
                    f"[{hs[i].get('category')}, {hs[i].get('verification_status')}] "
                    f"-> {(hs[i].get('voice_numbers') or [None])[0]}"
                )
        rep.append("")

    return rep, total_records, total_groups, classification_counts, cross_geography_groups


def guard_report_path(report_path: pathlib.Path, input_path: pathlib.Path) -> None:
    """Refuse any --report target that could clobber a dataset.

    Must run before any parent-directory creation or writing. Rejects, in
    order:
    - a report path resolving to the same file as --input
    - a report path resolving to the canonical hotlines.json, even when a
      different --input was given
    - a non-.md extension (blocks selecting a .json dataset as the target)

    Path-identity checks run before the extension check so that a
    same-file-as-input or canonical-dataset target is reported as such even
    when it also happens to lack a .md extension.
    """
    resolved_report = report_path.resolve()
    resolved_input = input_path.resolve()
    resolved_canonical = DATA.resolve()

    if resolved_report == resolved_input:
        raise SystemExit(f"--report must not be the same file as --input: {resolved_report}")

    if resolved_report == resolved_canonical:
        raise SystemExit(f"--report must not target the canonical dataset: {resolved_canonical}")

    if report_path.suffix.lower() != ".md":
        raise SystemExit(f"--report must be a .md file, got: {report_path}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Detect candidate duplicate hotlines within each country. Read-only: "
            "this command never writes to or modifies the input dataset. By "
            "default it prints a summary; pass --report to additionally write a "
            "markdown findings report to disk."
        )
    )
    parser.add_argument(
        "--input",
        type=pathlib.Path,
        default=DATA,
        help=f"Path to the hotlines dataset to scan (default: {DATA}).",
    )
    parser.add_argument(
        "--report",
        type=pathlib.Path,
        default=None,
        metavar="PATH",
        help=(
            "Write a markdown findings report to PATH (must end in .md). If "
            "omitted, no report is written. PATH must not resolve to --input "
            "or to the canonical hotlines.json; never modifies --input."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if args.report is not None:
        guard_report_path(args.report, args.input)

    data = json.loads(args.input.read_text(encoding="utf-8"))

    (
        body,
        total_records,
        total_groups,
        classification_counts,
        cross_geography_groups,
    ) = find_duplicates(data)

    breakdown = ", ".join(
        f"{classification_counts.get(key, 0)} {label}"
        for key, label in GROUP_CLASSIFICATION_LABELS.items()
    )
    print(
        f"Records scanned: {total_records}, candidate duplicate groups: {total_groups} "
        f"({breakdown}); {cross_geography_groups} cross-geography candidate(s) "
        "(orthogonal count, not a distinctness signal)"
    )
    print(
        "\nThis is detection only: no records were merged or modified, and none "
        "will be. Shared contact channels alone do not imply a duplicate, and their "
        "absence does not imply distinctness either — see "
        "docs/service-record-contract.md. Review candidate groups manually before "
        "taking any action."
    )

    if args.report is None:
        return 0

    report_path = args.report
    report_lines = ["# Duplicate detection findings", ""]
    report_lines += [
        "## Summary",
        "",
        f"- Records scanned: {total_records}",
        f"- Candidate duplicate groups found: {total_groups}",
    ] + [
        f"  - {label.capitalize()}: {classification_counts.get(key, 0)}"
        for key, label in GROUP_CLASSIFICATION_LABELS.items()
    ] + [
        f"- Cross-geography candidates (orthogonal review flag): {cross_geography_groups}",
        "",
        "These are candidates only. No merging was performed; review each group "
        "manually before making any changes to the dataset.",
        "",
    ]
    report_lines += body
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(report_lines), encoding="utf-8")
    print(f"Report: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
