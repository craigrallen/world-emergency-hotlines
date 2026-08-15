#!/usr/bin/env python3
"""Combine strictly bound read-only review signals into reviewer artifacts."""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import html
import json
import re
import urllib.parse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.apply_promotion_candidates import apply_candidate
from scripts.freshness_report import build_report as build_freshness_report
from scripts.lib.provenance import provenance_issues
from scripts.lib.promotion import (SAFE_CANDIDATE_TYPES, SAFE_FIELD_ACTIONS, LIST_APPEND_FIELDS,
                                   SCALAR_FILL_FIELDS, MERGE_FIELD_ACTIONS, additive_general_emergency_actions,
                                   compute_additive_hotline_field_actions, normalize_text)
from scripts.lib.safety import country_has_protected_hotlines, validate_promotion_candidate
from scripts.source_monitor import population_for, validate_current_snapshot

CANONICAL = ROOT / "hotlines.json"
HASH_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
ALLOWED_APPROVAL_STATES = frozenset({"approved", "rejected", "needs_manual_source_check"})
FRESHNESS_STATES = {"stale", "undated", "invalid_date", "future_date"}
MONITOR_OUTCOMES = {"ok", "blocked", "fetch_failure"}
MARKDOWN_PREVIEW_LIMIT = 100


def version(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def bundle_hash(bundle: dict) -> str:
    payload = {key: value for key, value in bundle.items() if key not in {"bundle_hash", "candidate_bundle_hash"}}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


def safe_link(value: object) -> str | None:
    try:
        parsed = urllib.parse.urlsplit(str(value))
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            return None
        if parsed.query or parsed.fragment:
            return None
        host = parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".")
        port = parsed.port
        default = 443 if parsed.scheme == "https" else 80
        netloc = f"[{host}]" if ":" in host else host
        if port is not None and port != default:
            netloc += f":{port}"
        path = urllib.parse.quote(urllib.parse.unquote(parsed.path or "/"), safe="/%:@!$&'()*+,;=-._~")
        return urllib.parse.urlunsplit((parsed.scheme, netloc, path, "", ""))
    except (UnicodeError, ValueError):
        return None


def index_records(data: dict) -> dict[str, tuple[dict, dict]]:
    result = {}
    if not isinstance(data, dict) or not isinstance(data.get("countries"), list):
        raise ValueError("canonical dataset structure invalid")
    for country in data["countries"]:
        for hotline in country.get("hotlines", []):
            rid = hotline.get("id")
            if not isinstance(rid, str) or not rid or rid in result:
                raise ValueError(f"missing or duplicate canonical record ID: {rid!r}")
            result[rid] = (country, hotline)
    return result


def _date(value: object, label: str) -> dt.date:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be an ISO date")
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO date") from exc


def _bound_hash(artifact: dict, label: str, canonical_version: str) -> None:
    value = artifact.get("canonical_hash")
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        raise ValueError(f"{label} canonical_hash missing or malformed")
    if value != canonical_version:
        raise ValueError(f"{label} canonical hash mismatch")


