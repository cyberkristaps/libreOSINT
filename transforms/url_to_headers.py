"""URL -> HTTP response headers: server banner, security headers, redirect chain. No API key required."""

from __future__ import annotations

import urllib.parse
import urllib.request
from typing import Dict, List, Optional

from osint_transform import Transform, TransformError, build_opener, http_request, main

MAX_REDIRECTS = 5
SECURITY_HEADERS = (
    "strict-transport-security",
    "content-security-policy",
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
    "permissions-policy",
)
BANNER_HEADERS = ("server", "x-powered-by", "via", "x-aspnet-version", "x-generator")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - urllib hook
        return None


NO_REDIRECT_OPENER = build_opener(_NoRedirect)  # honours OSINT_PROXY


def normalize_url(value: str) -> str:
    value = value.strip()
    if "://" not in value:
        value = "https://" + value
    parts = urllib.parse.urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise TransformError(f"{value!r} is not an http(s) URL")
    return value


def analyze(headers: Dict[str, str]) -> Dict[str, object]:
    lower = {k.lower(): v for k, v in headers.items()}
    banners = {h: lower[h] for h in BANNER_HEADERS if h in lower}
    present = [h for h in SECURITY_HEADERS if h in lower]
    missing = [h for h in SECURITY_HEADERS if h not in lower]
    return {"banners": banners, "security_present": present, "security_missing": missing}


def hop_props(hop: Dict[str, object]) -> Dict[str, object]:
    """Status, server banners and security headers of one response, for the URL that served it."""
    info = analyze(hop["headers"])  # type: ignore[arg-type]
    props: Dict[str, object] = {"http_status": hop["status"], **{f"header_{k}": v for k, v in info["banners"].items()}}  # type: ignore[union-attr]
    props["security_headers_present"] = info["security_present"]
    props["security_headers_missing"] = info["security_missing"]
    return props


def build(t: Transform, chain: List[Dict[str, object]]) -> None:
    # Every hop gets its own analysis: a bare 301 says little about the page users actually land on.
    prev = emit_url(t, str(chain[0]["url"]), hop_props(chain[0]))
    for hop in chain[1:]:
        ref = t.add_entity("URL", str(hop["url"]), hop_props(hop))
        t.link(prev, ref, "redirects_to")
        prev = ref
    t.data["chain"] = [{"url": h["url"], "status": h["status"], "headers": h["headers"]} for h in chain]


def emit_url(t: Transform, url: str, props: Dict[str, object]) -> str:
    """For URL input, merge into the input entity; for Domain input, add the URL it serves."""
    if t.entity_type == "URL":
        t.add_entity("URL", t.value, props)
        return t.INPUT
    ref = t.add_entity("URL", url, props)
    t.link(t.INPUT, ref, "serves")
    return ref


def fetch_chain(url: str) -> List[Dict[str, object]]:
    chain: List[Dict[str, object]] = []
    current: Optional[str] = url
    while current and len(chain) <= MAX_REDIRECTS:
        resp = http_request(current, timeout=15, opener=NO_REDIRECT_OPENER)
        chain.append({"url": current, "status": resp.status, "headers": resp.headers})
        location = next((v for k, v in resp.headers.items() if k.lower() == "location"), None)
        current = urllib.parse.urljoin(current, location) if 300 <= resp.status < 400 and location else None
        if current and urllib.parse.urlsplit(current).scheme.lower() not in ("http", "https"):
            chain[-1]["refused_redirect"] = current  # ftp://, file://… would bypass the proxy or read local files
            current = None
    return chain


def handle(t: Transform) -> None:
    url = normalize_url(t.value)
    t.log(f"fetching headers for {url}")
    chain = fetch_chain(url)
    t.log(f"{len(chain)} response(s); final status {chain[-1]['status']}")
    if chain[-1].get("refused_redirect"):
        t.log(f"not following redirect to non-HTTP(S) URL {chain[-1]['refused_redirect']}", "warn")
    build(t, chain)


if __name__ == "__main__":
    main(handle, accepts={"URL", "Domain", "Subdomain"})
