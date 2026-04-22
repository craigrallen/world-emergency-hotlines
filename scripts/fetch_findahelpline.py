#!/usr/bin/env python3
"""
Fetch and cache Find A Helpline country pages.

findahelpline.com is ThroughLine's curated global directory (13,000+ helplines,
130+ countries, human-vetted). Their data is served as Next.js SSR HTML with
Material-UI components tagged with data-testid attributes — scrapable politely.

Each country page (https://findahelpline.com/countries/{ISO-alpha-2-lowercase})
returns 20-40 helplines as the default paginated view.

This script:
  1. Reads the country list from hotlines.json so we only hit countries we cover
  2. Fetches each country's page (1 req/s, 20s timeout)
  3. Extracts helpline cards from the HTML using conservative DOM patterns
  4. Writes the structured data to sources/findahelpline.json with provenance

Run this on the Windows host (not the Cowork sandbox — sandbox is
provenance-gated). Takes ~5 minutes for 130 countries at 1 req/s + network.
"""
from __future__ import annotations

import json
import pathlib
import re
import ssl
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

# Force UTF-8 output on Windows console
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = pathlib.Path(__file__).parent.parent
OUT = ROOT / "sources" / "findahelpline.json"
CACHE_DIR = ROOT / "sources" / ".fah_cache"

UA = "Mozilla/5.0 (compatible; hotlines.world aggregator; +https://github.com/craigrallen/world-emergency-hotlines)"
DELAY = 1.0
TIMEOUT = 20


def fetch(url: str) -> tuple[int, str]:
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
            return r.status, r.read(2_000_000).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, f"__ERR__ {e}"


# ---------- Parse one country page ----------

# Each helpline is rendered inside a container that includes a tel:/sms: link
# plus surrounding UI nodes. We'll work card-by-card starting from `tel:` anchors.

PHONE_RE = re.compile(r'data-testid="phoneNumber"[^>]*href="tel:([^"]+)"')
SMS_RE = re.compile(r'data-testid="smsNumber"[^>]*href="sms:([^"]+)"')
TTY_RE = re.compile(r'data-testid="phoneTty"[^>]*href="tel:([^"]+)"')
CHAT_LINK_RE = re.compile(r'data-testid="visitWebsite"[^>]*href="([^"]+)"')
# Name appears inside an h2 or link near the card; we use a looser approach:
# find the nearest preceding <a> with a name-like text block.
NAME_RE = re.compile(
    r'<a[^>]*href="/helplines/[^"]+"[^>]*>(?:[^<]|<(?!/a>))*?<[^>]+>([^<]{3,120})</[^>]+></a>',
    re.I,
)
CARD_BOUNDARY_RE = re.compile(r'<div[^>]*data-testid="OrganizationCard"')


