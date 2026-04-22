#!/usr/bin/env python3
"""
Web-verification worker.

For every hotline that has a `website` URL, fetch the page and check whether
the listed phone number appears in it. On a match, promote the record to
`verification_status: "verified_web"` with today's date and add the fetched
URL to `sources`. Also hunts for hours hints (24/7, "Mon-Fri 9-5") and chat
URLs in the page text.

Designed to run on the user's Windows machine (has raw internet; the Cowork
sandbox is provenance-gated). Run with:

    python scripts/web_verify.py --limit 200
    python scripts/web_verify.py --status verified_knowledge --limit 500
    python scripts/web_verify.py --force      # re-check already-verified records

State is kept in scripts/.web_verify_cache.json so repeated runs resume where
they left off and respect a 30-day re-verification window.

Uses only stdlib (urllib, re, ssl) — no pip dependencies.
"""
from __future__ import annotations

import argparse
import io
import json
import pathlib
import re
import ssl
import sys
import time
import unicodedata
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

# Force UTF-8 stdout on Windows so we can print country names with non-ASCII chars
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = pathlib.Path(__file__).parent.parent
DATA = ROOT / "hotlines.json"
CACHE = ROOT / "scripts" / ".web_verify_cache.json"

UA = "Mozilla/5.0 (Hotlines.world dataset verifier; https://github.com/craigrallen/world-emergency-hotlines)"
TIMEOUT = 20
DELAY = 1.0  # seconds between requests (politeness)
RECHECK_AFTER_DAYS = 30


def digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def normalize_text(s: str) -> str:
    """Lower-case, strip accents, collapse whitespace. Use for fuzzy matching."""
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", s.lower()).strip()


def fetch(url: str) -> tuple[int, str, str]:
    """Return (status, final_url, text). Raises nothing — errors captured as status 0."""
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # some helpline sites have bad certs
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
            final = r.geturl()
            status = r.status
            raw = r.read(1_500_000)  # cap at 1.5 MB
        # Best-effort decode
        for enc in ("utf-8", "latin-1"):
            try:
                text = raw.decode(enc, errors="replace")
                break
            except Exception:
                continue
        return status, final, text
    except urllib.error.HTTPError as e:
        return e.code, url, ""
    except Exception as e:
        return 0, url, f"__ERR__ {type(e).__name__}: {e}"


# Very loose phone "appears on page" test: after stripping all non-digits from
# the page text and the target number, the target's digit sequence should occur
# as a substring, provided it is at least 4 digits long.
def phone_in_page(page_text: str, number: str) -> bool:
    target = digits(number)
    if len(target) < 4:
        return False
    # Short number like "988" -> require it to appear as its own token in the page to
    # avoid spurious matches (988 matches inside 1988, for example). Check the original
    # text for a boundary-sensitive match.
    if len(target) <= 4:
        pattern = re.compile(rf"(?<!\d){re.escape(target)}(?!\d)")
        # Strip only narrow/non-breaking spaces so "116 123" stays matchable
        cleaned = re.sub(r"[\u00A0\u2009\u202F]", " ", page_text)
        cleaned = re.sub(r"\s+", " ", cleaned)
        return bool(pattern.search(cleaned))
    # Longer numbers: strip non-digit characters and look for the sequence
    page_digits = digits(page_text)
    return target in page_digits


def extract_hours_hint(page_text: str) -> str | None:
    t = normalize_text(page_text)
    if "24/7" in t or "24 hours a day" in t or "around the clock" in t:
        return "24/7"
    m = re.search(r"(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*[-–—to]+\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*.{0,40}\d{1,2}\s*(am|pm)?\s*[-–—to]+\s*\d{1,2}\s*(am|pm)", t)
    if m:
        return m.group(0)[:80]
    return None


