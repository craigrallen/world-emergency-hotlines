#!/usr/bin/env python3
"""Bounded, read-only monitoring of canonical first-party source URLs."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import http.client
import ipaddress
import json
import re
import socket
import ssl
import sys
import threading
import queue
import time
import urllib.parse
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable

try:
    from scripts import monitor_delta
    from scripts.artifact_io import coordinated_write, guard_paths
except ModuleNotFoundError:
    import monitor_delta
    from artifact_io import coordinated_write, guard_paths

ROOT = Path(__file__).resolve().parent.parent
CANONICAL = ROOT / "hotlines.json"
MAX_BYTES = 512_000
MAX_REDIRECTS = 4
URL_TIMEOUT = 12.0
RUN_TIMEOUT = 240.0
DEFAULT_LIMIT = 25
UA = "world-emergency-hotlines-source-monitor/2.0 (+https://github.com/craigrallen/world-emergency-hotlines)"
REQUEST_INTERVAL = 0.25
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
OUTCOMES = {"ok", "blocked", "fetch_failure"}
TRIAGE_STATES = {"observed", "review_prompt"}
ALLOWED_CHANGES = {"new_observation", "content_hash_changed", "contact_presence_changed", "redirect_changed", "fetch_failure"}
SUMMARY_KEYS = {"eligible", "selected", "ok", "failure", "blocked", "new", "changed", "skipped_ineligible", "skipped_reasons", "degraded", "baseline_added", "baseline_removed", "canonical_hash_changed"}
OBSERVATION_KEYS = {"record_id", "country", "name", "source_url", "outcome", "http_status", "final_url",
                    "contact_present", "content_fingerprint", "changes", "truncated", "checked_at", "as_of",
                    "triage_state", "redirected", "error"}
HASH_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
MAX_POPULATION = 10_000
MAX_SNAPSHOT_BYTES = 1_000_000
POPULATION_KEYS = {"count", "digest", "identity_hashes"}
POLICY_MEANING = "Source observations are review prompts only; they do not prove validity or real-time availability."
POLICY_MUTATION = "No canonical or verification fields are changed."
POLICY_SELECTION = "ISO-week rotating window with deterministic critical-category cohort"
EMPTY_SNAPSHOT_KEYS = {"schema_version", "as_of", "canonical_hash", "observations"}


def empty_snapshot(as_of: dt.date, canonical_raw: bytes) -> dict:
    return {"schema_version": "3.0-empty-baseline", "as_of": as_of.isoformat(),
            "canonical_hash": canonical_hash(canonical_raw), "observations": []}


def validate_empty_snapshot(value: object, expected_hash: str, run_date: dt.date) -> dict:
    if (not isinstance(value, dict) or set(value) != EMPTY_SNAPSHOT_KEYS
            or value.get("schema_version") != "3.0-empty-baseline"
            or value.get("canonical_hash") != expected_hash or value.get("observations") != []):
        raise ValueError("empty source snapshot schema invalid")
    try:
        observed = dt.date.fromisoformat(value["as_of"])
    except (TypeError, ValueError) as exc:
        raise ValueError("empty source snapshot date invalid") from exc
    if observed != run_date or value["as_of"] != observed.isoformat():
        raise ValueError("empty source snapshot date invalid")
    return value


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript"}:
            self.hidden += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)


def _public_ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    address = ipaddress.ip_address(value.split("%", 1)[0])
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        if not address.ipv4_mapped.is_global:
            raise ValueError("non_public_address")
    if not address.is_global:
        raise ValueError("non_public_address")
    return address


def canonical_source_identity(url: str) -> tuple[str | None, str]:
    """Return a privacy-safe, fetchable URL identity without doing DNS."""
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme.lower() not in {"http", "https"}:
            return None, "non_http_scheme"
        if parsed.username is not None or parsed.password is not None:
            return None, "credentials"
        if parsed.query:
            return None, "query_not_allowed"
        if parsed.fragment:
            return None, "fragment_not_allowed"
        if not parsed.hostname:
            return None, "missing_host"
        host = parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".")
        if host == "localhost" or host.endswith(".localhost"):
            return None, "localhost"
        port = parsed.port
        default = 443 if parsed.scheme.lower() == "https" else 80
        netloc = f"[{host}]" if ":" in host else host
        if port is not None and port != default:
            netloc += f":{port}"
        path = urllib.parse.quote(urllib.parse.unquote(parsed.path or "/"), safe="/%:@!$&'()*+,;=-._~")
        return urllib.parse.urlunsplit((parsed.scheme.lower(), netloc, path, "", "")), "eligible"
    except (UnicodeError, ValueError):
        return None, "malformed_url"


def _resolve_with_deadline(resolver: Callable, host: str, port: int, deadline: float | None):
    if deadline is None:
        return resolver(host, port, type=socket.SOCK_STREAM)
    results: queue.Queue = queue.Queue(maxsize=1)
    def work() -> None:
        try:
            results.put((True, resolver(host, port, type=socket.SOCK_STREAM)))
        except BaseException as exc:
            results.put((False, exc))
    threading.Thread(target=work, daemon=True, name="bounded-dns-resolution").start()
    try:
        ok, value = results.get(timeout=_remaining(deadline))
    except queue.Empty as exc:
        raise TimeoutError("total_deadline") from exc
    if not ok:
        raise value
    return value


def resolve_public(url: str, resolver: Callable = socket.getaddrinfo, deadline: float | None = None) -> tuple[str, int, list[str]]:
    identity, reason = canonical_source_identity(url)
    if identity is None:
        raise ValueError(reason)
    parsed = urllib.parse.urlsplit(identity)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    infos = _resolve_with_deadline(resolver, parsed.hostname, port, deadline)
    if not infos:
        raise ValueError("unresolved_host")
    addresses: set[str] = set()
    for info in infos:
        address = _public_ip(info[4][0])
        addresses.add(address.compressed)
    return identity, port, sorted(addresses, key=lambda value: (ipaddress.ip_address(value).version, ipaddress.ip_address(value).packed))


def safe_public_url(url: str, resolver: Callable = socket.getaddrinfo) -> tuple[bool, str]:
    try:
        resolve_public(url, resolver)
        return True, "eligible"
    except (OSError, ValueError) as exc:
        return False, str(exc) or "malformed_or_unresolved_host"


def display_url(url: str) -> str:
    identity, _ = canonical_source_identity(url)
    return identity or "[ineligible-url]"


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("total_deadline")
    return remaining


class PinnedConnection(http.client.HTTPConnection):
    """HTTP connection whose TCP destination is an already validated IP."""
    def __init__(self, host: str, port: int, pinned_ip: str, validated: set[str], deadline: float,
                 tls: bool, context: ssl.SSLContext | None = None,
                 socket_factory: Callable = socket.create_connection) -> None:
        super().__init__(host, port, timeout=_remaining(deadline))
        self.pinned_ip = pinned_ip
        self.validated = validated
        self.deadline = deadline
        self.tls = tls
        self.context = context or ssl.create_default_context()
        self.socket_factory = socket_factory

    def connect(self) -> None:
        raw = self.socket_factory((self.pinned_ip, self.port), _remaining(self.deadline))
        try:
            peer = _public_ip(raw.getpeername()[0]).compressed
            if peer not in self.validated or peer != ipaddress.ip_address(self.pinned_ip).compressed:
                raise OSError("peer_address_mismatch")
            raw.settimeout(_remaining(self.deadline))
            if self.tls:
                # The original hostname is deliberately retained for SNI and hostname checks.
                raw = self.context.wrap_socket(raw, server_hostname=self.host)
                raw.settimeout(_remaining(self.deadline))
            self.sock = raw
        except BaseException:
            raw.close()
            raise


def redirect_target(current: str, location: str, resolver: Callable = socket.getaddrinfo,
                    deadline: float | None = None) -> tuple[tuple[str, int, list[str]] | None, str]:
    target = urllib.parse.urljoin(current, location)
    try:
        return resolve_public(target, resolver, deadline), "eligible"
    except (OSError, ValueError) as exc:
        return None, str(exc)


def normalized_text(raw: bytes, content_type: str) -> str:
    decoded = raw.decode("utf-8", "replace")
    if "html" in content_type.lower() or "<html" in decoded[:500].lower():
        parser = TextExtractor()
        parser.feed(decoded)
        decoded = " ".join(parser.parts)
    return re.sub(r"\s+", " ", html.unescape(decoded)).strip().casefold()


def _read_bounded(response: http.client.HTTPResponse, deadline: float) -> tuple[bytes, bool]:
    chunks: list[bytes] = []
    length = 0
    while length <= MAX_BYTES:
        if response.fp and getattr(response.fp, "raw", None) and getattr(response.fp.raw, "_sock", None):
            response.fp.raw._sock.settimeout(_remaining(deadline))
        chunk = response.read(min(64 * 1024, MAX_BYTES + 1 - length))
        if not chunk:
            break
        chunks.append(chunk)
        length += len(chunk)
    raw = b"".join(chunks)
    return raw[:MAX_BYTES], len(raw) > MAX_BYTES


def fetch(url: str, *, resolver: Callable = socket.getaddrinfo,
          connection_factory: Callable[..., PinnedConnection] = PinnedConnection,
          deadline: float | None = None) -> dict:
    deadline = min(deadline or time.monotonic() + URL_TIMEOUT, time.monotonic() + URL_TIMEOUT)
    current = url
    resolved = None
    for redirects in range(MAX_REDIRECTS + 1):
        try:
            # A hop's DNS result is consumed directly by its connection attempts.
            # Redirect validation supplies the next hop's result, avoiding rebinding.
            identity, port, addresses = resolved or resolve_public(current, resolver, deadline)
            resolved = None
            parsed = urllib.parse.urlsplit(identity)
            target = parsed.path or "/"
            response = None
            last_error: BaseException | None = None
            for pinned in addresses:
                connection = connection_factory(parsed.hostname, port, pinned, set(addresses), deadline, parsed.scheme == "https")
                try:
                    connection.request("GET", target, headers={"Host": parsed.netloc, "User-Agent": UA,
                                                                 "Accept": "text/html,text/plain;q=0.9,*/*;q=0.1",
                                                                 "Connection": "close"})
                    response = connection.getresponse()
                    break
                except (OSError, ssl.SSLError, http.client.HTTPException, TimeoutError) as exc:
                    last_error = exc
                    connection.close()
            if response is None:
                assert last_error is not None
                raise last_error
            try:
                status = response.status
                if status in REDIRECT_STATUSES:
                    location = response.getheader("Location")
                    if not location:
                        return _failure("fetch_failure", identity, status, "redirect_without_location")
                    if redirects == MAX_REDIRECTS:
                        return _failure("fetch_failure", identity, status, "redirect_limit")
                    target_resolution, reason = redirect_target(identity, location, resolver, deadline)
                    if target_resolution is None:
                        return _failure("blocked", identity, status, f"unsafe_redirect:{reason}")
                    resolved = target_resolution
                    current = resolved[0]
                    continue
                raw, truncated = _read_bounded(response, deadline)
                text = normalized_text(raw, response.getheader("Content-Type", ""))
                outcome = "ok" if 200 <= status < 300 else "fetch_failure"
                result = {"outcome": outcome, "http_status": status, "final_url": identity,
                          "text": text, "truncated": truncated}
                if outcome != "ok":
                    result["error"] = "http_error"
                return result
            finally:
                connection.close()
        except ValueError as exc:
            return _failure("blocked", display_url(current), None, str(exc))
        except (OSError, ssl.SSLError, http.client.HTTPException, TimeoutError) as exc:
            reason = str(exc) if str(exc) in {"peer_address_mismatch", "total_deadline"} else type(exc).__name__
            return _failure("blocked" if reason == "peer_address_mismatch" else "fetch_failure", display_url(current), None, reason)
    raise AssertionError("redirect loop escaped")


def _failure(outcome: str, final_url: str, status: int | None, error: str) -> dict:
    return {"outcome": outcome, "http_status": status, "final_url": final_url,
            "error": error, "text": "", "truncated": False}


def canonical_hash(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def identity_hash(record_id: str, source_url: str) -> str:
    return "sha256:" + hashlib.sha256((record_id + "\0" + source_url).encode("utf-8")).hexdigest()


def population_for(keys: set[tuple[str, str]]) -> dict:
    if len(keys) > MAX_POPULATION:
        raise ValueError("eligible identity population exceeds count limit")
    hashes = sorted(identity_hash(record_id, url) for record_id, url in keys)
    if len(hashes) != len(set(hashes)):
        raise ValueError("eligible identity hash collision")
    digest = canonical_hash("\n".join(hashes).encode("ascii"))
    return {"count": len(hashes), "digest": digest, "identity_hashes": hashes}


def validate_population(value: object) -> set[str]:
    if not isinstance(value, dict) or set(value) != POPULATION_KEYS:
        raise ValueError("previous population schema invalid")
    hashes = value.get("identity_hashes")
    if (type(value.get("count")) is not int or not 0 <= value["count"] <= MAX_POPULATION
            or not isinstance(hashes, list) or len(hashes) != value["count"]
            or hashes != sorted(hashes) or len(hashes) != len(set(hashes))
            or not all(isinstance(item, str) and HASH_RE.fullmatch(item) for item in hashes)):
        raise ValueError("previous population identities invalid")
    if value.get("digest") != canonical_hash("\n".join(hashes).encode("ascii")):
        raise ValueError("previous population digest inconsistent")
    return set(hashes)


def load_snapshot(path: Path) -> dict:
    return monitor_delta.json_bytes(
        monitor_delta.read_bounded_regular(path, MAX_SNAPSHOT_BYTES, "source snapshot"),
        "source snapshot")


def load_canonical(path: Path) -> tuple[bytes, dict]:
    raw = monitor_delta.read_bounded_regular(path, 8_000_000, "canonical input")
    value = monitor_delta.json_bytes(raw, "canonical input")
    if not isinstance(value, dict):
        raise ValueError("canonical input must be an object")
    return raw, value


def eligible_records(data: dict) -> tuple[list[tuple], Counter]:
    rows: dict[tuple[str, str], tuple] = {}
    skipped: Counter[str] = Counter()
    for country in data.get("countries", []):
        for record in country.get("hotlines", []):
            rid = record.get("id")
            candidates = ([record.get("website")] if record.get("website") else []) + (record.get("sources") or [])
            for url in candidates:
                if not isinstance(url, str):
                    skipped["non_string_url"] += 1
                    continue
                identity, reason = canonical_source_identity(url)
                if identity is None:
                    skipped[reason] += 1
                    continue
                key = (rid, identity)
                rows.setdefault(key, (rid, country.get("country", ""), record.get("name") or record.get("organization", ""), identity, record))
    return sorted(rows.values(), key=lambda row: (row[0] or "", row[3])), skipped


def _phone_present(value: str, text: str) -> bool:
    digits = re.sub(r"\D", "", value)
    if len(digits) < 3:
        return False
    pattern = r"(?<!\d)" + r"[\s().+\-/]*".join(map(re.escape, digits)) + r"(?!\d)"
    return re.search(pattern, text) is not None


def contact_present(record: dict, text: str) -> bool | None:
    contacts: list[str] = []
    for field in ("voice_numbers", "sms_numbers", "text_numbers", "short_codes"):
        contacts.extend(str(value) for value in (record.get(field) or []))
    emails = [str(record["email"]).strip().casefold()] if record.get("email") else []
    if not contacts and not emails:
        return None
    folded = text.casefold()
    if any(_phone_present(value, folded) for value in contacts):
        return True
    return any(re.search(r"(?<![\w.+-])" + re.escape(email) + r"(?![\w.-])", folded) for email in emails)


def validate_authenticated_previous_snapshot(previous: dict, run_as_of: dt.date,
                                             state_as_of: str | None = None) -> dict[tuple[str, str], dict]:
    """Validate an authenticated historical v3 snapshot without current data.

    The caller must authenticate the exact snapshot bytes before calling this
    function.  In particular, no assertion here is derived from today's
    canonical file: historical membership is evidence in its own right.
    """
    if not isinstance(previous, dict):
        raise ValueError("previous snapshot has invalid schema")
    if previous.get("schema_version") == "3.0-empty-baseline":
        raise ValueError("authenticated historical snapshot must use schema v3")
    version = previous.get("schema_version")
    expected_top = {"schema_version", "as_of", "checked_at", "canonical_hash", "url_limit", "observations", "summary", "policy"}
    expected_top |= {"population", "metadata"}
    if set(previous) != expected_top or version != "3.0" or not HASH_RE.fullmatch(previous.get("canonical_hash", "")):
        raise ValueError("previous snapshot has invalid version or hash")
    if type(previous["url_limit"]) is not int or not 1 <= previous["url_limit"] <= 500:
        raise ValueError("previous snapshot url_limit invalid")
    try:
        prior_date = dt.date.fromisoformat(previous["as_of"])
    except (TypeError, ValueError) as exc:
        raise ValueError("previous snapshot has invalid as_of") from exc
    if prior_date > run_as_of:
        raise ValueError("previous snapshot as_of is after current date")
    if state_as_of is not None and previous["as_of"] != state_as_of:
        raise ValueError("source state and snapshot dates differ")
    if previous.get("checked_at") != previous["as_of"]:
        raise ValueError("previous snapshot checked_at mismatch")
    summary = previous.get("summary")
    expected_summary = SUMMARY_KEYS
    if not isinstance(summary, dict) or set(summary) != expected_summary:
        raise ValueError("previous snapshot summary schema invalid")
    for key in expected_summary - {"skipped_reasons", "degraded", "canonical_hash_changed", "baseline_added", "baseline_removed"}:
        if type(summary.get(key)) is not int or summary[key] < 0:
            raise ValueError("previous snapshot summary counts invalid")
    migration = previous.get("metadata") == {"population_baseline_unavailable": True}
    for key in ("baseline_added", "baseline_removed"):
        if not ((migration and summary.get(key) is None) or (type(summary.get(key)) is int and summary[key] >= 0)):
            raise ValueError("previous snapshot population churn invalid")
    if (type(summary.get("degraded")) is not bool
            or type(summary.get("canonical_hash_changed")) is not bool
            or not isinstance(summary.get("skipped_reasons"), dict)):
        raise ValueError("previous snapshot summary types invalid")
    if any(not isinstance(k, str) or not k or type(v) is not int or v < 0 for k, v in summary["skipped_reasons"].items()):
        raise ValueError("previous snapshot skipped reasons invalid")
    policy = previous.get("policy")
    expected_policy = {"meaning", "mutation", "selection", "cursor", "critical_cohort"}
    if (not isinstance(policy, dict) or set(policy) != expected_policy
            or not all(isinstance(policy[k], str) and policy[k] for k in ("meaning", "mutation"))
            or (not isinstance(policy["selection"], str) or not policy["selection"]
                or type(policy["cursor"]) is not int or policy["cursor"] < 0
                or type(policy["critical_cohort"]) is not int or not 0 <= policy["critical_cohort"] <= previous["url_limit"])):
        raise ValueError("previous snapshot policy invalid")
    if (policy["selection"] != POLICY_SELECTION or policy["meaning"] != POLICY_MEANING
            or policy["mutation"] != POLICY_MUTATION):
        raise ValueError("previous snapshot selection policy invalid")
    previous_hashes = validate_population(previous["population"])
    if previous["population"]["count"] != summary["eligible"]:
        raise ValueError("previous population count inconsistent")
    if (not isinstance(previous.get("metadata"), dict)
            or set(previous["metadata"]) != {"population_baseline_unavailable"}
            or type(previous["metadata"]["population_baseline_unavailable"]) is not bool):
        raise ValueError("previous snapshot metadata invalid")
    if not isinstance(previous["observations"], list):
        raise ValueError("previous observations must be an array")
    result: dict[tuple[str, str], dict] = {}
    seen_keys: set[tuple[str, str]] = set()
    for row in previous["observations"]:
        if not isinstance(row, dict) or set(row) != OBSERVATION_KEYS:
            raise ValueError("previous snapshot observation schema invalid")
        record_id = row.get("record_id")
        if (not isinstance(record_id, str) or not 0 < len(record_id) <= 200
                or record_id != record_id.strip() or any(ord(char) < 32 or ord(char) == 127 for char in record_id)):
            raise ValueError("previous snapshot record_id invalid")
        if (not isinstance(row.get("country"), str) or len(row["country"]) > 200
                or any(ord(char) < 32 or ord(char) == 127 for char in row["country"])
                or not isinstance(row.get("name"), str) or len(row["name"]) > 300
                or any(ord(char) < 32 or ord(char) == 127 for char in row["name"])):
            raise ValueError("previous snapshot labels invalid")
        identity, reason = canonical_source_identity(row.get("source_url", ""))
        if identity is None or identity != row.get("source_url"):
            raise ValueError(f"previous snapshot source identity invalid: {reason}")
        if row.get("outcome") not in OUTCOMES:
            raise ValueError("previous snapshot outcome invalid")
        final_identity, final_reason = canonical_source_identity(row.get("final_url", ""))
        if final_identity is None or final_identity != row.get("final_url"):
            raise ValueError(f"previous snapshot final identity invalid: {final_reason}")
        if row.get("redirected") != (identity != final_identity):
            raise ValueError("previous snapshot redirected inconsistent")
        status = row.get("http_status")
        if status is not None and (type(status) is not int or not 100 <= status <= 599):
            raise ValueError("previous snapshot status invalid")
        if row.get("contact_present") not in {True, False, None} or not isinstance(row.get("truncated"), bool) or not isinstance(row.get("redirected"), bool):
            raise ValueError("previous snapshot observation types invalid")
        if (not isinstance(row.get("changes"), list) or len(row["changes"]) != len(set(row["changes"]))
                or not all(value in ALLOWED_CHANGES for value in row["changes"])):
            raise ValueError("previous snapshot changes invalid")
        if ("new_observation" in row["changes"] and row["changes"] != ["new_observation"]
                or "fetch_failure" in row["changes"] and row["outcome"] == "ok"):
            raise ValueError("previous snapshot changes inconsistent")
        for date_field in ("as_of", "checked_at"):
            try:
                row_date = dt.date.fromisoformat(row[date_field])
            except (TypeError, ValueError) as exc:
                raise ValueError("previous snapshot observation date invalid") from exc
            if row_date != prior_date:
                raise ValueError("previous snapshot observation date mismatch")
        fingerprint = row.get("content_fingerprint")
        if fingerprint is not None and not HASH_RE.fullmatch(fingerprint):
            raise ValueError("previous snapshot fingerprint invalid")
        error = row.get("error")
        if error is not None and (not isinstance(error, str) or not error or len(error) > 500):
            raise ValueError("previous snapshot error invalid")
        if row.get("triage_state") not in TRIAGE_STATES:
            raise ValueError("previous snapshot triage state invalid")
        if row["outcome"] == "ok":
            if status is None or not 200 <= status < 300 or fingerprint is None or error is not None:
                raise ValueError("previous snapshot successful outcome inconsistent")
        elif fingerprint is not None or row.get("contact_present") is not None or error is None:
            raise ValueError("previous snapshot failed outcome inconsistent")
        if row["outcome"] == "fetch_failure" and status is not None and 200 <= status < 300:
            raise ValueError("previous snapshot failure status inconsistent")
        expected_triage = "review_prompt" if row["outcome"] != "ok" or row["redirected"] or any(c != "new_observation" for c in row["changes"]) else "observed"
        if row["triage_state"] != expected_triage:
            raise ValueError("previous snapshot triage state inconsistent")
        key = (row["record_id"], identity)
        if key in seen_keys:
            raise ValueError("previous snapshot contains duplicate source identity")
        seen_keys.add(key)
        if identity_hash(*key) not in previous_hashes:
            raise ValueError("previous observation is absent from stored population")
        result[key] = row
    if list(result) != sorted(result):
        raise ValueError("previous observations are not sorted by source identity")
    if summary["selected"] != len(previous["observations"]) or summary["selected"] > summary["eligible"] or summary["selected"] > previous["url_limit"]:
        raise ValueError("previous snapshot selection counts inconsistent")
    counts = Counter(row["outcome"] for row in previous["observations"])
    if (summary["ok"], summary["failure"], summary["blocked"]) != (counts["ok"], counts["fetch_failure"], counts["blocked"]):
        raise ValueError("previous snapshot outcome counts inconsistent")
    if summary["new"] != sum(r["changes"] == ["new_observation"] for r in previous["observations"]):
        raise ValueError("previous snapshot new count inconsistent")
    if summary["changed"] != sum(bool(r["changes"] and r["changes"] != ["new_observation"]) for r in previous["observations"]):
        raise ValueError("previous snapshot changed count inconsistent")
    if summary["skipped_ineligible"] != sum(summary["skipped_reasons"].values()):
        raise ValueError("previous snapshot skipped count inconsistent")
    if summary["degraded"] != (bool(previous["observations"]) and summary["ok"] == 0):
        raise ValueError("previous snapshot degraded flag inconsistent")
    if summary["selected"] != min(previous["url_limit"], summary["eligible"]):
        raise ValueError("previous selected count is not the complete bounded window")
    remaining = summary["eligible"] - policy["critical_cohort"]
    if policy["critical_cohort"] > min(5, summary["selected"]):
        raise ValueError("previous critical cohort invalid")
    if (remaining == 0 and policy["cursor"] != 0) or (remaining > 0 and policy["cursor"] >= remaining):
        raise ValueError("previous selection cursor invalid")
    return result


def validate_previous(previous: dict, expected_hash: str, as_of: dt.date,
                      known_ids: set[str], current_keys: set[tuple[str, str]] | None = None) -> dict[tuple[str, str], dict]:
    """Compatibility wrapper: intrinsically validate, then filter comparisons."""
    if previous.get("schema_version") == "3.0-empty-baseline":
        validate_empty_snapshot(previous, expected_hash, dt.date.fromisoformat(previous.get("as_of", "")))
        if dt.date.fromisoformat(previous["as_of"]) > as_of:
            raise ValueError("previous snapshot as_of is after current date")
        return {}
    if previous["canonical_hash"] == expected_hash and current_keys is not None:
        if previous.get("schema_version") == "3.0" and validate_population(previous["population"]) != set(population_for(current_keys)["identity_hashes"]):
            raise ValueError("previous population does not match current canonical identities")
    if previous.get("schema_version") == "2.0":
        expected = {"schema_version", "as_of", "checked_at", "canonical_hash", "url_limit", "observations", "summary", "policy"}
        if set(previous) != expected or set(previous.get("policy", {})) != {"meaning", "mutation"}:
            raise ValueError("previous snapshot has invalid schema")
        eligible = previous.get("summary", {}).get("eligible")
        observed = previous.get("observations")
        if type(eligible) is not int or eligible < 0 or not isinstance(observed, list):
            raise ValueError("previous snapshot summary invalid")
        hashes = sorted(identity_hash(row.get("record_id", ""), row.get("source_url", ""))
                        for row in observed if isinstance(row, dict))
        nonce = 0
        while len(hashes) < eligible:
            candidate = canonical_hash(f"legacy-unobserved-{nonce}".encode())
            nonce += 1
            if candidate not in hashes: hashes.append(candidate)
        hashes.sort()
        upgraded = json.loads(json.dumps(previous))
        upgraded["schema_version"] = "3.0"
        upgraded["population"] = {"count": eligible, "digest": canonical_hash("\n".join(hashes).encode("ascii")), "identity_hashes": hashes}
        upgraded["metadata"] = {"population_baseline_unavailable": True}
        upgraded["summary"].update(baseline_added=None, baseline_removed=None, canonical_hash_changed=previous["canonical_hash"] != expected_hash)
        upgraded["policy"].update(selection=POLICY_SELECTION, cursor=0, critical_cohort=0)
        validated = validate_authenticated_previous_snapshot(upgraded, as_of)
    else:
        validated = validate_authenticated_previous_snapshot(previous, as_of)
    return {key: row for key, row in validated.items()
            if key[0] in known_ids and (current_keys is None or key in current_keys)}


def validate_current_snapshot(snapshot: dict, canonical_raw: bytes) -> dict:
    """Strictly validate a complete current v3 snapshot at every trust boundary."""
    if not isinstance(snapshot, dict) or snapshot.get("schema_version") != "3.0":
        raise ValueError("current source snapshot must use schema v3")
    try:
        as_of = dt.date.fromisoformat(snapshot.get("as_of", ""))
    except (TypeError, ValueError) as exc:
        raise ValueError("current source snapshot date invalid") from exc
    observations = snapshot.get("observations")
    if not isinstance(observations, list):
        raise ValueError("current source observations invalid")
    if not isinstance(canonical_raw, bytes):
        raise ValueError("canonical raw bytes are required for current source snapshot validation")
    expected_hash = canonical_hash(canonical_raw)
    data = json.loads(canonical_raw)
    eligible, skipped = eligible_records(data)
    current_keys = {(row[0], row[3]) for row in eligible}
    known_ids = {row.get("id") for country in data.get("countries", []) for row in country.get("hotlines", [])}
    summary = snapshot.get("summary", {})
    if (summary.get("eligible") != len(eligible)
            or summary.get("skipped_reasons") != dict(sorted(skipped.items()))
            or summary.get("skipped_ineligible") != sum(skipped.values())
            or snapshot.get("population") != population_for(current_keys)):
        raise ValueError("current source snapshot canonical population inconsistent")
    selected, cursor, critical = rotating_selection(eligible, snapshot.get("url_limit"), as_of)
    expected_order = sorted((row[0], row[1], row[2], row[3]) for row in selected)
    actual_order = [(row.get("record_id"), row.get("country"), row.get("name"), row.get("source_url"))
                    for row in observations if isinstance(row, dict)]
    if (len(actual_order) != len(observations) or actual_order != expected_order
            or snapshot.get("policy", {}).get("cursor") != cursor
            or snapshot.get("policy", {}).get("critical_cohort") != critical):
        raise ValueError("current source snapshot canonical selection inconsistent")
    validate_previous(snapshot, expected_hash, as_of, known_ids, current_keys)
    if snapshot["as_of"] != as_of.isoformat():
        raise ValueError("current source snapshot date is not canonical")
    return snapshot


def rotating_selection(eligible: list[tuple], limit: int, as_of: dt.date) -> tuple[list[tuple], int, int]:
    """Reserve a small critical cohort, then rotate the remainder by ISO week."""
    critical_categories = {"emergency", "suicide_crisis"}
    critical = [row for row in eligible if row[4].get("category") in critical_categories]
    critical_count = min(len(critical), limit, max(1, min(5, limit // 5 or 1)))
    fixed = critical[:critical_count]
    fixed_keys = {(row[0], row[3]) for row in fixed}
    pool = [row for row in eligible if (row[0], row[3]) not in fixed_keys]
    remaining = limit - len(fixed)
    cursor = 0 if not pool else ((as_of.isocalendar().year * 53 + as_of.isocalendar().week) * max(1, remaining)) % len(pool)
    rotated = (pool[cursor:] + pool[:cursor])[:remaining]
    return fixed + rotated, cursor, critical_count


def compare(observation: dict, prior_by_key: dict) -> list[str]:
    prior = prior_by_key.get((observation["record_id"], observation["source_url"]))
    if not prior:
        return ["new_observation"]
    changes = []
    for field, label in (("content_fingerprint", "content_hash_changed"), ("contact_present", "contact_presence_changed"), ("final_url", "redirect_changed")):
        if prior.get(field) != observation.get(field):
            changes.append(label)
    if observation["outcome"] != "ok" and prior.get("outcome") == "ok":
        changes.append("fetch_failure")
    return changes


def build(data: dict, raw: bytes, as_of: dt.date, limit: int, previous: dict | None, fetcher=fetch) -> dict:
    expected_hash = canonical_hash(raw)
    ids = {row.get("id") for country in data.get("countries", []) for row in country.get("hotlines", [])}
    eligible, skipped = eligible_records(data)
    current_keys = {(row[0], row[3]) for row in eligible}
    prior = validate_previous(previous, expected_hash, as_of, ids, current_keys) if previous is not None else {}
    population = population_for(current_keys)
    selected, cursor, critical_count = rotating_selection(eligible, limit, as_of)
    # Authenticated v3 artifact loading validates this stored population before
    # it reaches the producer, so canonical revisions can report truthful churn.
    population_unavailable = previous is None or previous.get("schema_version") == "2.0"
    if population_unavailable:
        previous_hashes = set()
    else:
        previous_hashes = validate_population(previous["population"])
        if previous.get("canonical_hash") == expected_hash and previous_hashes != set(population["identity_hashes"]):
            raise ValueError("previous population does not match current canonical identities")
    current_hashes = set(population["identity_hashes"])
    added = None if population_unavailable else len(current_hashes - previous_hashes)
    removed = None if population_unavailable else len(previous_hashes - current_hashes)
    observations = []
    run_deadline = time.monotonic() + RUN_TIMEOUT
    for position, (rid, country, name, url, record) in enumerate(selected):
        if position and fetcher is fetch:
            time.sleep(min(REQUEST_INTERVAL, max(0, run_deadline - time.monotonic())))
        if time.monotonic() >= run_deadline:
            result = _failure("fetch_failure", url, None, "run_deadline")
        elif fetcher is fetch:
            result = fetcher(url, deadline=run_deadline)
        else:
            result = fetcher(url)
        text = result.pop("text", "")
        fingerprint = "sha256:" + hashlib.sha256(text.encode()).hexdigest() if result["outcome"] == "ok" else None
        obs = {"record_id": rid, "country": country, "name": name, "source_url": url,
               "outcome": result["outcome"], "http_status": result.get("http_status"), "final_url": result["final_url"],
               "redirected": url != result["final_url"], "contact_present": contact_present(record, text) if result["outcome"] == "ok" else None,
               "content_fingerprint": fingerprint, "checked_at": as_of.isoformat(), "as_of": as_of.isoformat(),
               "triage_state": "review_prompt" if result["outcome"] != "ok" else "observed",
               "error": result.get("error"), "truncated": result.get("truncated", False)}
        obs["changes"] = compare(obs, prior)
        if obs["redirected"] or any(change != "new_observation" for change in obs["changes"]):
            obs["triage_state"] = "review_prompt"
        observations.append(obs)
    observations.sort(key=lambda row: (row["record_id"], row["source_url"]))
    outcomes = Counter(row["outcome"] for row in observations)
    change_count = sum(bool(row["changes"] and row["changes"] != ["new_observation"]) for row in observations)
    new_count = sum(row["changes"] == ["new_observation"] for row in observations)
    degraded = bool(observations) and outcomes["ok"] == 0
    return {"schema_version": "3.0", "as_of": as_of.isoformat(), "checked_at": as_of.isoformat(),
            "canonical_hash": expected_hash, "url_limit": limit, "observations": observations,
            "population": population, "metadata": {"population_baseline_unavailable": population_unavailable},
            "summary": {"eligible": len(eligible), "selected": len(selected), "ok": outcomes["ok"],
                        "failure": outcomes["fetch_failure"], "blocked": outcomes["blocked"], "new": new_count,
                        "changed": change_count, "skipped_ineligible": sum(skipped.values()),
                        "skipped_reasons": dict(sorted(skipped.items())), "degraded": degraded,
                        "baseline_added": added, "baseline_removed": removed,
                        "canonical_hash_changed": bool(previous and previous["canonical_hash"] != expected_hash)},
            "policy": {"meaning": POLICY_MEANING,
                       "mutation": POLICY_MUTATION,
                       "selection": POLICY_SELECTION,
                       "cursor": cursor, "critical_cohort": critical_count}}


def _escape(value: object) -> str:
    value = str(value if value not in (None, "") else "—")
    value = "".join(" " if ord(char) < 32 or ord(char) == 127 else char for char in value)
    escaped = html.escape(value, quote=True)
    return escaped.translate(str.maketrans({"|": "&#124;", "[": "&#91;", "]": "&#93;", "(": "&#40;", ")": "&#41;", "!": "&#33;", "`": "&#96;", "\\": "&#92;"}))


def _markdown_link(url: str) -> str:
    safe = urllib.parse.quote(url, safe="https:/%:@!$&'()*+,;=-._~")
    return f"<a href=\"{html.escape(safe, quote=True)}\">source</a>"


def markdown(report: dict) -> str:
    summary = report["summary"]
    lines = ["# Source monitor review", "", f"- As of: `{_escape(report['as_of'])}`",
             f"- Canonical hash: `{_escape(report['canonical_hash'])}`",
             f"- Selected / eligible: {summary['selected']} / {summary['eligible']}",
             f"- Outcomes: ok {summary['ok']}; failure {summary['failure']}; blocked {summary['blocked']}",
             f"- New / changed: {summary['new']} / {summary['changed']}",
             f"- Selection: {_escape(report['policy']['selection'])}; cursor {report['policy']['cursor']}; critical cohort {report['policy']['critical_cohort']}",
             f"- Canonical hash changed from baseline: **{'YES' if summary['canonical_hash_changed'] else 'no'}**",
             f"- Baseline membership added / removed: {summary['baseline_added']} / {summary['baseline_removed']}",
             f"- Skipped unsafe or ineligible: {summary['skipped_ineligible']}",
             f"- Degraded: **{'YES' if summary['degraded'] else 'no'}**", "",
             "> Source observations are review prompts only. They do not mean a service was test-called, is valid, or is available in real time.", "",
             "| Record ID | Country | Service | Source | HTTP | Contact observed | Triage |",
             "| --- | --- | --- | --- | ---: | --- | --- |"]
    if report["metadata"]["population_baseline_unavailable"]:
        lines.insert(10, "- Population baseline: **unavailable for the first snapshot or one-time v2 migration; churn is not inferred without independently reconstructable provenance**")
    for row in report["observations"]:
        lines.append(f"| {_escape(row['record_id'])} | {_escape(row['country'])} | {_escape(row['name'])} | {_markdown_link(row['source_url'])} | {_escape(row['http_status'])} | {_escape(row['contact_present'])} | {_escape(row['triage_state'])} |")
    if summary["skipped_reasons"]:
        lines += ["", "## Skipped reasons", ""] + [f"- `{_escape(reason)}`: {count}" for reason, count in summary["skipped_reasons"].items()]
    return "\n".join(lines) + "\n"


def guard_outputs(json_path: Path, markdown_path: Path, inputs: list[Path]) -> None:
    try:
        guard_paths(inputs, [(json_path, ".json"), (markdown_path, ".md")])
    except (OSError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc


def main(argv=None, fetcher=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=CANONICAL)
    parser.add_argument("--as-of", required=True)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--validate-previous-only", action="store_true",
                        help="Validate --previous against current input/as-of; exit 3 when incompatible")
    parser.add_argument("--json-output", type=Path)
    parser.add_argument("--markdown-output", type=Path)
    args = parser.parse_args(argv)
    try:
        as_of = dt.date.fromisoformat(args.as_of)
    except ValueError:
        parser.error("--as-of must be YYYY-MM-DD")
    if not 1 <= args.limit <= 500:
        parser.error("--limit must be between 1 and 500")
    if args.validate_previous_only:
        if not args.previous:
            parser.error("--validate-previous-only requires --previous")
        raw, data = load_canonical(args.input)
        ids = {row.get("id") for country in data.get("countries", []) for row in country.get("hotlines", [])}
        eligible, _ = eligible_records(data)
        current_keys = {(row[0], row[3]) for row in eligible}
        try:
            validate_previous(load_snapshot(args.previous), canonical_hash(raw), as_of, ids, current_keys)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(f"incompatible prior: {str(exc)[:300]}", file=sys.stderr)
            return 3
        print("compatible prior")
        return 0
    if args.json_output is None or args.markdown_output is None:
        parser.error("--json-output and --markdown-output are required")
    # The declared input and repository canonical file are the same logical
    # read-only input in the default invocation. Deduplicate only that pair;
    # distinct logical inputs (especially a previous snapshot) remain subject
    # to the strict alias checks in guard_paths.
    inputs = [args.input]
    try:
        same_canonical = args.input.resolve(strict=True) == CANONICAL.resolve(strict=True) or args.input.samefile(CANONICAL)
    except OSError:
        same_canonical = False
    if not same_canonical:
        inputs.append(CANONICAL)
    inputs += [args.previous] if args.previous else []
    guard_outputs(args.json_output, args.markdown_output, inputs)
    raw, data = load_canonical(args.input)
    previous = load_snapshot(args.previous) if args.previous else None
    if previous is not None and previous.get("schema_version") == "3.0-empty-baseline":
        validate_previous(previous,canonical_hash(raw),as_of,set(),set())
        previous=None
    report = build(data, raw, as_of, args.limit, previous, fetch if fetcher is None else fetcher)
    json_payload = (json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    if len(json_payload) > MAX_SNAPSHOT_BYTES:
        raise SystemExit("source snapshot exceeds byte limit")
    coordinated_write([
        (args.json_output, json_payload),
        (args.markdown_output, markdown(report).encode()),
    ])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
