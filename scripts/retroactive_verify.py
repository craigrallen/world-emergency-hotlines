#!/usr/bin/env python3
"""
Retroactively promote records to `verified_web` when their `sources` list
already contains a URL from the record's own `website` host.

Why this exists: the initial trawl_enrichment.py run had a bug where it
wouldn't promote curated (`verified_knowledge`) records even when it confirmed
the phone number on the provider's own site. The trawler still added the
matched URL to `sources`, so we can recover the promotion by cross-referencing
after the fact.

Promotion rule (conservative):

  - Record has a `website` URL.
  - Record's `sources` contains at least one URL whose host matches the
    `website` host (or is a subdomain of it).
  - Record's current `verification_status` is not already at `verified_web`
    or higher (`verified_authority`).
  - Record has at least one phone / sms / chat_url contact.

When promoted, `last_verified` is bumped to today.

Runs as a dry-run by default; pass `--apply` to write.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
from datetime import datetime

ROOT = pathlib.Path(__file__).parent.parent
DATA = ROOT / "hotlines.json"


def host_of(url: str) -> str:
    if not url:
        return ""
    m = re.match(r"^(?:https?://)?(?:www\.)?([^/]+)", url.strip(), re.I)
    return (m.group(1).lower() if m else "").strip()


def host_match(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    # Subdomain containment
    return a.endswith("." + b) or b.endswith("." + a)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Write the promotions back to hotlines.json")
    args = ap.parse_args()

    data = json.loads(DATA.read_text(encoding="utf-8"))
    candidates = []

    for c in data["countries"]:
        for h in c["hotlines"]:
            status = h.get("verification_status")
            if status in ("verified_web", "verified_authority", "deprecated"):
                continue
            website = h.get("website") or ""
            if not website:
                continue
            sources = h.get("sources") or []
            has_phone = bool(h.get("voice_numbers") or h.get("sms_numbers") or h.get("chat_url"))
            if not has_phone:
                continue
            w_host = host_of(website)
            if not w_host:
                continue
            for src in sources:
                s_host = host_of(src)
                if host_match(s_host, w_host):
                    candidates.append((c["country"], h, src))
                    break

    print(f"Found {len(candidates)} promotion candidates")
    for country, h, src in candidates[:25]:
        print(f"  [{country}] {h['name'][:50]:<50} [{h.get('verification_status')} -> verified_web]  source={src[:60]}")
    if len(candidates) > 25:
        print(f"  ... and {len(candidates) - 25} more")

    if not args.apply:
        print("\nDry run. Pass --apply to write.")
        return

    now = datetime.utcnow().date().isoformat()
    for country, h, src in candidates:
        h["verification_status"] = "verified_web"
        h["last_verified"] = now

    data["last_updated"] = now
    tmp = DATA.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA)
    print(f"Promoted {len(candidates)} records to verified_web.")


if __name__ == "__main__":
    main()