def parse_country_page(code: str, html: str) -> list[dict]:
    if not html:
        return []

    # First try the data-testid="helplineCard" boundary if present
    cards_positions = [m.start() for m in CARD_BOUNDARY_RE.finditer(html)]

    if cards_positions:
        segments = []
        for i, start in enumerate(cards_positions):
            end = cards_positions[i + 1] if i + 1 < len(cards_positions) else min(len(html), start + 20000)
            segments.append(html[start:end])
    else:
        # Fallback: split around each tel: anchor, 2kB window each side
        segments = []
        for m in re.finditer(r'href="tel:([^"]+)"', html):
            start = max(0, m.start() - 2500)
            end = min(len(html), m.end() + 1500)
            segments.append(html[start:end])

    records = []
    seen_names = set()
    for seg in segments:
        phone = None
        sms = None
        tty = None

        m = re.search(r'data-testid="phoneNumber"[^>]*href="tel:([^"]+)"', seg)
        if m: phone = m.group(1)
        m = re.search(r'data-testid="smsNumber"[^>]*href="sms:([^"]+)"', seg)
        if m: sms = m.group(1)
        m = re.search(r'data-testid="phoneTty"[^>]*href="tel:([^"]+)"', seg)
        if m: tty = m.group(1)

        website = None
        m = re.search(r'data-testid="visitWebsite"[^>]*href="([^"]+)"', seg)
        if m: website = m.group(1)

        chat_url = None
        m = re.search(r'data-testid="chat"[^>]*href="([^"]+)"', seg)
        if m: chat_url = m.group(1)

        # Name — FAH uses data-testid="headingLink" on the anchor wrapping the h2
        name = None
        head_match = re.search(
            r'data-testid="headingLink"[^>]*>(?:[^<]|<(?!/a>))*?<h[23][^>]*>([^<]{3,200})</h[23]>',
            seg, re.I | re.S,
        )
        if head_match:
            name = head_match.group(1).strip()
        if not name:
            h_match = re.search(r'<h[23][^>]*>([^<]{3,200})</h[23]>', seg)
            if h_match:
                name = h_match.group(1).strip()
        if not name:
            a_match = re.search(r'<a[^>]*href="/helplines/[^"]+"[^>]*>([^<]{3,120})</a>', seg)
            if a_match:
                name = a_match.group(1).strip()

        # Also capture the snippet / short description
        snippet = None
        sm = re.search(r'data-testid="snippet"[^>]*>([^<]{3,500})<', seg)
        if sm:
            snippet = sm.group(1).strip()

        if not name:
            continue
        if not (phone or sms or website):
            continue
        if name in seen_names:
            continue
        seen_names.add(name)

        # Tags — collected from chips in the segment
        tags = []
        for t in re.finditer(r'<span[^>]*class="[^"]*MuiChip-label[^"]*"[^>]*>([^<]+)</span>', seg):
            txt = re.sub(r"<[^>]+>", "", t.group(1)).strip()
            if txt and txt not in tags and len(txt) < 80:
                tags.append(txt)

        # Hours — look for typical labels
        hours = None
        m = re.search(r'data-testid="hours"[^>]*>([^<]+)<', seg)
        if m:
            hours = m.group(1).strip()

        records.append({
            "country": code,
            "name": name,
            "snippet": snippet,
            "phone": phone,
            "sms": sms,
            "tty": tty,
            "website": website,
            "chat_url": chat_url,
            "hours": hours,
            "tags": tags,
        })

    return records


def main():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Which countries do we care about?
    hotlines = json.loads((ROOT / "hotlines.json").read_text(encoding="utf-8"))
    codes = sorted({c["alpha-2"].lower() for c in hotlines["countries"] if c.get("alpha-2")})
    # Filter to countries that make sense (exclude uninhabited)
    skip = {"bv", "hm", "tf", "um"}  # uninhabited/military
    codes = [c for c in codes if c not in skip]

    print(f"Fetching {len(codes)} countries from Find A Helpline...", flush=True)

    all_records = []
    ok = 0
    empty = 0
    failed = 0
    for i, code in enumerate(codes, 1):
        cache = CACHE_DIR / f"{code}.html"
        # Use cache if fresh (< 14 days)
        if cache.exists():
            age_days = (datetime.now().timestamp() - cache.stat().st_mtime) / 86400
            if age_days < 14:
                html = cache.read_text(encoding="utf-8")
                status = 200
            else:
                status = None
                html = None
        else:
            status = None
            html = None

        if status is None:
            url = f"https://findahelpline.com/countries/{code}"
            status, html = fetch(url)
            if status == 200 and html:
                cache.write_text(html, encoding="utf-8")
            time.sleep(DELAY)

        if status != 200 or not html:
            failed += 1
            print(f"  [{i:>3}/{len(codes)}] {code}  HTTP {status} FAIL", flush=True)
            continue

        recs = parse_country_page(code, html)
        if not recs:
            empty += 1
            print(f"  [{i:>3}/{len(codes)}] {code}  (0 records)", flush=True)
            continue

        all_records.extend(recs)
        ok += 1
        print(f"  [{i:>3}/{len(codes)}] {code}  +{len(recs)} records (total {len(all_records)})", flush=True)

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(
        json.dumps({
            "source": "findahelpline.com (ThroughLine)",
            "scraped_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "country_count": ok,
            "record_count": len(all_records),
            "records": all_records,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nDone. {ok} countries ok, {empty} empty, {failed} failed.")
    print(f"Wrote {OUT} with {len(all_records)} records.")


if __name__ == "__main__":
    main()
