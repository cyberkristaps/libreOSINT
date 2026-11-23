"""URL -> readable page text (title, meta description, visible text, outbound links). No API key required."""

from __future__ import annotations

import re
import urllib.parse
from html.parser import HTMLParser
from typing import List

from osint_transform import Transform, TransformError, http_request, is_bot_challenge, main

MAX_TEXT = 12000
MAX_LINKS = 40
SKIP_TAGS = {"script", "style", "noscript", "template", "svg"}
BLOCK_TAGS = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer"}


class _TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.description = ""
        self.links: List[str] = []
        self._chunks: List[str] = []
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in SKIP_TAGS:
            self._skip += 1
        if tag == "title":
            self._in_title = True
        if tag == "meta" and (a.get("name") or "").lower() == "description":
            self.description = (a.get("content") or "").strip()
        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
        if tag in BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False
        if tag in BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self._chunks.append(data)

    def text(self) -> str:
        lines = (" ".join(line.split()) for line in "".join(self._chunks).splitlines())
        return "\n".join(line for line in lines if line)


def extract(page: str, base_url: str) -> dict:
    p = _TextParser()
    p.feed(page)
    links, seen = [], set()
    for href in p.links:
        url = urllib.parse.urljoin(base_url, href.strip())
        if url.startswith("http") and url not in seen:
            seen.add(url)
            links.append(url)
    text = p.text()
    return {
        "title": " ".join(p.title.split()),
        "description": p.description,
        "text": text[:MAX_TEXT],
        "truncated": len(text) > MAX_TEXT,
        "links": links[:MAX_LINKS],
    }


# Analytics / ad IDs that tie unrelated sites to one owner. G-/AW- are only taken in gtag context
# to avoid matching random "G-…" strings in page text.
TRACKING_PATTERNS = [
    re.compile(r"\b(UA-\d{4,10}-\d{1,4})\b"),
    re.compile(r"\b(GTM-[A-Z0-9]{4,10})\b"),
    re.compile(r"(?:[?&]id=|config['\"]\s*,\s*['\"])((?:G|AW)-[A-Z0-9]{6,12})\b"),
    re.compile(r"\b(?:ca-)?(pub-\d{10,20})\b"),
]


def tracking_codes(raw_html: str) -> List[str]:
    found: List[str] = []
    for pattern in TRACKING_PATTERNS:
        for code in pattern.findall(raw_html):
            if code not in found:
                found.append(code)
    return found[:20]


def handle(t: Transform) -> None:
    url = t.value.strip()
    if "://" not in url:
        url = "https://" + url
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise TransformError(f"{url!r} is not an http(s) URL")
    t.log(f"fetching {url}")
    resp = http_request(url, timeout=20, headers={"Accept": "text/html,application/xhtml+xml"})
    ctype = next((v for k, v in resp.headers.items() if k.lower() == "content-type"), "").lower()
    if is_bot_challenge(resp):
        raise TransformError(
            f"{url} is behind an anti-bot challenge (e.g. Cloudflare 'Just a moment…'); it cannot be fetched automatically. "
            "Try url_to_headers, domain_to_dns or web_search instead."
        )
    if resp.status >= 400:
        raise TransformError(f"HTTP {resp.status} for {url}")
    if "html" not in ctype and "text" not in ctype:
        raise TransformError(f"not a text page ({ctype or 'unknown content type'})")
    raw = resp.text()
    page = extract(raw, resp.url)
    props = {k: page[k] for k in ("title", "description") if page[k]}
    props["http_status"] = resp.status
    if t.entity_type == "URL":
        t.add_entity("URL", t.value, props)
        page_ref = t.INPUT
    else:
        page_ref = t.add_entity("URL", url, props)
        t.link(t.INPUT, page_ref, "serves")
    codes = tracking_codes(raw)
    if codes:
        # Recorded as a property: a code shared by two sites is a strong same-owner signal.
        t.add_entity("URL", t.value if page_ref == t.INPUT else url, {"tracking_codes": codes})
    page["tracking_codes"] = codes
    if codes:
        t.log(f"{len(codes)} tracking code(s): {', '.join(codes)}")
    t.data.update(page)
    t.data["final_url"] = resp.url
    t.log(f"{len(page['text'])} characters of text")


if __name__ == "__main__":
    main(handle, accepts={"URL", "Domain", "Subdomain"})
