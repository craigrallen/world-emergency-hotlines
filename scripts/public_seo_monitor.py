#!/usr/bin/env python3
"""Secretless, fixed-origin production SEO contract monitor."""
from __future__ import annotations

import argparse
import datetime as dt
import html
import importlib.util
import json
import re
import socket
import struct
import time
import urllib.parse
import unicodedata
import xml.etree.ElementTree as ET
import zlib
from html.parser import HTMLParser
from pathlib import Path

try:
    from scripts.artifact_io import coordinated_write, guard_paths
    from scripts.monitor_delta import MAX_ISSUES, validate_result
except ModuleNotFoundError:
    from artifact_io import coordinated_write, guard_paths
    from monitor_delta import MAX_ISSUES, validate_result

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("source_monitor_primitives", ROOT / "scripts/source_monitor.py")
sm = importlib.util.module_from_spec(spec); spec.loader.exec_module(sm)

ORIGIN = "https://worldhotlines.org"
HOST = "worldhotlines.org"
ROUTES = {"home": "/", "robots": "/robots.txt", "sitemap": "/sitemap.xml",
          "country": "/country/us", "category": "/category/emergency",
          "noindex": "/status", "image": "/social-card.png"}
MAX_BYTES = 512_000
MAX_SITEMAP_URLS = 2_000
MAX_REDIRECTS = 3
MAX_X_ROBOTS_HEADERS = 16
MAX_X_ROBOTS_BYTES = 4096
MAX_ROBOTS_RECORDS = 1000
MAX_PARSED_ANCHORS = 256
MAX_PARSED_META = 64
MAX_PARSED_JSONLD = 16
MAX_PARSED_SCRIPTS = 32
MAX_PARSED_IDS = 256
MAX_PARSED_CLASSES = 256
MAX_PARSED_TEXT = 16
MAX_ISSUE_CANDIDATES = 1_000
MAX_HTML_DEPTH = 128
MAX_CAPTURE_CHARS = 16_384
MAX_ATTRIBUTE_CHARS = 2_048
MAX_JSON_BYTES = 64_000
MAX_MARKDOWN_BYTES = 48_000
MAX_SITEMAP_ELEMENTS = 6_000
MAX_SITEMAP_DEPTH = 8
MAX_SITEMAP_ATTRIBUTES = 8
MAX_SITEMAP_FIELD_BYTES = 4_096
MAX_SITEMAP_TEXT_BYTES = 256_000
REQUEST_TIMEOUT = 10.0
RUN_TIMEOUT = 75.0
JSONLD_TYPES = {"WebSite", "Organization", "BreadcrumbList"}
JSONLD_REQUIRED = {"home": {"WebSite": 1, "Organization": 1},
                   "country": {"BreadcrumbList": 1}, "category": {"BreadcrumbList": 1},
                   "noindex": {}}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
SOCIAL_IMAGE = ORIGIN + "/social-card.png"
TEXT_LIMITS = {"title": 200, "description": 500, "h1": 300, "alt": 300}


def fixed_url(path: str) -> str:
    if path not in ROUTES.values():
        raise ValueError("route_not_allowlisted")
    return ORIGIN + path


def validate_origin_url(url: str) -> str:
    try: parsed = urllib.parse.urlsplit(url)
    except ValueError as exc: raise ValueError("malformed_url") from exc
    if (parsed.scheme, (parsed.hostname or "").lower(), parsed.port, parsed.username, parsed.password,
            parsed.query, parsed.fragment) != ("https", HOST, None, None, None, "", ""):
        raise ValueError("outside_fixed_origin")
    return urllib.parse.urlunsplit(("https", HOST, parsed.path or "/", "", ""))


