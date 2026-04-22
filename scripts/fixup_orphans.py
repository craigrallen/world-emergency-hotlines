#!/usr/bin/env python3
"""
Cleanup pass for records left orphaned after normalisation:

1. If a record has a website that looks like a chat page ('/chat' or 'chat.' prefix),
   promote it to chat_url.
2. If a record has ANY website or chat_url, it has a valid online contact method —
   don't keep it flagged `deprecated` just because it has no phone.
3. Re-run the '(phone notes: …)' recovery with a more permissive regex that
   also extracts numbers embedded inside parenthetical clauses.
"""
from __future__ import annotations

import json
import pathlib
import re
from datetime import datetime

ROOT = pathlib.Path(__file__).parent.parent
OUT = ROOT / "hotlines.json"

NUMBER_RE = re.compile(r"[+]?\d[\d\s\-()\.]{1,}[\d\)]")


def extract_numbers_permissive(text: str) -> list[str]:
    out = []
    for m in NUMBER_RE.findall(text or ""):
        cleaned = re.sub(r"[()]", " ", m).strip()
        cleaned = re.sub(r"\s+", " ", cleaned)
        if cleaned and re.search(r"\d{2,}", cleaned) and cleaned not in out:
            out.append(cleaned)
    return out


def main():
    data = json.loads(OUT.read_text(encoding="utf-8"))
    chat_promoted = 0
    deprecated_rescued = 0
    numbers_recovered = 0

    for c in data["countries"]:
        for h in c["hotlines"]:
            name_l = (h.get("name") or "").lower()
            site = h.get("website") or ""

            # 1. Promote chat-looking websites to chat_url
            if site and not h.get("chat_url"):
                if re.search(r"(/chat\b|chat\.|/webchat|livechat)", site, re.I) or "chat" in name_l:
                    h["chat_url"] = site
                    chat_promoted += 1

            # 2. Rescue notes text like '(phone notes: ...)'
            notes = h.get("notes") or ""
            leftover = re.findall(r"\(phone notes?:\s*([^)]+)\)", notes, re.I)
            for L in leftover:
                got = extract_numbers_permissive(L)
                if got:
                    existing = set(h.get("voice_numbers") or [])
                    for g in got:
                        if g not in existing:
                            h.setdefault("voice_numbers", []).append(g)
                            existing.add(g)
                            numbers_recovered += 1
            # Also try to find numbers directly in parentheticals in notes for records that still need them
            if not h.get("voice_numbers") and not h.get("sms_numbers"):
                paren_matches = re.findall(r"\(([^)]*\d[^)]*)\)", notes)
                for pm in paren_matches:
                    got = extract_numbers_permissive(pm)
                    if got:
                        h["voice_numbers"] = got
                        numbers_recovered += len(got)
                        break

            # Strip residual '(phone notes: ...)' fragments from notes
            h["notes"] = re.sub(r"\s*\(phone notes?:[^)]*\)?\s*", " ", notes).strip()

            # 3. Rescue deprecated when online-only contact exists
            has_contact = bool(
                h.get("voice_numbers") or h.get("sms_numbers")
                or h.get("text_numbers") or h.get("short_codes")
                or h.get("chat_url") or h.get("email")
            )
            # If no voice/sms/email but has website, website itself counts as contact for online-only services
            has_website = bool(h.get("website"))
            if h.get("verification_status") == "deprecated" and (has_contact or has_website):
                # Pick the appropriate non-deprecated state
                if any("helplines.world" in s for s in (h.get("sources") or [])):
                    h["verification_status"] = "cross_referenced"
                else:
                    h["verification_status"] = "legacy_unverified"
                deprecated_rescued += 1

    data["last_updated"] = datetime.utcnow().date().isoformat()
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    # Post-state
    from collections import Counter
    st = Counter(h.get("verification_status") for c in data["countries"] for h in c["hotlines"])
    print(f"chat_url promoted from website: {chat_promoted}")
    print(f"deprecated records rescued:      {deprecated_rescued}")
    print(f"voice numbers recovered:         {numbers_recovered}")
    print(f"Status distribution: {dict(st)}")


if __name__ == "__main__":
    main()
