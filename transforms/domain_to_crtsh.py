"""Domain -> Certificate Transparency: subdomains and certificates. No API key required.

Primary source is crt.sh; when it is down (it often returns 502) the transform falls back to
SSLMate Cert Spotter's free unauthenticated API (rate-limited).
"""

from __future__ import annotations

import re
import time
import urllib.parse
from typing import Dict, List, Set

from osint_transform import Transform, TransformError, http_request, main

MAX_CERTS = 40
MAX_SUBDOMAINS = 200
# What a certificate name must look like to become a Subdomain (no emails, URLs, spaces, wildcards left).
HOSTNAME = re.compile(r"^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)+$")


def names_from(entry: Dict) -> Set[str]:
    names: Set[str] = set()
    for field in ("name_value", "common_name"):
        for raw in str(entry.get(field) or "").splitlines():
            name = raw.strip().lower().rstrip(".")
            if name.startswith("*."):
                name = name[2:]
            if HOSTNAME.match(name):
                names.add(name)
    return names


def build(t: Transform, domain: str, entries: List[Dict]) -> None:
    domain = domain.lower().rstrip(".")
    # Newest first, so the cap keeps the most relevant certificates.
    entries = sorted(entries, key=lambda e: str(e.get("entry_timestamp") or ""), reverse=True)

    subdomains: Set[str] = set()
    for e in entries:
        for n in names_from(e):
            if n != domain and n.endswith("." + domain):
                subdomains.add(n)
    for name in sorted(subdomains)[:MAX_SUBDOMAINS]:
        ref = t.add_entity("Subdomain", name, {"source": "crt.sh"})
        t.link(t.INPUT, ref, "has_subdomain")

    seen: Set[str] = set()
    for e in entries:
        serial = str(e.get("serial_number") or "").lower()
        if not serial or serial in seen:
            continue
        seen.add(serial)
        if len(seen) > MAX_CERTS:
            break
        ref = t.add_entity(
            "SSL_Cert",
            serial,
            {
                "serial_number": serial,
                "issuer": e.get("issuer_name"),
                "common_name": e.get("common_name"),
                "not_before": e.get("not_before"),
                "not_after": e.get("not_after"),
                "crtsh_id": e.get("id"),
                "names": sorted(names_from(e)),
            },
        )
        t.link(ref, t.INPUT, "issued_to")

    t.data["subdomain_count"] = len(subdomains)
    t.data["certificate_count"] = len({str(e.get("serial_number")) for e in entries})
    if len(subdomains) > MAX_SUBDOMAINS:
        t.log(f"{len(subdomains)} subdomains found; kept the first {MAX_SUBDOMAINS}", "warn")


def build_certspotter(t: Transform, domain: str, issuances: List[Dict]) -> None:
    """Cert Spotter issuances: SSL_Cert keyed by SHA-256 fingerprint, plus subdomains from dns_names."""
    domain = domain.lower().rstrip(".")
    subdomains: Set[str] = set()
    for iss in issuances:
        names = names_from({"name_value": "\n".join(iss.get("dns_names") or [])})
        subdomains |= {n for n in names if n != domain and n.endswith("." + domain)}
    for name in sorted(subdomains)[:MAX_SUBDOMAINS]:
        t.link(t.INPUT, t.add_entity("Subdomain", name, {"source": "certspotter"}), "has_subdomain")
    for iss in sorted(issuances, key=lambda i: str(i.get("not_before") or ""), reverse=True)[:MAX_CERTS]:
        fp = str(iss.get("cert_sha256") or "").lower()
        if not fp:
            continue
        issuer = iss.get("issuer") or {}
        ref = t.add_entity(
            "SSL_Cert",
            fp,
            {
                "sha256": fp,
                "issuer": issuer.get("friendly_name") or issuer.get("name"),
                "not_before": iss.get("not_before"),
                "not_after": iss.get("not_after"),
                "names": sorted(iss.get("dns_names") or []),
                "source": "certspotter",
            },
        )
        t.link(ref, t.INPUT, "issued_to")
    t.data["subdomain_count"] = len(subdomains)
    t.data["certificate_count"] = len(issuances)


def query_crtsh(t: Transform, domain: str):
    url = "https://crt.sh/?" + urllib.parse.urlencode({"q": f"%.{domain}", "output": "json"})
    t.log(f"querying crt.sh for {domain} (can be slow)")
    for attempt in range(2):
        try:
            resp = http_request(url, timeout=45, headers={"Accept": "application/json"})
        except TransformError as err:
            t.log(f"crt.sh: {err}", "warn")
            return None
        if resp.status == 200:
            if not resp.body.strip():
                return []
            try:
                entries = resp.json()
            except TransformError:  # an HTML error page, or a response cut off at the size cap
                t.log("crt.sh returned something other than JSON", "warn")
                return None
            return entries if isinstance(entries, list) else None
        t.log(f"crt.sh returned HTTP {resp.status}" + ("; retrying once" if attempt == 0 else ""), "warn")
        if resp.status < 500:
            return None
        time.sleep(3)
    return None


def query_certspotter(t: Transform, domain: str):
    url = "https://api.certspotter.com/v1/issuances?" + urllib.parse.urlencode(
        {"domain": domain, "include_subdomains": "true", "expand": "dns_names"}
    ) + "&expand=issuer"
    t.log("falling back to Cert Spotter")
    resp = http_request(url, timeout=30, headers={"Accept": "application/json"})
    if resp.status == 429:
        raise TransformError("crt.sh is down and Cert Spotter's free rate limit is exhausted; try again later")
    if resp.status != 200:
        raise TransformError(f"crt.sh is down and Cert Spotter returned HTTP {resp.status}")
    data = resp.json()
    if not isinstance(data, list):
        raise TransformError("unexpected Cert Spotter response")
    return data


def handle(t: Transform) -> None:
    domain = t.value.strip().lower().rstrip(".")
    entries = query_crtsh(t, domain)
    if entries is not None:
        t.log(f"{len(entries)} log entries")
        t.data["source"] = "crt.sh"
        build(t, domain, entries)
        return
    issuances = query_certspotter(t, domain)
    t.log(f"{len(issuances)} certificate(s) from Cert Spotter")
    t.data["source"] = "certspotter"
    build_certspotter(t, domain, issuances)


if __name__ == "__main__":
    main(handle, accepts={"Domain", "Subdomain"})
