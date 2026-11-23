"""Offline tests for the starter transforms: parsing + graph building, no network."""

import io
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import domain_to_crtsh  # noqa: E402
import domain_to_dns  # noqa: E402
import fetch_page_text  # noqa: E402
import ip_to_internetdb  # noqa: E402
import username_to_accounts  # noqa: E402
import ip_to_rdap  # noqa: E402
import url_to_headers  # noqa: E402
import web_search  # noqa: E402
from osint_transform import INPUT_REF, HttpResponse, Transform, run  # noqa: E402


def transform(type_, value, params=None):
    return Transform({"contract_version": 1, "transform_id": "t", "entity": {"id": "x", "type": type_, "value": value}, "params": params or {}})


def doc(t):
    return t.response()


class DnsTests(unittest.TestCase):
    def test_doh_tries_the_next_endpoint_on_a_non_json_reply(self):
        answer = {"Answer": [{"type": 1, "data": "192.0.2.1", "TTL": 60}]}
        replies = [HttpResponse(200, "a", {}, b"<html>oops</html>"), HttpResponse(200, "b", {}, json.dumps(answer).encode())]
        with mock.patch.object(domain_to_dns, "http_request", side_effect=replies):
            self.assertEqual(domain_to_dns.resolve_doh("example.com", "A"), [("A", "192.0.2.1", 60)])

    def test_dnspython_timeouts_become_warnings(self):
        import types

        class DNSException(Exception):
            pass

        class Timeout(DNSException):
            pass

        resolver = types.SimpleNamespace(
            NXDOMAIN=type("NXDOMAIN", (DNSException,), {}), NoAnswer=type("NoAnswer", (DNSException,), {}),
            NoNameservers=type("NoNameservers", (DNSException,), {}), resolve=mock.Mock(side_effect=Timeout("lifetime expired")),
        )
        exception = types.SimpleNamespace(DNSException=DNSException)
        dns = types.SimpleNamespace(resolver=resolver, exception=exception)
        from osint_transform import TransformError

        with mock.patch.dict(sys.modules, {"dns": dns, "dns.resolver": resolver, "dns.exception": exception}):
            with self.assertRaises(TransformError):
                domain_to_dns.resolve_dnspython("example.com", "A")

    def test_parse_doh_filters_by_type(self):
        answer = {"Answer": [{"type": 5, "data": "alias."}, {"type": 1, "data": "192.0.2.1", "TTL": 60}]}
        self.assertEqual(domain_to_dns.parse_doh_answer(answer, "A"), [("A", "192.0.2.1", 60)])

    def test_parse_mx_and_txt(self):
        self.assertEqual(domain_to_dns.parse_mx("10 mail.Example.com."), (10, "mail.example.com"))
        self.assertEqual(domain_to_dns.parse_txt('"v=spf1 " "-all"'), "v=spf1 -all")

    def test_build_links_records_and_merges_txt_into_input(self):
        t = transform("Domain", "example.com")
        domain_to_dns.build(
            t,
            [("A", "192.0.2.1", 60), ("AAAA", "2001:db8::1", 60), ("MX", "10 mx.example.com.", 300), ("NS", "ns1.example.net.", 300), ("TXT", '"v=spf1 -all"', 300), ("A", "garbage", 1)],
        )
        d = doc(t)
        types = [(e["type"], e["value"]) for e in d["entities"]]
        self.assertIn(("IPv4", "192.0.2.1"), types)
        self.assertIn(("IPv6", "2001:db8::1"), types)
        self.assertIn(("Domain", "mx.example.com"), types)
        self.assertIn(("Domain", "ns1.example.net"), types)
        me = next(e for e in d["entities"] if e["value"] == "example.com")
        self.assertEqual(me["properties"]["spf"], "v=spf1 -all")
        self.assertEqual({e["label"] for e in d["edges"]}, {"resolves_to", "mail_handled_by", "name_server"})