def fetch_resource(url: str, *, resolver=socket.getaddrinfo, connection_factory=sm.PinnedConnection,
                   deadline=None) -> dict:
    deadline = min(deadline or time.monotonic() + REQUEST_TIMEOUT, time.monotonic() + REQUEST_TIMEOUT)
    current = validate_origin_url(url); resolved = None
    for redirect_count in range(MAX_REDIRECTS + 1):
        try:
            identity, port, addresses = resolved or sm.resolve_public(current, resolver, deadline)
            validate_origin_url(identity); resolved = None
            parsed = urllib.parse.urlsplit(identity); response = None; last_error = None
            for pinned in addresses:
                connection = connection_factory(HOST, port, pinned, set(addresses), deadline, True)
                try:
                    connection.request("GET", parsed.path or "/", headers={"Host": HOST, "User-Agent": sm.UA,
                                      "Accept": "text/html,application/xml,text/plain,image/png;q=0.8", "Connection": "close"})
                    response = connection.getresponse(); break
                except Exception as exc:
                    last_error = exc; connection.close()
            if response is None: raise last_error or OSError("connection_failed")
            try:
                status = response.status
                if status in sm.REDIRECT_STATUSES:
                    location = response.getheader("Location")
                    if not location: raise ValueError("redirect_without_location")
                    if redirect_count == MAX_REDIRECTS: raise ValueError("redirect_limit")
                    target = validate_origin_url(urllib.parse.urljoin(identity, location))
                    resolved = sm.resolve_public(target, resolver, deadline); current = target; continue
                body, truncated = sm._read_bounded(response, deadline)
                header_values=[]; header_bytes=0; header_error=None
                for key,value in (response.getheaders() if hasattr(response,"getheaders") else []):
                    if key.casefold() != "x-robots-tag": continue
                    encoded=value.encode("latin-1", "replace")
                    header_bytes += len(encoded)
                    if len(header_values) >= MAX_X_ROBOTS_HEADERS or header_bytes > MAX_X_ROBOTS_BYTES:
                        header_error="x_robots_tag_oversized"; break
                    header_values.append(value)
                return {"status": status, "final_url": identity, "body": body, "truncated": truncated,
                        "content_type": response.getheader("Content-Type", "").strip().lower()[:200],
                        "x_robots_tag": header_values, "x_robots_tag_error": header_error,
                        "redirect_count": redirect_count, "redirected": redirect_count > 0}
            finally: connection.close()
        except (ValueError, OSError, TimeoutError, sm.http.client.HTTPException) as exc:
            reason = str(exc) if str(exc) in {"outside_fixed_origin", "redirect_limit", "redirect_without_location", "peer_address_mismatch", "total_deadline"} else type(exc).__name__
            return {"error": reason, "status": None, "final_url": current, "body": b"", "truncated": False,
                    "content_type": "", "redirect_count": redirect_count, "redirected": redirect_count > 0}
    raise AssertionError("redirect loop")


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(); self.canonicals=[]; self.robots=[]; self.metadata={}; self.jsonld=[]
        self.titles=[]; self.h1s=[]; self.ids=set(); self.links=[]; self.classes=[]
        self._json=False; self._parts=[]; self._part_chars=0; self._stack=[]; self._text_capture=[]
        self._depth=0; self.scripts=0; self.overflows=set()
        self._meta_count=0
    def _append(self, collection, value, maximum, name):
        if len(collection) < maximum: collection.append(value)
        else: self.overflows.add(name)
    def _bounded(self, value):
        if not isinstance(value,str): return ""
        if len(value) > MAX_ATTRIBUTE_CHARS:
            self.overflows.add("attributes"); return value[:MAX_ATTRIBUTE_CHARS]
        return value
    def handle_starttag(self, tag, attrs):
        raw_tag=(self.get_starttag_text() or "")[:MAX_ATTRIBUTE_CHARS]
        unsafe_decoded_href=False
        if tag == "a":
            match=re.search(r'''(?is)\bhref\s*=\s*(["'])(.*?)\1''',raw_tag)
            if match:
                for numeric in re.findall(r"&#(?:x([0-9a-f]+)|([0-9]+));?",match.group(2),re.I):
                    point=int(numeric[0],16) if numeric[0] else int(numeric[1],10)
                    if point > 0x10ffff or not chr(point).isprintable() or unicodedata.category(chr(point))[0] in {"C","Z"}:
                        unsafe_decoded_href=True
        values = {key:self._bounded(value) for key,value in attrs if key is not None}
        rel = set((values.get("rel") or "").casefold().split())
        containers=[]
        if "data-hotline-card" in values: containers.append(("card", values.get("data-record-id", "")))
        if "data-prioritized-listing" in values: containers.append(("prioritized", values.get("data-prioritized-record-id", "")))
        inherited=list(self._stack[-1][1]) if self._stack else []
        self._depth += 1
        if len(self._stack) < MAX_HTML_DEPTH: self._stack.append((tag, inherited + containers))
        else: self.overflows.add("depth")
        if values.get("id"):
            if len(self.ids) < MAX_PARSED_IDS: self.ids.add(values["id"])
            else: self.overflows.add("ids")
        if values.get("class"):
            for token in values["class"].split(): self._append(self.classes,token,MAX_PARSED_CLASSES,"classes")
        if tag == "link" and "canonical" in rel:
            if self._meta_count < MAX_PARSED_META: self.canonicals.append(values.get("href", "")); self._meta_count += 1
            else: self.overflows.add("meta")
        robots_meta=tag == "meta" and (values.get("name") or "").casefold() == "robots"
        if robots_meta:
            if self._meta_count < MAX_PARSED_META: self.robots.append(values.get("content", "")); self._meta_count += 1
            else: self.overflows.add("meta")
        if tag == "meta":
            key=((values.get("property") or values.get("name") or "").strip().casefold())
            if key and self._meta_count < MAX_PARSED_META:
                self.metadata.setdefault(key,[]).append(values.get("content", "")); self._meta_count += 1
            elif key: self.overflows.add("meta")
        if tag == "a" and values.get("href"):
            safe_attrs={key:values[key] for key in ("data-phone-contact","data-message-contact","data-record-id","data-prioritized-record-id") if key in values}
            if unsafe_decoded_href: safe_attrs["_unsafe_href_decode"]="1"
            self._append(self.links,(values["href"],safe_attrs,inherited+containers),MAX_PARSED_ANCHORS,"anchors")
        if tag == "script":
            self.scripts += 1
            if self.scripts > MAX_PARSED_SCRIPTS: self.overflows.add("scripts")
            elif (values.get("type") or "").casefold() == "application/ld+json": self._json=True; self._parts=[]; self._part_chars=0
        if tag in {"title","h1"}:
            if len(self._text_capture) < MAX_PARSED_TEXT: self._text_capture.append((tag,[]))
            else: self.overflows.add("text")
    def handle_data(self, data):
        if self._json:
            remaining=MAX_CAPTURE_CHARS-self._part_chars
            if remaining > 0: self._parts.append(data[:remaining]); self._part_chars += min(len(data),remaining)
            if len(data) > remaining: self.overflows.add("jsonld")
        if self._text_capture:
            parts=self._text_capture[-1][1]; retained=sum(map(len,parts)); remaining=MAX_CAPTURE_CHARS-retained
            if remaining > 0: parts.append(data[:remaining])
            if len(data) > remaining: self.overflows.add("text")
    def handle_endtag(self, tag):
        if tag == "script" and self._json:
            self._append(self.jsonld,"".join(self._parts),MAX_PARSED_JSONLD,"jsonld"); self._json=False
        if self._text_capture and self._text_capture[-1][0] == tag:
            value="".join(self._text_capture.pop()[1]).strip()
            self._append(self.titles if tag == "title" else self.h1s,value,MAX_PARSED_TEXT,"text")
        for index in range(len(self._stack)-1,-1,-1):
            if self._stack[index][0] == tag:
                del self._stack[index:]; break
        self._depth=max(0,self._depth-1)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs); self.handle_endtag(tag)


