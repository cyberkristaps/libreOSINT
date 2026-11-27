"""Base helper for libreOSINT transforms (contract v1, see CLAUDE.md).

stdlib only. A transform looks like:

    from osint_transform import Transform, main

    def handle(t: Transform) -> None:
        ip = t.add_entity("IPv4", "192.0.2.1", properties={"record": "A"})
        t.link(t.INPUT, ip, "resolves_to")

    if __name__ == "__main__":
        main(handle, accepts={"Domain", "Subdomain"})

Rules: stdout carries exactly one JSON document (written by `run`); logs go to stderr.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import socket
import urllib.parse
import sys
import tempfile
import traceback
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, TextIO

CONTRACT_VERSION = 1
INPUT_REF = "$input"

ENTITY_TYPES = frozenset(
    {
        "Domain",
        "Subdomain",
        "IPv4",
        "IPv6",
        "Email",
        "Phone_Number",
        "Person",
        "Alias",
        "Organization",
        "Social_Account",
        "Location",
        "URL",
        "SSL_Cert",
        "Port_Service",
        "Collection",
    }
)
LOG_LEVELS = frozenset({"debug", "info", "warn", "error"})
USER_AGENT = "libreOSINT-transform/0.1"
# Ordinary request headers. Without Accept / Accept-Language some sites (e.g. DuckDuckGo) treat the request as a bot.
DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.8",
}
MAX_HTTP_BYTES = 8 * 1024 * 1024


class TransformError(Exception):
    """Raise to fail the run with a clean message (exit code 1, no traceback)."""


class Transform:
    INPUT = INPUT_REF

    def __init__(self, request: Dict[str, Any]):
        if request.get("contract_version") != CONTRACT_VERSION:
            raise TransformError(f"unsupported contract_version {request.get('contract_version')!r}")
        entity = request.get("entity") or {}
        if entity.get("type") not in ENTITY_TYPES or not isinstance(entity.get("value"), str):
            raise TransformError("request.entity must have a valid type and string value")
        self.request = request
        self.transform_id: str = request.get("transform_id", "")
        self.entity_type: str = entity["type"]
        self.value: str = entity["value"]
        self.properties: Dict[str, Any] = entity.get("properties") or {}
        self.params: Dict[str, Any] = request.get("params") or {}
        self._entities: List[Dict[str, Any]] = []
        self._edges: List[Dict[str, str]] = []
        self._messages: List[Dict[str, str]] = []
        #: Free-form structured results for consumers such as the AI investigator (not ingested into the graph).
        self.data: Dict[str, Any] = {}
        self._refs: Dict[tuple, str] = {}

    # -- building the response -------------------------------------------------
    def add_entity(
        self,
        type_: str,
        value: str,
        properties: Optional[Dict[str, Any]] = None,
        tags: Optional[Iterable[str]] = None,
    ) -> str:
        """Add an output entity and return its ref. Repeats of (type, value) within one run return the same ref."""
        if type_ not in ENTITY_TYPES:
            raise TransformError(f"unknown entity type {type_!r}")
        key = (type_, value)
        if key in self._refs:
            ref = self._refs[key]
            existing = next(e for e in self._entities if e["ref"] == ref)
            existing["properties"].update(properties or {})
            existing["tags"] = sorted(set(existing["tags"]) | set(tags or ()))
            return ref
        ref = f"e{len(self._entities) + 1}"
        self._refs[key] = ref
        self._entities.append(
            {"ref": ref, "type": type_, "value": value, "properties": dict(properties or {}), "tags": sorted(set(tags or ()))}
        )
        return ref

    def link(self, source: str, target: str, label: str) -> None:
        edge = {"source": source, "target": target, "label": label}
        if edge not in self._edges:  # same rule as the graph: unique (source, target, label)
            self._edges.append(edge)

    def log(self, text: str, level: str = "info") -> None:
        """Log to stderr (streamed live) and to the response's messages."""
        if level not in LOG_LEVELS:
            level = "info"
        print(f"[{level}] {text}", file=sys.stderr, flush=True)
        self._messages.append({"level": level, "text": text})

    def api_key(self, name: str) -> Optional[str]:
        """Return the keychain-injected key `OSINT_KEY_<NAME>` (declare it in manifest `requires_keys`)."""
        return os.environ.get(f"OSINT_KEY_{name.upper()}")

    def response(self) -> Dict[str, Any]:
        doc: Dict[str, Any] = {
            "contract_version": CONTRACT_VERSION,
            "entities": self._entities,
            "edges": self._edges,
            "messages": self._messages,
        }
        if self.data:
            doc["data"] = self.data
        return doc