class CrtshTests(unittest.TestCase):
    ENTRIES = [
        {"id": 1, "serial_number": "AA", "name_value": "*.example.com\nwww.example.com", "common_name": "example.com", "entry_timestamp": "2026-01-01", "issuer_name": "R3"},
        {"id": 2, "serial_number": "aa", "name_value": "api.example.com", "entry_timestamp": "2025-01-01"},
        {"id": 3, "serial_number": "BB", "name_value": "evil-example.com\nmail.EXAMPLE.com.", "entry_timestamp": "2026-02-01"},
    ]

    def test_extracts_subdomains_and_unique_certs(self):
        t = transform("Domain", "example.com")
        domain_to_crtsh.build(t, "example.com", self.ENTRIES)
        d = doc(t)
        subs = sorted(e["value"] for e in d["entities"] if e["type"] == "Subdomain")
        self.assertEqual(subs, ["api.example.com", "mail.example.com", "www.example.com"])
        certs = [e for e in d["entities"] if e["type"] == "SSL_Cert"]
        self.assertEqual(sorted(c["value"] for c in certs), ["aa", "bb"])
        self.assertTrue(all(e["target"] == INPUT_REF for e in d["edges"] if e["label"] == "issued_to"))

    def test_ignores_names_that_are_not_hostnames(self):
        names = domain_to_crtsh.names_from({"name_value": "https://x.example.com/\nops@example.com\nfoo bar.example.com\na.example.com:443\nok.example.com"})
        self.assertEqual(names, {"ok.example.com"})

    def test_non_json_crtsh_reply_falls_back(self):
        page = HttpResponse(200, "https://crt.sh/", {}, b"<html>busy</html>")
        with mock.patch.object(domain_to_crtsh, "http_request", return_value=page), mock.patch("sys.stderr", io.StringIO()):
            self.assertIsNone(domain_to_crtsh.query_crtsh(transform("Domain", "example.com"), "example.com"))


class RdapTests(unittest.TestCase):
    RDAP = {
        "name": "APNIC-LABS",
        "handle": "1.1.1.0 - 1.1.1.255",
        "country": "AU",
        "startAddress": "1.1.1.0",
        "endAddress": "1.1.1.255",
        "entities": [
            {"roles": ["abuse"], "vcardArray": ["vcard", [["fn", {}, "text", "Abuse desk"]]]},
            {"roles": ["registrant"], "handle": "ORG-1", "vcardArray": ["vcard", [["fn", {}, "text", "APNIC Research"]]]},
        ],
    }

    def test_prefers_registrant_and_records_asn_as_property(self):
        rdap = ip_to_rdap.parse_rdap(self.RDAP)
        self.assertEqual(rdap["org_name"], "APNIC Research")
        t = transform("IPv4", "1.1.1.1")
        ip_to_rdap.build(t, rdap, ip_to_rdap.parse_ripestat({"data": {"asns": ["13335"], "prefix": "1.1.1.0/24"}}))
        d = doc(t)
        self.assertEqual([(e["type"], e["value"]) for e in d["entities"]], [("IPv4", "1.1.1.1"), ("Organization", "APNIC Research")])
        self.assertEqual(d["entities"][0]["properties"]["asn"], "AS13335")
        self.assertEqual(d["entities"][1]["properties"]["asn"], "AS13335")

    def test_network_details_become_ip_properties(self):
        rdap = ip_to_rdap.parse_rdap({**self.RDAP, "cidr0_cidrs": [{"v4prefix": "1.1.1.0", "length": 24}]})
        t = transform("IPv4", "1.1.1.1")
        ip_to_rdap.build(t, rdap, ip_to_rdap.parse_ripestat({"data": {"asns": ["13335"], "prefix": "1.1.1.0/24"}}))
        d = doc(t)
        ip = d["entities"][0]["properties"]
        self.assertEqual((ip["netblocks"], ip["announced_prefix"], ip["asn"]), (["1.1.1.0/24"], "1.1.1.0/24", "AS13335"))
        self.assertEqual(d["edges"], [{"source": INPUT_REF, "target": "e2", "label": "registered_to"}])

    def test_rejects_private_ips(self):
        out = io.StringIO()
        req = {"contract_version": 1, "transform_id": "ip_to_rdap", "entity": {"id": "x", "type": "IPv4", "value": "10.0.0.1"}}
        with mock.patch("sys.stderr", io.StringIO()):
            code = run(ip_to_rdap.handle, stdin=io.StringIO(json.dumps(req)), stdout=out)
        self.assertEqual(code, 1)


