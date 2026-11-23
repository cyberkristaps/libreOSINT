"""Domain -> DNS records (A, AAAA, MX, NS, TXT).

Uses dnspython when installed; otherwise DNS-over-HTTPS JSON (Cloudflare, falling back to Google).
No API key required.
"""

from __future__ import annotations

import ipaddress
import json
import os
import urllib.parse
from typing import Dict, List, Tuple

from osint_transform import Transform, TransformError, http_request, main

RECORD_TYPES = ("A", "AAAA", "MX", "NS", "TXT")
DOH_ENDPOINTS = ("https://cloudflare-dns.com/dns-query", "https://dns.google/resolve")
# DNS RR type codes used in DoH JSON answers.
RR_CODES = {1: "A", 28: "AAAA", 15: "MX", 2: "NS", 16: "TXT", 5: "CNAME"}

Record = Tuple[str, str, int]  # (type, data, ttl)


def parse_doh_answer(doc: Dict, rtype: str) -> List[Record]:
    out: List[Record] = []
    for ans in doc.get("Answer") or []:
        t = RR_CODES.get(ans.get("type"))
        if t != rtype:
            continue
        out.append((t, str(ans.get("data", "")), int(ans.get("TTL", 0))))
    return out


def resolve_doh(name: str, rtype: str) -> List[Record]:
    last_err = None
    for endpoint in DOH_ENDPOINTS:
        url = f"{endpoint}?{urllib.parse.urlencode({'name': name, 'type': rtype})}"
        try:
            resp = http_request(url, headers={"Accept": "application/dns-json"}, timeout=10)
        except TransformError as err:
            last_err = err
            continue
        if resp.status != 200:
            last_err = TransformError(f"{endpoint} returned HTTP {resp.status}")
            continue
        try:
            doc = resp.json()
        except TransformError as err:
            last_err = err
            continue
        if not isinstance(doc, dict):
            last_err = TransformError(f"{endpoint} returned an unexpected answer")
            continue
        return parse_doh_answer(doc, rtype)
    raise TransformError(f"DNS-over-HTTPS lookup failed: {last_err}")


def resolve_dnspython(name: str, rtype: str) -> List[Record]:
    import dns.exception  # type: ignore
    import dns.resolver  # type: ignore

    try:
        answer = dns.resolver.resolve(name, rtype, lifetime=8)
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
        return []
    except dns.exception.DNSException as err:  # timeouts etc.: warn for this type, keep the others
        raise TransformError(f"{err.__class__.__name__}: {err}") from err
    return [(rtype, r.to_text(), answer.rrset.ttl) for r in answer]


def resolver():
    # dnspython talks to resolvers directly over UDP, which would bypass a configured proxy.
    if os.environ.get("OSINT_PROXY"):
        return resolve_doh, "dns-over-https via proxy"
    try:
        import dns.resolver  # type: ignore  # noqa: F401

        return resolve_dnspython, "dnspython"
    except ImportError:
        return resolve_doh, "dns-over-https"


def clean_host(data: str) -> str:
    return data.strip().rstrip(".").lower()


def parse_mx(data: str) -> Tuple[int, str]:
    parts = data.split()
    if len(parts) == 2 and parts[0].isdigit():
        return int(parts[0]), clean_host(parts[1])
    return 0, clean_host(parts[-1]) if parts else ""


def parse_txt(data: str) -> str:
    data = data.strip()
    # DoH / dnspython return TXT as one or more quoted strings.
    if data.startswith('"'):
        joined = data.replace('" "', '","')
        try:
            return "".join(json.loads("[" + joined + "]"))
        except ValueError:
            return data.strip('"')
    return data


def build(t: Transform, records: List[Record]) -> None:
    txt: List[str] = []
    for rtype, data, ttl in records:
        if rtype in ("A", "AAAA"):
            try:
                ip = ipaddress.ip_address(data.strip())
            except ValueError:
                continue
            ref = t.add_entity("IPv4" if ip.version == 4 else "IPv6", str(ip), {"record": rtype, "ttl": ttl})
            t.link(t.INPUT, ref, "resolves_to")
        elif rtype == "MX":
            prio, host = parse_mx(data)
            if host:
                ref = t.add_entity("Domain", host, {"record": "MX", "mx_priority": prio})
                t.link(t.INPUT, ref, "mail_handled_by")
        elif rtype == "NS":
            host = clean_host(data)
            if host:
                ref = t.add_entity("Domain", host, {"record": "NS"})
                t.link(t.INPUT, ref, "name_server")
        elif rtype == "TXT":
            txt.append(parse_txt(data))
    if txt:
        # Re-emitting the input entity merges TXT records into its properties (dedup rule).
        t.add_entity(t.entity_type, t.value, {"txt_records": txt})
        spf = [r for r in txt if r.lower().startswith("v=spf1")]
        if spf:
            t.add_entity(t.entity_type, t.value, {"spf": spf[0]})
    t.data["records"] = [{"type": r, "data": d, "ttl": ttl} for r, d, ttl in records]


def handle(t: Transform) -> None:
    name = clean_host(t.value)
    resolve, backend = resolver()
    t.log(f"resolving {name} via {backend}")
    records: List[Record] = []
    for rtype in RECORD_TYPES:
        try:
            got = resolve(name, rtype)
        except TransformError as err:
            t.log(f"{rtype}: {err}", "warn")
            continue
        records.extend(got)
        t.log(f"{rtype}: {len(got)} record(s)")
    if not records:
        t.log(f"no DNS records found for {name}", "warn")
    build(t, records)


if __name__ == "__main__":
    main(handle, accepts={"Domain", "Subdomain"})