def issue(code, subject, detail): return {"code": code[:80], "subject": subject[:300], "detail": detail[:200]}


class IssueCandidates(list):
    """A bounded list that reserves one slot for an exact overflow count."""
    def __init__(self, subject): super().__init__(); self.subject=subject; self.omitted=0
    def append(self, row):
        if len(self) < MAX_ISSUE_CANDIDATES-1: super().append(row); return
        self.omitted += 1
        summary=issue("issue_candidates_overflow",self.subject,f"{self.omitted} issue candidates omitted")
        if len(self) == MAX_ISSUE_CANDIDATES-1: super().append(summary)
        else: self[-1]=summary
    def extend(self, rows):
        for row in rows: self.append(row)


def bounded_issues(candidates):
    unique=sorted({(row["code"],row["subject"],row["detail"]) for row in candidates})
    omitted=max(0,len(unique)-(MAX_ISSUES-1))
    if omitted:
        unique=unique[:MAX_ISSUES-1]+[("issues_truncated","public-seo",f"{omitted} additional unique issues omitted")]
    return [issue(*row) for row in unique]


def cap_candidates(candidates, subject):
    if len(candidates) <= MAX_ISSUE_CANDIDATES: return candidates
    return candidates[:MAX_ISSUE_CANDIDATES]+[issue("issue_candidates_overflow",subject,"issue candidate count exceeded bound")]


def _mime(value, media_type):
    return bool(re.fullmatch(re.escape(media_type)+r"(?:\s*;\s*charset\s*=\s*(?:utf-8|\"utf-8\"))?",value,re.I))