class HeadersTests(unittest.TestCase):
    def test_redirect_chain_and_security_headers(self):
        chain = [
            {"url": "http://example.com", "status": 301, "headers": {"Location": "https://example.com/", "Server": "nginx"}},
            {"url": "https://example.com/", "status": 200, "headers": {"Strict-Transport-Security": "max-age=1"}},
        ]
        t = transform("URL", "http://example.com")
        url_to_headers.build(t, chain)
        d = doc(t)
        me = d["entities"][0]
        self.assertEqual(me["properties"]["header_server"], "nginx")
        self.assertIn("content-security-policy", me["properties"]["security_headers_missing"])
        self.assertEqual(d["edges"], [{"source": INPUT_REF, "target": "e2", "label": "redirects_to"}])
        final = d["entities"][1]["properties"]
        self.assertEqual(final["http_status"], 200)
        self.assertIn("strict-transport-security", final["security_headers_present"])

    def test_does_not_follow_redirects_off_http(self):
        resp = HttpResponse(302, "http://example.com", {"Location": "ftp://attacker.example/x"}, b"")
        with mock.patch("url_to_headers.http_request", return_value=resp) as req:
            chain = url_to_headers.fetch_chain("http://example.com")
        self.assertEqual(req.call_count, 1)
        self.assertEqual(len(chain), 1)
        self.assertEqual(chain[0]["refused_redirect"], "ftp://attacker.example/x")

    def test_domain_input_creates_served_url(self):
        t = transform("Domain", "example.com")
        url_to_headers.build(t, [{"url": "https://example.com", "status": 200, "headers": {}}])
        self.assertEqual(doc(t)["edges"][0]["label"], "serves")


class SearchTests(unittest.TestCase):
    HTML = """
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example <b>A</b></a>
    <a class="result__snippet">Snippet <b>one</b></a>
    <a class="result__a" href="https://example.org/b">B</a>
    """

    def test_parses_results_and_unwraps_redirects(self):
        results = web_search.parse_results(self.HTML)
        self.assertEqual([r["url"] for r in results], ["https://example.com/a", "https://example.org/b"])
        self.assertEqual(results[0]["title"], "Example A")
        self.assertEqual(results[0]["snippet"], "Snippet one")

    def test_fallback_parsers_skip_duckduckgo_category_links(self):
        ia = {"AbstractURL": "https://en.wikipedia.org/wiki/X", "AbstractText": "X is", "Heading": "X",
              "RelatedTopics": [{"FirstURL": "https://duckduckgo.com/c/Thing", "Text": "Thing"}]}
        self.assertEqual([r["url"] for r in web_search.parse_instant_answer(ia)], ["https://en.wikipedia.org/wiki/X"])
        wiki = {"query": {"search": [{"title": "ACME Corp", "snippet": "<span>ACME</span> &amp; co"}]}}
        self.assertEqual(web_search.parse_wikipedia(wiki)[0], {"url": "https://en.wikipedia.org/wiki/ACME_Corp", "title": "ACME Corp", "snippet": "ACME & co"})

    def test_uses_fallback_when_blocked(self):
        t = transform("Organization", "ACME")
        blocked = HttpResponse(202, web_search.ENDPOINT, {}, b"<html>anomaly</html>")
        with mock.patch.object(web_search, "http_request", return_value=blocked), mock.patch.object(
            web_search, "search_fallback", return_value=[{"url": "https://acme.example", "title": "ACME", "snippet": ""}]
        ):
            web_search.handle(t)
        self.assertEqual(t.data["provider"], "duckduckgo-instant-answer+wikipedia")
        self.assertEqual(doc(t)["entities"][0]["value"], "https://acme.example")


