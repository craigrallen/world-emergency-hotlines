#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.child_helpline_international import (
    CATEGORY_SLUG,
    DIRECTORY_URL,
    USER_AGENT,
    build_country_directory,
    fetch_child_helpline_posts,
    get_category_map,
    parse_post,
)

SOURCE_DIR = ROOT / "sources" / "child_helpline_international"
POSTS_PATH = SOURCE_DIR / "child_helpline_posts.json"
DIRECTORY_PATH = SOURCE_DIR / "child_helpline_directory.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def main() -> None:
    category_map = get_category_map()
    posts = fetch_child_helpline_posts()
    parsed_entries = [parse_post(post, category_map) for post in posts]
    grouped_countries = build_country_directory(parsed_entries)

    posts_payload = {
        "source_name": "child_helpline_international",
        "retrieved_at": utc_now(),
        "source_url": DIRECTORY_URL,
        "source_category_slug": CATEGORY_SLUG,
        "fetch_user_agent": USER_AGENT,
        "post_count": len(posts),
        "posts": [
            {
                "id": post.get("id"),
                "slug": post.get("slug"),
                "status": post.get("status"),
                "date": post.get("date"),
                "date_gmt": post.get("date_gmt"),
                "modified": post.get("modified"),
                "modified_gmt": post.get("modified_gmt"),
                "link": post.get("link"),
                "title": post.get("title", {}).get("rendered"),
                "excerpt": post.get("excerpt", {}).get("rendered"),
                "categories": post.get("categories", []),
            }
            for post in posts
        ],
    }
    directory_payload = {
        "source_name": "child_helpline_international",
        "retrieved_at": posts_payload["retrieved_at"],
        "source_url": DIRECTORY_URL,
        "source_category_slug": CATEGORY_SLUG,
        "fetch_user_agent": USER_AGENT,
        "country_count": len(grouped_countries),
        "helpline_count": len(parsed_entries),
        "countries": grouped_countries,
    }

    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    POSTS_PATH.write_text(json.dumps(posts_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    DIRECTORY_PATH.write_text(json.dumps(directory_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {POSTS_PATH.relative_to(ROOT)}")
    print(f"Wrote {DIRECTORY_PATH.relative_to(ROOT)}")
    print(f"Fetched {len(posts)} Child Helpline International posts across {len(grouped_countries)} countries")


if __name__ == "__main__":
    main()