def _jsonld_problems(name, route, blocks):
    problems=IssueCandidates(route); roots=[]; expected=ORIGIN+route
    for block in blocks:
        try: value=json.loads(block)
        except json.JSONDecodeError: problems.append(issue("jsonld_invalid", route, "JSON-LD is malformed")); continue
        values=value if isinstance(value,list) else [value]
        if len(values) > 10: problems.append(issue("jsonld_count", route, "JSON-LD root count exceeds bound")); continue
        for root in values:
            if (not isinstance(root,dict) or root.get("@context") != "https://schema.org"
                    or type(root.get("@type")) is not str or root["@type"] not in JSONLD_TYPES):
                problems.append(issue("jsonld_contract", route, "JSON-LD context or root type is unsupported")); continue
            roots.append(root)
            if root["@type"] in {"WebSite", "Organization"}:
                try: bound=validate_origin_url(root.get("url"))
                except (TypeError,ValueError): bound=None
                if bound != expected: problems.append(issue("jsonld_route_binding", route, "JSON-LD root URL must match its route"))
            if root["@type"] == "BreadcrumbList":
                items=root.get("itemListElement")
                if not isinstance(items,list) or not 2 <= len(items) <= 20:
                    problems.append(issue("jsonld_breadcrumb", route, "breadcrumb items are missing or unbounded")); continue
                for index,item in enumerate(items):
                    try: item_url=validate_origin_url(item.get("item"))
                    except (AttributeError,TypeError,ValueError): item_url=None
                    if (not isinstance(item,dict) or set(item) != {"@type","position","name","item"}
                            or item.get("@type") != "ListItem" or item.get("position") != index+1
                            or not isinstance(item.get("name"),str) or not 0 < len(item["name"].strip()) <= 200
                            or item_url is None):
                        problems.append(issue("jsonld_breadcrumb", route, "breadcrumb item is invalid")); break
                    if index == len(items)-1 and item_url != expected:
                        problems.append(issue("jsonld_route_binding", route, "final breadcrumb must match its route"))
    counts={kind:sum(root.get("@type")==kind for root in roots) for kind in JSONLD_TYPES}
    required=JSONLD_REQUIRED[name]
    if any(counts[kind] != count for kind,count in required.items()) or any(counts[kind] for kind in counts if kind not in required):
        problems.append(issue("jsonld_required", route, "route JSON-LD types/counts do not match production contract"))
    return problems


def robots_directives(values):
    """Return applicable generic/Googlebot directives from bounded header fields."""
    directives=[]
    for value in values:
        if not isinstance(value,str) or any(ord(c) < 32 and c != "\t" for c in value):
            raise ValueError("malformed")
        current_prefix=None
        for piece in value.split(","):
            token=piece.strip().casefold()
            if not token: raise ValueError("malformed")
            if ":" in token:
                prefix,token=token.split(":",1); prefix=prefix.strip(); token=token.strip()
                if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}",prefix) or not token:
                    raise ValueError("malformed")
                current_prefix=prefix
            if current_prefix in {None,"googlebot"}:
                if not re.fullmatch(r"[a-z][a-z0-9_-]*(?:\s*:\s*[^,]+)?",token):
                    raise ValueError("malformed")
                directives.append(token.split(":",1)[0].strip())
    expanded=[]
    for token in directives:
        expanded.extend(("noindex","nofollow") if token == "none" else (token,))
    return expanded


