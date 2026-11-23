"""Username (Alias) -> accounts found on ~700 websites. No API key required.

Site checks come from the WhatsMyName project dataset (CC BY-SA 4.0, © Micah Hoffman and contributors),
downloaded at runtime and cached for 7 days. Each site is checked with one request; a site counts as a hit
only if both its "exists" status code and marker text match and its "missing" marker does not.
NSFW and dating sites are skipped unless `params.include_sensitive` is true.

Results are leads, not proof: sites change, and some block automated checks (counted as errors).
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple

from osint_transform import Transform, TransformError, http_request, main, user_cache_dir, write_atomic

DATASET_URL = "https://raw.githubusercontent.com/WebBreacher/WhatsMyName/main/wmn-data.json"
CACHE_NAME = "wmn-data.json"
CACHE_MAX_AGE_S = 7 * 24 * 3600
SENSITIVE_CATEGORIES = {"xx NSFW xx", "dating"}
WORKERS = 24
TIMEOUT_S = 10
MAX_RESULTS = 80

Site = Dict[str, Any]


def cache_file() -> str:
    try:
        return os.path.join(user_cache_dir(), CACHE_NAME)
    except OSError as err:
        raise TransformError(f"cannot create the cache directory: {err}") from err


def parse_dataset(raw: bytes) -> Dict[str, Any]:
    doc = json.loads(raw)
    if not isinstance(doc, dict) or not isinstance(doc.get("sites"), list):
        raise ValueError("not a WhatsMyName dataset")
    return doc


def load_sites(t: Transform) -> Tuple[List[Site], str]:
    path = cache_file()
    fresh = os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_MAX_AGE_S
    if not fresh:
        try:
            resp = http_request(DATASET_URL, timeout=30, headers={"Accept": "application/json"})
            if resp.status == 200:
                parse_dataset(resp.body)  # never cache a truncated or wrong download
                write_atomic(path, resp.body)
                t.log("downloaded the WhatsMyName site list")
            else:
                t.log(f"could not refresh the site list (HTTP {resp.status})", "warn")
        except (TransformError, OSError, ValueError) as err:
            t.log(f"could not refresh the site list: {err}", "warn")
    try:
        with open(path, "rb") as fh:
            doc = parse_dataset(fh.read())
    except (OSError, ValueError) as exc:
        raise TransformError("the WhatsMyName site list is unavailable (no network and no cached copy)") from exc
    license_text = " ".join(doc.get("license") or [])[:200]
    return [s for s in doc["sites"] if isinstance(s, dict) and s.get("valid", True) is not False], license_text


def select_sites(sites: List[Site], include_sensitive: bool, categories: Optional[List[str]]) -> List[Site]:
    out = []
    for s in sites:
        cat = s.get("cat") or "misc"
        if cat in SENSITIVE_CATEGORIES and not include_sensitive:
            continue
        if categories and cat not in categories:
            continue
        out.append(s)
    return out


def account_for(site: Site, username: str) -> str:
    for ch in site.get("strip_bad_char") or "":
        username = username.replace(ch, "")
    return username


def body_with(body: str, account: str) -> bytes:
    """Fill {account} into a POST body: JSON-escaped for JSON bodies, form-encoded otherwise."""
    if body.lstrip().startswith(("{", "[")):
        value = json.dumps(account)[1:-1]
    else:
        value = urllib.parse.quote_plus(account)
    return body.replace("{account}", value).encode()


def is_hit(site: Site, status: int, body: str) -> bool:
    if status != int(site.get("e_code", 200)):
        return False
    if site.get("e_string") and site["e_string"] not in body:
        return False
    if site.get("m_string") and site["m_string"] in body:
        return False
    return True


def check_site(site: Site, username: str) -> Tuple[Site, Optional[str], Optional[str]]:
    """Returns (site, profile_url_if_found, error)."""
    account = account_for(site, username)
    in_url = urllib.parse.quote(account, safe="")
    url = site["uri_check"].replace("{account}", in_url)
    body = site.get("post_body")
    try:
        resp = http_request(
            url,
            method="POST" if body else "GET",
            data=body_with(body, account) if body else None,
            headers=site.get("headers") or {},
            timeout=TIMEOUT_S,
        )
    except TransformError as err:
        return site, None, str(err)
    if is_hit(site, resp.status, resp.text()):
        return site, (site.get("uri_pretty") or site["uri_check"]).replace("{account}", in_url), None
    return site, None, None


def handle(t: Transform) -> None:
    username = t.value.strip().lstrip("@")
    if not username or any(c.isspace() for c in username):
        raise TransformError("expected a single username without spaces")
    sites, license_text = load_sites(t)
    cats = t.params.get("categories")
    sites = select_sites(sites, bool(t.params.get("include_sensitive")), cats if isinstance(cats, list) else None)
    t.log(f"checking {len(sites)} sites for '{username}' (this takes a minute)")

    found: List[Dict[str, str]] = []
    errors = 0
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(check_site, s, username) for s in sites]
        for fut in as_completed(futures):
            site, url, err = fut.result()
            done += 1
            if err:
                errors += 1
            elif url:
                found.append({"site": site["name"], "category": site.get("cat") or "misc", "url": url})
                t.log(f"found on {site['name']}: {url}")
            if done % 100 == 0:
                t.log(f"{done}/{len(sites)} checked, {len(found)} found")

    found.sort(key=lambda f: (f["category"] != "social", f["site"].lower()))
    for f in found[:MAX_RESULTS]:
        ref = t.add_entity(
            "Social_Account",
            f["url"],
            {"site": f["site"], "category": f["category"], "username": username, "source": "WhatsMyName check"},
        )
        t.link(t.INPUT, ref, "used_on")
    t.data.update(
        {
            "checked": len(sites),
            "found": found,
            "errors": errors,
            "note": "Hits are leads, not proof: verify each profile is the same person.",
            "dataset": "WhatsMyName (CC BY-SA 4.0)",
            "dataset_license": license_text,
        }
    )
    t.log(f"{len(found)} account(s) found on {len(sites)} sites ({errors} could not be checked)")


if __name__ == "__main__":
    main(handle, accepts={"Alias"})
