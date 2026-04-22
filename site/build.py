#!/usr/bin/env python3
"""
Static site generator for Hotlines.world.

Reads ../hotlines.json and writes fully-rendered static HTML into ./public/:

    public/
      index.html                    — landing with country picker
      about.html                    — methodology, data notes
      country/<alpha-2>.html        — per-country directory
      category/<slug>.html          — global view of one category
      data.json                     — copy of the dataset for client-side search
      styles.css                    — Tailwind-built CSS (or CDN in dev)

No frontend build tooling — pages are HTML strings, interactivity uses Alpine.js
(CDN) for search and tiny state. Tailwind is loaded via the CDN wrapper for
zero-config deployment.
"""
from __future__ import annotations

import html
import json
import pathlib
import re
import shutil
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime

ROOT = pathlib.Path(__file__).parent.parent
SITE = pathlib.Path(__file__).parent
SRC = ROOT / "hotlines.json"
OUT = SITE / "public"


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = s.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "na"


def esc(s) -> str:
    if s is None:
        return ""
    return html.escape(str(s), quote=True)


CATEGORY_ICONS = {
    "emergency": "🚨",
    "suicide_crisis": "🆘",
    "mental_health": "💬",
    "child_protection": "🧒",
    "youth": "🧑",
    "domestic_violence": "🏠",
    "sexual_violence": "🛡️",
    "lgbtqia": "🏳️‍🌈",
    "substance_use": "💊",
    "elder_abuse": "👴",
    "veterans": "🎖️",
    "human_trafficking": "⛓️‍💥",
    "disaster": "🌀",
    "missing_persons": "👁️",
    "bereavement": "🕊️",
    "eating_disorders": "🥣",
    "gambling": "🎲",
    "self_harm": "❤️‍🩹",
    "perinatal": "🤰",
    "disability": "♿",
    "stalking": "👣",
    "male_victims": "🚹",
    "refugee_migrant": "🧭",
    "general_support": "🫶",
}

CATEGORY_LABELS = {
    "emergency": "Emergency (police/fire/ambulance)",
    "suicide_crisis": "Suicide & acute crisis",
    "mental_health": "Mental health",
    "child_protection": "Child protection",
    "youth": "Youth",
    "domestic_violence": "Domestic violence",
    "sexual_violence": "Sexual violence",
    "lgbtqia": "LGBTQIA+",
    "substance_use": "Substance use",
    "elder_abuse": "Elder abuse",
    "veterans": "Veterans",
    "human_trafficking": "Human trafficking",
    "disaster": "Disaster",
    "missing_persons": "Missing persons",
    "bereavement": "Bereavement",
    "eating_disorders": "Eating disorders",
    "gambling": "Problem gambling",
    "self_harm": "Self-harm",
    "perinatal": "Perinatal & postnatal",
    "disability": "Disability & illness",
    "stalking": "Stalking",
    "male_victims": "Male victims of abuse",
    "refugee_migrant": "Refugees & migrants",
    "general_support": "General listening & support",
}


def flag(a2: str) -> str:
    if not a2 or len(a2) != 2 or not a2.isalpha():
        return "🌐"
    return "".join(chr(127397 + ord(c)) for c in a2.upper())