def inspect_html(name, route, raw, sitemap_urls, header_values=(), header_error=None):
    problems=IssueCandidates(route); parser=PageParser()
    try: parser.feed(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError): return [issue("html_invalid", route, "response is not valid UTF-8 HTML")]
    expected=ORIGIN+route
    noindex=name == "noindex"
    if len(parser.titles)!=1 or not parser.titles[0] or len(parser.titles[0])>TEXT_LIMITS["title"]:
        problems.append(issue("title_contract",route,"expected exactly one nonempty bounded title"))
    descriptions=parser.metadata.get("description",[])
    if len(descriptions)!=1 or not descriptions[0].strip() or len(descriptions[0].strip())>TEXT_LIMITS["description"]:
        problems.append(issue("description_contract",route,"expected exactly one nonempty bounded meta description"))
    if len(parser.h1s)!=1 or not parser.h1s[0] or len(parser.h1s[0])>TEXT_LIMITS["h1"]:
        problems.append(issue("h1_contract",route,"expected exactly one nonempty bounded H1"))
    if len(parser.robots) != 1 and not (noindex and len(parser.robots) == 0): problems.append(issue("robots_meta_count", route, "expected exactly one robots meta"))
    expected_robots="noindex,follow" if noindex else "index,follow"
    if len(parser.robots) == 1 and parser.robots[0].strip().casefold() != expected_robots:
        problems.append(issue("robots_directive", route, f"expected exactly {expected_robots}"))
    try: header_directives=robots_directives(header_values)
    except ValueError: header_directives=[]; problems.append(issue("x_robots_tag_malformed",route,"X-Robots-Tag is malformed"))
    if header_error: problems.append(issue("x_robots_tag_oversized",route,"X-Robots-Tag exceeded bounded transport limits"))
    meta_directives=[] if not parser.robots else [x.strip().casefold() for x in parser.robots[0].split(",")]
    effective=meta_directives+header_directives
    if "index" in effective and "noindex" in effective:
        problems.append(issue("robots_conflict",route,"applicable index and noindex directives conflict"))
    if "follow" in effective and "nofollow" in effective:
        problems.append(issue("robots_conflict",route,"applicable follow and nofollow directives conflict"))
    if noindex:
        if "noindex" not in effective or "follow" not in effective or "nofollow" in effective:
            problems.append(issue("robots_directive",route,"status must effectively be noindex,follow"))
    elif "noindex" in effective or "nofollow" in effective:
        problems.append(issue("x_robots_tag_directive",route,"indexable route has an applicable blocking directive"))
    if noindex:
        if parser.canonicals or parser.metadata.get("og:url",[]): problems.append(issue("noindex_url_metadata", route, "noindex route must omit canonical and og:url"))
        if expected in sitemap_urls: problems.append(issue("noindex_in_sitemap", route, "noindex route appears in sitemap"))
    else:
        if parser.canonicals != [expected]: problems.append(issue("canonical_mismatch", route, "canonical must exactly match route URL"))
        if parser.metadata.get("og:url",[]) != [expected]: problems.append(issue("og_url_mismatch", route, "og:url must exactly match route URL"))
        if expected not in sitemap_urls: problems.append(issue("sitemap_missing_route", route, "indexable route absent from sitemap"))
    required={"og:title","og:description","og:type","og:image","og:image:width","og:image:height","og:image:type","og:image:alt",
              "twitter:card","twitter:title","twitter:description","twitter:image","twitter:image:alt"}
    for key in sorted(required):
        values=parser.metadata.get(key,[])
        limit=TEXT_LIMITS["alt"] if key.endswith(":alt") else 2048
        if len(values)!=1 or not values[0].strip() or len(values[0].strip())>limit:
            problems.append(issue("social_metadata_contract",route,f"expected exactly one nonempty bounded {key}"))
    def one(key):
        values=parser.metadata.get(key,[]); return values[0].strip() if len(values)==1 else None
    title=parser.titles[0] if len(parser.titles)==1 else None; description=descriptions[0].strip() if len(descriptions)==1 else None
    if one("og:title")!=title or one("twitter:title")!=title: problems.append(issue("social_title_mismatch",route,"social titles must match title"))
    if one("og:description")!=description or one("twitter:description")!=description: problems.append(issue("social_description_mismatch",route,"social descriptions must match meta description"))
    if one("og:type")!="website": problems.append(issue("social_type_mismatch",route,"og:type must be website"))
    if one("twitter:card")!="summary_large_image": problems.append(issue("twitter_card_mismatch",route,"twitter card must be summary_large_image"))
    if one("og:image")!=SOCIAL_IMAGE or one("twitter:image")!=SOCIAL_IMAGE:
        problems.append(issue("social_image_mismatch",route,"social image URLs must match the fixed production image"))
    if one("og:image:width")!="1200" or one("og:image:height")!="630" or one("og:image:type")!="image/png":
        problems.append(issue("social_image_declaration",route,"social image declarations must match the 1200x630 PNG"))
    if not one("og:image:alt") or one("og:image:alt")!=one("twitter:image:alt"):
        problems.append(issue("social_image_alt",route,"social image alt declarations must be nonempty and consistent"))
    problems.extend(_jsonld_problems(name,route,parser.jsonld))
    if name == "category":
        folded=raw.lower()
        if len(raw) >= 500_000: problems.append(issue("category_oversized", route, "category response is 500000 bytes or larger"))
        if b"hotline-card" in folded or re.search(br'href\s*=\s*["\'](?:tel|sms):', folded):
            problems.append(issue("category_contact_leak", route, "category contains hotline-card or contact URI"))
    if name == "country":
        fragment_links=[href for href,_,_ in parser.links if href.startswith("#")]
        if not fragment_links or any(href[1:] not in parser.ids for href in fragment_links):
            problems.append(issue("country_fragment", route, "country fragment target is absent"))
        if not any(token in raw for token in (b"scroll-mt-", b"scroll-margin")):
            problems.append(issue("country_scroll_offset", route, "fragment targets lack scroll offset"))
    seen_contacts=set()
    for href, attrs, containers in parser.links:
        stripped=href.strip(); prefix=stripped.split(":",1)[0].casefold() if ":" in stripped else ""
        if prefix in {"tel","sms"}:
            scheme,value=stripped.split(":",1); normalized_scheme=scheme.casefold()
            marker="data-phone-contact" if normalized_scheme == "tel" else "data-message-contact"
            forbidden=(attrs.get("_unsafe_href_decode") == "1" or href != stripped
                       or any(not char.isprintable() or unicodedata.category(char)[0] in {"C","Z"} for char in href))
            if forbidden or not re.fullmatch(r"(?:tel|sms):\+?[0-9]+",href):
                problems.append(issue("unsafe_contact_uri", route, "contact URI is not canonical lowercase syntax"))
            if attrs.get(marker) != value: problems.append(issue("contact_attribution", route, "contact marker does not match URI"))
            if len(containers) != 1 or not containers[0][1]:
                problems.append(issue("contact_attribution", route, "contact must have exactly one enclosing attributed listing"))
            elif ((attrs.get("data-record-id") is not None and attrs.get("data-record-id") != containers[0][1])
                  or (attrs.get("data-prioritized-record-id") is not None and attrs.get("data-prioritized-record-id") != containers[0][1])):
                problems.append(issue("contact_attribution", route, "contact claims a conflicting record"))
            identity=(containers[0] if len(containers)==1 else None, normalized_scheme, value)
            if identity in seen_contacts: problems.append(issue("contact_attribution", route, "duplicate contact link in attributed listing"))
            seen_contacts.add(identity)
    for name in sorted(parser.overflows):
        problems.append(issue("html_collection_overflow",route,f"{name} collection exceeded bound"))
    return problems