class FallbackTests(unittest.TestCase):
    def test_parses_duckduckgo_lite_results(self):
        page = """<table><tr><td><a rel="nofollow" href="https://cyberkristaps.org/" class='result-link'>Kristaps</a></td></tr>
        <tr><td class='result-snippet'>Security <b>research</b></td></tr></table>"""
        self.assertEqual(web_search.parse_results(page), [{"url": "https://cyberkristaps.org/", "title": "Kristaps", "snippet": "Security research"}])

    def test_tries_lite_endpoint_when_html_is_blocked(self):
        blocked = HttpResponse(202, web_search.ENDPOINT, {}, b"<html>anomaly</html>")
        lite = HttpResponse(200, web_search.LITE_ENDPOINT, {}, b"<a class='result-link' href='https://a.example/'>A</a>")
        with mock.patch.object(web_search, "http_request", side_effect=[blocked, lite]):
            results, provider = web_search.search_duckduckgo("q")
        self.assertEqual((provider, results[0]["url"]), ("duckduckgo-lite", "https://a.example/"))

    def test_network_error_on_html_endpoint_tries_lite(self):
        from osint_transform import TransformError

        lite = HttpResponse(200, web_search.LITE_ENDPOINT, {}, b"<a class='result-link' href='https://a.example/'>A</a>")
        with mock.patch.object(web_search, "http_request", side_effect=[TransformError("reset"), lite]):
            results, provider = web_search.search_duckduckgo("q")
        self.assertEqual(provider, "duckduckgo-lite")

    def test_fallback_survives_one_source_failing(self):
        from osint_transform import TransformError

        wiki = HttpResponse(200, "w", {}, json.dumps({"query": {"search": [{"title": "ACME", "snippet": ""}]}}).encode())
        with mock.patch.object(web_search, "http_request", side_effect=[TransformError("timed out"), wiki]), mock.patch("sys.stderr", io.StringIO()):
            results = web_search.search_fallback(transform("Organization", "ACME"), "ACME")
        self.assertEqual([r["title"] for r in results], ["ACME"])
        with mock.patch.object(web_search, "http_request", side_effect=TransformError("down")), mock.patch("sys.stderr", io.StringIO()):
            with self.assertRaises(TransformError):
                web_search.search_fallback(transform("Organization", "ACME"), "ACME")

    def test_fallback_marks_results_as_limited(self):
        t = transform("Person", "Jane Doe")
        with mock.patch.object(web_search, "search_duckduckgo", return_value=(None, 202)), mock.patch.object(web_search, "search_fallback", return_value=[]):
            web_search.handle(t)
        self.assertTrue(t.data["limited"])
        self.assertIn("NOT evidence", t.data["note"])

    def test_certspotter_fallback_builds_subdomains_and_fingerprinted_certs(self):
        t = transform("Domain", "kiberzona.lv")
        with mock.patch.object(domain_to_crtsh, "query_crtsh", return_value=None), mock.patch.object(
            domain_to_crtsh,
            "query_certspotter",
            return_value=[{"cert_sha256": "AB12", "dns_names": ["*.kiberzona.lv", "kiberzona.lv", "www.kiberzona.lv"], "not_before": "2026-11-15"}],
        ):
            domain_to_crtsh.handle(t)
        d = doc(t)
        self.assertEqual(t.data["source"], "certspotter")
        self.assertEqual([(e["type"], e["value"]) for e in d["entities"]], [("Subdomain", "www.kiberzona.lv"), ("SSL_Cert", "ab12")])

    def test_detects_cloudflare_challenge(self):
        from osint_transform import is_bot_challenge

        self.assertTrue(is_bot_challenge(HttpResponse(403, "u", {}, b"<title>Just a moment...</title>")))
        self.assertTrue(is_bot_challenge(HttpResponse(403, "u", {"cf-mitigated": "challenge"}, b"")))
        self.assertFalse(is_bot_challenge(HttpResponse(403, "u", {}, b"Forbidden")))
        self.assertFalse(is_bot_challenge(HttpResponse(200, "u", {}, b"just a moment")))


