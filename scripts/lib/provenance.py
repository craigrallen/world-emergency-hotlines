from __future__ import annotations

import copy
import json
from datetime import date, datetime, timezone

VALID_RECORD_STATUSES = frozenset(
    {
        "legacy_unverified",
        "verified_web",
        "verified_authority",
        "verified_knowledge",
        "cross_referenced",
        "disputed",
        "deprecated",
    }
)
VALID_SOURCE_CLASSES = frozenset(
    {
        "first_party",
        "government",
        "authority",
        "ngo_directory",
        "aggregator_directory",
        "community_index",
        "knowledge_authored",
    }
)
VALID_VERIFICATION_METHODS = frozenset(
    {
        "manual_web_review",
        "scripted_import",
        "knowledge_authored",
        "manual_dataset_review",
    }
)
VALID_REVIEW_STATES = frozenset({"staged", "reviewed", "promoted", "rejected"})
VALID_EVIDENCE_SOURCE_TYPES = frozenset(
    {
        "first_party",
        "government",
        "authority",
        "ngo_directory",
        "aggregator_directory",
        "community_index",
        "manual_note",
    }
)
VALID_CONFIDENCE = frozenset({"low", "medium", "high"})

FIELD_ORDER = [
    "record_status",
    "source_class",
    "verification_method",
    "retrieved_at",
    "review_state",
    "source_dataset",
    "source_status",
    "evidence",
]
EVIDENCE_FIELD_ORDER = [
    "field",
    "value",
    "source_url",
    "source_type",
    "checked_at",
    "confidence",
    "note",
]


def _is_empty(value: object) -> bool:
    return value in (None, "", [], {})


def _unique_list(items: list[object]) -> list[object]:
    seen = set()
    out = []
    for item in items:
        marker = json.dumps(item, ensure_ascii=False, sort_keys=True) if isinstance(item, (dict, list)) else item
        if marker in seen:
            continue
        seen.add(marker)
        out.append(item)
    return out


def normalize_iso_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value).strip()).isoformat()
    except ValueError:
        return None


def normalize_iso_timestamp(value: str | None) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _normalize_enum(value: str | None, allowed: frozenset[str]) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    if text in allowed:
        return text
    lowered = text.lower().replace("-", "_").replace(" ", "_")
    return lowered if lowered in allowed else None


def record_status_from_verification_status(status: str | None) -> str | None:
    if not status:
        return None
    if status in VALID_RECORD_STATUSES:
        return status
    if status in {"verified_web", "verified_authority", "verified_knowledge", "disputed", "deprecated", "cross_referenced"}:
        return status
    return "legacy_unverified"


def infer_source_class(record: dict) -> str | None:
    status = record.get("verification_status")
    metadata = record.get("_import_metadata") or {}
    dataset = metadata.get("source_dataset")
    if dataset == "web_verified_crisis_directory":
        return "aggregator_directory"
    if status == "verified_web":
        return "first_party"
    if status == "verified_authority":
        return "authority"
    if status == "verified_knowledge":
        return "knowledge_authored"
    if status in {"cross_referenced", "legacy_unverified"}:
        return "aggregator_directory"
    return None


def infer_verification_method(record: dict) -> str | None:
    metadata = record.get("_import_metadata") or {}
    if metadata.get("source_dataset"):
        return "scripted_import"
    if record.get("verification_status") in {"verified_web", "verified_authority"}:
        return "manual_web_review"
    if record.get("verification_status") == "verified_knowledge":
        return "knowledge_authored"
    return None


def infer_review_state(record: dict) -> str | None:
    metadata = record.get("_preview_metadata") or {}
    import_metadata = record.get("_import_metadata") or {}
    if metadata.get("dataset_role") == "supplemental_preview" or import_metadata.get("source_dataset"):
        return "staged"
    return None


def normalize_evidence_item(item: dict) -> dict | None:
    if not isinstance(item, dict):
        return None
    normalized = {}
    if item.get("field"):
        normalized["field"] = str(item["field"]).strip()
    if not _is_empty(item.get("value")):
        normalized["value"] = copy.deepcopy(item.get("value"))
    if item.get("source_url"):
        normalized["source_url"] = str(item["source_url"]).strip()
    source_type = _normalize_enum(item.get("source_type"), VALID_EVIDENCE_SOURCE_TYPES)
    if source_type:
        normalized["source_type"] = source_type
    checked_at = normalize_iso_date(item.get("checked_at"))
    if checked_at:
        normalized["checked_at"] = checked_at
    confidence = _normalize_enum(item.get("confidence"), VALID_CONFIDENCE)
    if confidence:
        normalized["confidence"] = confidence
    if item.get("note"):
        normalized["note"] = str(item["note"]).strip()
    return {key: normalized[key] for key in EVIDENCE_FIELD_ORDER if key in normalized} or None


def infer_evidence(record: dict) -> list[dict]:
    source_class = infer_source_class(record)
    confidence = "medium" if source_class == "aggregator_directory" else "high"
    checked_at = normalize_iso_date(record.get("last_verified"))
    sources = record.get("sources") or []
    source_url = sources[0] if len(sources) == 1 else None
    evidence = []
    for field in (
        "voice_numbers",
        "sms_numbers",
        "text_numbers",
        "short_codes",
        "chat_url",
        "email",
        "website",
        "hours",
        "languages",
        "cost",
        "target",
        "geography",
    ):
        value = record.get(field)
        if _is_empty(value):
            continue
        item = {
            "field": field,
            "value": copy.deepcopy(value),
            "source_type": source_class,
            "confidence": confidence,
        }
        if source_url:
            item["source_url"] = source_url
        if checked_at:
            item["checked_at"] = checked_at
        normalized = normalize_evidence_item(item)
        if normalized:
            evidence.append(normalized)
    return _unique_list(evidence)