def validate_freshness(artifact: dict, canonical_version: str, ids: dict[str, tuple[dict, dict]], as_of: dt.date) -> None:
    required = {"schema_version", "canonical_hash", "as_of", "stale_after_days", "review_limit", "summary",
                "review_required_by_status", "all_records_by_status", "all_records_by_category", "review_queue",
                "review_records", "review_queue_total", "review_queue_omitted", "review_queue_truncated", "policy"}
    if not isinstance(artifact, dict) or set(artifact) != required or artifact.get("schema_version") != "1.0":
        raise ValueError("freshness schema invalid")
    _bound_hash(artifact, "freshness", canonical_version)
    if _date(artifact.get("as_of"), "freshness as_of") != as_of:
        raise ValueError("freshness as_of mismatch")
    records = artifact.get("review_records")
    preview = artifact.get("review_queue")
    if not isinstance(records, list) or not isinstance(preview, list):
        raise ValueError("freshness queues must be arrays")
    for field in ("stale_after_days", "review_limit", "review_queue_total", "review_queue_omitted"):
        if type(artifact.get(field)) is not int or artifact[field] < (1 if field in {"stale_after_days", "review_limit"} else 0):
            raise ValueError(f"freshness {field} invalid")
    if not isinstance(artifact.get("review_queue_truncated"), bool) or not isinstance(artifact.get("summary"), dict):
        raise ValueError("freshness metadata types invalid")
    summary_keys = {"total_records", "current", "stale", "undated", "invalid_date", "future_date", "review_required", "critical_review_required"}
    if set(artifact["summary"]) != summary_keys or any(type(v) is not int or v < 0 for v in artifact["summary"].values()):
        raise ValueError("freshness summary invalid")
    for field in ("review_required_by_status", "all_records_by_status", "all_records_by_category"):
        value = artifact.get(field)
        if not isinstance(value, dict) or any(not isinstance(k, str) or type(v) is not int or v < 0 for k, v in value.items()):
            raise ValueError("freshness count mapping invalid")
    if not isinstance(artifact.get("policy"), dict) or set(artifact["policy"]) != {"critical_categories_first", "meaning", "mutation"}:
        raise ValueError("freshness policy invalid")
    row_keys = {"record_id", "country", "record_index", "name", "category", "geography", "verification_status", "last_verified", "age_days", "freshness"}
    seen: set[str] = set()
    for row in records:
        if not isinstance(row, dict) or set(row) != row_keys or row.get("record_id") not in ids or row.get("freshness") not in FRESHNESS_STATES:
            raise ValueError("freshness review record invalid or unknown")
        if row["record_id"] in seen:
            raise ValueError("freshness contains duplicate record IDs")
        seen.add(row["record_id"])
        if row.get("age_days") is not None and type(row.get("age_days")) is not int:
            raise ValueError("freshness age_days invalid")
        country, hotline = ids[row["record_id"]]
        canonical_values = {"country": country.get("country") or "", "name": hotline.get("name") or "",
                            "category": hotline.get("category") or "missing", "geography": hotline.get("geography") or "",
                            "verification_status": hotline.get("verification_status") or "missing",
                            "last_verified": hotline.get("last_verified"), "record_index": country.get("hotlines", []).index(hotline)}
        if any(row[k] != value for k, value in canonical_values.items()):
            raise ValueError("freshness row canonical values mismatch")
    if artifact["review_queue_total"] != len(records) or artifact["review_queue_omitted"] != len(records) - len(preview) or artifact["review_queue_truncated"] != (len(preview) < len(records)):
        raise ValueError("freshness queue metadata inconsistent")
    if preview != records[:len(preview)]:
        raise ValueError("freshness preview is not a prefix of review_records")
    def priority(row: dict) -> tuple:
        return ({"invalid_date": 0, "future_date": 1, "undated": 2, "stale": 3}[row["freshness"]],
                -(row["age_days"] or 0), row["country"].casefold(), row["category"], row["name"].casefold(), row["record_index"])
    critical = [r for r in records if r["category"] in {"emergency", "suicide_crisis"}]
    general = [r for r in records if r["category"] not in {"emergency", "suicide_crisis"}]
    if records != sorted(critical, key=priority) + sorted(general, key=priority):
        raise ValueError("freshness review_records ordering invalid")
    summary = artifact["summary"]
    if summary["review_required"] != len(records) or summary["critical_review_required"] != len(critical):
        raise ValueError("freshness summary review counts inconsistent")
    if summary["total_records"] != len(ids) or sum(summary[k] for k in ("current", "stale", "undated", "invalid_date", "future_date")) != len(ids):
        raise ValueError("freshness summary total inconsistent")
    status_counts: dict[str, int] = {}
    category_counts: dict[str, int] = {}
    for _, hotline in ids.values():
        status = hotline.get("verification_status") or "missing"
        category = hotline.get("category") or "missing"
        status_counts[status] = status_counts.get(status, 0) + 1
        category_counts[category] = category_counts.get(category, 0) + 1
    review_status: dict[str, int] = {}
    for row in records:
        review_status[row["verification_status"]] = review_status.get(row["verification_status"], 0) + 1
    if artifact["all_records_by_status"] != dict(sorted(status_counts.items())) or artifact["all_records_by_category"] != dict(sorted(category_counts.items())) or artifact["review_required_by_status"] != dict(sorted(review_status.items())):
        raise ValueError("freshness count mappings inconsistent")

    # Reconstruct the complete artifact from canonical data. This is deliberately
    # stronger than validating rows against themselves: omissions and fabricated
    # date states, ages, counts, previews, or ordering must all fail closed.
    canonical_data = {"countries": []}
    seen_countries: set[int] = set()
    for country, _ in ids.values():
        if id(country) not in seen_countries:
            canonical_data["countries"].append(country)
            seen_countries.add(id(country))
    expected = build_freshness_report(canonical_data, as_of, artifact["stale_after_days"], artifact["review_limit"], canonical_version)
    if artifact != expected:
        raise ValueError("freshness artifact does not match canonical recomputation")