class PageTextTests(unittest.TestCase):
    def test_extracts_readable_text(self):
        page = """<html><head><title> Hi </title><meta name="description" content="Desc"><script>var x=1</script></head>
        <body><h1>Header</h1><p>Hello <b>world</b></p><a href="/about">About</a><style>.x{}</style></body></html>"""
        out = fetch_page_text.extract(page, "https://example.com/index.html")
        self.assertEqual(out["title"], "Hi")
        self.assertEqual(out["description"], "Desc")
        self.assertIn("Hello world", out["text"])
        self.assertNotIn("var x", out["text"])
        self.assertEqual(out["links"], ["https://example.com/about"])


    def test_content_type_is_case_insensitive(self):
        page = HttpResponse(200, "https://example.com/", {"Content-Type": "Text/HTML; charset=UTF-8"}, b"<title>Hi</title><p>Hello there</p>")
        t = transform("URL", "https://example.com/")
        with mock.patch.object(fetch_page_text, "http_request", return_value=page), mock.patch("sys.stderr", io.StringIO()):
            fetch_page_text.handle(t)
        self.assertIn("Hello there", json.dumps(doc(t)))


class TrackingCodeTests(unittest.TestCase):
    def test_extracts_tracking_codes_in_context(self):
        raw = """
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ"></script>
        <script>gtag('config', 'AW-123456789'); ga('create', 'UA-12345678-1', 'auto');</script>
        <script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABCD12');</script>
        <ins data-ad-client="ca-pub-1234567890123456"></ins>
        <p>Not a code: G-UNIT, GTM-</p>
        """
        self.assertEqual(
            fetch_page_text.tracking_codes(raw),
            ["UA-12345678-1", "GTM-ABCD12", "G-ABC123XYZ", "AW-123456789", "pub-1234567890123456"],
        )


class InternetDbTests(unittest.TestCase):
    def test_ports_hostnames_and_vulns(self):
        t = transform("IPv4", "192.0.2.10")
        ip_to_internetdb.build(t, "192.0.2.10", {"ports": [443, 22], "hostnames": ["www.example.com", "example.org"], "cpes": ["cpe:/a:nginx:nginx"], "vulns": ["CVE-2021-1"], "tags": ["cdn"]})
        d = doc(t)
        me = d["entities"][0]["properties"]
        self.assertEqual((me["open_ports"], me["vulns"], me["cpes"]), ([22, 443], ["CVE-2021-1"], ["cpe:/a:nginx:nginx"]))
        values = [(e["type"], e["value"]) for e in d["entities"][1:]]
        self.assertEqual(values, [("Port_Service", "192.0.2.10:22"), ("Port_Service", "192.0.2.10:443"), ("Subdomain", "www.example.com"), ("Domain", "example.org")])
        self.assertEqual({e["label"] for e in d["edges"]}, {"exposes_port", "hosts"})

    def test_ipv6_ports_are_bracketed(self):
        t = transform("IPv6", "2001:db8::1")
        ip_to_internetdb.build(t, "2001:db8::1", {"ports": [443]})
        self.assertIn("[2001:db8::1]:443", [e["value"] for e in doc(t)["entities"]])

    def test_rejects_private_addresses_and_handles_no_data(self):
        with mock.patch("sys.stderr", io.StringIO()):
            req = {"contract_version": 1, "transform_id": "x", "entity": {"id": "x", "type": "IPv4", "value": "10.0.0.1"}}
            self.assertEqual(run(ip_to_internetdb.handle, stdin=io.StringIO(json.dumps(req)), stdout=io.StringIO()), 1)
        t = transform("IPv4", "1.1.1.1")
        with mock.patch.object(ip_to_internetdb, "http_request", return_value=HttpResponse(404, "u", {}, b"{}")), mock.patch("sys.stderr", io.StringIO()):
            ip_to_internetdb.handle(t)
        self.assertEqual((t.data["found"], doc(t)["entities"]), (False, []))


