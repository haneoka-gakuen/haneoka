"""Build the release-scoped Anon Tokyo catalog projection.

The feature is only present in some game servers.  This module deliberately
keeps its availability independent of the surrounding game's feature flags:
the presence of ``MasterATCharacter`` is the primary client-data signal.  It
also keeps the original MasterText locale slots intact rather than fabricating
a Japanese fallback for GL-only content.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

from build.spine_catalog import (
    build_spine_catalog,
    read_spine_metadata,
    sanitize_spine_value,
    spine_model_reference,
    spine_records,
)
from core.contracts import ANON_TOKYO_SCHEMA


JsonObject = dict[str, Any]

AT_SOURCE_ROOT = "Assets/AddressableResources/AnonTokyo/"
AT_LOCALE_SLOTS = (
    ("ja", 0, "_japanese"),
    ("en", 1, "_english"),
    ("zh-Hant", 2, "_traditionalChinese"),
    ("zh-Hans", 3, "_simplifiedChinese"),
    ("ko", 4, "_korean"),
)
AT_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
AT_IMAGE_LOCALE_SUFFIX = re.compile(
    r"^(?P<name>.+)\((?P<locale>ja|en|zh-Hant|zh-Hans|ko)\)$"
)
AT_SAFE_ID = re.compile(r"[^A-Za-z0-9.:-]+")


def _value_id(value: Any) -> str:
    """Return an AT namespaced, URL-safe identity without hiding the raw id."""

    raw = str(value)
    safe = AT_SAFE_ID.sub("-", raw).strip("-")
    if safe:
        return safe
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"value-{digest}"


def _at_id(kind: str, value: Any) -> str:
    return f"at-{kind}-{_value_id(value)}"


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _as_int_list(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    return [_as_int(item) for item in value]


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if value in (None, ""):
        return []
    return [str(value)]


def _raw_time_window(row: JsonObject, start_key: str, end_key: str) -> JsonObject:
    """Keep client-authored time values without inferring an epoch or timezone."""

    return {
        "start": row.get(start_key),
        "end": row.get(end_key),
    }


def _encoded_entries(value: Any) -> list[JsonObject]:
    """Split the common AT semicolon/comma value encoding without naming fields.

    The game uses this encoding for different semantic domains (rewards,
    passive ability values, FEVER rewards).  Giving positions made-up names
    would be less reliable than preserving both the raw value and its tokens.
    """

    text = str(value or "").strip()
    if not text:
        return []
    return [
        {"raw": entry, "values": [part.strip() for part in entry.split(",")]}
        for entry in text.split(";")
        if entry.strip()
    ]


def _encoded_value(value: Any) -> JsonObject:
    return {"raw": str(value or ""), "entries": _encoded_entries(value)}


def _localized_text(data: Any, value: Any) -> JsonObject | None:
    """Expose MasterText slots exactly; never copy one locale into another."""

    if value is None:
        return None
    text_id = str(value).strip()
    if not text_id or text_id == "-":
        return None
    values = list(data.text(text_id))
    variants = {
        locale: str(values[index])
        for locale, index, _field in AT_LOCALE_SLOTS
        if index < len(values) and str(values[index])
    }
    # MasterText stores parallel slots, not an authored-base-locale marker.
    # Only call a locale the base when the source actually has one usable slot.
    base_locale = next(iter(variants)) if len(variants) == 1 else None
    return {
        "textId": text_id,
        "values": values,
        "baseLocale": base_locale,
        "variants": variants,
        "status": "resolved" if variants else "missing",
    }


def _has_localized_value(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("status") == "resolved"
        and isinstance(value.get("variants"), dict)
        and bool(value["variants"])
    )


def _stable_identity_label(
    kind: str,
    raw_id: Any,
    bang_identity_number: Any = None,
) -> str:
    """Return a non-localized identifier label from real customer identity."""

    label = f"{kind}:{_value_id(raw_id)}"
    bang = _as_int(bang_identity_number)
    return f"{label}:bang-{bang}" if bang else label


def _stable_identity_name(
    kind: str,
    raw_id: Any,
    *,
    source_table: str,
    bang_identity_number: Any = None,
) -> JsonObject:
    """Make a UI-safe name only when the client authored no text at all.

    This is deliberately an invariant identity token, not a translated role
    name.  It gives the catalog a usable, non-repeating label while making its
    provenance and derived status explicit to future consumers.
    """

    label = _stable_identity_label(kind, raw_id, bang_identity_number)
    return {
        "values": [label for _locale, _index, _field in AT_LOCALE_SLOTS],
        "baseLocale": None,
        "variants": {locale: label for locale, _index, _field in AT_LOCALE_SLOTS},
        "status": "derived",
        "resolution": "stable-identity",
        "identity": {
            "kind": kind,
            "rawId": raw_id,
            "sourceTable": source_table,
            **(
                {"bangIdentityNumber": _as_int(bang_identity_number)}
                if _as_int(bang_identity_number)
                else {}
            ),
        },
    }


def _source_key(value: str) -> str:
    """Keep non-public Unity provenance out of URL/path validation semantics."""

    return value.removeprefix("Assets/AddressableResources/")


def _variant_name(value: str) -> tuple[str, str | None]:
    match = AT_IMAGE_LOCALE_SUFFIX.fullmatch(value)
    if match is None:
        return value, None
    return str(match.group("name")), str(match.group("locale"))


def _candidate(
    *,
    url: str,
    source_path: str,
    output_path: str | None,
    source_is_public: bool,
    kind: str,
) -> JsonObject:
    value: JsonObject = {"url": url, "kind": kind}
    if source_is_public:
        value["sourcePath"] = source_path
    else:
        value["sourceKey"] = _source_key(source_path)
    if output_path:
        value["outputPath"] = output_path
    return value


def _image_index(data: Any) -> JsonObject:
    """Index only verified Anon Tokyo images and Sprite derivatives once."""

    cached = getattr(data, "_anon_tokyo_image_index", None)
    if cached is not None:
        return cached
    by_path: dict[str, dict[str | None, list[JsonObject]]] = {}
    by_name: dict[str, dict[str | None, list[JsonObject]]] = {}

    def add(
        path_key: str,
        name_key: str,
        locale: str | None,
        value: JsonObject,
    ) -> None:
        by_path.setdefault(path_key, {}).setdefault(locale, []).append(value)
        by_name.setdefault(name_key, {}).setdefault(locale, []).append(value)

    for source_path, source in data.source_index.items():
        if not source_path.startswith(AT_SOURCE_ROOT) or not isinstance(source, dict):
            continue
        path = PurePosixPath(source_path)
        if path.suffix.casefold() in AT_IMAGE_SUFFIXES:
            url = data.asset(source_path)
            if url:
                stem, locale = _variant_name(path.stem)
                path_key = (path.parent / stem).as_posix()
                add(
                    path_key,
                    stem,
                    locale,
                    _candidate(
                        url=url,
                        source_path=source_path,
                        output_path=None,
                        source_is_public=True,
                        kind="source",
                    ),
                )
        for output in source.get("outputs", []):
            if not isinstance(output, dict) or output.get("type") != "Sprite":
                continue
            output_path = str(output.get("path") or "")
            url = data.runtime_output_url(output_path)
            if not url:
                continue
            filename = PurePosixPath(output_path).name
            marker = filename.find("--Sprite")
            if marker <= 0:
                continue
            sprite_name, locale = _variant_name(filename[:marker])
            add(
                sprite_name,
                sprite_name,
                locale,
                _candidate(
                    url=url,
                    source_path=source_path,
                    output_path=output_path,
                    source_is_public=bool(data.asset(source_path)),
                    kind="sprite-derivative",
                ),
            )
    cached = {"byPath": by_path, "byName": by_name}
    setattr(data, "_anon_tokyo_image_index", cached)
    return cached


def _select_image_candidate(values: list[JsonObject]) -> JsonObject | None:
    """Prefer a direct normalized PNG; reject ambiguous logical assets."""

    if not values:
        return None
    direct = [value for value in values if value.get("kind") == "source"]
    candidates = direct or values
    unique = {str(value.get("url")): value for value in candidates if value.get("url")}
    return next(iter(unique.values())) if len(unique) == 1 else None


def _image(data: Any, value: Any) -> JsonObject | None:
    """Resolve an AT logical image key into URL-verified locale variants."""

    if value is None:
        return None
    asset_key = str(value).strip()
    if not asset_key or asset_key == "-":
        return None
    index = _image_index(data)
    canonical_path: str | None = None
    path_value = asset_key
    if path_value.startswith("EmbAnonTokyo/"):
        path_value = f"Assets/AddressableResources/{path_value.removeprefix('Emb')}"
    if path_value.startswith(AT_SOURCE_ROOT):
        path = PurePosixPath(path_value)
        stem = path.stem if path.suffix else path.name
        stem, _locale = _variant_name(stem)
        canonical_path = (path.parent / stem).as_posix()
    logical_name = PurePosixPath(path_value).name
    if PurePosixPath(logical_name).suffix:
        logical_name = PurePosixPath(logical_name).stem
    logical_name, _locale = _variant_name(logical_name)
    variants_by_locale = (
        index["byPath"].get(canonical_path, {})
        if canonical_path is not None
        else index["byName"].get(logical_name, {})
    )
    selected = {
        locale: candidate
        for locale, values in variants_by_locale.items()
        if (candidate := _select_image_candidate(values)) is not None
    }
    base = selected.get(None)
    variants = {
        str(locale): value
        for locale, value in selected.items()
        if locale is not None
    }
    base_locale: str | None = None
    # The GL package has Simplified Chinese guide artwork as the unsuffixed
    # source plus explicit en/zh-Hant/ko siblings.  This is an observed AT
    # packaging convention, not a global "unsuffixed means Japanese" rule.
    if (
        base is not None
        and "/GuideCarousel/" in str(canonical_path or "")
        and variants
    ):
        base_locale = "zh-Hans"
        variants[base_locale] = base
    result: JsonObject = {
        "assetKey": asset_key,
        "baseLocale": base_locale,
        "variants": variants,
        "status": "resolved" if base or variants else "missing",
    }
    if base is not None:
        result.update({key: value for key, value in base.items() if key != "kind"})
    if not base and not variants:
        result["reason"] = "verified-at-image-not-found"
    return result


def _record_map(records: list[JsonObject], kind: str, raw_key: str = "rawId") -> JsonObject:
    output: JsonObject = {}
    for record in records:
        raw_id = record.get(raw_key)
        identity = _at_id(kind, raw_id)
        if identity in output:
            raise ValueError(f"Anon Tokyo catalog has duplicate {kind} id: {raw_id}")
        output[identity] = {"id": identity, **record}
    return output


def _master_rows(data: Any, table: str) -> list[JsonObject]:
    return sorted(
        (row for row in data.rows(table) if isinstance(row, dict)),
        key=lambda row: str(row.get("_id") if row.get("_id") is not None else ""),
    )


def _asset_source_available(data: Any, path_name: Any) -> bool:
    value = str(path_name or "").strip()
    if not value:
        return False
    source = f"Assets/AddressableResources/{value}.asset"
    return source in data.source_index


def _characters(data: Any) -> tuple[JsonObject, JsonObject]:
    avatars = {
        _as_int(row.get("_id")): row
        for row in _master_rows(data, "MasterATAvatar")
        if _as_int(row.get("_id"))
    }
    avatar_records = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "avatarPath": str(row.get("_avatarPath") or ""),
                "image": _image(data, row.get("_avatarPath")),
            }
            for row in _master_rows(data, "MasterATAvatar")
        ],
        "avatar",
    )
    records = []
    for row in _master_rows(data, "MasterATCharacter"):
        identity = _as_int(row.get("_id"))
        if not identity:
            continue
        avatar_id = _as_int(row.get("_avatarID"))
        avatar = avatars.get(avatar_id, {})
        passive = _encoded_value(row.get("_charPassiveAbility"))
        records.append(
            {
                "rawId": identity,
                "name": _localized_text(data, row.get("_name")),
                "bangIdentityNumber": _as_int(row.get("_bangIdentityNumber")),
                "avatarId": avatar_id,
                "avatarRef": _at_id("avatar", avatar_id) if avatar_id else None,
                "avatar": _image(data, avatar.get("_avatarPath")),
                "initType": row.get("_initType"),
                "levelLimit": _as_int(row.get("_levelLimit")),
                "scale": row.get("_scale"),
                "unlock": {
                    "itemId": _as_int(row.get("_buyItemId")),
                    "count": _as_int(row.get("_buyItemCount")),
                },
                "passiveAbility": passive["raw"],
                "passiveAbilityEntries": passive["entries"],
                "defaultAvatarIds": _as_int_list(row.get("_defaultAvatar")),
                "feverAvatarIds": _as_int_list(row.get("_feverAvatar")),
                "sfAvatarIds": _as_int_list(row.get("_sfAvatar")),
                "defaultParts": {
                    "brow": _as_int_list(row.get("_defaultBrow")),
                    "face": _as_int_list(row.get("_defaultFace")),
                    "hair1": _as_int_list(row.get("_defaultHair1")),
                    "hair2": _as_int_list(row.get("_defaultHair2")),
                    "hair3": _as_int_list(row.get("_defaultHair3")),
                },
            }
        )
    return _record_map(records, "character"), avatar_records


def _goods(data: Any) -> JsonObject:
    categories = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_suitName")),
                "icon": _image(data, row.get("_icon")),
                "subType": row.get("_subType"),
            }
            for row in _master_rows(data, "MasterATGoodCategory")
        ],
        "good-category",
    )
    tags = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_tagName")),
                "icon": _image(data, row.get("_iconPathName")),
            }
            for row in _master_rows(data, "MasterATTag")
        ],
        "tag",
    )
    items = []
    for row in _master_rows(data, "MasterATGoods"):
        identity = _as_int(row.get("_id"))
        if not identity:
            continue
        category_id = _as_int(row.get("_categoryId"))
        tag_ids = _as_int_list(row.get("_tagID"))
        items.append(
            {
                "rawId": identity,
                "name": _localized_text(data, row.get("_name")),
                "icon": _image(data, row.get("_address")),
                "address": str(row.get("_address") or ""),
                "categoryId": category_id,
                "categoryRef": _at_id("good-category", category_id),
                "tagIds": tag_ids,
                "tagRefs": [_at_id("tag", value) for value in tag_ids],
                "deliveryDuration": row.get("_deliveryDuration"),
                "purchase": {
                    "cost": _as_int(row.get("_buyItemCost")),
                    "count": _as_int(row.get("_buyItemCount")),
                },
                "buyItemCost": _as_int(row.get("_buyItemCost")),
                "buyItemCount": _as_int(row.get("_buyItemCount")),
                "sale": {
                    "coinCounts": _as_int_list(row.get("_sellCoinCount")),
                    "expCounts": _as_int_list(row.get("_sellExpCount")),
                    "discardCoinCounts": _as_int_list(row.get("_discardCoin")),
                },
                "enhanceCost": _as_int_list(row.get("_enhanceCost")),
                "unlock": {
                    "type": row.get("_unlockType"),
                    "costType": row.get("_unlockCostType"),
                    "costCount": row.get("_unlockCostCount"),
                    "count": row.get("_unlockCount"),
                    "clothIds": _as_int_list(row.get("_unlockClothID")),
                },
                "isShow": bool(row.get("_isShow")),
                "availability": _raw_time_window(row, "_startTime", "_endTime"),
            }
        )
    reloading = []
    for row in _master_rows(data, "MasterATReloading"):
        identity = _as_int(row.get("_id"))
        if not identity:
            continue
        goods_id = _as_int(row.get("_goodsId"))
        character_ids = _as_int_list(row.get("_canUseChar"))
        reloading.append(
            {
                "rawId": identity,
                "name": _localized_text(data, row.get("_name")),
                "icon": _image(data, row.get("_iconPath")),
                "specialIcon": _image(data, row.get("_iconPathSpecial")),
                "goodsId": goods_id,
                "goodsRef": _at_id("good", goods_id) if goods_id else None,
                "characterIds": character_ids,
                "characterRefs": [_at_id("character", value) for value in character_ids],
                "specialCharacterId": _as_int(row.get("_specialCharID")),
                "spineType": row.get("_spineType"),
                "type": row.get("_spineType"),
                "spinePartIds": _as_int_list(row.get("_spineparent")),
                "spineParent": _as_int_list(row.get("_spineparent")),
                "spineDefaultIds": _as_int_list(row.get("_spineparentDefaultId")),
                "spineSpecialPartIds": _as_int_list(row.get("_spineparentSpecial")),
                "rarity": row.get("_rarity"),
                "popularity": row.get("_popularity"),
                "jumpType": row.get("_jumpType"),
                "isShow": bool(row.get("_isShow")),
                "reward": _encoded_value(row.get("_reward")),
                "availability": _raw_time_window(row, "_startTime", "_endTime"),
            }
        )
    links = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "goodsIds": _as_int_list(row.get("_goodsList")),
                "goodsRefs": [
                    _at_id("good", value) for value in _as_int_list(row.get("_goodsList"))
                ],
                "reloadingIds": _as_int_list(row.get("_reloadingID")),
                "reloadingRefs": [
                    _at_id("reloading", value)
                    for value in _as_int_list(row.get("_reloadingID"))
                ],
            }
            for row in _master_rows(data, "MasterATGoodsToReloading")
        ],
        "goods-reloading-link",
    )
    return {
        "categories": categories,
        "tags": tags,
        "items": _record_map(items, "good"),
        "reloading": _record_map(reloading, "reloading"),
        "reloadingLinks": links,
    }


def _shop(data: Any) -> JsonObject:
    main_types = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_nameId")),
                "icon": _image(data, row.get("_iconPath")),
                "type": row.get("_type"),
                "areaType": row.get("_areaType"),
                "order": row.get("_order"),
                "isShow": bool(row.get("_isShow")),
            }
            for row in _master_rows(data, "MasterATDecorationMainType")
        ],
        "decoration-main-type",
    )
    sub_types = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_nameId")),
                "icon": _image(data, row.get("_iconPath")),
                "type": row.get("_type"),
                "subType": row.get("_subType"),
                "order": row.get("_order"),
                "isShow": bool(row.get("_isShow")),
            }
            for row in _master_rows(data, "MasterATDecorationSubType")
        ],
        "decoration-sub-type",
    )

    def decoration(row: JsonObject, *, static: bool = False) -> JsonObject:
        identity = _as_int(row.get("_id"))
        return {
            "rawId": identity,
            "name": _localized_text(data, row.get("_productNameID")),
            "address": str(row.get("_address") or ""),
            "icon": _image(data, row.get("_iconPath")),
            "type": row.get("_type"),
            "subType": row.get("_subType"),
            "size": _as_int_list(row.get("_size")),
            "directions": _as_int_list(row.get("_direction")),
            **({
                "purchase": {
                    "itemId": _as_int(row.get("_buyItemId")),
                    "count": _as_int(row.get("_buyItemCount")),
                },
                "sale": {
                    "itemId": _as_int(row.get("_sellItemId")),
                    "count": _as_int(row.get("_sellItemCount")),
                },
                "buyDirection": row.get("_buyDirection"),
                "condition": {
                    "type": row.get("_conditionType"),
                    "value": row.get("_conditionValue"),
                },
                "conditionType": row.get("_conditionType"),
                "conditionValue": row.get("_conditionValue"),
                "popularity": {
                    "id": row.get("_popularityId"),
                    "count": row.get("_popularityCount"),
                },
                "maxLimitCount": row.get("_maxLimitCount"),
            } if not static else {}),
        }

    stores = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_productNameID")),
                "description": _localized_text(data, row.get("_productDescID")),
                "level": row.get("_level"),
                "roomSizeKey": row.get("_roomSize"),
                "size": _as_int_list(row.get("_size")),
                "customerCount": row.get("_customerCount"),
                "purchase": {
                    "itemId": _as_int(row.get("_buyItemId")),
                    "count": _as_int(row.get("_buyItemCount")),
                },
                "popularity": {
                    "id": row.get("_popularityId"),
                    "count": row.get("_popularityCount"),
                    "shopRequirement": row.get("_shopPopularityRequirement"),
                },
            }
            for row in _master_rows(data, "MasterATStore")
        ],
        "store",
    )
    shelves = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_productNameID")),
                "description": _localized_text(data, row.get("_productDescID")),
                "address": str(row.get("_address") or ""),
                "type": row.get("_type"),
                "subType": row.get("_subType"),
                "size": _as_int_list(row.get("_size")),
                "directions": _as_int_list(row.get("_direction")),
                "limitCount": _as_int_list(row.get("_limitCount")),
                "amount": row.get("_amount"),
                "purchase": {
                    "itemId": _as_int(row.get("_buyItemId")),
                    "count": _as_int(row.get("_buyItemCount")),
                },
            }
            for row in _master_rows(data, "MasterATShelf")
        ],
        "shelf",
    )

    def capacity_records(table: str, kind: str) -> JsonObject:
        return _record_map(
            [
                {
                    "rawId": _as_int(row.get("_id")),
                    "limitCount": row.get("_limitCount"),
                    "purchase": {
                        "itemId": _as_int(row.get("_buyItemId")),
                        "count": _as_int(row.get("_buyItemCount")),
                    },
                }
                for row in _master_rows(data, table)
            ],
            kind,
        )

    return {
        "mainTypes": main_types,
        "subTypes": sub_types,
        "decorations": _record_map(
            [decoration(row) for row in _master_rows(data, "MasterATDecoration")],
            "decoration",
        ),
        "staticDecorations": _record_map(
            [
                decoration(row, static=True)
                for row in _master_rows(data, "MasterATStaticDecoration")
            ],
            "static-decoration",
        ),
        "stores": stores,
        "shelves": shelves,
        "initialMapObjects": _record_map(
            [
                {
                    "rawId": _as_int(row.get("_id")),
                    "configId": _as_int(row.get("_configId")),
                    "mapIndex": row.get("_mapIndex"),
                    "tileIndex": row.get("_tidx"),
                    "direction": row.get("_forword"),
                }
                for row in _master_rows(data, "MasterATInitMapObjects")
            ],
            "initial-map-object",
        ),
        "warehouse": capacity_records("MasterATWarehouse", "warehouse"),
        "safeDepositBoxes": capacity_records("MasterATSafedepositBox", "safe-deposit-box"),
    }


def _themes(data: Any) -> JsonObject:
    records = []
    for row in _master_rows(data, "MasterATSuitTheme"):
        identity = _as_int(row.get("_id"))
        if not identity:
            continue
        collect_ids = _as_int_list(row.get("_needCollect"))
        buy_ids = _as_int_list(row.get("_rewardCanBuyId"))
        records.append(
            {
                "rawId": identity,
                "name": _localized_text(data, row.get("_suitName")),
                "preview": _image(data, row.get("_promoImagePath")),
                "collectReloadingIds": collect_ids,
                "collectReloadingRefs": [_at_id("reloading", value) for value in collect_ids],
                "purchasableReloadingIds": buy_ids,
                "purchasableReloadingRefs": [_at_id("reloading", value) for value in buy_ids],
                "reward": _encoded_value(row.get("_reward")),
                "availability": _raw_time_window(row, "_startTime", "_endTime"),
            }
        )
    return _record_map(records, "theme")


def _stages(data: Any) -> JsonObject:
    # The Fever stage-select screen tiles are the ordered AT_Icon_Fever_Stage*
    # atlas sprites; masters carry no icon column, so stages bind them by order.
    stage_rows = sorted(
        (row for row in _master_rows(data, "MasterATStage") if _as_int(row.get("_id"))),
        key=lambda row: _as_int(row.get("_id")),
    )
    stages = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "image": _image(data, f"AT_Icon_Fever_Stage{index}"),
                "bandId": row.get("_bandID"),
                "bangIdentityNumbers": _as_int_list(row.get("_bangIdentityNumber")),
                "feverCharacterIds": _as_int_list(row.get("_feverBandMembers")),
                "feverReward": _encoded_value(row.get("_feverBufferReward")),
                "startAt": row.get("_startAt"),
                "endAt": row.get("_endAt"),
                "availability": _raw_time_window(row, "_startAt", "_endAt"),
            }
            for index, row in enumerate(stage_rows)
        ],
        "stage",
    )
    music = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_name")),
                "icon": _image(data, row.get("_iconPathName")),
                "bandId": row.get("_bandID"),
                "cueSheetName": str(row.get("_cueSheetName") or ""),
                "pathName": str(row.get("_pathName") or ""),
                "durationSeconds": row.get("_musicTime"),
                "isDefault": bool(row.get("_stageDefaultMusic")),
                "defaultUnlockState": bool(row.get("_defaultUnlockState")),
                "unlock": {
                    "itemId": _as_int(row.get("_buyItemId")),
                    "count": _as_int(row.get("_buyItemCount")),
                    "levelLimit": row.get("_levelLimit"),
                },
                "startAt": row.get("_startAt"),
                "endAt": row.get("_endAt"),
                "availability": _raw_time_window(row, "_startAt", "_endAt"),
            }
            for row in _master_rows(data, "MasterATStageMusic")
        ],
        "stage-music",
    )
    buffs = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_buffName")),
                "icon": _image(data, row.get("_icon")),
            }
            for row in _master_rows(data, "MasterATStageBuff")
        ],
        "stage-buff",
    )
    bgm = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "cueName": str(row.get("_cueName") or ""),
                "cueSheetName": str(row.get("_cueSheetName") or ""),
            }
            for row in _master_rows(data, "MasterATBgmMusic")
        ],
        "bgm",
    )
    return {"stages": stages, "music": music, "buffs": buffs, "bgm": bgm}


def _tasks(data: Any) -> JsonObject:
    tabs = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_suitName")),
            }
            for row in _master_rows(data, "MasterATTaskTabs")
        ],
        "task-tab",
    )
    main_records: list[JsonObject] = []
    for row in _master_rows(data, "MasterATTaskMain"):
        reward = _encoded_value(row.get("_reward"))
        main_records.append(
            {
                "rawId": _as_int(row.get("_id")),
                # MasterATTaskMain has one authored text field.  It functions
                # as the displayed task label in the client, so retain it as
                # both a title and a description rather than inventing one.
                "title": _localized_text(data, row.get("_description")),
                "description": _localized_text(data, row.get("_description")),
                "taskTabId": row.get("_taskTabsID"),
                "tabId": row.get("_taskTabsID"),
                "taskTabRef": _at_id("task-tab", row.get("_taskTabsID")),
                "taskTypeId": row.get("_taskTypeID"),
                "parameters": [row.get("_param1"), row.get("_param2"), row.get("_param3")],
                "reward": reward["raw"],
                "rewardEntries": reward["entries"],
            }
        )
    main = _record_map(main_records, "task")
    types = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "description": _localized_text(data, row.get("_description")),
                "icon": _image(data, row.get("_icon")),
                "secondaryIcon": _image(data, row.get("_icon1")),
                "jumpTabType": row.get("_jumpTabType"),
                "parameters": [row.get("_param1"), row.get("_param2"), row.get("_param3")],
            }
            for row in _master_rows(data, "MasterATTaskType")
        ],
        "task-type",
    )
    chapters = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_chapterName")),
                "taskIds": _as_int_list(row.get("_taskIDList")),
                "taskRefs": [
                    _at_id("task", value) for value in _as_int_list(row.get("_taskIDList"))
                ],
                "reward": _encoded_value(row.get("_reward")),
            }
            for row in _master_rows(data, "MasterATChapterTask")
        ],
        "chapter-task",
    )
    daily = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "guaranteed": bool(row.get("_guaranteed")),
                "levelLimited": row.get("_levelLimited"),
                "weight": row.get("_weight"),
            }
            for row in _master_rows(data, "MasterATDailyTask")
        ],
        "daily-task",
    )
    achievement_tasks = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_taskName")),
                "beforeTaskId": row.get("_beforeTaskID"),
            }
            for row in _master_rows(data, "MasterATAchievementTask")
        ],
        "achievement-task",
    )
    achievements = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_achievement_name")),
                "description": _localized_text(data, row.get("_achievement_desc")),
                "iconKey": str(row.get("_achievement_icon") or ""),
                "displayOrder": row.get("_display_order"),
                "trigger": {
                    "type": row.get("_trigger_type"),
                    "param": row.get("_trigger_param"),
                    "value": row.get("_trigger_value"),
                },
                "reward": {
                    "type": row.get("_reward_type"),
                    "id": row.get("_reward_id"),
                    "count": row.get("_reward_count"),
                },
                "availability": _raw_time_window(row, "_starttimeAt", "_endtimeAt"),
            }
            for row in _master_rows(data, "MasterATAchievement")
        ],
        "achievement",
    )
    return {
        "tabs": tabs,
        "main": main,
        "types": types,
        "chapter": chapters,
        "daily": daily,
        "achievements": achievements,
        "achievementTasks": achievement_tasks,
        "timeLimited": _record_map([], "time-limited-task"),
    }


def _progression(data: Any) -> JsonObject:
    currencies = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_suitName")),
                "icon": _image(data, row.get("_icon")),
                "acquirable": row.get("_acquirable"),
                "note": str(row.get("_note1") or ""),
                "version": str(row.get("_version1") or ""),
            }
            for row in _master_rows(data, "MasterATCurrencyType")
        ],
        "currency",
    )
    player_levels = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "level": row.get("_level"),
                "exp": row.get("_exp"),
                "customerCount": row.get("_customerCount"),
                "strengthLimit": row.get("_strengthLimit"),
                "townNpcSpawnRate": row.get("_townNpcSpawnRate"),
                "spawnRates": {
                    str(level): row.get(f"_spawnRateLevel{level}")
                    for level in range(1, 9)
                },
                "reward": _encoded_value(row.get("_reward")),
            }
            for row in _master_rows(data, "MasterATPlayer")
        ],
        "player-level",
    )
    attributes = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "description": _localized_text(data, row.get("_description")),
                "levelDescription": _localized_text(data, row.get("_descriptionForLevel")),
                "icon": _image(data, row.get("_icon")),
                "defaultValue": row.get("_defaultValue"),
                "isPercent": bool(row.get("_isPercent")),
            }
            for row in _master_rows(data, "MasterATAttribute")
        ],
        "attribute",
    )
    inspirations = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "purchaseNum": row.get("_purchaseNum"),
                "extraPurchase": row.get("_extraPurchase"),
                "range": str(row.get("_inspirationRange") or ""),
            }
            for row in _master_rows(data, "MasterATInspiration")
        ],
        "inspiration",
    )
    passive = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_passiveAbilityName")),
                "value": _localized_text(data, row.get("_passiveAbilityValue")),
                "icon": _image(data, row.get("_icon")),
            }
            for row in _master_rows(data, "MasterATCharPassiveAbility")
        ],
        "passive-ability",
    )
    rewards = _record_map(
        [
            {"rawId": _as_int(row.get("_id")), "type": row.get("_type")}
            for row in _master_rows(data, "MasterATReward")
        ],
        "reward",
    )
    global_values = {
        str(row.get("_id")): str(row.get("_value") or "")
        for row in _master_rows(data, "MasterATGlobal")
        if str(row.get("_id") or "")
    }
    return {
        "currencies": currencies,
        "playerLevels": player_levels,
        "attributes": attributes,
        "inspirations": inspirations,
        "passiveAbilities": passive,
        "rewards": rewards,
        "global": global_values,
    }


def _staffing(data: Any) -> JsonObject:
    at_characters_by_id = {
        _as_int(row.get("_id")): row
        for row in _master_rows(data, "MasterATCharacter")
        if _as_int(row.get("_id"))
    }
    at_characters_by_bang = {
        _as_int(row.get("_bangIdentityNumber")): row
        for row in at_characters_by_id.values()
        if _as_int(row.get("_bangIdentityNumber"))
    }
    master_characters_by_id = {
        _as_int(row.get("_id")): row
        for row in _master_rows(data, "MasterCharacter")
        if _as_int(row.get("_id"))
    }

    def character_link(at_character: JsonObject | None) -> JsonObject:
        """Follow the verified AT identity -> main character-name relation."""

        if not isinstance(at_character, dict):
            return {}
        character_id = _as_int(at_character.get("_id"))
        avatar_id = _as_int(at_character.get("_avatarID"))
        bang_identity_number = _as_int(at_character.get("_bangIdentityNumber"))
        master_character = master_characters_by_id.get(avatar_id)
        if not character_id or not avatar_id or not isinstance(master_character, dict):
            return {}
        character_name = _localized_text(data, master_character.get("_nameTextID"))
        short_character_name = _localized_text(data, master_character.get("_shortNameTextID"))
        return {
            "characterId": character_id,
            "characterRef": _at_id("character", character_id),
            "masterCharacterId": avatar_id,
            "bangIdentityNumber": bang_identity_number,
            # Keep both authored domains separate. AT's key is the feature's
            # own label; the general character key fills the primary display
            # name only when the former is unavailable in this client build.
            "anonTokyoName": _localized_text(data, at_character.get("_name")),
            "characterName": character_name,
            "shortCharacterName": short_character_name,
            "characterNameTextId": str(master_character.get("_nameTextID") or ""),
            "characterNameAvailable": _has_localized_value(character_name),
        }

    def fallback_name(
        kind: str,
        row: JsonObject,
        source_table: str,
        bang_identity_number: Any = None,
    ) -> tuple[JsonObject, str, JsonObject]:
        raw_id = _as_int(row.get("_id"))
        label = _stable_identity_label(kind, raw_id, bang_identity_number)
        return (
            _stable_identity_name(
                kind,
                raw_id,
                source_table=source_table,
                bang_identity_number=bang_identity_number,
            ),
            label,
            {
                "kind": "stable-identity",
                "sourceTable": source_table,
                "reason": "no-authored-name-or-verified-character-link",
            },
        )

    roles = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "name": _localized_text(data, row.get("_namePath")),
                "icon": _image(data, row.get("_iconPath")),
            }
            for row in _master_rows(data, "MasterATRoleJob")
        ],
        "role",
    )

    clerk_records: list[JsonObject] = []
    for row in _master_rows(data, "MasterATClerk"):
        raw_id = _as_int(row.get("_id"))
        character_id = _as_int(row.get("_characterID"))
        source_name = _localized_text(data, row.get("_nameID"))
        linked = character_link(at_characters_by_id.get(character_id))
        linked_name = linked.get("characterName")
        if _has_localized_value(source_name):
            name = source_name
            label = _stable_identity_label("clerk", raw_id)
            resolution = {
                "kind": "master-text",
                "sourceTable": "MasterATClerk",
                "masterField": "_nameID",
                "textId": source_name.get("textId"),
            }
        elif _has_localized_value(linked_name):
            name = linked_name
            label = _stable_identity_label("clerk", raw_id)
            resolution = {
                "kind": "linked-master-character",
                "sourceTable": "MasterATClerk",
                "relation": "_characterID -> MasterATCharacter._id -> _avatarID -> MasterCharacter._id",
                "masterField": "MasterCharacter._nameTextID",
                "textId": linked_name.get("textId"),
            }
        else:
            name, label, resolution = fallback_name("clerk", row, "MasterATClerk")
        clerk_records.append(
            {
                "rawId": raw_id,
                "characterId": character_id,
                "characterRef": _at_id("character", character_id) if character_id else None,
                "name": name,
                "displayName": name,
                "displayLabel": label,
                "nameKey": str(row.get("_nameID") or ""),
                "sourceName": source_name,
                "nameResolution": resolution,
                **linked,
                "point": row.get("_point"),
            }
        )
    clerks = _record_map(clerk_records, "clerk")

    def named_records(table: str, kind: str, name_field: str, icon_field: str | None = None) -> JsonObject:
        records: list[JsonObject] = []
        for row in _master_rows(data, table):
            raw_id = _as_int(row.get("_id"))
            source_name = _localized_text(data, row.get(name_field))
            if _has_localized_value(source_name):
                name = source_name
                label = _stable_identity_label(kind, raw_id)
                resolution = {
                    "kind": "master-text",
                    "sourceTable": table,
                    "masterField": name_field,
                    "textId": source_name.get("textId"),
                }
            else:
                name, label, resolution = fallback_name(kind, row, table)
            records.append(
                {
                    "rawId": raw_id,
                    "name": name,
                    "displayName": name,
                    "displayLabel": label,
                    "nameKey": str(row.get(name_field) or ""),
                    "sourceName": source_name,
                    "nameResolution": resolution,
                    **({"icon": _image(data, row.get(icon_field))} if icon_field else {}),
                    **{
                        key.removeprefix("_"): value
                        for key, value in row.items()
                        if key not in {"_id", name_field, icon_field}
                    },
                }
            )
        return _record_map(records, kind)

    def plain_records(table: str, kind: str) -> JsonObject:
        return _record_map(
            [
                {
                    "rawId": _as_int(row.get("_id")),
                    "values": {
                        key.removeprefix("_"): value
                        for key, value in row.items()
                        if key != "_id"
                    },
                }
                for row in _master_rows(data, table)
            ],
            kind,
        )

    def generic_customer_records(
        table: str,
        customer_kind: str,
        entity_kind: str,
    ) -> JsonObject:
        records: list[JsonObject] = []
        for row in _master_rows(data, table):
            raw_id = _as_int(row.get("_id"))
            name, label, resolution = fallback_name(customer_kind, row, table)
            records.append(
                {
                    "rawId": raw_id,
                    "name": name,
                    "displayName": name,
                    "displayLabel": label,
                    "nameResolution": resolution,
                    "defaultAvatarIds": _as_int_list(row.get("_defaultAvatar")),
                    "values": {
                        key.removeprefix("_"): value
                        for key, value in row.items()
                        if key != "_id"
                    },
                }
            )
        return _record_map(records, entity_kind)

    band_customer_records: list[JsonObject] = []
    for row in _master_rows(data, "MasterATBDCustomer"):
        raw_id = _as_int(row.get("_id"))
        bang_identity_number = _as_int(row.get("_bangIdentityNumber"))
        source_name = _localized_text(data, row.get("_bdCustomerID"))
        linked = character_link(at_characters_by_bang.get(bang_identity_number))
        linked_name = linked.get("characterName")
        if _has_localized_value(source_name):
            name = source_name
            label = _stable_identity_label("band", raw_id, bang_identity_number)
            resolution = {
                "kind": "master-text",
                "sourceTable": "MasterATBDCustomer",
                "masterField": "_bdCustomerID",
                "textId": source_name.get("textId"),
            }
        elif _has_localized_value(linked_name):
            name = linked_name
            label = _stable_identity_label("band", raw_id, bang_identity_number)
            resolution = {
                "kind": "linked-master-character",
                "sourceTable": "MasterATBDCustomer",
                "relation": "_bangIdentityNumber -> MasterATCharacter._bangIdentityNumber -> _avatarID -> MasterCharacter._id",
                "masterField": "MasterCharacter._nameTextID",
                "textId": linked_name.get("textId"),
            }
        else:
            name, label, resolution = fallback_name(
                "band",
                row,
                "MasterATBDCustomer",
                bang_identity_number,
            )
        band_customer_records.append(
            {
                "rawId": raw_id,
                "name": name,
                "displayName": name,
                "displayLabel": label,
                "nameKey": str(row.get("_bdCustomerID") or ""),
                "sourceName": source_name,
                "nameResolution": resolution,
                **linked,
                "defaultAvatarIds": _as_int_list(row.get("_defaultAvatar")),
                **{
                    key.removeprefix("_"): value
                    for key, value in row.items()
                    if key not in {"_id", "_bdCustomerID", "_defaultAvatar"}
                },
            }
        )

    customer_collections = {
        "normal": generic_customer_records("MasterATCustomer", "normal", "customer"),
        "normalPools": plain_records("MasterATCustomerArray", "customer-pool"),
        "band": _record_map(band_customer_records, "band-customer"),
        "bandLevels": plain_records("MasterATBDCustomerLv", "band-customer-level"),
        "roam": generic_customer_records(
            "MasterATRoamCustomer",
            "roam",
            "roam-customer",
        ),
        "roamPools": plain_records("MasterATRoamCustomerArray", "roam-customer-pool"),
        "town": generic_customer_records("MasterATTownNpc", "town", "town-npc"),
        "townPools": plain_records("MasterATTownNpcArray", "town-npc-pool"),
    }
    # The general staffing browse page consumes individual people, not the
    # pool/level configuration records. Keep those collections separately
    # while exposing a flat, route-stable customer record map for the UI.
    customers: JsonObject = {}
    for customer_kind in ("normal", "band", "roam", "town"):
        values = customer_collections[customer_kind]
        if not isinstance(values, dict):
            continue
        for identity, customer in values.items():
            if not isinstance(customer, dict):
                continue
            if identity in customers:
                raise ValueError(f"Anon Tokyo customer identity repeats: {identity}")
            customers[identity] = {**customer, "customerKind": customer_kind}

    return {
        "roles": roles,
        "clerks": clerks,
        "helpers": named_records("MasterATHelper", "helper", "_helperName", "_iconPath"),
        "helperSkills": named_records("MasterATHelperSkill", "helper-skill", "_helperSkillName"),
        "deliveries": named_records("MasterATDelivery", "delivery", "_deliveryName"),
        "deliverySkills": named_records("MasterATDeliverySkill", "delivery-skill", "_deliverySkillName"),
        "deliverymen": named_records("MasterATDeliveryman", "deliveryman", "_deliverymanNameID"),
        "customers": customers,
        "customerCollections": customer_collections,
    }


def _dialogue(data: Any) -> JsonObject:
    character_chats = _record_map(
        [
            {
                "rawId": row.get("_id"),
                "characterName": _localized_text(data, row.get("_name")),
                "cashierGroupId": row.get("_cashier"),
                "shopAssistantGroupId": row.get("_guider"),
                "restockerGroupId": row.get("_replenishmentStaff"),
            }
            for row in _master_rows(data, "MasterATCharChat")
        ],
        "character-chat",
    )
    chat_groups = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "textIds": [
                    item.strip()
                    for item in str(row.get("_chatWordsIds") or "").split(",")
                    if item.strip()
                ],
                "lines": [
                    _localized_text(data, item.strip())
                    for item in str(row.get("_chatWordsIds") or "").split(",")
                    if item.strip()
                ],
            }
            for row in _master_rows(data, "MasterATCharChatManage")
        ],
        "chat-group",
    )
    monologue_main = {
        _as_int(row.get("_id")): _localized_text(data, row.get("_monologueText"))
        for row in _master_rows(data, "MasterATMonologueMain")
    }
    monologues = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "characterName": _localized_text(data, row.get("_name")),
                "groups": {
                    "cashier": {
                        "id": _as_int(row.get("_monologueCashier")),
                        "line": monologue_main.get(_as_int(row.get("_monologueCashier"))),
                    },
                    "restocker": {
                        "id": _as_int(row.get("_monologueRestocker")),
                        "line": monologue_main.get(_as_int(row.get("_monologueRestocker"))),
                    },
                    "shopAssistant": {
                        "id": _as_int(row.get("_monologueShopAss")),
                        "line": monologue_main.get(_as_int(row.get("_monologueShopAss"))),
                    },
                    "standby": {
                        "id": _as_int(row.get("_monologueStandby")),
                        "line": monologue_main.get(_as_int(row.get("_monologueStandby"))),
                    },
                },
            }
            for row in _master_rows(data, "MasterATMonologueChar")
        ],
        "monologue",
    )
    talking = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "characterId": _as_int(row.get("_characterID")),
                "characterRef": _at_id("character", row.get("_characterID")),
                "text": _localized_text(data, row.get("_talkingTextID")),
            }
            for row in _master_rows(data, "MasterATTalking")
        ],
        "talking",
    )
    return {
        "characterChats": character_chats,
        "chatGroups": chat_groups,
        "monologues": monologues,
        "talking": talking,
    }


def _guides(data: Any) -> JsonObject:
    steps = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "group": row.get("_group"),
                "page": str(row.get("_page") or ""),
                "path": str(row.get("_path") or ""),
                "title": _localized_text(data, row.get("_textId")),
                "text": _localized_text(data, row.get("_textId")),
                "hint": _localized_text(data, row.get("_hintId")),
                "carouselId": row.get("_carouselId"),
                "frameType": row.get("_frameType"),
                "focusPadding": row.get("_focusPadding"),
                "keepCameraFollow": bool(row.get("_keepCameraFollow")),
                "autoDelayMs": row.get("_autoDelayMs"),
                "minShowSeconds": row.get("_minShowSec"),
                "wait": {
                    "key": row.get("_waitKey"),
                    "timeoutMs": row.get("_waitTimeoutMs"),
                },
                "navigation": {
                    "retryToStepId": row.get("_retryToStepId"),
                    "skipToStepId": row.get("_skipToStepId"),
                    "completeEventId": row.get("_completeEventId"),
                },
            }
            for row in _master_rows(data, "MasterATGuide")
        ],
        "guide-step",
    )
    image_pages = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "carouselId": row.get("_carouselId"),
                "pageIndex": row.get("_pageIndex"),
                "imageKey": str(row.get("_imageKey") or ""),
                "image": _image(data, row.get("_imageKey")),
                "title": _localized_text(data, row.get("_titleId")),
                "description": _localized_text(data, row.get("_descriptionId")),
                "nextButton": _localized_text(data, row.get("_nextButtonId")),
                "closeButton": _localized_text(data, row.get("_closeButtonId")),
            }
            for row in _master_rows(data, "MasterATImageGuide")
        ],
        "image-guide",
    )
    return {"steps": steps, "imagePages": image_pages}


def _map_configs(data: Any) -> JsonObject:
    configs: list[JsonObject] = []
    prefix = f"{AT_SOURCE_ROOT}Config/MapConfig_"
    for source_path in sorted(data.source_index):
        path = PurePosixPath(source_path)
        if not source_path.startswith(prefix) or path.suffix.casefold() != ".txt":
            continue
        url = data.asset(source_path)
        if not url:
            continue
        file = data.assets / Path(*path.parts)
        try:
            payload = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"Anon Tokyo map configuration is invalid: {source_path}") from error
        if not isinstance(payload, dict):
            raise ValueError(f"Anon Tokyo map configuration is not an object: {source_path}")
        map_index = _as_int(payload.get("mapIndex"))
        if not map_index:
            raise ValueError(f"Anon Tokyo map configuration has no mapIndex: {source_path}")
        tiles = payload.get("tiles")
        static_objects = payload.get("staticObjects")
        editable_objects = payload.get("editableObjects")
        configs.append(
            {
                "rawId": map_index,
                "mapIndex": map_index,
                "sourcePath": source_path,
                "url": url,
                "exportTime": payload.get("exportTime"),
                "countX": payload.get("countX"),
                "countY": payload.get("countY"),
                "size": [payload.get("countX"), payload.get("countY")],
                "tileCount": len(tiles) if isinstance(tiles, list) else 0,
                "staticObjectCount": (
                    len(static_objects) if isinstance(static_objects, list) else 0
                ),
                "objectCount": sum(
                    len(objects)
                    for objects in (static_objects, editable_objects)
                    if isinstance(objects, list)
                ),
                "configuration": payload,
            }
        )
    return _record_map(configs, "map")


def _spine(
    data: Any,
    source_id: str,
    spine_catalog: JsonObject | None = None,
) -> JsonObject:
    """Keep AT recipes small and link their components to the Spine catalog.

    A release can contain hundreds of independently useful Spine models.  The
    Anon Tokyo document deliberately retains only the default-character
    recipes and lightweight references to their component models; consumers
    fetch the full model through the standalone ``spine`` collection when it
    is actually selected for playback.
    """

    parts = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "order": row.get("_order"),
                "pathName": str(row.get("_pathName") or ""),
                "sourceAvailable": _asset_source_available(data, row.get("_pathName")),
            }
            for row in _master_rows(data, "MasterATReplacementparts")
        ],
        "spine-part",
    )
    defaults = _record_map(
        [
            {
                "rawId": _as_int(row.get("_id")),
                "listId": row.get("_listID"),
                "part": str(row.get("_part") or ""),
            }
            for row in _master_rows(data, "MasterATSpineparentDefault")
        ],
        "spine-default",
    )
    catalog = spine_catalog or build_spine_catalog(data, source_id)
    base: JsonObject = {
        "available": False,
        "status": "unavailable",
        "reason": "spine-build-metadata-missing",
        "models": {},
        "unavailableModels": {},
        "renderRecipes": {},
        "unavailableRenderRecipes": {},
        "parts": parts,
        "defaults": defaults,
    }
    metadata, metadata_reason = read_spine_metadata(data, source_id)
    if metadata is None:
        return {**base, "reason": metadata_reason}

    raw_recipes = spine_records(metadata.get("renderRecipes"), "render recipe")
    raw_unavailable_recipes = spine_records(
        metadata.get("unavailableRenderRecipes"), "unavailable render recipe"
    )

    def compact_recipe(identity: str, value: JsonObject) -> JsonObject:
        """Recipes are presentation metadata; the per-part renderer payloads stay in the spine build."""

        runtime = value.get("runtime") if isinstance(value.get("runtime"), dict) else {}
        return {
            "id": str(value.get("id") or identity),
            "characterId": value.get("characterId"),
            "avatarId": value.get("avatarId"),
            "nameKey": value.get("nameKey"),
            "defaultAvatarReloadingIds": value.get("defaultAvatarReloadingIds"),
            "outfitReloadingIds": value.get("outfitReloadingIds"),
            "appearance": value.get("appearance"),
            "animation": value.get("animation"),
            "scale": value.get("scale"),
            "parts": [
                {
                    "modelId": part.get("modelId"),
                    "order": part.get("order"),
                    "reloadingId": part.get("reloadingId"),
                }
                for part in (value.get("parts") or [])
                if isinstance(part, dict)
            ],
            "preview": value.get("preview"),
            "runtime": {
                "status": runtime.get("status"),
                "renderer": runtime.get("renderer"),
                "sort": runtime.get("sort"),
                "verification": runtime.get("verification"),
            },
        }

    recipes = {
        identity: compact_recipe(identity, sanitize_spine_value(data, value))
        for identity, value in raw_recipes.items()
        if value.get("feature") == "anon-tokyo"
    }
    recipe_order = [
        identity
        for identity in metadata.get("renderRecipeOrder", [])
        if isinstance(identity, str) and identity in recipes
    ]
    recipe_order = list(
        dict.fromkeys([*recipe_order, *sorted(identity for identity in recipes if identity not in recipe_order)])
    )
    unavailable_recipes = {
        identity: compact_recipe(identity, sanitize_spine_value(data, value))
        for identity, value in raw_unavailable_recipes.items()
        if identity in recipes
    }
    unavailable_recipes.update(
        {
            identity: recipe
            for identity, recipe in recipes.items()
            if isinstance(recipe.get("runtime"), dict)
            and recipe["runtime"].get("status") != "ready"
        }
    )
    model_ids = sorted(
        {
            str(part.get("modelId"))
            for recipe in recipes.values()
            if isinstance(recipe.get("parts"), list)
            for part in recipe["parts"]
            if isinstance(part, dict) and isinstance(part.get("modelId"), str)
        }
    )
    catalog_models = catalog.get("models") if isinstance(catalog.get("models"), dict) else {}
    models: JsonObject = {}
    unavailable_models: JsonObject = {}
    for identity in model_ids:
        model = catalog_models.get(identity)
        if isinstance(model, dict):
            reference = spine_model_reference(model)
        else:
            reference = {
                "id": identity,
                "status": "unavailable",
                "reason": "model-not-present-in-spine-catalog",
            }
        models[identity] = reference
        if reference.get("status") != "available":
            unavailable_models[identity] = reference
    playable = bool(catalog.get("available")) and bool(recipes)
    return {
        "available": playable,
        "status": "available" if playable else "unavailable",
        "reason": (
            "anon-tokyo-default-render-recipes-present"
            if playable
            else (
                "anon-tokyo-render-recipes-absent"
                if bool(catalog.get("available"))
                else str(catalog.get("reason") or metadata_reason)
            )
        ),
        "metadata": {
            key: metadata.get(key)
            for key in (
                "schema",
                "runtime",
                "modelCount",
                "playableModelCount",
                "unavailableModelCount",
                "previewRenderedCount",
                "previewUnavailableCount",
                "renderRecipeCount",
                "unavailableRenderRecipeCount",
                "browserRuntime",
                "anonTokyo",
            )
            if metadata.get(key) is not None
        },
        "models": models,
        "modelOrder": model_ids,
        "unavailableModels": unavailable_models,
        "unavailableModelOrder": sorted(unavailable_models),
        "renderRecipes": {identity: recipes[identity] for identity in recipe_order},
        "renderRecipeOrder": recipe_order,
        "unavailableRenderRecipes": unavailable_recipes,
        "unavailableRenderRecipeOrder": sorted(unavailable_recipes),
        "parts": parts,
        "defaults": defaults,
    }


def _source_table_counts(data: Any) -> JsonObject:
    return {
        table: len(data.rows(table))
        for table in sorted(data.tables)
        if table.startswith("MasterAT")
    }


def _source_tables(data: Any) -> JsonObject:
    """Retain exact MasterAT rows as a lossless fallback for future readers.

    The semantic sections above make the current site fast to implement, but
    an AT update can add fields before the projection gains a named alias.
    Keeping the original table/field spelling means those authored values are
    still public, inspectable data rather than silently disappearing.
    """

    output: JsonObject = {}
    for table in sorted(name for name in data.tables if name.startswith("MasterAT")):
        rows = _master_rows(data, table)
        output[table] = {
            "count": len(rows),
            "fields": sorted({key for row in rows for key in row}),
            "rows": rows,
        }
    return output


def build_anon_tokyo_catalog(
    data: Any,
    source_id: str,
    spine_catalog: JsonObject | None = None,
) -> JsonObject:
    """Project client-authored Anon Tokyo data, or a stable unavailable document."""

    source_table_counts = _source_table_counts(data)
    available = bool(source_table_counts.get("MasterATCharacter"))
    base: JsonObject = {
        "schema": ANON_TOKYO_SCHEMA,
        "server": data.server,
        "sourceId": source_id,
        "available": available,
        "reason": (
            "primary-master-table-present" if available else "primary-master-table-absent"
        ),
        "localization": {
            "localeSlots": [
                {"locale": locale, "index": index, "masterField": field}
                for locale, index, field in AT_LOCALE_SLOTS
            ],
            "textFallback": "none",
            "imageFallback": "none",
        },
        "sourceTableCounts": source_table_counts,
    }
    if not available:
        return {
            **base,
            "counts": {},
            "sourceTables": _source_tables(data),
            "spine": _spine(data, source_id, spine_catalog),
        }

    characters, avatars = _characters(data)
    goods = _goods(data)
    shop = _shop(data)
    themes = _themes(data)
    stages = _stages(data)
    tasks = _tasks(data)
    progression = _progression(data)
    staffing = _staffing(data)
    dialogue = _dialogue(data)
    guides = _guides(data)
    maps = _map_configs(data)
    spine = _spine(data, source_id, spine_catalog)
    counts = {
        "characters": len(characters),
        "avatars": len(avatars),
        "goods": len(goods["items"]),
        "reloading": len(goods["reloading"]),
        "decorations": len(shop["decorations"]),
        "staticDecorations": len(shop["staticDecorations"]),
        "themes": len(themes),
        "stages": len(stages["stages"]),
        "tasks": len(tasks["main"]),
        "guideSteps": len(guides["steps"]),
        "maps": len(maps),
        "spineParts": len(spine["parts"]),
    }
    return {
        **base,
        "counts": counts,
        "sourceTables": _source_tables(data),
        "characters": characters,
        "avatars": avatars,
        "goods": goods,
        "shop": shop,
        "themes": themes,
        "stages": stages,
        "tasks": tasks,
        "progression": progression,
        "staffing": staffing,
        "dialogue": dialogue,
        "guides": guides,
        "map": {"configs": maps},
        "spine": spine,
        "evidence": {
            "availability": "MasterATCharacter is the primary availability table.",
            "master": "All values are projected from named MasterAT tables without inferred enum labels.",
            "rawMaster": "sourceTables retains exact MasterAT rows and field spellings alongside the semantic projection.",
            "localization": "Missing MasterText slots remain empty; no locale is copied into another slot.",
            "images": "Only normalized source images or verified Unity Sprite derivatives receive a public URL.",
            "spine": "Spine runtime availability is supplied only by metadata/spine.json with matching release identity.",
        },
    }
