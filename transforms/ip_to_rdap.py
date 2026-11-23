"""IP -> RDAP registration (network owner) and origin ASN. No API key required.

Sources: rdap.org (redirects to the responsible RIR) and RIPEstat network-info for the ASN.
"""

from __future__ import annotations

import ipaddress
import urllib.parse
from typing import Any, Dict, List, Optional

from osint_transform import Transform, TransformError, http_request, main


def vcard_value(entity: Dict[str, Any], key: str) -> Optional[str]:
    card = entity.get("vcardArray")
    if not (isinstance(card, list) and len(card) == 2 and isinstance(card[1], list)):
        return None
    for item in card[1]:
        if isinstance(item, list) and len(item) >= 4 and item[0] == key:
            value = item[3]
            if isinstance(value, list):
                value = " ".join(str(v) for v in value if v)
            return str(value).strip() or None
    return None


def find_org(entities: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Prefer registrant, then administrative contacts; recurse into nested entities."""
    ranked = ("registrant", "administrative", "technical", "abuse")
    flat: List[Dict[str, Any]] = []

    def walk(es):
        for e in es or []:
            flat.append(e)
            walk(e.get("entities"))

    walk(entities)
    for role in ranked:
        for e in flat:
            if role in (e.get("roles") or []) and vcard_value(e, "fn"):
                return e
    return None


def parse_rdap(doc: Dict[str, Any]) -> Dict[str, Any]:
    org = find_org(doc.get("entities") or [])
    cidrs = [
        f"{c.get('v4prefix') or c.get('v6prefix')}/{c.get('length')}"
        for c in doc.get("cidr0_cidrs") or []
        if c.get("length") is not None
    ]
    return {
        "network_name": doc.get("name"),
        "handle": doc.get("handle"),
        "country": doc.get("country"),
        "range": f"{doc.get('startAddress')} - {doc.get('endAddress')}" if doc.get("startAddress") else None,
        "cidrs": cidrs,
        "org_name": vcard_value(org, "fn") if org else None,
        "org_handle": org.get("handle") if org else None,
        "org_email": vcard_value(org, "email") if org else None,
    }


def parse_ripestat(doc: Dict[str, Any]) -> Dict[str, Any]:
    data = doc.get("data") or {}
    return {"asns": [str(a) for a in data.get("asns") or []], "prefix": data.get("prefix")}


def canonical_cidr(cidr: Optional[str]) -> Optional[str]:
    try:
        return str(ipaddress.ip_network(str(cidr).strip(), strict=False)) if cidr else None
    except ValueError:
        return None


def build(t: Transform, rdap: Dict[str, Any], ripe: Dict[str, Any]) -> None:
    """IP —registered_to→ Organization. Network range, CIDRs and origin ASN become properties of the IP."""
    props: Dict[str, Any] = {k: v for k, v in rdap.items() if v and k not in ("cidrs",) and not k.startswith("org_")}
    cidrs = [c for c in (canonical_cidr(x) for x in rdap.get("cidrs") or []) if c]
    if cidrs:
        props["netblocks"] = cidrs
    announced = canonical_cidr(ripe.get("prefix"))
    if announced:
        props["announced_prefix"] = announced
    asns = [f"AS{a}" for a in ripe.get("asns") or []]
    if asns:
        props["asn"] = asns[0] if len(asns) == 1 else asns
    if props:
        t.add_entity(t.entity_type, t.value, props)

    if rdap.get("org_name"):
        org_props = {k: rdap[k] for k in ("org_handle", "org_email", "country") if rdap.get(k)}
        if asns:
            org_props["asn"] = asns[0] if len(asns) == 1 else asns
        org_ref = t.add_entity("Organization", rdap["org_name"], org_props)
        t.link(t.INPUT, org_ref, "registered_to")
    t.data.update({"rdap": rdap, "routing": ripe})


def handle(t: Transform) -> None:
    try:
        ip = ipaddress.ip_address(t.value.strip())
    except ValueError as exc:
        raise TransformError(f"{t.value!r} is not an IP address") from exc
    if ip.is_private or ip.is_loopback or ip.is_link_local:
        raise TransformError(f"{ip} is a private/reserved address; RDAP has no public record")

    t.log(f"RDAP lookup for {ip}")
    resp = http_request(f"https://rdap.org/ip/{ip}", headers={"Accept": "application/rdap+json"}, timeout=20)
    if resp.status != 200:
        raise TransformError(f"RDAP returned HTTP {resp.status}")
    rdap = parse_rdap(resp.json())

    ripe: Dict[str, Any] = {}
    try:
        url = "https://stat.ripe.net/data/network-info/data.json?" + urllib.parse.urlencode({"resource": str(ip)})
        r = http_request(url, timeout=15)
        if r.status == 200:
            ripe = parse_ripestat(r.json())
    except TransformError as err:
        t.log(f"ASN lookup failed: {err}", "warn")
    build(t, rdap, ripe)


if __name__ == "__main__":
    main(handle, accepts={"IPv4", "IPv6"})