class UsernameTests(unittest.TestCase):
    SITES = [
        {"name": "Alpha", "uri_check": "https://alpha.example/{account}", "e_code": 200, "e_string": "profile", "m_string": "not found", "cat": "social"},
        {"name": "Beta", "uri_check": "https://beta.example/api", "uri_pretty": "https://beta.example/u/{account}", "post_body": '{"u":"{account}"}', "e_code": 200, "e_string": '"id"', "cat": "coding"},
        {"name": "Gamma", "uri_check": "https://gamma.example/{account}", "e_code": 200, "e_string": "profile", "cat": "social"},
        {"name": "Hidden", "uri_check": "https://nsfw.example/{account}", "e_code": 200, "e_string": "x", "cat": "xx NSFW xx"},
        {"name": "Dots", "uri_check": "https://{account}.blog.example/", "strip_bad_char": ".", "e_code": 200, "e_string": "blog", "cat": "blog"},
    ]

    def fake_http(self, url, method="GET", data=None, headers=None, timeout=0):
        if "alpha" in url:
            return HttpResponse(200, url, {}, b"<div>profile</div>")
        if "beta" in url:
            self.assertEqual((method, data), ("POST", b'{"u":"j.doe"}'))
            return HttpResponse(200, url, {}, b'{"id": 1}')
        if "gamma" in url:
            return HttpResponse(200, url, {}, b"profile not found")  # e_string present but m_string? none -> but check status
        if "blog" in url:
            self.assertIn("jdoe.blog.example", url)  # dots stripped
            return HttpResponse(404, url, {}, b"")
        raise AssertionError(f"unexpected request {url}")

    def test_checks_sites_and_returns_profiles(self):
        t = transform("Alias", "@j.doe")
        with mock.patch.object(username_to_accounts, "load_sites", return_value=(self.SITES, "CC BY-SA")), mock.patch.object(
            username_to_accounts, "http_request", side_effect=self.fake_http
        ), mock.patch("sys.stderr", io.StringIO()):
            username_to_accounts.handle(t)
        d = doc(t)
        self.assertEqual(sorted(e["value"] for e in d["entities"]), ["https://alpha.example/j.doe", "https://beta.example/u/j.doe", "https://gamma.example/j.doe"])
        self.assertEqual(t.data["checked"], 4)  # NSFW skipped by default
        self.assertTrue(all(e["label"] == "used_on" for e in d["edges"]))

    def test_account_is_encoded_for_urls_and_bodies(self):
        seen = []

        def http(url, method="GET", data=None, headers=None, timeout=0):
            seen.append((url, data))
            return HttpResponse(200, url, {}, b'profile "id"')

        sites = [self.SITES[0], self.SITES[1], {"name": "Form", "uri_check": "https://form.example/", "post_body": "user={account}", "e_code": 200, "e_string": "profile"}]
        with mock.patch.object(username_to_accounts, "http_request", side_effect=http):
            results = [username_to_accounts.check_site(s, 'a/b?c"ü') for s in sites]
        self.assertEqual(seen[0][0], "https://alpha.example/a%2Fb%3Fc%22%C3%BC")
        self.assertEqual(json.loads(seen[1][1]), {"u": 'a/b?c"ü'})
        self.assertEqual(seen[2][1], b"user=a%2Fb%3Fc%22%C3%BC")
        self.assertEqual(results[1][1], "https://beta.example/u/a%2Fb%3Fc%22%C3%BC")

    def test_site_list_is_cached_privately_and_atomically(self):
        import tempfile

        good = json.dumps({"license": ["CC BY-SA"], "sites": self.SITES}).encode()
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"HOME": home, "APPDATA": home}), mock.patch("sys.stderr", io.StringIO()):
            with mock.patch.object(username_to_accounts, "http_request", return_value=HttpResponse(200, "u", {}, good)):
                sites, _ = username_to_accounts.load_sites(transform("Alias", "x"))
            path = username_to_accounts.cache_file()
            self.assertTrue(path.startswith(home))
            self.assertEqual(len(sites), len(self.SITES))
            if os.name == "posix":
                self.assertEqual(os.stat(os.path.dirname(path)).st_mode & 0o077, 0)
            # A broken download must not replace the good cached copy.
            os.utime(path, (0, 0))
            with mock.patch.object(username_to_accounts, "http_request", return_value=HttpResponse(200, "u", {}, b'{"sites": [')):
                sites, _ = username_to_accounts.load_sites(transform("Alias", "x"))
            self.assertEqual(len(sites), len(self.SITES))

    def test_missing_marker_rejects_hit(self):
        site = {"e_code": 200, "e_string": "profile", "m_string": "not found"}
        self.assertTrue(username_to_accounts.is_hit(site, 200, "profile"))
        self.assertFalse(username_to_accounts.is_hit(site, 200, "profile not found"))
        self.assertFalse(username_to_accounts.is_hit(site, 404, "profile"))

    def test_rejects_usernames_with_spaces(self):
        with mock.patch("sys.stderr", io.StringIO()):
            req = {"contract_version": 1, "transform_id": "x", "entity": {"id": "x", "type": "Alias", "value": "dark lord"}}
            self.assertEqual(run(username_to_accounts.handle, stdin=io.StringIO(json.dumps(req)), stdout=io.StringIO()), 1)


