import datetime as dt
import importlib.util
import json
import ssl
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("source_monitor", ROOT / "scripts/source_monitor.py")
sm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sm)


def resolver(*addresses):
    return lambda *args, **kwargs: [(None, None, None, None, (address, 443)) for address in addresses]


class FakeSocket:
    def __init__(self, peer): self.peer = peer; self.timeout = None; self.closed = False
    def getpeername(self): return (self.peer, 443)
    def settimeout(self, value): self.timeout = value
    def close(self): self.closed = True


class SourceMonitorTests(unittest.TestCase):
    def data(self, url="https://example.org/"):
        return {"countries": [{"country": "X", "hotlines": [{"id": "weh_1", "name": "Help", "category": "emergency", "website": url, "sources": [], "voice_numbers": ["12345"]}]}]}

    def test_identity_rejects_private_inputs_before_dns(self):
        public = resolver("93.184.216.34")
        self.assertTrue(sm.safe_public_url("https://example.org/a", public)[0])
        for url in ("https://example.org/a?token=secret", "https://example.org/#secret", "file:///etc/passwd", "http://user:pass@example.org/", "http://localhost/", "http://example.org:bad/"):
            self.assertFalse(sm.safe_public_url(url, public)[0])
        self.assertEqual(sm.display_url("https://example.org/a?token=secret"), "[ineligible-url]")

    def test_all_dns_answers_must_be_global_including_mapped_ipv6(self):
        for addresses in (("93.184.216.34", "127.0.0.1"), ("::ffff:127.0.0.1",)):
            ok, reason = sm.safe_public_url("https://example.org/", resolver(*addresses))
            self.assertFalse(ok)
            self.assertIn("non_public", reason)

    def test_connection_is_pinned_and_peer_mismatch_rejected(self):
        calls = []
        def factory(destination, timeout):
            calls.append(destination)
            return FakeSocket("8.8.4.4")
        conn = sm.PinnedConnection("example.org", 443, "8.8.8.8", {"8.8.8.8"}, 10**9, False, socket_factory=factory)
        with self.assertRaisesRegex(OSError, "peer_address_mismatch"):
            conn.connect()
        self.assertEqual(calls, [("8.8.8.8", 443)])

    def test_tls_uses_default_verifying_context_and_original_hostname(self):
        conn = sm.PinnedConnection("example.org", 443, "8.8.8.8", {"8.8.8.8"}, 10**9, True)
        self.assertEqual(conn.context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(conn.context.check_hostname)
        self.assertEqual(conn.host, "example.org")

    def test_redirect_target_is_resolved_separately(self):
        calls = []
        def resolve(host, port, **kwargs):
            calls.append(host)
            return resolver("8.8.8.8")(host, port, **kwargs)
        target, reason = sm.redirect_target("https://example.org/a", "https://other.example/b", resolve)
        self.assertEqual((target, reason), (("https://other.example/b", 443, ["8.8.8.8"]), "eligible"))
        self.assertEqual(calls, ["other.example"])

    def test_selection_deduplicates_identity_and_never_fetches_queries(self):
        data = self.data("https://EXAMPLE.org:443/a")
        data["countries"][0]["hotlines"][0]["sources"] = ["https://example.org/a", "https://example.org/a?secret=x"]
        rows, skipped = sm.eligible_records(data)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][3], "https://example.org/a")
        self.assertEqual(skipped["query_not_allowed"], 1)

    def test_contact_boundaries_empty_fingerprint_and_exact_truncation(self):
        record = self.data()["countries"][0]["hotlines"][0]
        self.assertTrue(sm.contact_present(record, "Call 12-345 now"))
        self.assertFalse(sm.contact_present(record, "Call 9123456 now"))
        raw = json.dumps(self.data()).encode()
        result = sm.build(self.data(), raw, dt.date(2026, 8, 13), 5, None,
                          lambda url: {"outcome": "ok", "http_status": 200, "final_url": url, "text": "", "truncated": False})
        self.assertRegex(result["observations"][0]["content_fingerprint"], r"^sha256:[0-9a-f]{64}$")

    def test_previous_is_strict_and_previous_urls_are_never_fetch_targets(self):
        data = self.data(); raw = json.dumps(data).encode(); calls = []
        base = sm.build(data, raw, dt.date(2026, 8, 12), 5, None,
                        lambda url: {"outcome": "ok", "http_status": 200, "final_url": url, "text": "12345", "truncated": False})
        def fetcher(url): calls.append(url); return {"outcome": "ok", "http_status": 200, "final_url": url, "text": "12345", "truncated": False}
        sm.build(data, raw, dt.date(2026, 8, 13), 5, base, fetcher)
        self.assertEqual(calls, ["https://example.org/"])
        base["observations"].append(dict(base["observations"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            sm.build(data, raw, dt.date(2026, 8, 13), 5, base, fetcher)

    def test_output_alias_guard(self):
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "out"
            with self.assertRaisesRegex(SystemExit, "alias"):
                sm.guard_outputs(target, target, [])

    def test_markdown_table_metacharacters_are_inert(self):
        data = self.data(); raw = json.dumps(data).encode()
        report = sm.build(data, raw, dt.date(2026, 8, 13), 1, None,
                          lambda url: {"outcome": "ok", "http_status": 200, "final_url": url, "text": "12345", "truncated": False})
        payload = "x|[click](https://evil.invalid)!`<b>\r\n\x01"
        report["observations"][0].update(record_id=payload, country=payload, name=payload)
        rendered = sm.markdown(report)
        row = next(line for line in rendered.splitlines() if "&#91;click&#93;" in line)
        self.assertEqual(row.count("|"), 8)
        self.assertNotIn("[click](", rendered)
        self.assertNotIn("![", rendered)
        self.assertNotIn("<b>", rendered)

    def test_bounded_read_exact_limit_and_one_over(self):
        class Response:
            fp = None
            def __init__(self, body): self.body = body
            def read(self, size): chunk, self.body = self.body[:size], self.body[size:]; return chunk
        self.assertEqual(sm._read_bounded(Response(b"x" * sm.MAX_BYTES), 10**9), (b"x" * sm.MAX_BYTES, False))
        self.assertEqual(sm._read_bounded(Response(b"x" * (sm.MAX_BYTES + 1)), 10**9), (b"x" * sm.MAX_BYTES, True))

    def test_failover_uses_validated_addresses_stops_on_response_and_closes(self):
        calls, connections = [], []
        class Response:
            status = 503; fp = None
            def getheader(self, name, default=None): return default
            def read(self, size): return b""
        class Connection:
            def __init__(self, host, port, pinned, validated, deadline, tls):
                self.pinned = pinned; self.closed = False; connections.append(self)
            def request(self, *args, **kwargs):
                calls.append(self.pinned)
                if self.pinned == "8.8.4.4": raise OSError("connect")
            def getresponse(self): return Response()
            def close(self): self.closed = True
        result = sm.fetch("https://example.org/", resolver=resolver("2001:4860:4860::8888", "8.8.4.4", "8.8.8.8"), connection_factory=Connection)
        self.assertEqual(calls, ["8.8.4.4", "8.8.8.8"])
        self.assertEqual(result["http_status"], 503)
        self.assertEqual(result["text"], "")
        self.assertTrue(all(c.closed for c in connections))

    def test_redirect_resolution_is_reused_and_connections_close(self):
        resolutions, connected, connections = [], [], []
        def resolve(host, port, **kwargs):
            resolutions.append(host)
            address = "8.8.8.8" if host == "example.org" else "1.1.1.1"
            return [(None, None, None, None, (address, port))]
        class Response:
            fp = None
            def __init__(self, status, location=None): self.status=status; self.location=location
            def getheader(self, name, default=None): return self.location if name == "Location" else default
            def read(self, size): return b"ok" if self.status == 200 else b""
        class Connection:
            def __init__(self, host, port, pinned, validated, deadline, tls): self.host=host; self.pinned=pinned; self.closed=False; connections.append(self)
            def request(self, *args, **kwargs): connected.append(self.pinned)
            def getresponse(self): return Response(302, "https://other.example/b") if self.host == "example.org" else Response(200)
            def close(self): self.closed=True
        result = sm.fetch("https://example.org/a", resolver=resolve, connection_factory=Connection)
        self.assertEqual(resolutions, ["example.org", "other.example"])
        self.assertEqual(connected, ["8.8.8.8", "1.1.1.1"])
        self.assertEqual(result["final_url"], "https://other.example/b")
        self.assertTrue(all(c.closed for c in connections))

    def test_expired_total_deadline_is_bounded(self):
        result = sm.fetch("https://example.org/", resolver=resolver("8.8.8.8"), deadline=time.monotonic() - 1)
        self.assertEqual(result["error"], "total_deadline")

    def test_host_header_formats_default_nondefault_and_ip_literals(self):
        observed = []
        class Response:
            status = 200; fp = None
            def getheader(self, name, default=None): return default
            def read(self, size): return b""
        class Connection:
            def __init__(self, *args): pass
            def request(self, method, target, headers): observed.append(headers["Host"])
            def getresponse(self): return Response()
            def close(self): pass
        for url, address in (("http://example.org/", "8.8.8.8"), ("http://example.org:8080/", "8.8.8.8"),
                             ("http://8.8.8.8:8080/", "8.8.8.8"), ("http://[2001:4860:4860::8888]:8080/", "2001:4860:4860::8888")):
            sm.fetch(url, resolver=resolver(address), connection_factory=Connection)
        self.assertEqual(observed, ["example.org", "example.org:8080", "8.8.8.8:8080", "[2001:4860:4860::8888]:8080"])


if __name__ == "__main__": unittest.main()
