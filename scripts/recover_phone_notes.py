#!/usr/bin/env python3
"""
The helplines.world importer stashed numbers with parenthetical labels into the
`notes` field as '(phone notes: 911 | 112)'. This re-scans every record, pulls
any numbers back out of those parentheticals, and restores them to
voice_numbers. Records that recover at least one number are un-deprecated.
"""
from __future__ import annotations

import json
import pathlib
import re
from datetime import datetime

ROOT = pathlib.Path(__file__).parent.parent
OUT = ROOT / "hotlines.json"

NUMBER_RE = re.compile(r"[+]?\d[\d\s\-()\.]{1,}[\d\)]")
PHONE_NOTES_RE = re.compile(r"\(phone notes?:\s*([^)]+)\)", re.I)


def extract_numbers(text: str) -> list[str]:
    out = []
    for part in re.split(r"\s*[|,;/]\s*|\s+or\s+", text):
        # Reject purely parenthetical labels like "Police"
        if not re.search(r"\d", part):
            continue
        # Strip trailing labels in parens
        part = re.sub(r"\([^)]*[A-Za-z][^)]*\)", "", part)
        matches = NUMBER_RE.findall(part)
        for m in matches:
            cleaned = m.strip().rstrip(")").strip()
            cleaned = re.sub(r"\s+", " ", cleaned)
            if cleaned and cleaned not in out and re.search(r"\d{2,}", cleaned):
                out.append(cleaned)
    return out


def main():
    data = json.loads(OUT.read_text(encoding="utf-8"))
    recovered = 0
    reactivated = 0

    for c in data["countries"]:
        for h in c["hotlines"]:
            notes = h.get("notes") or ""
            if not notes:
                continue
            m = PHONE_NOTES_RE.search(notes)
            if not m:
                continue
            found = extract_numbers(m.group(1))
            if not found:
                continue
            existing = set(h.get("voice_numbers") or [])
            new_nums = [n for n in found if n not in existing]
            if new_nums:
                h["voice_numbers"] = list(existing) + new_nums
                recovered += len(new_nums)
            # Remove the (phone notes: ...) clause from notes
            h["notes"] = re.sub(r"\s*\(phone notes?:[^)]+\)\s*", " ", notes).strip()
            # If this record was only deprecated because it lacked contact, reactivate it
            has_contact = bool(h.get("voice_numbers") or h.get("sms_numbers") or h.get("chat_url") or h.get("email"))
            if has_contact and h.get("verification_status") == "deprecated":
                # Restore to the appropriate status - cross_referenced since it came from helplines.world
                sources = h.get("sources") or []
                if any("helplines.world" in s for s in sources):
                    h["verification_status"] = "cross_referenced"
                else:
                    h["verification_status"] = "legacy_unverified"
                reactivated += 1

    data["last_updated"] = datetime.utcnow().date().isoformat()
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Recovered {recovered} numbers; reactivated {reactivated} records.")


if __name__ == "__main__":
    main()
