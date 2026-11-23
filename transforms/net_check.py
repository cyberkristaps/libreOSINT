"""Network check for the Settings dialog (not a lookup): which public IP do lookups come from?

Runs with the same OSINT_PROXY as real lookups, so it shows exactly what target sites would see.
"""

from __future__ import annotations

from osint_transform import Transform, TransformError, http_request, main, proxy_url


def handle(t: Transform) -> None:
    resp = http_request("https://api.ipify.org?format=json", timeout=25, headers={"Accept": "application/json"})
    if resp.status != 200:
        raise TransformError(f"IP check returned HTTP {resp.status}")
    ip = resp.json().get("ip")
    t.data.update({"ip": ip, "proxied": bool(proxy_url())})
    t.log(f"exit IP {ip}")


if __name__ == "__main__":
    main(handle)
