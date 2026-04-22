from __future__ import annotations

import html
import json
import re
import unicodedata
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any

BASE_URL = "https://childhelplineinternational.org"
DIRECTORY_URL = f"{BASE_URL}/helplines/"
WP_API_ROOT = f"{BASE_URL}/wp-json/wp/v2"
CATEGORY_SLUG = "child-helpline"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/html, */*;q=0.1",
    "Accept-Language": "en-US,en;q=0.9",
}
BLOCK_TAGS = {
    "p",
    "div",
    "section",
    "article",
    "li",
    "ul",
    "ol",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "br",
}
SOCIAL_LABELS = {
    "facebook": "facebook",
    "instagram": "instagram",
    "twitter": "twitter",
    "x": "x",
    "youtube": "youtube",
    "linkedin": "linkedin",
    "tiktok": "tiktok",
}


@dataclass
class LinkItem:
    text: str
    href: str


class _RenderedHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._line_parts: list[str] = []
        self.lines: list[str] = []
        self.links: list[LinkItem] = []
        self._current_href: str | None = None
        self._current_link_parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag in BLOCK_TAGS:
            self._flush_line()
        if tag == "a":
            self._current_href = dict(attrs).get("href")
            self._current_link_parts = []

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if tag in BLOCK_TAGS:
            self._flush_line()
        if tag == "a" and self._current_href:
            text = normalize_whitespace("".join(self._current_link_parts))
            if text:
                self.links.append(LinkItem(text=text, href=self._current_href))
            self._current_href = None
            self._current_link_parts = []

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = normalize_whitespace(data)
        if not text:
            return
        self._line_parts.append(text)
        if self._current_href:
            self._current_link_parts.append(text)

    def close(self) -> None:
        super().close()
        self._flush_line()

    def _flush_line(self) -> None:
        line = normalize_whitespace(" ".join(self._line_parts))
        if line:
            self.lines.append(line)
        self._line_parts = []


def normalize_whitespace(value: str | None) -> str:
    return " ".join((value or "").replace("\xa0", " ").split())


def normalize_name(name: str) -> str:
    text = (name or "").lower().strip().replace("&", "and")
    text = "".join(
        ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch)
    )
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def get_json(url: str) -> Any:
    request = urllib.request.Request(url, headers=DEFAULT_HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def get_child_helpline_category_id() -> int:
    categories = get_json(f"{WP_API_ROOT}/categories?slug={CATEGORY_SLUG}")
    if not categories:
        raise RuntimeError(f"Could not resolve Child Helpline category slug {CATEGORY_SLUG!r}")
    return int(categories[0]["id"])


def get_category_map() -> dict[int, dict[str, Any]]:
    categories: dict[int, dict[str, Any]] = {}
    page = 1
    while True:
        payload = get_json(f"{WP_API_ROOT}/categories?per_page=100&page={page}")
        if not payload:
            break
        for item in payload:
            categories[int(item["id"])] = item
        if len(payload) < 100:
            break
        page += 1
    return categories


def fetch_child_helpline_posts() -> list[dict[str, Any]]:
    category_id = get_child_helpline_category_id()
    posts: list[dict[str, Any]] = []
    page = 1
    while True:
        payload = get_json(
            f"{WP_API_ROOT}/posts?categories={category_id}&per_page=100&page={page}&orderby=slug&order=asc"
        )
        if not payload:
            break
        posts.extend(payload)
        if len(payload) < 100:
            break
        page += 1
    return posts


def strip_html(value: str | None) -> str:
    parser = _RenderedHtmlParser()
    parser.feed(value or "")
    parser.close()
    return "\n".join(parser.lines)


def parse_rendered_html(value: str | None) -> tuple[list[str], list[LinkItem]]:
    parser = _RenderedHtmlParser()
    parser.feed(value or "")
    parser.close()
    lines = [line for line in parser.lines if line and line != "< Back to Child Helplines"]
    links = [link for link in parser.links if link.text and "Back to Child Helplines" not in link.text]
    return lines, links


def visible_phone_text(text: str, href: str) -> str:
    cleaned = normalize_whitespace(text)
    cleaned = re.sub(r"^(Call|Text|SMS|WhatsApp|Whatsapp)\s+", "", cleaned, flags=re.I)
    if cleaned:
        return cleaned
    href_value = href.removeprefix("tel:")
    return normalize_whitespace(href_value)


def is_probable_domain(text: str) -> bool:
    return bool(re.search(r"[A-Za-z0-9-]+\.[A-Za-z]{2,}", text or ""))


def classify_links(links: list[LinkItem]) -> dict[str, Any]:
    contacts: dict[str, Any] = {
        "voice_numbers": [],
        "sms_numbers": [],
        "chat_urls": [],
        "emails": [],
        "websites": [],
        "social_urls": {},
        "other_urls": [],
    }
    for link in links:
        text = normalize_whitespace(html.unescape(link.text))
        href = normalize_whitespace(link.href)
        lowered_text = text.lower()
        lowered_href = href.lower()
        if href.startswith("tel:"):
            number = visible_phone_text(text, href)
            if not number:
                continue
            if lowered_text.startswith(("text", "sms", "whatsapp")):
                contacts["sms_numbers"].append(number)
            else:
                contacts["voice_numbers"].append(number)
            continue
        if href.startswith("mailto:"):
            email_value = href.removeprefix("mailto:").strip() or text.replace("Email", "").strip()
            if email_value:
                contacts["emails"].append(email_value)
            continue
        if not href.startswith(("http://", "https://")):
            continue
        social_key = None
        for label, normalized in SOCIAL_LABELS.items():
            if lowered_text == label or f"{label}.com" in lowered_href or f"/{label}" in lowered_href:
                social_key = normalized
                break
        if social_key:
            contacts["social_urls"][social_key] = href
            continue
        if any(keyword in lowered_text for keyword in ("chat", "message online", "online consultation", "webchat", "line")):
            contacts["chat_urls"].append(href)
            continue
        if lowered_text == "website" or is_probable_domain(text):
            contacts["websites"].append(href)
            continue
        contacts["other_urls"].append({"label": text, "url": href})
    for key in ("voice_numbers", "sms_numbers", "chat_urls", "emails", "websites"):
        contacts[key] = unique_strings(contacts[key])
    contacts["other_urls"] = unique_dicts(contacts["other_urls"])
    return contacts


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        marker = normalize_whitespace(value)
        if not marker or marker in seen:
            continue
        seen.add(marker)
        output.append(marker)
    return output


def unique_dicts(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    output: list[dict[str, Any]] = []
    for value in values:
        marker = json.dumps(value, ensure_ascii=False, sort_keys=True)
        if marker in seen:
            continue
        seen.add(marker)
        output.append(value)
    return output


def _section_values(lines: list[str], start_prefix: str, stop_markers: tuple[str, ...]) -> list[str]:
    capture = False
    values: list[str] = []
    for line in lines:
        if line.startswith(start_prefix):
            capture = True
            continue
        if capture and line in stop_markers:
            break
        if capture and line:
            values.append(line)
    return values


def parse_post(post: dict[str, Any], category_map: dict[int, dict[str, Any]]) -> dict[str, Any]:
    title = html.unescape(post["title"]["rendered"])
    if ":" not in title:
        raise ValueError(f"Unexpected Child Helpline post title without country prefix: {title!r}")
    country_name, service_name = [normalize_whitespace(part) for part in title.split(":", 1)]
    lines, links = parse_rendered_html(post.get("content", {}).get("rendered"))
    summary_lines: list[str] = []
    for line in lines:
        if line in {"Services", "Operating Information", "Contact Details"}:
            break
        summary_lines.append(line)
    services = _section_values(lines, f"{service_name} offers:", ("Operating Information", "Contact Details"))
    languages = _section_values(lines, f"{service_name} provides service in:", ("Opening hours are:", "Contact Details"))
    hours = _section_values(lines, "Opening hours are:", ("Contact Details",))
    contacts = classify_links(links)
    categories = [category_map.get(int(cat_id), {}) for cat_id in post.get("categories", [])]
    region_names = [html.unescape(item.get("name", "")) for item in categories if item.get("slug") != CATEGORY_SLUG]
    return {
        "country_name": country_name,
        "service_name": service_name,
        "source_url": post.get("link"),
        "source_post_id": post.get("id"),
        "source_post_slug": post.get("slug"),
        "source_post_status": post.get("status"),
        "source_post_date": post.get("date"),
        "source_post_modified": post.get("modified"),
        "source_post_modified_gmt": post.get("modified_gmt"),
        "source_regions": unique_strings(region_names),
        "summary": normalize_whitespace(" ".join(summary_lines)),
        "services": unique_strings(services),
        "languages": unique_strings(languages),
        "hours": normalize_whitespace(" ".join(hours)) or None,
        "voice_numbers": contacts["voice_numbers"],
        "sms_numbers": contacts["sms_numbers"],
        "chat_urls": contacts["chat_urls"],
        "emails": contacts["emails"],
        "websites": contacts["websites"],
        "social_urls": contacts["social_urls"],
        "other_contact_urls": contacts["other_urls"],
        "source_excerpt": normalize_whitespace(strip_html(post.get("excerpt", {}).get("rendered"))),
        "source_content_lines": lines,
    }


def build_country_directory(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in entries:
        grouped[entry["country_name"]].append(entry)
    countries: list[dict[str, Any]] = []
    for country_name in sorted(grouped):
        helplines = sorted(grouped[country_name], key=lambda item: (item["service_name"], item["source_post_slug"]))
        countries.append(
            {
                "country_name": country_name,
                "source_regions": unique_strings(
                    [region for helpline in helplines for region in helpline.get("source_regions", [])]
                ),
                "source_urls": unique_strings([helpline["source_url"] for helpline in helplines if helpline.get("source_url")]),
                "helplines": helplines,
            }
        )
    return countries
