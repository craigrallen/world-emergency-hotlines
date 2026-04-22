from __future__ import annotations

import copy
import json
import re
import unicodedata
from typing import Iterable

SAFE_CANDIDATE_TYPES = frozenset(
    {
        "append_new_hotline",
        "merge_missing_fields",
        "upgrade_emergency_metadata",
    }
)
SAFE_FIELD_ACTIONS = frozenset({"append_unique", "fill_if_empty", "merge_provenance"})
LIST_APPEND_FIELDS = frozenset(
    {
        "voice_numbers",
        "sms_numbers",
        "text_numbers",
        "short_codes",
        "languages",
        "sources",
        "general_emergency",
    }
)
SCALAR_FILL_FIELDS = frozenset(
    {
        "organization",
        "chat_url",
        "email",
        "website",
        "hours",
        "cost",
        "target",
        "geography",
        "notes",
    }
)
MERGE_FIELD_ACTIONS = {
    "provenance": "merge_provenance",
}

HOTLINE_DEFAULTS = {
    "organization": None,
    "category": "general_support",
    "voice_numbers": [],
    "sms_numbers": [],
    "text_numbers": [],
    "short_codes": [],
    "chat_url": None,
    "email": None,
    "website": None,
    "hours": None,
    "languages": [],
    "cost": "unknown",
    "target": None,
    "geography": None,
    "notes": "",
    "verification_status": "legacy_unverified",
    "last_verified": None,
    "sources": [],
    "provenance": None,
}


def normalize_text(value: str | None) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def is_empty(value: object) -> bool:
    return value in (None, "", [])


def unique_list(values: Iterable) -> list:
    seen = set()
    output = []
    for value in values:
        marker = json.dumps(value, ensure_ascii=False, sort_keys=True) if isinstance(value, (dict, list)) else value
        if marker in seen:
            continue
        seen.add(marker)
        output.append(value)
    return output


def prepare_hotline(hotline: dict, country_name: str) -> dict:
    prepared = copy.deepcopy(HOTLINE_DEFAULTS)
    prepared.update(copy.deepcopy(hotline))
    prepared["name"] = hotline["name"]
    if not prepared.get("organization"):
        prepared["organization"] = hotline["name"]
    if not prepared.get("geography"):
        prepared["geography"] = country_name
    for field in LIST_APPEND_FIELDS.intersection(prepared.keys()):
        prepared[field] = unique_list(prepared.get(field) or [])
    return prepared


def hotlines_by_normalized_name(country: dict) -> dict[str, dict]:
    return {
        normalize_text(hotline.get("name")): hotline
        for hotline in country.get("hotlines", [])
        if hotline.get("name")
    }


def compute_additive_hotline_field_actions(existing: dict, proposed: dict) -> dict[str, str]:
    field_actions: dict[str, str] = {}

    for field in sorted(LIST_APPEND_FIELDS - {"general_emergency"}):
        existing_values = unique_list(existing.get(field) or [])
        proposed_values = unique_list(proposed.get(field) or [])
        additions = [value for value in proposed_values if value not in existing_values]
        if additions:
            field_actions[field] = "append_unique"

    for field in sorted(SCALAR_FILL_FIELDS):
        if is_empty(existing.get(field)) and not is_empty(proposed.get(field)):
            field_actions[field] = "fill_if_empty"

    for field, action in MERGE_FIELD_ACTIONS.items():
        if proposed.get(field):
            field_actions[field] = action

    return field_actions


def additive_general_emergency_actions(existing_country: dict, preview_country: dict) -> dict[str, str]:
    existing_values = unique_list(existing_country.get("general_emergency") or [])
    proposed_values = unique_list(preview_country.get("general_emergency") or [])
    additions = [value for value in proposed_values if value not in existing_values]
    actions: dict[str, str] = {}
    if additions:
        actions["general_emergency"] = "append_unique"
    if is_empty(existing_country.get("notes")) and not is_empty(preview_country.get("notes")):
        actions["notes"] = "fill_if_empty"
    return actions
