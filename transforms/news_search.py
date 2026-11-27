"""News articles about a query, grouped under a "News · <query>" branch. No API key required.

Uses Bing News' public RSS feed, which returns the article URL, outlet and publish date.
Run it on the News branch itself to add more articles to that branch.
"""

from __future__ import annotations

import email.utils
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import timezone
from typing import Dict, List, Optional

from osint_transform import Transform, TransformError, collection_name, http_request, main, search_query

ENDPOINT = "https://www.bing.com/news/search"
NEWS = "News"
MAX_RESULTS = 25


def article_url(link: str) -> Optional[str]:
    """Bing wraps targets as bing.com/news/apiclick.aspx?...&url=<encoded url>; return the real article URL."""
    link = (link or "").strip()
    try:
        parts = urllib.parse.urlsplit(link)
    except ValueError:
        return None
    if (parts.hostname or "").endswith("bing.com"):
        target = urllib.parse.parse_qs(parts.query).get("url")
        link = target[0] if target else ""
    return link if link.startswith(("http://", "https://")) else None


def iso_date(raw: str) -> str:
    try:
        dt = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _text(item: ET.Element, local_name: str) -> str:
    """Child text by local name, ignoring XML namespaces (Bing puts the outlet in a `News:Source` element)."""
    for child in item:
        if child.tag == local_name or child.tag.endswith("}" + local_name):
            return " ".join((child.text or "").split())
    return ""


def parse_feed(body: bytes) -> List[Dict[str, str]]:
    # RSS needs no DTD. Refusing one rules out entity-expansion ("billion laughs") and external-entity tricks
    # without a third-party parser (transforms are stdlib-only).
    if b"<!DOCTYPE" in body.upper() or b"<!ENTITY" in body.upper():
        raise TransformError("news feed declares a DTD; refusing to parse it")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as err:
        raise TransformError(f"news feed is not valid RSS: {err}")
    out: List[Dict[str, str]] = []
    seen = set()
    for item in root.iter("item"):
        url = article_url(_text(item, "link"))
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(
            {
                "url": url,
                "title": _text(item, "title"),
                "snippet": _text(item, "description"),
                "published": iso_date(_text(item, "pubDate")),
                "outlet": _text(item, "Source"),
            }
        )
    return out[:MAX_RESULTS]


def search(query: str) -> List[Dict[str, str]]:
    resp = http_request(ENDPOINT + "?" + urllib.parse.urlencode({"q": query, "format": "rss"}), timeout=20)
    if resp.status != 200:
        raise TransformError(f"news search failed: HTTP {resp.status}")
    return parse_feed(resp.body)


def handle(t: Transform) -> None:
    query = search_query(t)
    if not query:
        raise TransformError("empty search query")
    t.log(f"searching news: {query}")
    articles = search(query)
    t.log(f"{len(articles)} article(s)")
    t.data["query"] = query
    t.data["results"] = articles
    if not articles:
        return
    if t.entity_type == "Collection":
        branch = t.INPUT  # run on a branch: add to it
    else:
        branch = t.add_entity("Collection", collection_name(NEWS, query), {"category": NEWS, "query": query})
        t.link(t.INPUT, branch, "has_results")
    for a in articles:
        props = {"title": a["title"], "snippet": a["snippet"], "search_query": query, "category": NEWS}
        if a["published"]:
            props["published"] = a["published"]
        if a["outlet"]:
            props["outlet"] = a["outlet"]
        ref = t.add_entity("URL", a["url"], props)
        t.link(branch, ref, "contains")


if __name__ == "__main__":
    main(handle)