def extract_chat_url(page_text: str, base_url: str) -> str | None:
    # Look for explicit chat URLs
    for m in re.finditer(r'href="([^"]+)"[^>]*>[^<]{0,40}(chat|web ?chat|live ?chat|talk online)', page_text, re.I):
        href = m.group(1)
        if href.startswith("/"):
            # Resolve
            base = re.match(r"(https?://[^/]+)", base_url)
            if base:
                return base.group(1) + href
        if href.startswith("http"):
            return href
    return None


def load_cache() -> dict:
    if CACHE.exists():
        try:
            return json.loads(CACHE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_cache(cache: dict):
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CACHE)


def atomic_write_data(data: dict):
    tmp = DATA.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--status", default=None,
                    help="Only process records with this verification_status")
    ap.add_argument("--force", action="store_true",
                    help="Re-verify even recently checked records")
    ap.add_argument("--start", type=int, default=0, help="Skip first N eligible records")
    args = ap.parse_args()

    data = json.loads(DATA.read_text(encoding="utf-8"))
    cache = load_cache()

    # Build flat list of (country, record) pairs that have a website to test
    todo = []
    for c in data["countries"]:
        for h in c["hotlines"]:
            if not h.get("website"):
                continue
            if args.status and h.get("verification_status") != args.status:
                continue
            url = h["website"]
            # Skip if cache says we checked recently unless --force
            last = cache.get(url, {}).get("last")
            if last and not args.force:
                try:
                    if datetime.fromisoformat(last) > datetime.now(timezone.utc) - timedelta(days=RECHECK_AFTER_DAYS):
                        continue
                except Exception:
                    pass
            todo.append((c, h))

    print(f"{len(todo)} candidate records to verify "
          f"(limit {args.limit}, start {args.start})", flush=True)

    todo = todo[args.start:args.start + args.limit]
    promoted = 0
    hours_added = 0
    chat_added = 0
    errors = 0
    network_fail = 0

    for idx, (country, h) in enumerate(todo, 1):
        url = h["website"]
        # Ensure the URL is fully qualified
        if not url.startswith("http"):
            url = "https://" + url
        print(f"[{idx:>4}/{len(todo)}] {country['country'][:25]:<25} {h['name'][:40]:<40} {url}", flush=True)
        status, final_url, text = fetch(url)
        cache[url] = {"last": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                      "status": status, "final": final_url}
        if status == 0 or status >= 400:
            network_fail += 1
            print(f"         -> HTTP {status}", flush=True)
            time.sleep(DELAY)
            continue
        if not text:
            network_fail += 1
            time.sleep(DELAY)
            continue

        # Match against the record's numbers
        all_nums = list(h.get("voice_numbers") or []) + list(h.get("sms_numbers") or []) + list(h.get("short_codes") or [])
        matched = False
        for n in all_nums:
            if phone_in_page(text, n):
                matched = True
                break

        if matched:
            if h.get("verification_status") != "verified_web":
                h["verification_status"] = "verified_web"
                promoted += 1
            h["last_verified"] = datetime.utcnow().date().isoformat()
            if final_url not in (h.get("sources") or []):
                h.setdefault("sources", []).append(final_url)

        # Hours hint — only add when missing
        if not h.get("hours"):
            hint = extract_hours_hint(text)
            if hint:
                h["hours"] = hint
                hours_added += 1

        # Chat URL — only add when missing
        if not h.get("chat_url"):
            ch = extract_chat_url(text, url)
            if ch:
                h["chat_url"] = ch
                chat_added += 1

        time.sleep(DELAY)
        # Flush cache every record, JSON every 25 records (smaller write cost)
        save_cache(cache)
        if idx % 25 == 0:
            atomic_write_data(data)

    # Final flush
    data["last_updated"] = datetime.utcnow().date().isoformat()
    atomic_write_data(data)
    save_cache(cache)

    print(f"\nDone. Promoted {promoted} -> verified_web, +{hours_added} hours, +{chat_added} chat URLs, {network_fail} network failures.", flush=True)


if __name__ == "__main__":
    main()
