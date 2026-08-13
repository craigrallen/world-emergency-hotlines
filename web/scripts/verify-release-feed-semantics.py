#!/usr/bin/env python3
import json, re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1] / "public" / "feeds"
def https(value):
    parsed = urlsplit(value)
    assert parsed.scheme == "https" and parsed.netloc == "worldhotlines.org" and not parsed.username and not parsed.password
def date(value): datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")

feed = json.loads((root / "releases.json").read_text())
assert feed["version"] == "https://jsonfeed.org/version/1.1" and feed["title"] and feed["authors"]
assert feed["feed_url"].endswith("/feeds/releases.json"); https(feed["home_page_url"]); https(feed["feed_url"])
json_ids=[]
for item in feed["items"]:
    assert set(("id","url","title","content_text","date_published")) <= item.keys(); https(item["id"]); https(item["url"]); date(item["date_published"]); json_ids.append(item["id"])
assert len(json_ids) == len(set(json_ids))

atom_ns={"a":"http://www.w3.org/2005/Atom"}; atom=ET.parse(root / "releases.atom").getroot()
assert atom.tag == "{http://www.w3.org/2005/Atom}feed" and atom.find("a:author/a:name",atom_ns).text
self_link=next(x for x in atom.findall("a:link",atom_ns) if x.get("rel")=="self")
assert self_link.get("type")=="application/atom+xml"; https(self_link.get("href")); date(atom.find("a:updated",atom_ns).text)
atom_ids=[]
for entry in atom.findall("a:entry",atom_ns):
    for required in ("id","title","updated","summary"): assert entry.find(f"a:{required}",atom_ns) is not None
    atom_ids.append(entry.find("a:id",atom_ns).text); https(atom_ids[-1]); date(entry.find("a:updated",atom_ns).text); https(entry.find("a:link",atom_ns).get("href"))
assert atom_ids == json_ids and len(atom_ids)==len(set(atom_ids))

rss=ET.parse(root / "releases.rss").getroot(); assert rss.tag=="rss" and rss.get("version")=="2.0"
channel=rss.find("channel"); assert channel is not None and channel.findtext("title") and channel.findtext("description") and channel.findtext("link")
https(channel.findtext("link")); datetime.strptime(channel.findtext("lastBuildDate"),"%a, %d %b %Y %H:%M:%S GMT")
atom_link=channel.find("{http://www.w3.org/2005/Atom}link"); assert atom_link.get("rel")=="self" and atom_link.get("type")=="application/rss+xml"; https(atom_link.get("href"))
rss_ids=[]
for item in channel.findall("item"):
    for required in ("title","link","guid","pubDate","description"): assert item.find(required) is not None
    https(item.findtext("link")); rss_ids.append(item.findtext("guid")); datetime.strptime(item.findtext("pubDate"),"%a, %d %b %Y %H:%M:%S GMT")
assert rss_ids == json_ids and len(rss_ids)==len(set(rss_ids))
print(f"Feed semantics OK: {len(json_ids)} uniquely ordered JSON Feed 1.1, Atom 1.0, and RSS 2.0 items")