def inspect_sitemap(raw):
    if len(raw) > MAX_BYTES:
        return set(), [issue("sitemap_oversized","/sitemap.xml","sitemap exceeded byte cap")]
    declaration=re.match(br"^\xef\xbb\xbf|^\s+",raw)
    if declaration:
        return set(), [issue("sitemap_xml","/sitemap.xml","malformed XML declaration or leading content")]
    xml_decl=re.match(br"<\?xml\s+version=(?:'1\.0'|\"1\.0\")(?:\s+encoding=(?:'UTF-8'|\"UTF-8\"))?\s*\?>",raw,re.I)
    remainder=raw[xml_decl.end():] if xml_decl else raw
    if remainder.startswith(b"<?") or re.search(br"(?is)<!|%\s*[A-Za-z_:][\w.:-]*\s*;|<\s*(?:[A-Za-z_][\w.-]*:)?include\b",remainder):
        return set(), [issue("sitemap_xml","/sitemap.xml","forbidden XML declaration or inclusion")]
    try: root=ET.fromstring(raw)
    except ET.ParseError: return set(), [issue("sitemap_xml", "/sitemap.xml", "malformed XML")]
    elements=0; total_text=0; stack=[(root,1)]
    while stack:
        element,depth=stack.pop(); elements += 1
        if elements > MAX_SITEMAP_ELEMENTS or depth > MAX_SITEMAP_DEPTH or len(element.attrib) > MAX_SITEMAP_ATTRIBUTES:
            return set(), [issue("sitemap_bounds","/sitemap.xml","sitemap structure exceeded bound")]
        fields=list(element.attrib.items())+[("text",element.text or ""),("tail",element.tail or "")]
        for key,value in fields:
            size=len(str(key).encode("utf-8"))+len(str(value).encode("utf-8")); total_text += size
            if size > MAX_SITEMAP_FIELD_BYTES or total_text > MAX_SITEMAP_TEXT_BYTES:
                return set(), [issue("sitemap_bounds","/sitemap.xml","sitemap decoded text exceeded bound")]
        stack.extend((child,depth+1) for child in reversed(list(element)))
    namespace="http://www.sitemaps.org/schemas/sitemap/0.9"; url_tag=f"{{{namespace}}}url"; loc_tag=f"{{{namespace}}}loc"
    if root.tag != f"{{{namespace}}}urlset" or root.attrib or (root.text and root.text.strip()):
        return set(), [issue("sitemap_schema", "/sitemap.xml", "expected namespaced urlset root")]
    urls=[]; problems=IssueCandidates("/sitemap.xml")
    for child in list(root):
        children=list(child)
        if (child.tag != url_tag or child.attrib or len(children) != 1 or children[0].tag != loc_tag
                or children[0].attrib or list(children[0]) or not children[0].text or not children[0].text.strip()
                or (child.text and child.text.strip()) or (child.tail and child.tail.strip())
                or (children[0].tail and children[0].tail.strip())):
            problems.append(issue("sitemap_schema", "/sitemap.xml", "expected only url elements containing one nonempty loc")); continue
        if len(urls) < MAX_SITEMAP_URLS: urls.append(children[0].text.strip())
        else: problems.append(issue("sitemap_count", "/sitemap.xml", "URL count exceeds bound")); break
    if len(urls) != len(set(urls)): problems.append(issue("sitemap_duplicate", "/sitemap.xml", "duplicate URL"))
    for url in urls:
        try: validate_origin_url(url)
        except ValueError: problems.append(issue("sitemap_url", "/sitemap.xml", "URL outside fixed origin or contains unsafe components"))
    return set(urls), problems