def normalize_provenance(record: dict, provenance: dict | None = None) -> dict | None:
    existing = provenance if provenance is not None else record.get("provenance")
    existing = copy.deepcopy(existing) if isinstance(existing, dict) else {}
    if not existing and not (record.get("verification_status") or record.get("_import_metadata")):
        return None

    normalized = {}
    record_status = _normalize_enum(existing.get("record_status"), VALID_RECORD_STATUSES) or record_status_from_verification_status(record.get("verification_status"))
    if record_status:
        normalized["record_status"] = record_status

    source_class = _normalize_enum(existing.get("source_class"), VALID_SOURCE_CLASSES) or infer_source_class(record)
    if source_class:
        normalized["source_class"] = source_class

    verification_method = _normalize_enum(existing.get("verification_method"), VALID_VERIFICATION_METHODS) or infer_verification_method(record)
    if verification_method:
        normalized["verification_method"] = verification_method

    import_metadata = record.get("_import_metadata") or {}
    retrieved_at = normalize_iso_timestamp(existing.get("retrieved_at")) or normalize_iso_timestamp(import_metadata.get("retrieved_at"))
    if retrieved_at:
        normalized["retrieved_at"] = retrieved_at

    review_state = _normalize_enum(existing.get("review_state"), VALID_REVIEW_STATES) or infer_review_state(record)
    if review_state:
        normalized["review_state"] = review_state

    source_dataset = existing.get("source_dataset") or import_metadata.get("source_dataset")
    if source_dataset:
        normalized["source_dataset"] = str(source_dataset)

    source_status = existing.get("source_status") or import_metadata.get("source_verification_status")
    if source_status:
        normalized["source_status"] = str(source_status)

    evidence = []
    for item in existing.get("evidence") or []:
        normalized_item = normalize_evidence_item(item)
        if normalized_item:
            evidence.append(normalized_item)
    if not evidence:
        evidence = infer_evidence(record)
    evidence = _unique_list(evidence)
    if evidence:
        normalized["evidence"] = evidence

    return {key: normalized[key] for key in FIELD_ORDER if key in normalized} or None


def merge_provenance(existing: dict | None, proposed: dict | None) -> dict | None:
    if not existing:
        return copy.deepcopy(proposed) if proposed else None
    if not proposed:
        return copy.deepcopy(existing)
    merged = copy.deepcopy(existing)
    for field in FIELD_ORDER:
        if field == "evidence":
            merged_evidence = _unique_list(list(merged.get("evidence") or []) + list(proposed.get("evidence") or []))
            if merged_evidence:
                merged["evidence"] = merged_evidence
            continue
        if _is_empty(merged.get(field)) and not _is_empty(proposed.get(field)):
            merged[field] = copy.deepcopy(proposed[field])
    return {key: merged[key] for key in FIELD_ORDER if key in merged and not _is_empty(merged[key])} or None


def provenance_issues(record: dict) -> list[str]:
    issues = []
    provenance = record.get("provenance")
    if provenance is None:
        return issues
    if not isinstance(provenance, dict):
        return ["provenance must be an object when present"]
    if provenance.get("record_status") and _normalize_enum(provenance.get("record_status"), VALID_RECORD_STATUSES) is None:
        issues.append(f"invalid provenance.record_status: {provenance.get('record_status')!r}")
    if provenance.get("source_class") and _normalize_enum(provenance.get("source_class"), VALID_SOURCE_CLASSES) is None:
        issues.append(f"invalid provenance.source_class: {provenance.get('source_class')!r}")
    if provenance.get("verification_method") and _normalize_enum(provenance.get("verification_method"), VALID_VERIFICATION_METHODS) is None:
        issues.append(f"invalid provenance.verification_method: {provenance.get('verification_method')!r}")
    if provenance.get("review_state") and _normalize_enum(provenance.get("review_state"), VALID_REVIEW_STATES) is None:
        issues.append(f"invalid provenance.review_state: {provenance.get('review_state')!r}")
    if provenance.get("retrieved_at") and normalize_iso_timestamp(provenance.get("retrieved_at")) is None:
        issues.append("invalid provenance.retrieved_at timestamp")
    inferred_status = record_status_from_verification_status(record.get("verification_status"))
    if provenance.get("record_status") and inferred_status and provenance.get("record_status") != inferred_status:
        issues.append(
            f"provenance.record_status {provenance.get('record_status')!r} does not match verification_status {record.get('verification_status')!r}"
        )
    for index, item in enumerate(provenance.get("evidence") or []):
        if not isinstance(item, dict) or normalize_evidence_item(item) is None:
            issues.append(f"invalid provenance.evidence[{index}]")
            continue
        if item.get("checked_at") and normalize_iso_date(item.get("checked_at")) is None:
            issues.append(f"invalid provenance.evidence[{index}].checked_at")
        if item.get("source_type") and _normalize_enum(item.get("source_type"), VALID_EVIDENCE_SOURCE_TYPES) is None:
            issues.append(f"invalid provenance.evidence[{index}].source_type: {item.get('source_type')!r}")
    return issues
