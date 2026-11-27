"""Domain -> registration record: registrar, registrant (when the registry publishes it), dates, name servers.

RDAP first (via rdap.org, which forwards to the registry); for a .com-style "thin" registry the registrar's own
RDAP record is read too, because that is where the registrant lives. Registries without RDAP (e.g. .lv) are asked
over classic WHOIS (port 43), with the server taken from IANA. WHOIS traffic follows the proxy setting too.

Many registries withhold private registrants' names (GDPR). That is reported as such, never guessed.
No API key required.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from osint_transform import Transform, TransformError, http_request, main, tcp_connect

RDAP_BOOTSTRAP = "https://rdap.org/domain/"
IANA_WHOIS = "whois.iana.org"
MAX_WHOIS_BYTES = 256 * 1024
# Placeholders registries use instead of real contact data.
REDACTED = re.compile(r"redacted|privacy|private|withheld|not disclosed|data protected|gdpr|statutory masking|contact the registrar|please query|rdds|registrar of record|see the contact form", re.I)
HOST = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")


def _published(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip()
    return value if value and not REDACTED.search(value) else None


# -- RDAP -----------------------------------------------------------------------------
def _vcard(entity: Dict[str, Any], key: str) -> Optional[str]:
    card = entity.get("vcardArray")
    if not (isinstance(card, list) and len(card) == 2 and isinstance(card[1], list)):
        return None
    for item in card[1]:
        if isinstance(item, list) and len(item) >= 4 and item[0] == key:
            value = item[3]
            if key == "adr" and isinstance(item[1], dict) and item[1].get("cc"):
                return str(item[1]["cc"])
            if isinstance(value, list):
                value = value[-1] if key == "adr" else " ".join(str(v) for v in value if v)
            return str(value).strip() or None
    return None


def _entities(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []

    def walk(es):
        for e in es or []:
            if isinstance(e, dict):
                out.append(e)
                walk(e.get("entities"))

    walk(doc.get("entities"))
    return out


def parse_rdap(doc: Dict[str, Any]) -> Dict[str, Any]:
    rec: Dict[str, Any] = {"source": "rdap"}
    for ev in doc.get("events") or []:
        key = {"registration": "created", "expiration": "expires", "last changed": "updated"}.get(ev.get("eventAction"))
        if key and ev.get("eventDate"):
            rec[key] = ev["eventDate"]
    if doc.get("status"):
        rec["status"] = [str(s) for s in doc["status"]]
    ns = [str(n.get("ldhName", "")).lower().rstrip(".") for n in doc.get("nameservers") or []]
    if ns:
        rec["name_servers"] = [n for n in ns if n]
    for e in _entities(doc):
        roles = e.get("roles") or []
        if "registrar" in roles and not rec.get("registrar"):
            rec["registrar"] = _vcard(e, "fn")
            iana = next((p.get("identifier") for p in e.get("publicIds") or [] if "IANA" in str(p.get("type"))), None)
            if iana:
                rec["registrar_iana_id"] = str(iana)
        if "registrant" in roles and not rec.get("registrant_seen"):
            rec["registrant_seen"] = True
            org = _published(_vcard(e, "org"))
            name = _published(_vcard(e, "fn"))
            rec["registrant_name"] = name
            rec["registrant_org"] = org
            rec["registrant_email"] = _published(_vcard(e, "email"))
            cc = _vcard(e, "adr")
            rec["registrant_country"] = cc if cc and len(cc) == 2 else None
            rec["registrant_kind"] = "organization" if org or _vcard(e, "kind") == "org" else "person" if name else None
            form = _vcard(e, "contact-uri")
            if form and form.startswith("https://"):
                rec["registrant_contact_form"] = form
    return rec


def _registrar_rdap_url(doc: Dict[str, Any]) -> Optional[str]:
    for link in doc.get("links") or []:
        if link.get("rel") == "related" and "rdap" in str(link.get("type", "")) and str(link.get("href", "")).startswith("https://"):
            return link["href"]
    return None


def rdap_lookup(t: Transform, domain: str) -> Optional[Dict[str, Any]]:
    """The RDAP record, or None when the TLD has no RDAP service."""
    resp = http_request(RDAP_BOOTSTRAP + domain, headers={"Accept": "application/rdap+json, application/json"}, timeout=20)
    if resp.status == 404:
        return None
    if resp.status != 200:
        raise TransformError(f"RDAP lookup failed: HTTP {resp.status}")
    doc = resp.json()
    if not isinstance(doc, dict):
        raise TransformError("RDAP answer is not a JSON object")
    rec = parse_rdap(doc)
    related = _registrar_rdap_url(doc)
    if related and not rec.get("registrant_seen"):
        # Thin registries (.com/.net): the registrant is only in the registrar's record.
        try:
            r2 = http_request(related, headers={"Accept": "application/rdap+json, application/json"}, timeout=20)
            sub = r2.json() if r2.status == 200 else None
            if isinstance(sub, dict):
                more = parse_rdap(sub)
                for k, v in more.items():
                    if k.startswith("registrant") or not rec.get(k):
                        rec[k] = v
        except (TransformError, ValueError) as err:
            t.log(f"registrar RDAP record unavailable: {err}", "warn")
    return rec


# -- WHOIS ----------------------------------------------------------------------------
def whois_query(server: str, query: str) -> str:
    sock = tcp_connect(server, 43, timeout=20)
    try:
        sock.sendall(query.encode("idna") + b"\r\n")
        chunks: List[bytes] = []
        size = 0
        while size < MAX_WHOIS_BYTES:
            chunk = sock.recv(8192)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
    except OSError as err:
        raise TransformError(f"WHOIS query to {server} failed: {err}") from err
    finally:
        sock.close()
    raw = b"".join(chunks)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def whois_server_for(tld: str) -> Optional[str]:
    text = whois_query(IANA_WHOIS, tld)
    m = re.search(r"^whois:\s*(\S+)", text, re.M | re.I)
    server = m.group(1).lower() if m else None
    return server if server and HOST.match(server) else None


def _pairs(text: str) -> List[Tuple[str, str, str]]:
    """(section, key, value) for every `key: value` line; `[Section]` headers (as .lv uses) set the section."""
    out = []
    section = ""
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(("%", "#", ">>>")):
            continue
        m = re.match(r"^\[(.+)\]$", line)
        if m:
            section = m.group(1).strip().lower()
            continue
        if ":" in line:
            key, value = line.split(":", 1)
            out.append((section, key.strip().lower(), value.strip()))
    return out


def parse_whois(text: str) -> Dict[str, Any]:
    rec: Dict[str, Any] = {"source": "whois"}
    ns: List[str] = []
    status: List[str] = []
    for section, key, value in _pairs(text):
        if not value:
            continue
        holder = section in ("holder", "registrant", "owner") or key.startswith(("registrant", "holder", "owner"))
        if key in ("nserver", "name server", "nameserver", "name servers"):
            ns.append(value.split()[0].lower().rstrip("."))
        elif key in ("status", "domain status", "state"):
            status.append(value.split()[0])
        elif key in ("registrar", "sponsoring registrar", "registrar name") and not section.startswith("holder"):
            rec.setdefault("registrar", value)
        elif key in ("creation date", "created", "registered", "registration time", "domain registration date"):
            rec.setdefault("created", value)
        elif key in ("registry expiry date", "expiration date", "expires", "paid-till", "expiry date", "registrar registration expiration date"):
            rec.setdefault("expires", value)
        elif key in ("updated date", "changed", "last updated", "last-update", "last modified") and section != "whois":
            rec.setdefault("updated", value)
        elif holder and key in ("name", "registrant name", "registrant", "holder"):
            rec.setdefault("registrant_name", _published(value))
            rec["registrant_seen"] = True
        elif holder and key in ("organization", "organisation", "org", "registrant organization", "registrant organisation"):
            rec.setdefault("registrant_org", _published(value))
            rec["registrant_seen"] = True
        elif holder and key in ("email", "e-mail", "registrant email"):
            rec.setdefault("registrant_email", _published(value))
        elif holder and key in ("country", "registrant country"):
            rec.setdefault("registrant_country", value)
            rec["registrant_seen"] = True
        elif holder and key == "type":
            rec["registrant_kind"] = "person" if "natural" in value.lower() or "person" in value.lower() else "organization"
            rec["registrant_seen"] = True
        elif holder and key == "visit" and value.startswith("https://"):
            rec.setdefault("registrant_contact_form", value.split()[0].rstrip("."))
    if ns:
        rec["name_servers"] = list(dict.fromkeys(n for n in ns if HOST.match(n)))
    if status:
        rec["status"] = status
    if rec.get("registrant_org") and not rec.get("registrant_kind"):
        rec["registrant_kind"] = "organization"
    return rec


RECORD_FIELDS = ("registrar", "created", "expires", "name_servers", "status", "registrant_seen", "registrant_kind")


def looks_unregistered(text: str) -> bool:
    return bool(re.search(r"no match|not found|no entries found|no data found|status:\s*free|is available|no object found", text, re.I))


# -- graph ----------------------------------------------------------------------------
def candidates(t: Transform) -> List[str]:
    """The domain itself, then (for a subdomain) each parent down to two labels: the registry only knows
    registered names, and without a public-suffix list we can't tell `a.example.co.uk` from `a.example.com`."""
    name = t.value.strip().lower().rstrip(".")
    if not HOST.match(name):
        raise TransformError(f"{t.value!r} is not a domain name")
    labels = name.split(".")
    if t.entity_type == "Domain":
        return [name]
    return [".".join(labels[i:]) for i in range(len(labels) - 1)]


