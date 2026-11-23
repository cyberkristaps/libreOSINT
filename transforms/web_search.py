"""Free-text web search. No API key required.

Tries DuckDuckGo's HTML results first. If DuckDuckGo answers with its bot check, the transform does
not try to get around it; it falls back to official no-key APIs instead (DuckDuckGo Instant Answer
and Wikipedia search), which return fewer, encyclopedic results.
The entity value is the search query (any entity type).
"""

from __future__ import annotations

import html
import re
import urllib.parse
from html.parser import HTMLParser
from typing import Dict, List, Optional

from osint_transform import Transform, TransformError, http_request, main

ENDPOINT = "https://html.duckduckgo.com/html/"
LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/"
LINK_CLASSES = {"result__a", "result-link"}
SNIPPET_CLASSES = {"result__snippet", "result-snippet"}
MAX_RESULTS = 10


class _ResultParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.results: List[Dict[str, str]] = []
        self._field: Optional[str] = None
        self._buf: List[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = set((a.get("class") or "").split())
        if tag == "a" and classes & LINK_CLASSES:
            self.results.append({"url": resolve_href(a.get("href") or ""), "title": "", "snippet": ""})
            self._start("title")
        elif classes & SNIPPET_CLASSES and self.results:
            self._start("snippet")

    def handle_endtag(self, tag):
        if self._field and tag in ("a", "div", "td"):
            self.results[-1][self._field] = " ".join("".join(self._buf).split())
            self._field = None

    def handle_data(self, data):
        if self._field:
            self._buf.append(data)

    def _start(self, field):
        self._field = field
        self._buf = []


def resolve_href(href: str) -> str:
    """DDG wraps targets as //duckduckgo.com/l/?uddg=<encoded url>."""
    href = html.unescape(href)
    parsed = urllib.parse.urlsplit(href)
    target = urllib.parse.parse_qs(parsed.query).get("uddg")
    if target:
        return target[0]
    return "https:" + href if href.startswith("//") else href


def parse_results(page: str) -> List[Dict[str, str]]:
    p = _ResultParser()
    p.feed(page)
    seen = set()
    out = []
    for r in p.results:
        if r["url"].startswith("http") and r["url"] not in seen and "duckduckgo.com/y.js" not in r["url"]:
            seen.add(r["url"])
            out.append(r)
    return out[:MAX_RESULTS]


def looks_blocked(page: str) -> bool:
    low = page.lower()
    return "anomaly" in low and "result__a" not in low and "result-link" not in low


def search_duckduckgo(query: str):
    """Try DuckDuckGo's two no-JavaScript endpoints. Returns (results, provider) or (None, why_not)."""
    why = "no response"
    for endpoint, provider in ((ENDPOINT, "duckduckgo-html"), (LITE_ENDPOINT, "duckduckgo-lite")):
        try:
            resp = http_request(
                endpoint,
                method="POST",
                data=urllib.parse.urlencode({"q": query}).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=20,
            )
        except TransformError as err:
            why = str(err)
            continue
        page = resp.text()
        if resp.status == 200 and not looks_blocked(page):
            return parse_results(page), provider
        why = f"HTTP {resp.status}" if resp.status != 200 else "blocked"
    return None, why


def parse_instant_answer(doc: Dict) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    if doc.get("AbstractURL") and doc.get("AbstractText"):
        out.append({"url": doc["AbstractURL"], "title": doc.get("Heading") or doc["AbstractURL"], "snippet": doc["AbstractText"]})
    if doc.get("OfficialWebsite"):
        out.append({"url": doc["OfficialWebsite"], "title": "Official website", "snippet": ""})
    for info in (doc.get("Infobox") or {}).get("content") or []:
        if info.get("data_type") == "official_website" and isinstance(info.get("value"), str):
            out.append({"url": info["value"], "title": "Official website", "snippet": ""})
    for topic in doc.get("RelatedTopics") or []:
        for item in topic.get("Topics", [topic]):
            if item.get("FirstURL") and item.get("Text") and "duckduckgo.com/" not in item["FirstURL"]:
                out.append({"url": item["FirstURL"], "title": item["Text"][:120], "snippet": item["Text"]})
    return out


def parse_wikipedia(doc: Dict) -> List[Dict[str, str]]:
    out = []
    for hit in ((doc.get("query") or {}).get("search")) or []:
        title = hit.get("title", "")
        snippet = html.unescape(re.sub(r"<[^>]+>", "", hit.get("snippet", "")))
        url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))
        out.append({"url": url, "title": title, "snippet": snippet})
    return out


def dedupe(results: List[Dict[str, str]]) -> List[Dict[str, str]]:
    seen, out = set(), []
    for r in results:
        if r["url"] not in seen:
            seen.add(r["url"])
            out.append(r)
    return out[:MAX_RESULTS]


def search_fallback(t: Transform, query: str) -> List[Dict[str, str]]:
    sources = (
        ("DuckDuckGo Instant Answer", "https://api.duckduckgo.com/?" + urllib.parse.urlencode({"q": query, "format": "json", "no_html": 1}), parse_instant_answer),
        (
            "Wikipedia",
            "https://en.wikipedia.org/w/api.php?"
            + urllib.parse.urlencode({"action": "query", "list": "search", "srsearch": query, "format": "json", "srlimit": 5}),
            parse_wikipedia,
        ),
    )
    results: List[Dict[str, str]] = []
    failed = []
    for name, url, parse in sources:
        try:
            resp = http_request(url, timeout=15)
            if resp.status != 200:
                raise TransformError(f"HTTP {resp.status}")
            doc = resp.json() if resp.body.strip() else {}
            if isinstance(doc, dict):
                results += parse(doc)
        except TransformError as err:  # one source down: still use the other
            t.log(f"{name}: {err}", "warn")
            failed.append(name)
    if len(failed) == len(sources):
        raise TransformError("web search is unavailable: DuckDuckGo, its Instant Answer API and Wikipedia all failed")
    return dedupe(results)


def handle(t: Transform) -> None:
    query = str(t.params.get("query") or t.value).strip()
    if not query:
        raise TransformError("empty search query")
    t.log(f"searching: {query}")
    results, provider = search_duckduckgo(query)
    if results is not None:
        t.data["provider"] = provider
        t.data["limited"] = False
    else:
        t.log(f"DuckDuckGo web search unavailable ({provider}); falling back to Instant Answer + Wikipedia APIs", "warn")
        results = search_fallback(t, query)
        t.data["provider"] = "duckduckgo-instant-answer+wikipedia"
        t.data["limited"] = True
        t.data["note"] = (
            "Full web search was unavailable; only encyclopedic sources were searched. "
            "An empty or short result list is NOT evidence that nothing exists online."
        )
    t.log(f"{len(results)} result(s)")
    for r in results:
        ref = t.add_entity("URL", r["url"], {"title": r["title"], "snippet": r["snippet"], "search_query": query})
        t.link(t.INPUT, ref, "mentioned_in")
    t.data["query"] = query
    t.data["results"] = results


if __name__ == "__main__":
    main(handle)