def inspect_robots(raw):
    """Parse bounded UTF-8 robots groups and test only the fixed production probes."""
    problems=IssueCandidates("/robots.txt")
    try: text=raw.decode("utf-8")
    except UnicodeDecodeError: return [issue("robots_malformed","/robots.txt","robots.txt is not valid UTF-8")]
    groups=[]; agents=[]; rules=[]; sitemaps=[]; records=0; saw_rule=False
    for original in text.splitlines():
        if re.match(r"(?i)^\s*sitemap\s*:",original) and "#" in original:
            problems.append(issue("robots_sitemap","/robots.txt","sitemap declaration must not use a fragment trick"))
        line=original.split("#",1)[0].strip()
        if not line: continue
        records += 1
        if records > MAX_ROBOTS_RECORDS: return [issue("robots_malformed","/robots.txt","robots.txt record count exceeds bound")]
        if ":" not in line: problems.append(issue("robots_malformed","/robots.txt","record lacks a field separator")); continue
        field,value=(part.strip() for part in line.split(":",1)); field=field.casefold()
        if field == "user-agent":
            if not value or not re.fullmatch(r"[A-Za-z0-9_.*-]+",value): problems.append(issue("robots_malformed","/robots.txt","invalid user-agent")); continue
            if saw_rule:
                groups.append((agents,rules)); agents=[]; rules=[]; saw_rule=False
            agents.append(value.casefold())
        elif field in {"allow","disallow"}:
            if not agents: problems.append(issue("robots_malformed","/robots.txt","rule appears outside a group")); continue
            if any(c in value for c in "?#") or not value.startswith("/") and value != "":
                problems.append(issue("robots_malformed","/robots.txt","invalid crawl rule")); continue
            rules.append((field,value)); saw_rule=True
        elif field == "sitemap": sitemaps.append(value)
        else: problems.append(issue("robots_malformed","/robots.txt","unsupported robots field"))
    if agents: groups.append((agents,rules))
    if sitemaps != [ORIGIN+"/sitemap.xml"]:
        problems.append(issue("robots_sitemap","/robots.txt","expected exactly one production sitemap declaration"))
    probes=(ROUTES["home"],ROUTES["country"],ROUTES["category"],ROUTES["sitemap"],ROUTES["image"])
    def crawlable(agent,path):
        specific=[rules for names,rules in groups if agent in names]
        applicable=specific or [rules for names,rules in groups if "*" in names]
        matches=[]
        for group_rules in applicable:
            for kind,pattern in group_rules:
                if pattern == "": continue
                expression="^"+re.escape(pattern).replace(r"\*",".*")
                if pattern.endswith("$"): expression=expression[:-2]+"$"
                if re.search(expression,path): matches.append((len(pattern.replace("*","" ).rstrip("$")),kind))
        if not matches: return True
        longest=max(x[0] for x in matches)
        return any(kind=="allow" for length,kind in matches if length==longest)
    for agent in ("*","googlebot"):
        for path in probes:
            if not crawlable(agent,path): problems.append(issue("robots_blocked",path,f"blocked for {agent}"))
    return problems


def valid_social_png(raw):
    """Validate the complete bounded PNG container without inflating image data."""
    if not isinstance(raw,bytes) or len(raw) > MAX_BYTES or not raw.startswith(PNG_SIGNATURE): return False
    offset=8; chunks=0; saw_ihdr=False; saw_plte=False; saw_idat=False; idat_bytes=0; idat_ended=False
    while offset < len(raw):
        if len(raw)-offset < 12: return False
        length=struct.unpack_from(">I",raw,offset)[0]
        if length > MAX_BYTES-12 or length > len(raw)-offset-12: return False
        kind=raw[offset+4:offset+8]; data_start=offset+8; data_end=data_start+length; crc_end=data_end+4
        if not re.fullmatch(rb"[A-Za-z]{4}",kind) or kind[2] & 0x20: return False
        if zlib.crc32(kind+raw[data_start:data_end]) & 0xffffffff != struct.unpack_from(">I",raw,data_end)[0]: return False
        chunks += 1
        if chunks == 1:
            if kind != b"IHDR" or length != 13: return False
            width,height,depth,color,compression,filter_method,interlace=struct.unpack(">IIBBBBB",raw[data_start:data_end])
            if ((width,height)!=(1200,630) or depth != 8 or color not in {2,6}
                    or compression != 0 or filter_method != 0 or interlace not in {0,1}): return False
            saw_ihdr=True
        elif kind == b"IHDR": return False
        elif kind == b"PLTE":
            if saw_plte or saw_idat or length == 0 or length > 768 or length % 3: return False
            saw_plte=True
        elif kind == b"IDAT":
            if idat_ended or length == 0: return False
            saw_idat=True; idat_bytes += length
            if idat_bytes > MAX_BYTES: return False
        elif kind == b"IEND":
            return bool(saw_ihdr and saw_idat and length == 0 and crc_end == len(raw))
        else:
            if kind[0] & 0x20 == 0: return False
            if saw_idat: idat_ended=True
        if kind != b"IDAT" and saw_idat: idat_ended=True
        offset=crc_end
    return False