def lookup(t: Transform, domain: str) -> Optional[Dict[str, Any]]:
    rec = rdap_lookup(t, domain)
    if rec is not None:
        return rec
    tld = domain.rsplit(".", 1)[-1]
    server = whois_server_for(tld)
    if not server:
        raise TransformError(f".{tld} has neither RDAP nor a WHOIS server listed at IANA")
    t.log(f".{tld} has no RDAP service; asking {server} over WHOIS")
    text = whois_query(server, domain)
    rec = parse_whois(text)
    # Registries word "no such domain" in many ways (.lv: "Invalid query"); a reply with no registration data
    # at all is treated the same, so a subdomain moves on to its parent.
    if looks_unregistered(text) or not any(rec.get(k) for k in RECORD_FIELDS):
        return None
    rec["source"] = f"whois:{server}"
    return rec


def build(t: Transform, domain: str, rec: Dict[str, Any]) -> None:
    props: Dict[str, Any] = {"registered_domain": domain, "registration_source": rec["source"]}
    for key in ("created", "expires", "updated", "status", "name_servers", "registrar", "registrar_iana_id", "registrant_country", "registrant_contact_form"):
        if rec.get(key):
            props[key] = rec[key]
    note = registrant_note(rec)
    if note:
        props["registrant"] = note
        t.log(note)
        t.data["registrant_note"] = note
    # The registration belongs to the registered domain: the input itself, or its parent for a subdomain.
    if t.entity_type == "Subdomain" and domain != t.value.strip().lower().rstrip("."):
        target = t.add_entity("Domain", domain, props)
        t.link(t.INPUT, target, "subdomain_of")
    else:
        t.add_entity(t.entity_type, t.value, props)
        target = t.INPUT

    if rec.get("registrar"):
        reg_props = {"role": "domain registrar"}
        if rec.get("registrar_iana_id"):
            reg_props["iana_id"] = rec["registrar_iana_id"]
        t.link(target, t.add_entity("Organization", rec["registrar"], reg_props), "registered_with")

    name, org = rec.get("registrant_name"), rec.get("registrant_org")
    if org or name:
        type_ = "Organization" if org or rec.get("registrant_kind") != "person" else "Person"
        holder = t.add_entity(type_, org or name, {"role": "domain registrant"})
        t.link(target, holder, "registered_to")
        if rec.get("registrant_email"):
            t.link(holder, t.add_entity("Email", rec["registrant_email"], {"role": "registrant email"}), "uses_email")
    elif not note:
        t.log("the registry does not publish the registrant")


