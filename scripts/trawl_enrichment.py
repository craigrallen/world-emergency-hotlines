#!/usr/bin/env python3
"""
Internet-trawling enrichment worker.

For every hotline record, use the fields we already have (name, country,
phone) as search keys to find the organisation's real web footprint. Then
extract structured metadata from the pages we reach:

  • `hours`            — "24/7", "Mon–Fri 9am–5pm", etc.
  • `languages`        — languages the line supports
  • `chat_url`         — live-chat page
  • `sms_numbers`      — "text HOME to 741741" style
  • `email`            — contact email
  • `website`          — found via DuckDuckGo when missing
  • `social`           — appended to notes as "twitter: URL" etc.
  • verified_web       — promote on successful phone-number match

Strategy per record:

  1. If no website on file, query DuckDuckGo HTML (no API key) for
     '<name> <country>' and pick the first plausible hit.
  2. Fetch the website home + /contact + /about + /help (best-effort).
  3. Parse phones, SMS, hours, languages, chat links, email, socials.
  4. Merge into the existing record, filling blanks but never downgrading
     curated fields (verified_knowledge / verified_web).
  5. On phone-number match with the page body, promote to `verified_web`
     and append the matching URL to `sources`.

Resumable via a cache file. Runs politely at 1 request/second with a
30-second-per-site timeout.

Stdlib-only (urllib + re + ssl) — no pip dependencies.

Usage:
    python scripts/trawl_enrichment.py --limit 200
    python scripts/trawl_enrichment.py --status legacy_unverified --limit 500
    python scripts/trawl_enrichment.py --country FR
    python scripts/trawl_enrichment.py --force   # re-check recent records

Run on the Windows host (Cowork sandbox's web_fetch is provenance-gated).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import ssl
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

# Force UTF-8 stdout on Windows
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = pathlib.Path(__file__).parent.parent
DATA = ROOT / "hotlines.json"
CACHE = ROOT / "scripts" / ".trawl_cache.json"

UA = "Mozilla/5.0 (Hotlines.world aggregator; https://github.com/craigrallen/world-emergency-hotlines)"
TIMEOUT = 20
DELAY = 1.2
RECHECK_AFTER_DAYS = 30


# ---------- small utilities ----------

def digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def phone_key(s: str, tail: int = 7) -> str:
    d = digits(s)
    return d[-tail:] if len(d) >= tail else d


def host_of(url: str) -> str:
    if not url:
        return ""
    m = re.match(r"^(?:https?://)?(?:www\.)?([^/]+)", url.strip(), re.I)
    return (m.group(1).lower() if m else "").strip()


def norm_text(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", s.lower()).strip()


def strip_html(html: str, limit: int = 30000) -> str:
    # Remove scripts and styles wholesale before tag-strip
    html = re.sub(r"<script\b[^<]*(?:(?!</script>)<[^<]*)*</script>", " ", html, flags=re.I)
    html = re.sub(r"<style\b[^<]*(?:(?!</style>)<[^<]*)*</style>", " ", html, flags=re.I)
    html = re.sub(r"<[^>]+>", " ", html)
    html = re.sub(r"&nbsp;", " ", html)
    html = re.sub(r"&amp;", "&", html)
    html = re.sub(r"\s+", " ", html).strip()
    return html[:limit]


def fetch(url: str, timeout: int = TIMEOUT) -> tuple[int, str, str]:
    try:
        ctx = ssl.create_default_context()
        # Some health ministries still run TLS 1.0
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml",
        })
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            final = r.geturl()
            status = r.status
            raw = r.read(2_000_000)
        text = ""
        for enc in ("utf-8", "latin-1"):
            try:
                text = raw.decode(enc, errors="replace")
                break
            except Exception:
                continue
        return status, final, text
    except urllib.error.HTTPError as e:
        return e.code, url, ""
    except Exception:
        return 0, url, ""


# ---------- DuckDuckGo HTML search (no API key) ----------

def ddg_find_site(name: str, country: str) -> str | None:
    """Return the first plausible official-looking hit for '<name> <country>'."""
    q = urllib.parse.quote(f'"{name}" {country} helpline OR hotline OR crisis')
    status, _, html = fetch(f"https://duckduckgo.com/html/?q={q}")
    if status != 200 or not html:
        return None
    # DDG HTML wraps each hit in class="result__a" href="..."
    for m in re.finditer(r'class="result__a"[^>]*href="([^"]+)"', html):
        href = m.group(1)
        # Resolve DDG's redirect wrapper
        if "duckduckgo.com/l/" in href:
            parse = urllib.parse.urlparse(href)
            qs = urllib.parse.parse_qs(parse.query)
            if "uddg" in qs:
                href = qs["uddg"][0]
        if not href.startswith("http"):
            continue
        h = host_of(href)
        # Skip aggregators
        if any(bad in h for bad in (
            "helplines.world", "findahelpline.com", "wikipedia.org",
            "facebook.com", "twitter.com", "instagram.com", "youtube.com",
            "yelp.com", "reddit.com", "pinterest.com", "amazon.com",
            "linkedin.com", "quora.com",
        )):
            continue
        return href
    return None


# ---------- Pattern extractors ----------

HOURS_PATTERNS = [
    (re.compile(r"\b24[\s/-]?7\b"), "24/7"),
    (re.compile(r"\b24\s*hours?\s*(?:a|per)\s*day\b", re.I), "24 hours a day"),
    (re.compile(r"\baround\s*the\s*clock\b", re.I), "Around the clock"),
    (re.compile(r"\b24\s*x\s*7\b", re.I), "24x7"),
]


def extract_hours(text: str) -> str | None:
    for rx, label in HOURS_PATTERNS:
        if rx.search(text):
            return label
    m = re.search(
        r"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*[-–—]\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[^.]{0,60}\d{1,2}[:\.]?\d{0,2}\s*(?:am|pm|AM|PM)?\s*[-–—]\s*\d{1,2}[:\.]?\d{0,2}\s*(?:am|pm|AM|PM)",
        text, re.I)
    if m:
        return m.group(0).strip()[:80]
    m = re.search(r"\b(?:open|available)\b[^.]{0,60}\d{1,2}[:\.]?\d{0,2}\s*(?:am|pm|AM|PM)", text, re.I)
    if m:
        return m.group(0).strip()[:80]
    return None


# Popular language names — we look for these in plain text.
LANG_TOKENS = [
    "English", "Spanish", "Français", "French", "Deutsch", "German",
    "Italiano", "Italian", "Português", "Portuguese", "Nederlands", "Dutch",
    "中文", "Chinese", "Mandarin", "Cantonese",
    "日本語", "Japanese", "한국어", "Korean",
    "العربية", "Arabic", "עברית", "Hebrew",
    "Русский", "Russian", "Українська", "Ukrainian", "Polski", "Polish",
    "Türkçe", "Turkish", "Bahasa", "Malay", "Indonesian",
    "हिन्दी", "Hindi", "اردو", "Urdu", "বাংলা", "Bengali", "தமிழ்", "Tamil",
    "Español", "Svenska", "Swedish", "Dansk", "Danish", "Norsk", "Norwegian",
    "Suomi", "Finnish", "Magyar", "Hungarian", "Čeština", "Czech", "Slovenčina",
    "Slovak", "Română", "Romanian", "Ελληνικά", "Greek", "فارسی", "Persian",
    "Tagalog", "Filipino", "Vietnamese", "Tiếng Việt", "Thai", "ไทย",
    "Swahili", "Amharic", "Afrikaans", "Zulu", "Xhosa", "Sotho", "Hausa",
    "Yoruba", "Igbo", "Welsh", "Cymraeg", "Gaeilge", "Irish",
]


def extract_languages(text: str) -> list[str]:
    langs = []
    for t in LANG_TOKENS:
        if re.search(rf"\b{re.escape(t)}\b", text):
            canon = {"Français": "French", "Deutsch": "German", "Italiano": "Italian",
                     "Português": "Portuguese", "Nederlands": "Dutch",
                     "Español": "Spanish", "Русский": "Russian", "Українська": "Ukrainian",
                     "Polski": "Polish", "Türkçe": "Turkish", "Suomi": "Finnish",
                     "Magyar": "Hungarian", "Čeština": "Czech", "Slovenčina": "Slovak",
                     "Română": "Romanian", "Ελληνικά": "Greek", "فارسی": "Persian",
                     "Svenska": "Swedish", "Dansk": "Danish", "Norsk": "Norwegian",
                     "हिन्दी": "Hindi", "اردو": "Urdu", "বাংলা": "Bengali",
                     "தமிழ்": "Tamil", "中文": "Chinese", "日本語": "Japanese",
                     "한국어": "Korean", "العربية": "Arabic", "עברית": "Hebrew",
                     "Tiếng Việt": "Vietnamese", "ไทย": "Thai", "Cymraeg": "Welsh",
                     "Gaeilge": "Irish"}.get(t, t)
            if canon not in langs:
                langs.append(canon)
    return langs[:15]


EMAIL_RX = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
CHAT_HINT = re.compile(r"(live\s*chat|web\s*chat|chat\s*with\s*us|chat\s*online|talk\s*online)", re.I)
SOCIAL_RX = {
    "twitter": re.compile(r'https?://(?:www\.)?(?:twitter|x)\.com/(?!intent|home|share|search|compose|status|i/)([A-Za-z0-9_]{3,})(?=[/?"\s<])'),
    "facebook": re.compile(r'https?://(?:www\.|web\.)?facebook\.com/(?!plugins|sharer|dialog|tr\?|tr/)([A-Za-z0-9.\-]{3,})(?=[/?"\s<])'),
    "instagram": re.compile(r'https?://(?:www\.)?instagram\.com/(?!p/|reel/|tv/|stories/|explore)([A-Za-z0-9_.\-]{3,})(?=[/?"\s<])'),
    "youtube": re.compile(r'https?://(?:www\.)?youtube\.com/(?:c/|channel/|user/|@)([A-Za-z0-9_.\-]{3,})(?=[/?"\s<])'),
    "linkedin": re.compile(r'https?://(?:www\.)?linkedin\.com/(?:company|in|school)/([A-Za-z0-9_.\-]{3,})(?=[/?"\s<])'),
}


def extract_email(text: str) -> str | None:
    for m in EMAIL_RX.finditer(text):
        addr = m.group(0)
        low = addr.lower()
        if any(b in low for b in ("noreply", "donotreply", "wix.com", "sentry.io", "example.com", "yoursite")):
            continue
        if addr.endswith((".png", ".jpg", ".svg")):
            continue
        return addr
    return None


def extract_chat(html: str, base_url: str) -> str | None:
    base_host = host_of(base_url)
    for m in re.finditer(r'href="([^"]+)"[^>]*>[^<]{0,40}(?:chat|text|talk)', html, re.I):
        href = m.group(1)
        if CHAT_HINT.search(html[max(0, m.start() - 200):m.end() + 200]):
            if href.startswith("/"):
                base = re.match(r"(https?://[^/]+)", base_url)
                if base:
                    return base.group(1) + href
            if href.startswith("http"):
                return href
    # Alternative: look for canonical chat URLs like chat.foo.com or /chat
    for m in re.finditer(r'href="(https?://chat\.[^"]+|https?://[^/]*/(?:chat|webchat|live-chat)[^"]*)"', html, re.I):
        return m.group(1)
    return None


def extract_socials(html: str) -> list[str]:
    out = []
    for key, rx in SOCIAL_RX.items():
        m = rx.search(html)
        if m:
            out.append(f"{key}: {m.group(0)}")
    return out[:4]


def phone_appears_on_page(page_text: str, number: str) -> bool:
    target = digits(number)
    if len(target) < 4:
        return False
    if len(target) <= 4:
        # short codes — require them as a standalone digit run
        pattern = re.compile(rf"(?<!\d){re.escape(target)}(?!\d)")
        return bool(pattern.search(re.sub(r"[\u00A0\u2009\u202F]", " ", page_text)))
    return target in digits(page_text)


# ---------- Cache ----------

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


def atomic_write(data: dict):
    tmp = DATA.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA)


# ---------- Main ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--status", default=None,
                    help="Only process records with this verification_status")
    ap.add_argument("--country", default=None,
                    help="ISO alpha-2 code to limit to a single country")
    ap.add_argument("--force", action="store_true",
                    help="Re-process records cached within the last 30 days")
    ap.add_argument("--no-ddg", action="store_true",
                    help="Don't use DuckDuckGo to discover missing websites")
    args = ap.parse_args()

    data = json.loads(DATA.read_text(encoding="utf-8"))
    cache = load_cache()
    cache.setdefault("records", {})

    todo: list[tuple[dict, dict]] = []
    for c in data["countries"]:
        if args.country and c.get("alpha-2") and c["alpha-2"].upper() != args.country.upper():
            continue
        for h in c["hotlines"]:
            if args.status and h.get("verification_status") != args.status:
                continue
            key = f"{c.get('alpha-2','??')}:{h.get('name','')}"
            last = cache["records"].get(key, {}).get("last")
            if last and not args.force:
                try:
                    if datetime.fromisoformat(last) > datetime.now(timezone.utc) - timedelta(days=RECHECK_AFTER_DAYS):
                        continue
                except Exception:
                    pass
            todo.append((c, h))

    todo = todo[:args.limit]
    print(f"{len(todo)} records queued", flush=True)

    promoted = 0
    site_discovered = 0
    fields_added = 0

    for idx, (country, h) in enumerate(todo, 1):
        key = f"{country.get('alpha-2','??')}:{h.get('name','')}"
        name = h.get("name", "")
        website = h.get("website") or ""
        is_curated = h.get("verification_status") in ("verified_knowledge", "verified_web", "verified_authority")

        # 1. Discover website if missing
        if not website and not args.no_ddg and name:
            found = ddg_find_site(name, country["country"])
            if found:
                website = found
                h["website"] = found
                site_discovered += 1
                time.sleep(DELAY)

        cache["records"][key] = {"last": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                 "website": website}

        # 2. Fetch pages
        pages_text = []
        matched_url = None
        if website:
            urls_to_try = [website]
            if website.endswith("/"):
                base = website.rstrip("/")
            else:
                base = website
            for path in ("/contact", "/contact-us", "/about", "/get-help", "/help"):
                urls_to_try.append(base + path)

            for url in urls_to_try[:4]:  # cap at 4 fetches per record
                status, final, html = fetch(url, timeout=15)
                if status == 200 and html:
                    text = strip_html(html, 40000)
                    pages_text.append((final, html, text))
                    # Match phone?
                    for nums in (h.get("voice_numbers") or []) + (h.get("sms_numbers") or []):
                        if phone_appears_on_page(text + " " + html, nums):
                            matched_url = final
                            break
                time.sleep(DELAY)

        # 3. Extract and merge
        for final_url, html, text in pages_text:
            if not h.get("hours"):
                h_hint = extract_hours(text)
                if h_hint:
                    h["hours"] = h_hint
                    fields_added += 1
            if not h.get("languages"):
                lang = extract_languages(text)
                if lang:
                    h["languages"] = lang
                    fields_added += 1
            if not h.get("email"):
                e = extract_email(html)
                if e:
                    h["email"] = e
                    fields_added += 1
            if not h.get("chat_url"):
                chat = extract_chat(html, final_url)
                if chat:
                    h["chat_url"] = chat
                    fields_added += 1
            socials = extract_socials(html)
            if socials:
                existing_notes = h.get("notes") or ""
                to_add = [s for s in socials if s not in existing_notes]
                if to_add:
                    h["notes"] = (existing_notes + ("\n\n" if existing_notes else "") + "\n".join(to_add)).strip()
                    fields_added += 1

        # 4. Promote on phone match. verified_web is the strongest status, so we
        #    promote upward from everything except verified_authority (which is
        #    even stronger) or deprecated.
        if matched_url:
            if h.get("verification_status") not in ("verified_web", "verified_authority", "deprecated"):
                h["verification_status"] = "verified_web"
                promoted += 1
            h["last_verified"] = datetime.utcnow().date().isoformat()
            srcs = set(h.get("sources") or [])
            srcs.add(matched_url)
            h["sources"] = sorted(srcs)

        # Flush every 10 records
        if idx % 10 == 0:
            atomic_write(data)
            save_cache(cache)

        tag = "✓" if matched_url else ("?" if website else "-")
        print(f"[{idx:>4}/{len(todo)}] {tag} [{country.get('alpha-2','??')}] {name[:40]:<40} site={bool(website)} matched={bool(matched_url)}", flush=True)

    atomic_write(data)
    save_cache(cache)
    print(f"\nDone. +{site_discovered} websites discovered, +{fields_added} metadata fields, +{promoted} promoted to verified_web.", flush=True)


if __name__ == "__main__":
    main()