# -- proxy (OSINT_PROXY) ---------------------------------------------------------------
# The app passes the user's network setting as OSINT_PROXY: http(s)://host:port or socks5(h)://[user:pass@]host:port.
# SOCKS always resolves hostnames on the proxy side (no DNS leaks). There is no fallback to a direct
# connection: if the proxy is unreachable, requests fail.
PROXY_ENV = "OSINT_PROXY"


COLLECTION_SEP = " · "


def collection_name(category: str, query: str) -> str:
    """Value of the Collection (branch) that groups `category` results for `query`, e.g. "News · example.com"."""
    return f"{category}{COLLECTION_SEP}{query}"


def search_query(t: Transform) -> str:
    """What a search transform should look for: an explicit `query` param, the query a Collection was built
    for (so running a search on a branch adds to that branch), or the entity value."""
    if t.params.get("query"):
        return str(t.params["query"]).strip()
    if t.entity_type == "Collection":
        q = t.properties.get("query")
        if isinstance(q, str) and q.strip():
            return q.strip()
        return t.value.split(COLLECTION_SEP, 1)[-1].strip()
    return t.value.strip()


def proxy_url() -> Optional[str]:
    return os.environ.get(PROXY_ENV) or None


def user_cache_dir() -> str:
    """Per-user cache directory for transforms (created 0700), never a shared temp path."""
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or ""
    if sys.platform == "win32" and os.environ.get("APPDATA"):
        path = os.path.join(os.environ["APPDATA"], "libreOSINT", "cache")
    elif sys.platform == "darwin" and home:
        path = os.path.join(home, "Library", "Caches", "libreOSINT")
    elif home:
        path = os.path.join(home, ".cache", "libreosint")
    else:
        raise TransformError("no home directory to cache in")
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def write_atomic(path: str, data: bytes) -> None:
    """Write via a temp file + rename so readers never see a half-written file."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise OSError("SOCKS proxy closed the connection")
        buf += chunk
    return buf


SOCKS_ERRORS = {
    1: "general failure", 2: "not allowed by ruleset", 3: "network unreachable", 4: "host unreachable",
    5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported",
}


def socks5_connect(proxy: urllib.parse.SplitResult, host: str, port: int, timeout: Optional[float]) -> socket.socket:
    """Open a TCP connection to host:port through a SOCKS5 proxy (RFC 1928/1929), resolving host remotely."""
    try:
        sock = socket.create_connection((proxy.hostname, proxy.port or 1080), timeout=timeout)
    except OSError as err:
        raise OSError(f"SOCKS proxy {proxy.hostname}:{proxy.port} unreachable ({err})") from err
    try:
        user, password = urllib.parse.unquote(proxy.username or ""), urllib.parse.unquote(proxy.password or "")
        u, p = user.encode(), password.encode()
        if len(u) > 255 or len(p) > 255:
            raise OSError("SOCKS username and password must each be at most 255 bytes")
        target = _socks_address(host)
        sock.sendall(b"\x05\x02\x00\x02" if user else b"\x05\x01\x00")
        ver, method = _recv_exact(sock, 2)
        if ver != 5 or method == 0xFF:
            raise OSError("SOCKS proxy refused our authentication methods")
        if method == 2:
            sock.sendall(b"\x01" + bytes([len(u)]) + u + bytes([len(p)]) + p)
            if _recv_exact(sock, 2)[1] != 0:
                raise OSError("SOCKS proxy rejected the username/password")
        sock.sendall(b"\x05\x01\x00" + target + port.to_bytes(2, "big"))
        reply = _recv_exact(sock, 4)
        if reply[1] != 0:
            raise OSError(f"SOCKS proxy could not reach {host}:{port}: {SOCKS_ERRORS.get(reply[1], reply[1])}")
        atyp = reply[3]
        skip = 4 if atyp == 1 else 16 if atyp == 4 else _recv_exact(sock, 1)[0]
        _recv_exact(sock, skip + 2)
        return sock
    except BaseException:
        sock.close()
        raise


def _socks_address(host: str) -> bytes:
    """ATYP + address for a SOCKS5 CONNECT: IP literals as such, names as a domain (resolved by the proxy)."""
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
        return (b"\x01" if ip.version == 4 else b"\x04") + ip.packed
    except ValueError:
        pass
    try:
        name = host.encode("idna")
    except UnicodeError as err:
        raise OSError(f"invalid hostname {host!r}") from err
    if not 0 < len(name) <= 255:
        raise OSError(f"hostname {host!r} is too long for SOCKS5")
    return b"\x03" + bytes([len(name)]) + name


def _socks_handlers(proxy: urllib.parse.SplitResult):
    class SocksHTTPConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socks5_connect(proxy, self.host, self.port, self.timeout)

    class SocksHTTPSConnection(http.client.HTTPSConnection):
        def connect(self):
            sock = socks5_connect(proxy, self.host, self.port, self.timeout)
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)

    class SocksHTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(SocksHTTPConnection, req)

    class SocksHTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(SocksHTTPSConnection, req, context=self._context)

    return [urllib.request.ProxyHandler({}), SocksHTTPHandler(), SocksHTTPSHandler()]


class _RefuseFTP(urllib.request.FTPHandler):
    def ftp_open(self, req):
        raise urllib.error.URLError(f"refusing non-HTTP(S) URL {req.full_url} (it would not go through the proxy)")


class _RefuseFile(urllib.request.FileHandler):
    def file_open(self, req):
        raise urllib.error.URLError(f"refusing local file URL {req.full_url}")


def _http_only() -> List[urllib.request.BaseHandler]:
    # urllib adds FTP and file handlers by default and follows redirects to ftp://. FTP never goes
    # through OSINT_PROXY, so a target could redirect there to learn the real IP. Lookups are HTTP(S) only.
    return [_RefuseFTP(), _RefuseFile()]


def build_opener(*handlers: urllib.request.BaseHandler) -> urllib.request.OpenerDirector:
    """urllib opener that honours OSINT_PROXY. Use this instead of urllib.request.build_opener in transforms."""
    raw = proxy_url()
    if not raw:
        return urllib.request.build_opener(*_http_only(), *handlers)
    proxy = urllib.parse.urlsplit(raw)
    if proxy.scheme in ("socks5", "socks5h"):
        return urllib.request.build_opener(*_http_only(), *_socks_handlers(proxy), *handlers)
    if proxy.scheme in ("http", "https"):
        return urllib.request.build_opener(*_http_only(), urllib.request.ProxyHandler({"http": raw, "https": raw}), *handlers)
    raise TransformError(f"unsupported proxy scheme {proxy.scheme!r} in {PROXY_ENV}")


_DEFAULT_OPENER: Optional[urllib.request.OpenerDirector] = None


def _default_opener() -> urllib.request.OpenerDirector:
    global _DEFAULT_OPENER
    if _DEFAULT_OPENER is None:
        _DEFAULT_OPENER = build_opener()
    return _DEFAULT_OPENER


# -- HTTP helpers (stdlib only) --------------------------------------------------------
def http_request(
    url: str,
    *,
    method: str = "GET",
    data: Optional[bytes] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = 20.0,
    opener: Optional[urllib.request.OpenerDirector] = None,
) -> "HttpResponse":
    """Perform a request and return status, headers and body (capped at MAX_HTTP_BYTES). HTTP errors are returned, not raised."""
    open_fn = (opener or _default_opener()).open
    try:
        req = urllib.request.Request(ascii_url(url), data=data, method=method, headers={**DEFAULT_HEADERS, **(headers or {})})
        try:
            resp = open_fn(req, timeout=timeout)
        except urllib.error.HTTPError as err:
            resp = err
        with resp:
            body = resp.read(MAX_HTTP_BYTES + 1)[:MAX_HTTP_BYTES]
            return HttpResponse(resp.status if hasattr(resp, "status") else resp.code, resp.geturl(), dict(resp.headers.items()), body)
    except urllib.error.URLError as err:
        raise TransformError(f"request to {url} failed: {err.reason}") from err
    except (OSError, http.client.HTTPException) as err:  # timeouts, resets, TLS errors, malformed responses
        raise TransformError(f"request to {url} failed: {err.__class__.__name__}: {err}") from err
    except ValueError as err:  # malformed URL or header values (UnicodeError included)
        raise TransformError(f"request to {url} failed: invalid URL or header ({err})") from err


def ascii_url(url: str) -> str:
    """Make a URL with non-ASCII parts requestable: IDNA host, percent-encoded path/query/fragment."""
    if url.isascii():
        return url
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError as err:
        raise ValueError(f"invalid hostname {host!r}") from err
    netloc = host if ":" not in host else f"[{host}]"
    if parts.port is not None:
        netloc += f":{parts.port}"
    if parts.username is not None:
        cred = urllib.parse.quote(parts.username, safe="%")
        if parts.password is not None:
            cred += ":" + urllib.parse.quote(parts.password, safe="%")
        netloc = f"{cred}@{netloc}"
    keep = "/?#[]@!$&'()*+,;=:%~"
    return urllib.parse.urlunsplit(
        (parts.scheme, netloc, urllib.parse.quote(parts.path, safe=keep), urllib.parse.quote(parts.query, safe=keep), urllib.parse.quote(parts.fragment, safe=keep))
    )


def is_bot_challenge(resp: "HttpResponse") -> bool:
    """True for anti-bot interstitials (Cloudflare "Just a moment…", etc.). Transforms must not try to get past them."""
    if resp.status not in (403, 429, 503):
        return False
    headers = {k.lower(): v.lower() for k, v in resp.headers.items()}
    if headers.get("cf-mitigated") == "challenge":
        return True
    body = resp.body[:20000].lower()
    return any(m in body for m in (b"just a moment", b"cf-chl", b"attention required", b"captcha"))


class HttpResponse:
    def __init__(self, status: int, url: str, headers: Dict[str, str], body: bytes):
        self.status = status
        self.url = url
        self.headers = headers
        self.body = body

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        try:
            return json.loads(self.body)
        except ValueError as exc:
            raise TransformError(f"expected JSON from {self.url} (HTTP {self.status})") from exc


def run(
    handler: Callable[[Transform], None],
    accepts: Optional[Set[str]] = None,
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
) -> int:
    """Read the request, call `handler`, write the response. Returns the process exit code."""
    try:
        request = json.load(stdin)
        t = Transform(request)
        if accepts is not None and t.entity_type not in accepts:
            raise TransformError(f"input type {t.entity_type} not accepted (expects {sorted(accepts)})")
        handler(t)
    except json.JSONDecodeError as exc:
        print(f"[error] invalid JSON on stdin: {exc}", file=sys.stderr, flush=True)
        return 1
    except TransformError as exc:
        print(f"[error] {exc}", file=sys.stderr, flush=True)
        return 1
    except Exception:  # noqa: BLE001 - surface unexpected failures to the console
        traceback.print_exc(file=sys.stderr)
        return 2
    json.dump(t.response(), stdout, separators=(",", ":"))
    stdout.write("\n")
    stdout.flush()
    return 0


def main(handler: Callable[[Transform], None], accepts: Optional[Set[str]] = None) -> None:
    """Entry point for transform scripts: `if __name__ == "__main__": main(handle, {...})`."""
    sys.exit(run(handler, accepts))
