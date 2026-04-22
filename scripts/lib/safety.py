from __future__ import annotations

from typing import Iterable, Sequence

PROTECTED_CANONICAL_STATUSES = frozenset(
    {
        "verified_web",
        "verified_authority",
        "verified_knowledge",
        "disputed",
        "deprecated",
    }
)

STATUS_RANK = {
    "legacy_unverified": 0,
    "verified_web": 1,
    "verified_authority": 2,
    "verified_knowledge": 3,
    "disputed": 4,
    "deprecated": 5,
}

SUPPLEMENTAL_PREVIEW_ROLE = "supplemental_preview"
CANONICAL_DATASET_ROLE = "canonical"
ALLOWED_PROTECTED_PROMOTION_ACTIONS = frozenset({"merge_missing_fields", "append_new_hotline"})


def hotline_has_protected_status(hotline: dict) -> bool:
    return hotline.get("verification_status") in PROTECTED_CANONICAL_STATUSES


def country_has_protected_hotlines(country: dict) -> bool:
    return any(hotline_has_protected_status(hotline) for hotline in country.get("hotlines", []))


def country_has_only_legacy_hotlines(country: dict) -> bool:
    hotlines = country.get("hotlines", [])
    return bool(hotlines) and all(not hotline_has_protected_status(hotline) for hotline in hotlines)


def protected_statuses_for_country(country: dict) -> list[str]:
    return sorted(
        {
            hotline.get("verification_status")
            for hotline in country.get("hotlines", [])
            if hotline_has_protected_status(hotline)
        }
    )


def preview_dataset_claims_canonical(dataset: dict) -> bool:
    metadata = dataset.get("_preview_metadata") or {}
    role = metadata.get("dataset_role")
    methodology = (dataset.get("methodology") or "").lower()
    return role == CANONICAL_DATASET_ROLE or "canonical dataset" in methodology and "not the canonical dataset" not in methodology


def canonical_write_requested(argv: Sequence[str]) -> bool:
    return "--apply" in argv


def validate_promotion_candidate(candidate: dict, protected_countries: Iterable[str]) -> None:
    country = candidate.get("country")
    candidate_type = candidate.get("candidate_type")
    protected_country_names = set(protected_countries)
    if country in protected_country_names and candidate_type not in ALLOWED_PROTECTED_PROMOTION_ACTIONS:
        allowed = ", ".join(sorted(ALLOWED_PROTECTED_PROMOTION_ACTIONS))
        raise ValueError(
            f"Protected canonical country {country!r} cannot use candidate_type {candidate_type!r}; "
            f"allowed actions: {allowed}"
        )


def status_rank(status: str | None) -> int:
    return STATUS_RANK.get(status or "legacy_unverified", -1)


def would_downgrade_status(existing_status: str | None, proposed_status: str | None) -> bool:
    if proposed_status is None:
        return False
    return status_rank(proposed_status) < status_rank(existing_status)
