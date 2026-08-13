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
SUMMARY_KEYS = {"eligible", "selected", "ok", "failure", "blocked", "new", "changed", "skipped_ineligible", "skipped_reasons", "degraded"}
OBSERVATION_KEYS = {"record_id", "country", "name", "source_url", "outcome", "http_status", "final_url",
                    "contact_present", "content_fingerprint", "changes", "truncated", "checked_at", "as_of",
                    "triage_state", "redirected", "error"}
HASH_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")


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


def validate_previous(previous: dict, expected_hash: str, as_of: dt.date, known_ids: set[str]) -> dict[tuple[str, str], dict]:
    if not isinstance(previous, dict) or set(previous) != {"schema_version", "as_of", "checked_at", "canonical_hash", "url_limit", "observations", "summary", "policy"}:
        raise ValueError("previous snapshot has invalid schema")
    if previous["schema_version"] != "2.0" or not HASH_RE.fullmatch(previous.get("canonical_hash", "")):
        raise ValueError("previous snapshot has invalid version or hash")
    if previous["canonical_hash"] != expected_hash:
        raise ValueError("previous snapshot canonical hash mismatch")
    if type(previous["url_limit"]) is not int or not 1 <= previous["url_limit"] <= 500:
        raise ValueError("previous snapshot url_limit invalid")
    try:
        prior_date = dt.date.fromisoformat(previous["as_of"])
    except (TypeError, ValueError) as exc:
        raise ValueError("previous snapshot has invalid as_of") from exc
    if prior_date > as_of:
        raise ValueError("previous snapshot as_of is after current date")
    if previous.get("checked_at") != previous["as_of"]:
        raise ValueError("previous snapshot checked_at mismatch")
    summary = previous.get("summary")
    if not isinstance(summary, dict) or set(summary) != SUMMARY_KEYS:
        raise ValueError("previous snapshot summary schema invalid")
    for key in SUMMARY_KEYS - {"skipped_reasons", "degraded"}:
        if type(summary.get(key)) is not int or summary[key] < 0:
            raise ValueError("previous snapshot summary counts invalid")
    if type(summary.get("degraded")) is not bool or not isinstance(summary.get("skipped_reasons"), dict):
        raise ValueError("previous snapshot summary types invalid")
    if any(not isinstance(k, str) or not k or type(v) is not int or v < 0 for k, v in summary["skipped_reasons"].items()):
        raise ValueError("previous snapshot skipped reasons invalid")
    policy = previous.get("policy")
    if not isinstance(policy, dict) or set(policy) != {"meaning", "mutation"} or any(not isinstance(v, str) or not v for v in policy.values()):
        raise ValueError("previous snapshot policy invalid")
    if not isinstance(previous["observations"], list):
        raise ValueError("previous observations must be an array")
    result: dict[tuple[str, str], dict] = {}
    for row in previous["observations"]:
        if not isinstance(row, dict) or set(row) != OBSERVATION_KEYS or row.get("record_id") not in known_ids:
            raise ValueError("previous snapshot contains unknown record ID")
        if not isinstance(row.get("country"), str) or not isinstance(row.get("name"), str):
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
        if key in result:
            raise ValueError("previous snapshot contains duplicate source identity")
        result[key] = row
    if summary["selected"] != len(result) or summary["selected"] > summary["eligible"] or summary["selected"] > previous["url_limit"]:
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
    if summary["degraded"] != (bool(result) and summary["ok"] == 0):
        raise ValueError("previous snapshot degraded flag inconsistent")
    return result


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
    prior = validate_previous(previous, expected_hash, as_of, ids) if previous is not None else {}
    eligible, skipped = eligible_records(data)
    selected = eligible[:limit]
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
    outcomes = Counter(row["outcome"] for row in observations)
    change_count = sum(bool(row["changes"] and row["changes"] != ["new_observation"]) for row in observations)
    new_count = sum(row["changes"] == ["new_observation"] for row in observations)
    degraded = bool(observations) and outcomes["ok"] == 0
    return {"schema_version": "2.0", "as_of": as_of.isoformat(), "checked_at": as_of.isoformat(),
            "canonical_hash": expected_hash, "url_limit": limit, "observations": observations,
            "summary": {"eligible": len(eligible), "selected": len(selected), "ok": outcomes["ok"],
                        "failure": outcomes["fetch_failure"], "blocked": outcomes["blocked"], "new": new_count,
                        "changed": change_count, "skipped_ineligible": sum(skipped.values()),
                        "skipped_reasons": dict(sorted(skipped.items())), "degraded": degraded},
            "policy": {"meaning": "Source observations are review prompts only; they do not prove validity or real-time availability.",
                       "mutation": "No canonical or verification fields are changed."}}


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
             f"- Skipped unsafe or ineligible: {summary['skipped_ineligible']}",
             f"- Degraded: **{'YES' if summary['degraded'] else 'no'}**", "",
             "> Source observations are review prompts only. They do not mean a service was test-called, is valid, or is available in real time.", "",
             "| Record ID | Country | Service | Source | HTTP | Contact observed | Triage |",
             "| --- | --- | --- | --- | ---: | --- | --- |"]
    for row in report["observations"]:
        lines.append(f"| {_escape(row['record_id'])} | {_escape(row['country'])} | {_escape(row['name'])} | {_markdown_link(row['source_url'])} | {_escape(row['http_status'])} | {_escape(row['contact_present'])} | {_escape(row['triage_state'])} |")
    if summary["skipped_reasons"]:
        lines += ["", "## Skipped reasons", ""] + [f"- `{_escape(reason)}`: {count}" for reason, count in summary["skipped_reasons"].items()]
    return "\n".join(lines) + "\n"


def guard_outputs(json_path: Path, markdown_path: Path, inputs: list[Path]) -> None:
    resolved_inputs = {path.resolve() for path in inputs}
    resolved_outputs = [json_path.resolve(), markdown_path.resolve()]
    if resolved_outputs[0] == resolved_outputs[1]:
        raise SystemExit("outputs must not alias each other")
    for path, suffix in ((json_path, ".json"), (markdown_path, ".md")):
        if path.suffix.lower() != suffix:
            raise SystemExit(f"output must end in {suffix}: {path}")
        if path.resolve() in resolved_inputs:
            raise SystemExit("output must not overwrite an input or canonical dataset")
        if path.exists():
            raise SystemExit(f"output already exists: {path}")


def main(argv=None) -> int:
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
        raw = args.input.read_bytes()
        data = json.loads(raw)
        ids = {row.get("id") for country in data.get("countries", []) for row in country.get("hotlines", [])}
        try:
            validate_previous(json.loads(args.previous.read_text()), canonical_hash(raw), as_of, ids)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(f"incompatible prior: {str(exc)[:300]}", file=sys.stderr)
            return 3
        print("compatible prior")
        return 0
    if args.json_output is None or args.markdown_output is None:
        parser.error("--json-output and --markdown-output are required")
    inputs = [args.input, CANONICAL] + ([args.previous] if args.previous else [])
    guard_outputs(args.json_output, args.markdown_output, inputs)
    raw = args.input.read_bytes()
    previous = json.loads(args.previous.read_text()) if args.previous else None
    report = build(json.loads(raw), raw, as_of, args.limit, previous)
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    args.markdown_output.write_text(markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