def page_head(title: str, description: str, canonical: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(description)}">
  <link rel="canonical" href="{esc(canonical)}">
  <meta property="og:title" content="{esc(title)}">
  <meta property="og:description" content="{esc(description)}">
  <meta property="og:type" content="website">
  <meta name="theme-color" content="#dc2626">
  <script src="https://cdn.tailwindcss.com"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <style>
    .prose a {{ color: #2563eb; text-decoration: underline; }}
    [x-cloak] {{ display: none !important; }}
  </style>
</head>"""


def nav(active: str | None = None) -> str:
    def link(href, label, key):
        is_active = "text-red-700 font-semibold" if active == key else "text-slate-600 hover:text-slate-900"
        return f'<a href="{href}" class="{is_active}">{label}</a>'
    return f"""
<header class="border-b border-slate-200 bg-white">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
    <a href="/" class="flex items-center gap-2 text-slate-900 font-semibold text-lg">
      <span aria-hidden="true" class="text-red-600 text-2xl">🆘</span>
      <span>Hotlines.world</span>
    </a>
    <nav class="flex items-center gap-5 text-sm">
      {link('/', 'Find a line', 'home')}
      {link('/about.html', 'About', 'about')}
      <a href="https://github.com/craigrallen/world-emergency-hotlines" class="text-slate-600 hover:text-slate-900" rel="noopener">Source</a>
    </nav>
  </div>
</header>"""


def footer() -> str:
    return f"""
<footer class="border-t border-slate-200 bg-slate-50 mt-16">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 py-8 text-sm text-slate-600 space-y-2">
    <p><strong>If you're in immediate danger,</strong> dial the general emergency number for your country — for example, 911 (North America), 999 (UK), 112 (EU), 000 (Australia). Most mobile phones route 112 to the local emergency service.</p>
    <p>Hotlines.world is a free directory built from open data sources. Numbers and hours change — verify on the provider's official site before acting. Not medical or legal advice. <a href="/about.html" class="underline">Methodology</a> · <a href="https://github.com/craigrallen/world-emergency-hotlines" class="underline" rel="noopener">Source on GitHub</a>.</p>
    <p class="text-slate-500">Last updated {datetime.utcnow().date().isoformat()}.</p>
  </div>
</footer>"""


def in_crisis_banner() -> str:
    return """
<section class="bg-red-50 border-b border-red-100">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
    <p class="text-red-800 font-semibold text-sm">In crisis right now?</p>
    <p class="text-red-700 text-sm">
      Call your country's emergency number (911, 999, 112, 000).
      Online support (global): <a href="https://findahelpline.com" class="underline font-medium" rel="noopener">findahelpline.com</a>.
    </p>
  </div>
</section>"""


def render_hotline_card(h: dict) -> str:
    cat = h.get("category") or "general_support"
    icon = CATEGORY_ICONS.get(cat, "📞")
    label = CATEGORY_LABELS.get(cat, cat)

    # Numbers
    number_rows = []
    for n in h.get("voice_numbers") or []:
        number_rows.append(
            f'<a href="tel:{esc(re.sub(r"[^0-9+*#]", "", n))}" class="block font-mono text-lg text-slate-900 hover:text-red-700">📞 {esc(n)}</a>'
        )
    for n in h.get("sms_numbers") or []:
        number_rows.append(
            f'<a href="sms:{esc(re.sub(r"[^0-9+*#]", "", n))}" class="block font-mono text-base text-slate-700 hover:text-red-700">💬 Text {esc(n)}</a>'
        )
    for n in h.get("short_codes") or []:
        number_rows.append(
            f'<div class="block font-mono text-base text-slate-700">🔢 {esc(n)}</div>'
        )

    extras = []
    if h.get("chat_url"):
        extras.append(
            f'<a href="{esc(h["chat_url"])}" class="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline" target="_blank" rel="noopener">💬 Live chat ↗</a>'
        )
    if h.get("email"):
        extras.append(
            f'<a href="mailto:{esc(h["email"])}" class="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline">✉️ {esc(h["email"])}</a>'
        )
    if h.get("website"):
        extras.append(
            f'<a href="{esc(h["website"])}" class="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline" target="_blank" rel="noopener">🌐 Website ↗</a>'
        )

    meta_bits = []
    if h.get("hours"):
        meta_bits.append(f'<span class="text-slate-700">⏰ {esc(h["hours"])}</span>')
    if h.get("languages"):
        langs = ", ".join(h["languages"]) if isinstance(h["languages"], list) else h["languages"]
        if langs:
            meta_bits.append(f'<span class="text-slate-700">🗣️ {esc(langs)}</span>')
    if h.get("cost") and h["cost"] != "unknown":
        cost_label = {
            "free": "Free",
            "free_from_mobile": "Free from mobile",
            "free_from_landline": "Free from landline",
            "local_rate": "Local-rate call",
            "standard_rate": "Standard call rate",
            "paid": "Premium / paid",
        }.get(h["cost"], h["cost"])
        meta_bits.append(f'<span class="text-slate-700">💰 {esc(cost_label)}</span>')

    status = h.get("verification_status", "legacy_unverified")
    status_badge = {
        "verified_web": ('Verified on site', 'bg-green-100 text-green-800'),
        "verified_authority": ('Verified (authority)', 'bg-green-100 text-green-800'),
        "verified_knowledge": ('Curated', 'bg-sky-100 text-sky-800'),
        "legacy_unverified": ('Imported', 'bg-slate-100 text-slate-600'),
        "disputed": ('Disputed', 'bg-amber-100 text-amber-800'),
        "deprecated": ('Deprecated', 'bg-red-100 text-red-800'),
    }.get(status, ('Unknown', 'bg-slate-100 text-slate-600'))

    notes_html = ""
    if h.get("notes"):
        notes_html = f'<p class="text-sm text-slate-600 mt-2">{esc(h["notes"])}</p>'

    target_html = ""
    if h.get("target"):
        target_html = f'<p class="text-sm text-slate-500 mt-1">For: {esc(h["target"])}</p>'

    return f"""
<article class="bg-white border border-slate-200 rounded-xl p-5 hover:border-slate-300 transition-colors">
  <header class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
        <span aria-hidden="true">{icon}</span>
        <a href="/category/{slugify(cat)}.html" class="uppercase tracking-wide hover:text-red-700">{esc(label)}</a>
      </div>
      <h3 class="text-base font-semibold text-slate-900 leading-snug">{esc(h.get("name", ""))}</h3>
    </div>
    <span class="shrink-0 inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full {status_badge[1]}">{status_badge[0]}</span>
  </header>
  <div class="mt-3 space-y-1">
    {"".join(number_rows)}
  </div>
  <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
    {"".join(meta_bits)}
  </div>
  <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1">
    {"".join(extras)}
  </div>
  {target_html}
  {notes_html}
</article>"""


def build_home(data):
    countries = sorted(data["countries"], key=lambda c: c["country"])
    total_hotlines = sum(len(c["hotlines"]) for c in data["countries"])
    # Build country grid
    rows = []
    for c in countries:
        if len(c["hotlines"]) == 0:
            continue
        rows.append(
            f'<a href="/country/{esc(c["alpha-2"]).lower()}.html" class="flex items-center gap-3 p-3 rounded-lg border border-slate-200 hover:border-red-400 hover:bg-red-50 transition-colors">'
            f'<span class="text-2xl" aria-hidden="true">{flag(c.get("alpha-2",""))}</span>'
            f'<span class="flex-1 min-w-0"><span class="block font-medium text-slate-900 truncate">{esc(c["country"])}</span>'
            f'<span class="block text-xs text-slate-500">{len(c["hotlines"])} lines</span></span></a>'
        )
    country_grid = "\n".join(rows)

    category_tiles = []
    for cat, label in CATEGORY_LABELS.items():
        icon = CATEGORY_ICONS.get(cat, "📞")
        category_tiles.append(
            f'<a href="/category/{slugify(cat)}.html" class="flex items-center gap-3 p-4 rounded-lg border border-slate-200 hover:border-slate-400 bg-white transition-colors">'
            f'<span class="text-2xl" aria-hidden="true">{icon}</span>'
            f'<span class="font-medium text-slate-900">{esc(label)}</span></a>'
        )

    return page_head(
        "Hotlines.world — emergency & crisis support in every country",
        "Free directory of emergency numbers, suicide crisis lines, child protection, domestic violence and other crisis support hotlines for every country.",
        "https://hotlines.world/",
    ) + f"""
<body class="bg-slate-50 text-slate-900 antialiased">
{nav(active='home')}
{in_crisis_banner()}

<main>
  <section class="bg-white border-b border-slate-200">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 py-12">
      <h1 class="text-3xl sm:text-4xl font-bold tracking-tight">Emergency & crisis lines, every country.</h1>
      <p class="mt-3 text-slate-600 max-w-2xl">{total_hotlines:,} hotlines across {len(countries)} countries and territories. Free, offline-friendly, open-source.</p>

      <div x-data="{{ q: '', all: [], results: [], loaded: false }}" x-init="
        fetch('/data.json').then(r => r.json()).then(d => {{ all = []; for (const c of d.countries) for (const h of c.hotlines) all.push({{ country: c.country, alpha2: c['alpha-2'], name: h.name, category: h.category, numbers: (h.voice_numbers||[]).concat(h.sms_numbers||[]).join(' ') }}); loaded = true }});
        $watch('q', v => {{ if (v.length < 2) {{ results = []; return }} const needle = v.toLowerCase(); results = all.filter(r => r.country.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle) || r.numbers.includes(needle)).slice(0, 20) }})
      " class="mt-6 relative">
        <label for="q" class="sr-only">Search</label>
        <input id="q" type="search" x-model="q" placeholder="Search country, service or number..."
          class="w-full px-4 py-3 border border-slate-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
        <div x-show="results.length" x-cloak class="absolute z-10 left-0 right-0 mt-2 bg-white border border-slate-200 rounded-lg shadow-lg max-h-96 overflow-y-auto">
          <template x-for="r in results" :key="r.country + r.name">
            <a :href="'/country/' + r.alpha2.toLowerCase() + '.html'" class="block px-4 py-3 hover:bg-slate-50 border-b border-slate-100 last:border-0">
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-sm font-medium text-slate-900 truncate" x-text="r.name"></div>
                  <div class="text-xs text-slate-500 truncate"><span x-text="r.country"></span> · <span x-text="r.category"></span></div>
                </div>
                <div class="text-xs text-slate-500 font-mono whitespace-nowrap" x-text="r.numbers"></div>
              </div>
            </a>
          </template>
        </div>
      </div>
    </div>
  </section>

  <section class="max-w-6xl mx-auto px-4 sm:px-6 py-10">
    <h2 class="text-xl font-semibold text-slate-900 mb-4">Browse by category</h2>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {"".join(category_tiles)}
    </div>
  </section>

  <section class="max-w-6xl mx-auto px-4 sm:px-6 py-10">
    <h2 class="text-xl font-semibold text-slate-900 mb-4">Pick your country</h2>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {country_grid}
    </div>
  </section>
</main>

{footer()}
</body></html>"""


def build_country_page(c: dict) -> str:
    # Group hotlines by category
    groups = defaultdict(list)
    for h in c["hotlines"]:
        groups[h.get("category") or "general_support"].append(h)

    # Order: emergency first, then other categories in the standard order
    cat_order = list(CATEGORY_LABELS.keys())
    ordered = [k for k in cat_order if k in groups] + [k for k in groups if k not in cat_order]

    sections = []
    for cat in ordered:
        lines = groups[cat]
        icon = CATEGORY_ICONS.get(cat, "📞")
        sections.append(
            f'<section class="mt-8"><h2 id="{slugify(cat)}" class="text-lg font-semibold text-slate-900 flex items-center gap-2">'
            f'<span aria-hidden="true">{icon}</span>{esc(CATEGORY_LABELS.get(cat, cat))}'
            f'<span class="text-xs font-normal text-slate-500">({len(lines)})</span></h2>'
            f'<div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">'
            + "".join(render_hotline_card(h) for h in lines)
            + '</div></section>'
        )

    general_emergency_bar = ""
    if c.get("general_emergency"):
        nums = c["general_emergency"]
        big = ""
        for n in nums:
            big += f'<a href="tel:{esc(re.sub(r"[^0-9+*#]", "", n))}" class="inline-block font-mono text-2xl sm:text-3xl font-bold text-red-700 px-3 py-1 hover:bg-red-50 rounded">{esc(n)}</a>'
        general_emergency_bar = (
            f'<section class="mt-4 p-4 rounded-lg border border-red-200 bg-red-50">'
            f'<p class="text-sm text-red-800 font-semibold uppercase tracking-wide">General emergency</p>'
            f'<div class="mt-1 flex flex-wrap items-center gap-2">{big}</div>'
            + (f'<p class="mt-2 text-sm text-red-900">{esc(c.get("notes") or "")}</p>' if c.get("notes") else "")
            + '</section>'
        )

    return page_head(
        f'Emergency & crisis hotlines in {c["country"]} — Hotlines.world',
        f'Police, fire, ambulance and crisis support numbers in {c["country"]}: suicide, mental health, child protection, domestic violence, LGBTQIA+, substance use.',
        f'https://hotlines.world/country/{c["alpha-2"].lower()}.html',
    ) + f"""
<body class="bg-slate-50 text-slate-900 antialiased">
{nav()}
{in_crisis_banner()}

<main class="max-w-6xl mx-auto px-4 sm:px-6 py-8">
  <div class="flex items-center gap-3">
    <span class="text-4xl" aria-hidden="true">{flag(c.get("alpha-2",""))}</span>
    <div>
      <h1 class="text-2xl sm:text-3xl font-bold">{esc(c["country"])}</h1>
      <p class="text-sm text-slate-500">{len(c["hotlines"])} lines · <a href="/" class="underline">All countries</a></p>
    </div>
  </div>
  {general_emergency_bar}
  {"".join(sections)}
</main>

{footer()}
</body></html>"""


def build_category_page(cat: str, entries):
    icon = CATEGORY_ICONS.get(cat, "📞")
    label = CATEGORY_LABELS.get(cat, cat)
    # Group by country
    by_country = defaultdict(list)
    for c, h in entries:
        by_country[c["country"]].append((c, h))

    blocks = []
    for country_name in sorted(by_country.keys()):
        cc = by_country[country_name][0][0]
        cards = "".join(render_hotline_card(h) for _, h in by_country[country_name])
        blocks.append(
            f'<section class="mt-6"><h2 class="text-base font-semibold flex items-center gap-2">'
            f'<span class="text-xl">{flag(cc.get("alpha-2",""))}</span>'
            f'<a href="/country/{esc(cc["alpha-2"]).lower()}.html" class="hover:text-red-700">{esc(country_name)}</a></h2>'
            f'<div class="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">{cards}</div></section>'
        )

    return page_head(
        f'{label} hotlines worldwide — Hotlines.world',
        f'Crisis support lines for {label.lower()} in every country, with phone numbers, text, live chat and hours.',
        f'https://hotlines.world/category/{slugify(cat)}.html',
    ) + f"""
<body class="bg-slate-50 text-slate-900 antialiased">
{nav()}
{in_crisis_banner()}
<main class="max-w-6xl mx-auto px-4 sm:px-6 py-8">
  <div class="flex items-center gap-3">
    <span class="text-4xl" aria-hidden="true">{icon}</span>
    <div>
      <h1 class="text-2xl sm:text-3xl font-bold">{esc(label)} — worldwide</h1>
      <p class="text-sm text-slate-500">{len(entries)} lines across {len(by_country)} countries</p>
    </div>
  </div>
  {"".join(blocks)}
</main>
{footer()}
</body></html>"""


def build_about():
    return page_head(
        "About — Hotlines.world",
        "Methodology, data sources and verification status for Hotlines.world.",
        "https://hotlines.world/about.html",
    ) + f"""
<body class="bg-slate-50 text-slate-900 antialiased">
{nav(active='about')}
<main class="max-w-3xl mx-auto px-4 sm:px-6 py-10 prose">
  <h1>About Hotlines.world</h1>
  <p>A free, open-source directory of emergency numbers and crisis support helplines for every country in the world — suicide and mental-health crisis lines, child protection, domestic violence, LGBTQIA+, substance use, bereavement, and more.</p>

  <h2>How the data is sourced</h2>
  <p>Records come from three pipelines merged together:</p>
  <ol>
    <li><strong>Curated tier</strong> — hand-authored rich records (category, hours, languages, cost, target audience, website, notes) for every major country and most of the long tail. Labeled <em>Curated</em> in the UI.</li>
    <li><strong>Imported tier</strong> — records from public open-data sources (<code>atlacord/Naga</code>, <code>information.json</code>), re-categorised and deduplicated. Labeled <em>Imported</em> in the UI.</li>
    <li><strong>Web-verified tier</strong> — records that have been re-checked against the provider's official website. Labeled <em>Verified on site</em>.</li>
  </ol>

  <h2>Can I rely on it?</h2>
  <p>Treat this as a starting point, not a final source of truth. Crisis-line numbers and hours change. If you're routing someone in distress, confirm the number on the provider's official site on the day you publish. The <em>Verified on site</em> tag shows which records have been checked that way.</p>

  <h2>Data licence</h2>
  <p>The dataset is released under CC0 (public domain). See <a href="https://github.com/craigrallen/world-emergency-hotlines">github.com/craigrallen/world-emergency-hotlines</a> for the JSON, schema docs and change log.</p>

  <h2>Global crisis aggregators</h2>
  <ul>
    <li><a href="https://findahelpline.com" rel="noopener">Find A Helpline</a> (ThroughLine) — curated global directory with 13,000+ helplines.</li>
    <li><a href="https://www.befrienders.org" rel="noopener">Befrienders Worldwide</a> — network of emotional-support lines.</li>
    <li><a href="https://www.iasp.info/resources/Crisis_Centres/" rel="noopener">IASP Crisis Centres</a> — International Association for Suicide Prevention directory.</li>
  </ul>

  <h2>Report a correction</h2>
  <p>Open an issue on <a href="https://github.com/craigrallen/world-emergency-hotlines/issues">GitHub</a> or email the maintainer. Corrections land in the next dataset pass.</p>
</main>
{footer()}
</body></html>"""


def build_404():
    return page_head("Not found — Hotlines.world", "Page not found.", "https://hotlines.world/404.html") + f"""
<body class="bg-slate-50 text-slate-900 antialiased">
{nav()}
<main class="max-w-2xl mx-auto px-6 py-20 text-center">
  <h1 class="text-3xl font-bold">Not found</h1>
  <p class="mt-3 text-slate-600">The page you were looking for isn't here. Try starting from the <a class="underline" href="/">home page</a>.</p>
</main>
{footer()}
</body></html>"""


def build_robots():
    return "User-agent: *\nAllow: /\nSitemap: https://hotlines.world/sitemap.xml\n"


def build_sitemap(data):
    urls = ["https://hotlines.world/", "https://hotlines.world/about.html"]
    for c in data["countries"]:
        if c["hotlines"]:
            urls.append(f'https://hotlines.world/country/{c["alpha-2"].lower()}.html')
    for cat in CATEGORY_LABELS:
        urls.append(f'https://hotlines.world/category/{slugify(cat)}.html')
    body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    for u in urls:
        body += f"  <url><loc>{esc(u)}</loc></url>\n"
    body += "</urlset>\n"
    return body


def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))

    # Don't rmtree (OneDrive locks sub-files); just (re)create dirs and overwrite.
    (OUT / "country").mkdir(parents=True, exist_ok=True)
    (OUT / "category").mkdir(parents=True, exist_ok=True)

    # home
    (OUT / "index.html").write_text(build_home(data), encoding="utf-8")
    (OUT / "about.html").write_text(build_about(), encoding="utf-8")
    (OUT / "404.html").write_text(build_404(), encoding="utf-8")

    # country pages
    for c in data["countries"]:
        if not c.get("alpha-2"):
            continue
        (OUT / "country" / f'{c["alpha-2"].lower()}.html').write_text(
            build_country_page(c), encoding="utf-8"
        )

    # category pages
    cat_entries = defaultdict(list)
    for c in data["countries"]:
        for h in c["hotlines"]:
            cat_entries[h.get("category") or "general_support"].append((c, h))
    for cat, entries in cat_entries.items():
        (OUT / "category" / f"{slugify(cat)}.html").write_text(
            build_category_page(cat, entries), encoding="utf-8"
        )

    # supporting files
    (OUT / "data.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    (OUT / "robots.txt").write_text(build_robots(), encoding="utf-8")
    (OUT / "sitemap.xml").write_text(build_sitemap(data), encoding="utf-8")

    total_pages = len(list(OUT.rglob("*.html")))
    print(f"Built {total_pages} pages into {OUT}")


if __name__ == "__main__":
    main()