def validate_monitor(artifact: dict, canonical_raw: bytes, canonical_version: str, ids: set[str], as_of: dt.date) -> None:
    required = {"schema_version", "canonical_hash", "as_of", "checked_at", "url_limit", "observations", "summary", "policy", "population", "metadata"}
    if not isinstance(artifact, dict) or set(artifact) != required or artifact.get("schema_version") != "3.0":
        raise ValueError("source monitor schema invalid")
    _bound_hash(artifact, "source monitor", canonical_version)
    if _date(artifact.get("as_of"), "source monitor as_of") != as_of or artifact.get("checked_at") != artifact.get("as_of"):
        raise ValueError("source monitor as_of mismatch")
    try:
        validate_current_snapshot(artifact, canonical_raw)
    except ValueError as exc:
        raise ValueError(f"source monitor invalid: {exc}") from exc
    if not isinstance(artifact.get("observations"), list) or not isinstance(artifact.get("url_limit"), int):
        raise ValueError("source monitor types invalid")
    seen = set()
    for row in artifact["observations"]:
        observation_required = {"record_id", "source_url", "outcome", "http_status", "final_url", "contact_present", "content_fingerprint", "changes", "truncated"}
        if not isinstance(row, dict) or not observation_required <= set(row) or row.get("record_id") not in ids or row.get("outcome") not in MONITOR_OUTCOMES:
            raise ValueError("source monitor observation invalid or unknown")
        link = safe_link(row.get("source_url"))
        if not link or link != row.get("source_url"):
            raise ValueError("source monitor source identity invalid")
        key = (row["record_id"], link)
        if key in seen:
            raise ValueError("source monitor duplicate observation identity")
        seen.add(key)
        fingerprint = row.get("content_fingerprint")
        if fingerprint is not None and not HASH_RE.fullmatch(fingerprint):
            raise ValueError("source monitor fingerprint invalid")
        if row.get("contact_present") not in {True, False, None} or not isinstance(row.get("changes"), list) or not all(isinstance(value, str) for value in row["changes"]):
            raise ValueError("source monitor observation types invalid")
        if not isinstance(row.get("truncated"), bool) or (row.get("http_status") is not None and (not isinstance(row["http_status"], int) or isinstance(row["http_status"], bool))):
            raise ValueError("source monitor response metadata invalid")


