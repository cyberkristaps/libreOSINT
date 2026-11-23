"""IP -> open ports, software (CPE), known vulnerabilities and hostnames from Shodan InternetDB.

Free, no API key. The data comes from periodic internet-wide scans, so it can be days or weeks old;
this lookup never contacts the target itself.
"""

from __future__ import annotations

import ipaddress
from typing import Any, Dict, List

from osint_transform import Transform, TransformError, http_request, main

MAX_PORTS = 60
MAX_HOSTNAMES = 40


def host_type(name: str) -> str:
    # Two labels (example.com) → Domain; more (www.example.com) → Subdomain. Good enough without a PSL.
    return "Domain" if name.count(".") <= 1 else "Subdomain"


def build(t: Transform, ip: str, doc: Dict[str, Any]) -> None:
    ports: List[int] = sorted(int(p) for p in doc.get("ports") or [] if str(p).isdigit())
    vulns: List[str] = sorted(doc.get("vulns") or [])
    props: Dict[str, Any] = {"open_ports": ports, "scan_source": "Shodan InternetDB"}
    if doc.get("cpes"):
        props["cpes"] = doc["cpes"]
    if vulns:
        props["vulns"] = vulns
    if doc.get("tags"):
        props["scan_tags"] = doc["tags"]
    t.add_entity(t.entity_type, t.value, props)

    for port in ports[:MAX_PORTS]:
        host = f"[{ip}]" if ":" in ip else ip  # IPv6 needs brackets before the port
        ref = t.add_entity("Port_Service", f"{host}:{port}", {"ip": ip, "port": port, "source": "Shodan InternetDB"})
        t.link(t.INPUT, ref, "exposes_port")
    for name in (doc.get("hostnames") or [])[:MAX_HOSTNAMES]:
        name = str(name).strip().rstrip(".").lower()
        if name:
            t.link(t.INPUT, t.add_entity(host_type(name), name, {"source": "Shodan InternetDB"}), "hosts")

    t.data.update({"ports": ports, "vulns": vulns, "cpes": doc.get("cpes") or [], "hostnames": doc.get("hostnames") or []})
    if vulns:
        t.log(f"{len(vulns)} known vulnerabilit{'y' if len(vulns) == 1 else 'ies'}: {', '.join(vulns[:10])}", "warn")


def handle(t: Transform) -> None:
    try:
        ip = ipaddress.ip_address(t.value.strip())
    except ValueError as exc:
        raise TransformError(f"{t.value!r} is not an IP address") from exc
    if not ip.is_global:
        raise TransformError(f"{ip} is not a public address; InternetDB has no meaningful data for it")
    t.log(f"InternetDB lookup for {ip}")
    resp = http_request(f"https://internetdb.shodan.io/{ip}", headers={"Accept": "application/json"}, timeout=15)
    if resp.status == 404:
        t.log(f"no scan data for {ip}")
        t.data["found"] = False
        return
    if resp.status == 429:
        raise TransformError("InternetDB rate limit reached; try again in a minute")
    if resp.status != 200:
        raise TransformError(f"InternetDB returned HTTP {resp.status}")
    t.data["found"] = True
    build(t, str(ip), resp.json())
    t.log(f"{len(t.data['ports'])} open port(s), {len(t.data['hostnames'])} hostname(s)")


if __name__ == "__main__":
    main(handle, accepts={"IPv4", "IPv6"})