def run(as_of, fetcher=fetch_resource):
    responses={}; problems=IssueCandidates("public-seo"); deadline=time.monotonic()+RUN_TIMEOUT
    for name,path in ROUTES.items():
        if time.monotonic() >= deadline: response={"error":"run_deadline","status":None,"body":b"","truncated":False,"content_type":"","final_url":ORIGIN+path,"redirect_count":0,"redirected":False}
        else: response=fetcher(fixed_url(path), deadline=deadline)
        responses[name]=response
        if response.get("error"): problems.append(issue("fetch_unavailable", path, response["error"]))
        elif response["status"] != 200: problems.append(issue("http_status", path, f"HTTP {response['status']}"))
        elif response["truncated"]: problems.append(issue("response_oversized", path, "response exceeded byte cap"))
        elif response.get("redirect_count", int(bool(response.get("redirected")))) > 0:
            problems.append(issue("redirect", path, "route redirected"))
        elif response["final_url"] != fixed_url(path): problems.append(issue("redirect", path, "route redirected"))
    sitemap_urls=set()
    if not responses["sitemap"].get("error") and not responses["sitemap"]["truncated"]:
        if responses["sitemap"].get("status") == 200 and responses["sitemap"].get("content_type") not in {"application/xml","text/xml","application/sitemap+xml"}:
            problems.append(issue("sitemap_content_type", "/sitemap.xml", "successful sitemap response must be XML"))
        else:
            sitemap_urls, found=inspect_sitemap(responses["sitemap"]["body"]); problems.extend(found)
    if responses["robots"].get("status")==200 and not _mime(responses["robots"].get("content_type",""),"text/plain"):
        problems.append(issue("robots_content_type","/robots.txt","expected text/plain with optional UTF-8 charset"))
    if responses["robots"].get("status")==200 and not responses["robots"].get("truncated"):
        problems.extend(inspect_robots(responses["robots"]["body"]))
    for name in ("home","country","category","noindex"):
        response=responses[name]
        if response.get("status") == 200 and not response["truncated"]:
            if not _mime(response.get("content_type",""),"text/html"):
                problems.append(issue("html_content_type",ROUTES[name],"expected text/html with optional UTF-8 charset"))
            else: problems.extend(inspect_html(name, ROUTES[name], response["body"], sitemap_urls,
                response.get("x_robots_tag",()),response.get("x_robots_tag_error")))
    image=responses["image"]
    if image.get("status") == 200 and (image["content_type"] != "image/png" or not valid_social_png(image["body"])):
        problems.append(issue("social_image_invalid", ROUTES["image"], "expected a structurally valid 1200x630 RGB/RGBA PNG"))
    problems=bounded_issues(cap_candidates(problems,"public-seo"))
    unavailable=any(row["code"]=="fetch_unavailable" for row in problems)
    return validate_result({"schema_version":"1.0","monitor":"public-seo","as_of":as_of,"status":"unavailable" if unavailable else ("regression" if problems else "ok"),
            "issues":problems,"metrics":{"routes":len(ROUTES),"sitemap_urls":len(sitemap_urls),"checks_failed":len(problems)}})


def markdown(report):
    lines=["# Public SEO monitor","",f"- As of: `{html.escape(report['as_of'])}`",f"- Status: **{report['status']}**",f"- Failed checks: {len(report['issues'])}","","> Bounded deployment observations are review prompts only; they do not verify hotline validity or real-time availability."]
    if report["issues"]: lines += ["","## Issues",""]+[f"- `{html.escape(x['code'])}` `{html.escape(x['subject'])}`: {html.escape(x['detail'])}" for x in report["issues"]]
    return "\n".join(lines)+"\n"


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--as-of",required=True); parser.add_argument("--json-output",type=Path,required=True); parser.add_argument("--markdown-output",type=Path,required=True)
    args=parser.parse_args(argv)
    try: parsed_date=dt.date.fromisoformat(args.as_of)
    except ValueError: parser.error("--as-of must be a canonical YYYY-MM-DD date")
    if args.as_of != parsed_date.isoformat(): parser.error("--as-of must be a canonical YYYY-MM-DD date")
    try: guard_paths([],[(args.json_output,".json"),(args.markdown_output,".md")])
    except (OSError,ValueError) as exc: parser.error(str(exc))
    report=validate_result(run(parsed_date.isoformat()))
    json_payload=(json.dumps(report,sort_keys=True,indent=2)+"\n").encode("utf-8",errors="strict")
    markdown_payload=markdown(report).encode("utf-8",errors="strict")
    if len(json_payload) > MAX_JSON_BYTES or len(markdown_payload) > MAX_MARKDOWN_BYTES:
        parser.error("bounded report output exceeds byte limit")
    coordinated_write([(args.json_output,json_payload),(args.markdown_output,markdown_payload)])
    print(json.dumps({"status":report["status"],"issues":len(report["issues"])},sort_keys=True))
    return 2 if report["status"]=="unavailable" else (1 if report["status"]=="regression" else 0)


if __name__=="__main__": raise SystemExit(main())