def validate_candidates(artifact: dict, canonical_version: str, ids: dict[str, tuple[dict, dict]]) -> tuple[list[dict], str]:
    required = {"$schema_version", "canonical_hash", "generated_at", "canonical_dataset", "preview_datasets", "summary", "candidates"}
    if not isinstance(artifact, dict) or set(artifact) != required or artifact.get("$schema_version") != "2.0" or not isinstance(artifact.get("candidates"), list):
        raise ValueError("candidate bundle schema invalid")
    _bound_hash(artifact, "candidate bundle", canonical_version)
    if not isinstance(artifact.get("generated_at"), str) or not artifact["generated_at"].endswith("Z"):
        raise ValueError("candidate bundle generated_at invalid")
    try:
        dt.datetime.fromisoformat(artifact["generated_at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("candidate bundle generated_at invalid") from exc
    if (not isinstance(artifact.get("canonical_dataset"), str) or not artifact["canonical_dataset"]
            or not isinstance(artifact.get("preview_datasets"), list) or not all(isinstance(value, str) for value in artifact["preview_datasets"])
            or not isinstance(artifact.get("summary"), dict) or set(artifact["summary"]) != {"candidate_count", "candidate_types"}):
        raise ValueError("candidate bundle types invalid")
    countries = {country.get("country"): country for country, _ in ids.values()}
    alpha2 = {country.get("alpha-2"): country for country in countries.values() if country.get("alpha-2")}
    candidate_keys = {"candidate_id", "country", "alpha-2", "candidate_type", "canonical_match", "proposed_hotline",
                      "source_artifact", "field_actions", "safety_flags", "requires_human_review"}
    seen = set()
    for candidate in artifact["candidates"]:
        cid = candidate.get("candidate_id") if isinstance(candidate, dict) else None
        if not isinstance(cid, str) or not cid.strip() or cid in seen:
            raise ValueError("candidate IDs must be unique nonempty strings")
        seen.add(cid)
        if candidate.get("candidate_type") not in SAFE_CANDIDATE_TYPES:
            raise ValueError("candidate type is not safe")
        expected_candidate_keys = candidate_keys | ({"proposed_country_updates"} if candidate.get("candidate_type") == "upgrade_emergency_metadata" else set())
        if set(candidate) != expected_candidate_keys:
            raise ValueError("candidate schema invalid")
        country = countries.get(candidate.get("country"))
        if (country is None or not isinstance(candidate.get("alpha-2"), str)
                or not re.fullmatch(r"[A-Z]{2}", candidate["alpha-2"])
                or country.get("alpha-2") != candidate["alpha-2"]
                or (candidate["alpha-2"] in alpha2 and alpha2[candidate["alpha-2"]] is not country)):
            raise ValueError("candidate canonical country target invalid")
        match = candidate.get("canonical_match")
        if not isinstance(match, dict) or set(match) != {"country", "hotline_name", "match_confidence"} or match.get("country") != candidate["country"] or type(match.get("match_confidence")) not in {int, float} or isinstance(match.get("match_confidence"), bool) or not 0 <= match["match_confidence"] <= 1:
            raise ValueError("candidate canonical match invalid")
        names = {h.get("name") for h in country.get("hotlines", [])}
        ctype = candidate["candidate_type"]
        expected_confidence = 1.0 if ctype in {"merge_missing_fields", "upgrade_emergency_metadata"} else 0.0
        if match["match_confidence"] != expected_confidence:
            raise ValueError("candidate canonical match confidence inconsistent")
        if ctype == "merge_missing_fields" and match.get("hotline_name") not in names:
            raise ValueError("candidate hotline target invalid")
        if ctype != "merge_missing_fields" and match.get("hotline_name") is not None:
            raise ValueError("candidate hotline target invalid")
        proposed = candidate.get("proposed_hotline")
        if (ctype == "upgrade_emergency_metadata") != (proposed is None) or (proposed is not None and not isinstance(proposed, dict)):
            raise ValueError("candidate proposed_hotline invalid")
        if ctype == "upgrade_emergency_metadata" and not isinstance(candidate.get("proposed_country_updates"), dict):
            raise ValueError("candidate country updates invalid")
        actions = candidate.get("field_actions")
        if not isinstance(actions, dict) or not actions or any(not isinstance(k, str) or v not in SAFE_FIELD_ACTIONS for k, v in actions.items()):
            raise ValueError("candidate field actions unsafe")
        valid_actions = ({field: "append_unique" for field in LIST_APPEND_FIELDS}
                         | {field: "fill_if_empty" for field in SCALAR_FILL_FIELDS}
                         | MERGE_FIELD_ACTIONS | {"hotlines": "append_unique"})
        if any(valid_actions.get(field) != action for field, action in actions.items()):
            raise ValueError("candidate field action target unsafe")
        if not isinstance(candidate.get("source_artifact"), str) or not candidate["source_artifact"] or not isinstance(candidate.get("safety_flags"), list) or not all(isinstance(v, str) for v in candidate["safety_flags"]) or candidate.get("requires_human_review") is not True:
            raise ValueError("candidate field types invalid")
        validate_promotion_candidate(candidate, {candidate["country"]} if country_has_protected_hotlines(country) else set())
        protected = {name for name, value in countries.items() if country_has_protected_hotlines(value)}
        if ctype == "merge_missing_fields":
            target = next(h for h in country.get("hotlines", []) if h.get("name") == match["hotline_name"])
            if normalize_text(proposed.get("name")) != normalize_text(target.get("name")):
                raise ValueError("candidate canonical match conflicts with proposed hotline")
            if actions.get("provenance") == "merge_provenance" and (
                    not isinstance(proposed.get("provenance"), dict) or not proposed["provenance"]
                    or provenance_issues(proposed)):
                raise ValueError("candidate proposed provenance invalid")
            expected_actions = compute_additive_hotline_field_actions(target, proposed)
            if actions != expected_actions or not expected_actions:
                raise ValueError("candidate merge actions are not exactly additive")
        elif ctype == "append_new_hotline":
            if actions != {"hotlines": "append_unique"}:
                raise ValueError("append candidate field_actions invalid")
            name = proposed.get("name")
            contact_fields = ("voice_numbers", "sms_numbers", "text_numbers", "short_codes", "chat_url", "email", "website")
            if not isinstance(name, str) or not name.strip() or not any(proposed.get(field) for field in contact_fields):
                raise ValueError("append candidate proposed hotline lacks required minimum")
            if normalize_text(name) in {normalize_text(h.get("name")) for h in country.get("hotlines", [])}:
                raise ValueError("append candidate duplicates canonical hotline name")
        else:
            expected_actions = additive_general_emergency_actions(country, candidate["proposed_country_updates"])
            if actions != expected_actions or not expected_actions:
                raise ValueError("candidate country updates are not exactly additive")
        try:
            changed = apply_candidate(copy.deepcopy({"countries": list(countries.values())}), copy.deepcopy(candidate), protected)
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"candidate fails promotion dry-run: {exc}") from exc
        if not changed:
            raise ValueError("candidate promotion dry-run is a no-op")
    types = {kind: sum(c["candidate_type"] == kind for c in artifact["candidates"]) for kind in sorted({c["candidate_type"] for c in artifact["candidates"]})}
    if artifact["summary"].get("candidate_count") != len(artifact["candidates"]) or artifact["summary"].get("candidate_types") != types:
        raise ValueError("candidate summary inconsistent")
    return artifact["candidates"], bundle_hash(artifact)


def validate_approvals(artifact: dict, canonical_version: str, expected_bundle_hash: str, candidate_ids: set[str], as_of: dt.date) -> dict[str, str]:
    required = {"schema_version", "canonical_hash", "candidate_bundle_hash", "review_date", "decisions"}
    allowed = required | {"reviewer", "notes"}
    if not isinstance(artifact, dict) or set(artifact) - allowed or not required <= set(artifact) or artifact.get("schema_version") != "1.0":
        raise ValueError("approval artifact schema invalid")
    _bound_hash(artifact, "approval artifact", canonical_version)
    if artifact.get("candidate_bundle_hash") != expected_bundle_hash or not HASH_RE.fullmatch(str(artifact.get("candidate_bundle_hash", ""))):
        raise ValueError("approval candidate_bundle_hash mismatch")
    if _date(artifact.get("review_date"), "approval review_date") > as_of:
        raise ValueError("approval review_date is after workbench as_of")
    for optional in ("reviewer", "notes"):
        if optional in artifact and (not isinstance(artifact[optional], str) or len(artifact[optional]) > 500):
            raise ValueError("approval optional field invalid")
    if not isinstance(artifact.get("decisions"), list):
        raise ValueError("approval decisions must be an array")
    states = {}
    for decision in artifact["decisions"]:
        cid = decision.get("candidate_id") if isinstance(decision, dict) else None
        state = decision.get("state") if isinstance(decision, dict) else None
        if not isinstance(decision, dict) or set(decision) - {"candidate_id", "state", "reviewer", "notes"} or not {"candidate_id", "state"} <= set(decision):
            raise ValueError("approval decision schema invalid")
        for optional in ("reviewer", "notes"):
            if optional in decision and (not isinstance(decision[optional], str) or len(decision[optional]) > 500):
                raise ValueError("approval decision optional field invalid")
        if cid in states:
            raise ValueError("approval decisions contain duplicate candidate IDs")
        if cid not in candidate_ids:
            raise ValueError("approvals contain unknown candidate IDs")
        if state not in ALLOWED_APPROVAL_STATES:
            raise ValueError("approval state invalid")
        states[cid] = state
    return states


def build(data: dict, raw: bytes, as_of: dt.date, freshness: dict, monitor: dict | None = None,
          candidates: dict | None = None, approvals: dict | None = None) -> dict:
    ids = index_records(data)
    canonical_version = version(raw)
    validate_freshness(freshness, canonical_version, ids, as_of)
    if monitor is not None:
        validate_monitor(monitor, raw, canonical_version, set(ids), as_of)
    candidate_rows = []
    candidate_digest = None
    decisions: dict[str, str] = {}
    candidate_values: list[dict] = []
    if candidates is not None:
        candidate_values, candidate_digest = validate_candidates(candidates, canonical_version, ids)
        if approvals is not None:
            decisions = validate_approvals(approvals, canonical_version, candidate_digest, {row["candidate_id"] for row in candidate_values}, as_of)
    elif approvals is not None:
        raise ValueError("approvals require a candidate bundle")

    queue: dict[str, dict] = {}
    def entry(rid: str) -> dict:
        country, hotline = ids[rid]
        return queue.setdefault(rid, {"record_id": rid, "country": country.get("country", ""),
            "name": hotline.get("name") or hotline.get("organization", ""), "category": hotline.get("category", ""),
            "signals": [], "evidence_links": [], "next_action": "no_action", "priority": 90})

    for row in freshness["review_records"]:
        item = entry(row["record_id"])
        item["signals"].append({"kind": "freshness", "state": row["freshness"], "age_days": row.get("age_days")})
        critical = item["category"] in {"emergency", "suicide_crisis"}
        item["priority"] = min(item["priority"], 10 if critical else 40)
        item["next_action"] = "live_first_party_review"
    for observation in (monitor or {}).get("observations", []):
        item = entry(observation["record_id"])
        link = safe_link(observation["source_url"])
        if link and link not in item["evidence_links"]:
            item["evidence_links"].append(link)
        changes = observation.get("changes", [])
        failure = observation["outcome"] != "ok"
        missing = observation.get("contact_present") is False and observation.get("content_fingerprint") is not None
        if failure or missing or changes:
            item["signals"].append({"kind": "source_observation", "outcome": observation["outcome"],
                                    "contact_present": observation.get("contact_present"), "changes": changes})
            item["priority"] = min(item["priority"], 0 if missing and item["category"] in {"emergency", "suicide_crisis"} else 5 if failure else 20)
            item["next_action"] = "live_first_party_review"
    for candidate in candidate_values:
        candidate_type = candidate["candidate_type"]
        action = "duplicate_scope_review" if candidate_type == "merge_missing_fields" else "candidate_approval_review"
        proposed = candidate.get("proposed_hotline") or {}
        candidate_rows.append({"candidate_id": candidate["candidate_id"], "country": candidate.get("country", ""),
            "name": proposed.get("name", ""), "candidate_type": candidate_type,
            "approval_state": decisions.get(candidate["candidate_id"], "unreviewed"),
            "signals": [{"kind": "promotion_candidate"}], "next_action": action, "priority": 30})
    rows = sorted(queue.values(), key=lambda item: (item["priority"], item["record_id"]))
    candidate_rows.sort(key=lambda item: (item["priority"], item["candidate_id"]))
    freshness_meta = {"total": freshness["review_queue_total"], "preview": len(freshness["review_queue"]),
                      "truncated": freshness["review_queue_truncated"], "omitted": freshness["review_queue_omitted"]}
    monitor_summary = (monitor or {}).get("summary", {"selected": 0, "ok": 0, "failure": 0, "blocked": 0, "new": 0, "changed": 0, "skipped_ineligible": 0, "degraded": False})
    return {"schema_version": "2.0", "as_of": as_of.isoformat(), "canonical_hash": canonical_version,
            "candidate_bundle_hash": candidate_digest, "record_queue": rows, "candidate_queue": candidate_rows,
            "freshness_queue": freshness_meta, "source_outcomes": monitor_summary,
            "markdown_preview_limit": MARKDOWN_PREVIEW_LIMIT,
            "policy": {"signals": "Signals remain separate; there is no composite quality or safety score.",
                       "meaning": "The workbench does not infer validity, test-call status, eligibility, availability, or structured scope.",
                       "mutation": "Reviewer artifacts only; inputs and canonical data are never modified."}}


def _escape(value: object) -> str:
    value = str(value if value not in (None, "") else "—")
    value = "".join(" " if ord(char) < 32 or ord(char) == 127 else char for char in value)
    escaped = html.escape(value, quote=True)
    return escaped.translate(str.maketrans({"|": "&#124;", "[": "&#91;", "]": "&#93;", "(": "&#40;", ")": "&#41;", "!": "&#33;", "`": "&#96;", "\\": "&#92;"}))


def _link(url: str) -> str:
    validated = safe_link(url)
    if validated is None:
        return "—"
    destination = urllib.parse.quote(validated, safe="https:/%:@!$&'()*+,;=-._~")
    return f"<a href=\"{html.escape(destination, quote=True)}\">source</a>"


def markdown(report: dict) -> str:
    fm = report["freshness_queue"]
    sm = report["source_outcomes"]
    rows = report["record_queue"][:report["markdown_preview_limit"]]
    candidates = report["candidate_queue"][:report["markdown_preview_limit"]]
    lines = ["# Verification operations workbench", "", f"- As of: `{_escape(report['as_of'])}`",
             f"- Canonical hash: `{_escape(report['canonical_hash'])}`",
             f"- Freshness records: {fm['total']} total; {fm['preview']} source preview; {fm['omitted']} omitted there; full queue propagated",
             f"- Source outcomes: ok {sm.get('ok', 0)}; failure {sm.get('failure', 0)}; blocked {sm.get('blocked', 0)}; new {sm.get('new', 0)}; changed {sm.get('changed', 0)}",
             f"- Source monitoring degraded: **{'YES' if sm.get('degraded') else 'no'}**", "",
             "> Review prompts only. A source observation does not mean a service was test-called or is available in real time.", "",
             "## Canonical record queue", "", "| Priority | Record ID | Country | Service | Next action | Evidence |",
             "| ---: | --- | --- | --- | --- | --- |"]
    for item in rows:
        links = " ".join(_link(url) for url in item["evidence_links"]) or "—"
        lines.append(f"| {item['priority']} | {_escape(item['record_id'])} | {_escape(item['country'])} | {_escape(item['name'])} | {_escape(item['next_action'])} | {links} |")
    if len(report["record_queue"]) > len(rows):
        lines += ["", f"Record queue preview omitted {len(report['record_queue']) - len(rows)} rows; JSON contains the full queue."]
    lines += ["", "## Promotion candidate queue", "", "| Priority | Candidate ID | Country | Service | Approval | Next action |",
              "| ---: | --- | --- | --- | --- | --- |"]
    for item in candidates:
        lines.append(f"| {item['priority']} | {_escape(item['candidate_id'])} | {_escape(item['country'])} | {_escape(item['name'])} | {_escape(item['approval_state'])} | {_escape(item['next_action'])} |")
    if len(report["candidate_queue"]) > len(candidates):
        lines += ["", f"Candidate queue preview omitted {len(report['candidate_queue']) - len(candidates)} rows; JSON contains the full queue."]
    return "\n".join(lines) + "\n"


def load(path: Path | None) -> dict | None:
    return json.loads(path.read_text()) if path else None


def guard_outputs(json_path: Path, markdown_path: Path, inputs: list[Path | None]) -> None:
    resolved_inputs = {path.resolve() for path in inputs if path}
    if json_path.resolve() == markdown_path.resolve():
        raise SystemExit("outputs must not alias each other")
    for path, suffix in ((json_path, ".json"), (markdown_path, ".md")):
        if path.suffix.lower() != suffix or path.resolve() in resolved_inputs or path.exists():
            raise SystemExit(f"unsafe or existing output: {path}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=CANONICAL)
    parser.add_argument("--as-of", required=True)
    parser.add_argument("--freshness", type=Path, required=True)
    parser.add_argument("--source-monitor", type=Path)
    parser.add_argument("--candidates", type=Path)
    parser.add_argument("--approvals", type=Path)
    parser.add_argument("--json-output", type=Path, required=True)
    parser.add_argument("--markdown-output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        as_of = dt.date.fromisoformat(args.as_of)
    except ValueError:
        parser.error("--as-of must be YYYY-MM-DD")
    inputs = [args.input, CANONICAL, args.freshness, args.source_monitor, args.candidates, args.approvals]
    guard_outputs(args.json_output, args.markdown_output, inputs)
    raw = args.input.read_bytes()
    report = build(json.loads(raw), raw, as_of, load(args.freshness), load(args.source_monitor), load(args.candidates), load(args.approvals))
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    args.markdown_output.write_text(markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