def registrant_note(rec: Dict[str, Any]) -> Optional[str]:
    """A plain-language note when the registry confirms a registrant but withholds who it is."""
    if rec.get("registrant_name") or rec.get("registrant_org"):
        return None
    if not (rec.get("registrant_seen") or rec.get("registrant_kind")):
        return None
    who = {"person": "a private person", "organization": "an organization"}.get(rec.get("registrant_kind") or "", "a registrant")
    country = f" in {rec['registrant_country']}" if rec.get("registrant_country") else ""
    note = f"Registered to {who}{country}; the registry withholds the name."
    if rec.get("registrant_contact_form"):
        note += f" Contact form: {rec['registrant_contact_form']}"
    return note


def handle(t: Transform) -> None:
    for domain in candidates(t):
        t.log(f"looking up registration of {domain}")
        rec = lookup(t, domain)
        if rec is None:
            continue
        rec = {k: v for k, v in rec.items() if v not in (None, "", [])}
        t.data["registration"] = {k: v for k, v in rec.items() if k != "registrant_seen"}
        t.data["domain"] = domain
        build(t, domain, rec)
        return
    raise TransformError(f"{t.value} is not registered (or the registry has no record of it)")


if __name__ == "__main__":
    main(handle, accepts={"Domain", "Subdomain"})
