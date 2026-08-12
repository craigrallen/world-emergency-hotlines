from __future__ import annotations

import hashlib
import json
import re
import uuid

RECORD_ID_RE = re.compile(r"^weh_[0-9a-f]{24}$")
RECORD_ID_NAMESPACE = uuid.UUID("72c258bc-4f22-4d2f-990c-29e3cfaec96c")


def record_id_from_seed(seed: str) -> str:
    """Create an opaque ID for first assignment; persisted IDs are never recomputed."""
    return f"weh_{uuid.uuid5(RECORD_ID_NAMESPACE, seed).hex[:24]}"


def backfill_seed(country: dict, hotline: dict, ordinal: int) -> str:
    """Deterministic migration seed. It is not a durable identity contract."""
    payload = {
        "alpha2": country.get("alpha-2"),
        "ordinal": ordinal,
        "record": hotline,
    }
    return "backfill-v1:" + json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def promotion_seed(candidate: dict) -> str:
    candidate_id = candidate.get("candidate_id")
    if not isinstance(candidate_id, str) or not candidate_id.strip():
        raise ValueError("append_new_hotline candidate requires a non-empty candidate_id for ID assignment")
    return f"promotion-v1:{candidate_id.strip()}"


def canonical_sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()