class HttpHelperTests(unittest.TestCase):
    def test_timeouts_become_transform_errors(self):
        import socket

        from osint_transform import TransformError, http_request

        opener = mock.Mock(open=mock.Mock(side_effect=socket.timeout("timed out")))
        with mock.patch("osint_transform._default_opener", return_value=opener):
            with self.assertRaises(TransformError):
                http_request("https://example.com")


    def test_non_ascii_urls_are_encoded_not_crashing(self):
        from osint_transform import TransformError, ascii_url, http_request

        self.assertEqual(ascii_url("https://bücher.example/päth?q=ü#x"), "https://xn--bcher-kva.example/p%C3%A4th?q=%C3%BC#x")
        self.assertEqual(ascii_url("https://example.com/a?b=1"), "https://example.com/a?b=1")
        opener = mock.Mock(open=mock.Mock(side_effect=lambda req, timeout: self.fail("must not be opened")))
        with self.assertRaises(TransformError):
            http_request("https://" + "ä" * 70 + ".example/", opener=opener)  # label too long for IDNA

    def test_socks_addresses_keep_ip_literals_and_limit_names(self):
        from osint_transform import _socks_address

        self.assertEqual(_socks_address("192.0.2.1"), b"\x01\xc0\x00\x02\x01")
        self.assertEqual(_socks_address("[2001:db8::1]")[:1], b"\x04")
        self.assertEqual(len(_socks_address("2001:db8::1")), 17)
        self.assertEqual(_socks_address("example.com"), b"\x03\x0bexample.com")
        with self.assertRaises(OSError):
            _socks_address(".".join(["a" * 60] * 5))  # valid labels, but over 255 bytes

    def test_openers_refuse_ftp_and_file_urls(self):
        # FTP would bypass OSINT_PROXY (and urllib follows redirects to ftp://); file:// reads local files.
        from osint_transform import TransformError, build_opener, http_request

        for env in ({}, {"OSINT_PROXY": "socks5h://127.0.0.1:9"}, {"OSINT_PROXY": "http://127.0.0.1:9"}):
            with mock.patch.dict(os.environ, env):
                opener = build_opener()
                for url in ("ftp://127.0.0.1:9/x", "file:///etc/hosts"):
                    with self.assertRaises(TransformError) as ctx:
                        http_request(url, opener=opener, timeout=2)
                    self.assertIn("refusing", str(ctx.exception), f"{env} {url}")

    def test_http_redirect_to_ftp_is_refused(self):
        import http.server
        import threading

        from osint_transform import TransformError, http_request

        class Redirect(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", "ftp://127.0.0.1:9/leak")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Redirect)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with mock.patch.dict(os.environ), mock.patch("osint_transform._DEFAULT_OPENER", None):
            os.environ.pop("OSINT_PROXY", None)
            with self.assertRaises(TransformError) as ctx:
                http_request(f"http://127.0.0.1:{server.server_port}/", timeout=5)
        self.assertIn("refusing", str(ctx.exception))


class ProxyTests(unittest.TestCase):
    """End-to-end through a tiny local SOCKS5 proxy in front of a local HTTP server."""

    def setUp(self):
        import http.server
        import socket
        import socketserver
        import threading

        class Hello(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = b"hello via " + self.headers.get("Host", "").encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.web = http.server.HTTPServer(("127.0.0.1", 0), Hello)
        web_port = self.web.server_address[1]
        self.requested_hosts = []
        test = self

        class Socks(socketserver.BaseRequestHandler):
            def handle(self):
                c = self.request
                n_methods = c.recv(2)[1]
                methods = c.recv(n_methods)
                if 2 in methods:
                    c.sendall(b"\x05\x02")
                    ulen = c.recv(2)[1]
                    user = c.recv(ulen)
                    plen = c.recv(1)[0]
                    c.recv(plen)
                    test.requested_hosts.append(("user", user.decode()))
                    c.sendall(b"\x01\x00")
                else:
                    c.sendall(b"\x05\x00")
                hdr = c.recv(4)
                assert hdr[3] == 3, "client must send a hostname (remote DNS)"
                name = c.recv(c.recv(1)[0]).decode()
                port = int.from_bytes(c.recv(2), "big")
                test.requested_hosts.append((name, port))
                upstream = socket.create_connection(("127.0.0.1", web_port))
                c.sendall(b"\x05\x00\x00\x01" + bytes(4) + b"\x00\x00")
                c.settimeout(2)
                upstream.settimeout(2)
                req = c.recv(65536)
                upstream.sendall(req)
                resp = b""
                try:
                    while True:
                        chunk = upstream.recv(65536)
                        if not chunk:
                            break
                        resp += chunk
                        if b"hello via" in resp:
                            break
                except socket.timeout:
                    pass
                c.sendall(resp)
                upstream.close()

        self.socks = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Socks)
        self.socks.daemon_threads = True
        for srv in (self.web, self.socks):
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        import osint_transform

        osint_transform._DEFAULT_OPENER = None

    def tearDown(self):
        import osint_transform

        self.web.shutdown()
        self.socks.shutdown()
        osint_transform._DEFAULT_OPENER = None

    def test_requests_go_through_socks5_with_remote_dns(self):
        from osint_transform import http_request

        port = self.socks.server_address[1]
        with mock.patch.dict(os.environ, {"OSINT_PROXY": f"socks5h://127.0.0.1:{port}"}):
            resp = http_request("http://target.invalid:8080/")
        self.assertEqual((resp.status, resp.text()), (200, "hello via target.invalid:8080"))
        self.assertEqual(self.requested_hosts, [("target.invalid", 8080)])  # unresolved name reached the proxy

    def test_socks_username_password(self):
        from osint_transform import http_request

        port = self.socks.server_address[1]
        with mock.patch.dict(os.environ, {"OSINT_PROXY": f"socks5://case-42:x@127.0.0.1:{port}"}):
            http_request("http://target.invalid/")
        self.assertEqual(self.requested_hosts[0], ("user", "case-42"))

    def test_fails_closed_when_proxy_is_down(self):
        import socket

        from osint_transform import TransformError, http_request

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            dead = s.getsockname()[1]
        with mock.patch.dict(os.environ, {"OSINT_PROXY": f"socks5h://127.0.0.1:{dead}"}):
            with self.assertRaises(TransformError) as ctx:
                http_request("http://127.0.0.1:%d/" % self.web.server_address[1])
        self.assertIn("unreachable", str(ctx.exception))

    def test_dns_uses_doh_when_proxied(self):
        with mock.patch.dict(os.environ, {"OSINT_PROXY": "socks5h://127.0.0.1:9050"}):
            self.assertEqual(domain_to_dns.resolver()[1], "dns-over-https via proxy")


class ManifestTests(unittest.TestCase):
    def test_every_manifest_entry_has_a_script(self):
        with open(os.path.join(HERE, "manifest.json")) as fh:
            manifest = json.load(fh)
        ids = [t["id"] for t in manifest["transforms"]]
        self.assertEqual(len(ids), len(set(ids)))
        for t in manifest["transforms"]:
            self.assertTrue(os.path.isfile(os.path.join(HERE, t["command"][-1])), t["id"])


if __name__ == "__main__":
    unittest.main()
