"""Human-readable projections for the game's rotating systems."""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any, Callable


def _number(row: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = row.get(key)
        if value is not None:
            try:
                return int(value)
            except (TypeError, ValueError):
                pass
    return 0


def _asset(data: Any, value: Any) -> str | None:
    name = str(value or "").strip("/")
    if not name:
        return None
    if not name.startswith(("Assets/", "Packages/")):
        name = f"Assets/AddressableResources/{name}"
    if not re.search(r"\.[A-Za-z0-9]+$", name):
        name += ".png"
    return data.asset(name)


def _localized_name(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(part or "") for part in value]
    return [str(value or ""), "", "", "", ""]


def _resource(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    resource_type: int,
    resource_id: int,
    count: int = 1,
) -> dict[str, Any]:
    key = str(resource_id)
    source: dict[str, Any] | None = None
    route = ""
    secondary: list[str] | None = None
    if resource_type == 1:
        source = documents["items"]["items"].get(key)
        route = f"/catalog/items?item={resource_id}"
        name = source.get("name") if source else None
        image = source.get("image") if source else None
    elif resource_type == 2:
        source = documents["cards"].get(key)
        route = f"/catalog/member-cards?card={resource_id}"
        name = source.get("prefix") if source else None
        image = (source.get("images") or {}).get("thumbnail") if source else None
        character = documents["characters"].get(str(source.get("characterId"))) if source else None
        secondary = character.get("characterName") if character else None
    elif resource_type == 3:
        source = documents["support-cards"].get(key)
        route = f"/catalog/support-cards?snap={resource_id}"
        name = source.get("prefix") or source.get("cardName") if source else None
        image = (source.get("images") or {}).get("thumbnail") if source else None
        secondary = source.get("cardName") if source else None
    elif resource_type == 8:
        source = documents["songs"].get(key)
        route = f"/catalog/songs?song={resource_id}"
        name = source.get("musicTitle") if source else None
        image = source.get("jacketThumbUrl") or source.get("jacketUrl") if source else None
        secondary = source.get("bandName") if source else None
    elif resource_type == 9:
        source = documents["stamps"].get(key)
        route = f"/catalog/stamps?stamp={resource_id}"
        name = source.get("name") if source else None
        image = source.get("image") if source else None
    elif resource_type == 7:
        gacha = next(
            (row for row in data.rows("MasterGacha") if _number(row, "_id") == resource_id),
            None,
        )
        name = data.text(gacha.get("_nameTextId")) if gacha else None
        image = None
    else:
        name = None
        image = None
    return {
        "kind": resource_types.get(resource_type, ""),
        "name": _localized_name(name),
        "secondary": secondary or [],
        "image": image or "",
        "href": route if source else "",
        "count": max(0, count),
    }


def _entry(
    identity: str,
    title: list[str],
    *,
    kind: str,
    image: str | None = None,
    description: list[str] | None = None,
    start_at: list[int | None] | None = None,
    end_at: list[int | None] | None = None,
    **details: Any,
) -> dict[str, Any]:
    return {
        "id": identity,
        "title": title,
        "kind": kind,
        "image": image or "",
        "description": description or [],
        "startAt": start_at or [0, None, None, None, None],
        "endAt": end_at or [0, None, None, None, None],
        **details,
    }


def _events(data: Any, documents: dict[str, Any], stamp: Callable[[Any], list[int | None]]) -> dict[str, Any]:
    entries: dict[str, Any] = {}
    for row in data.rows("MasterEvent"):
        identity = _number(row, "_id")
        if not identity:
            continue
        entries[str(identity)] = _entry(
            str(identity),
            data.text(row.get("_nameTextId") or row.get("_nameTextID")),
            kind="game-event",
            image=_asset(data, row.get("_bannerAssetName") or row.get("_bannerAsset")),
            description=data.text(row.get("_descriptionTextId")),
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
        )
    return {"entries": entries, "hasGameEvents": bool(data.rows("MasterEvent"))}


def _real_lives(data: Any, documents: dict[str, Any], stamp: Callable[[Any], list[int | None]]) -> dict[str, Any]:
    entries: dict[str, Any] = {}
    for row in data.rows("MasterRealLiveSchedule"):
        identity = _number(row, "_id")
        if not identity:
            continue
        bands = [documents["bands"].get(str(value)) for value in row.get("_bandIds", [])]
        bands = [band for band in bands if isinstance(band, dict)]
        if not bands:
            continue
        title = [
            " / ".join(str((band.get("bandName") or [""] * 5)[index] or "") for band in bands)
            for index in range(5)
        ]
        entries[f"real-live-{identity}"] = _entry(
            f"real-live-{identity}",
            title,
            kind="real-live",
            image=str(bands[0].get("logo") or ""),
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            readyAt=stamp(row.get("_readyAt")),
            bands=[{"name": band.get("bandName"), "icon": band.get("icon"), "logo": band.get("logo")} for band in bands],
        )
    return {"entries": entries}


def _prize_rate_rows(
    prize_rows: list[dict[str, Any]],
    group_weight: int,
) -> list[dict[str, Any]]:
    """Absolute draw weights of every prize inside one prize group.

    The game expresses every rate in basis points of the whole lottery: the
    lot group carries ``_weight`` out of 10000, pickup prizes (``_pickUpType``
    2) carry ``_pickUpFixedRate`` out of 10000 each, and the remaining prizes
    split the group's leftover weight equally. Verified against the release
    pools: a 3.00% SSR-member slot with five pickups at 50 (0.50% each) leaves
    0.50% for the other five cards (0.10% each).
    """
    pickups = [row for row in prize_rows if _number(row, "_pickUpType") == 2]
    fixed_total = sum(_number(row, "_pickUpFixedRate") for row in pickups)
    regular = [row for row in prize_rows if _number(row, "_pickUpType") != 2]
    regular_share = max(0, group_weight - fixed_total) // len(regular) if regular else 0
    return [
        {
            "prize": row,
            "weight": _number(row, "_pickUpFixedRate") or regular_share,
            "pickup": row in pickups,
        }
        for row in prize_rows
    ]


def _gacha(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    stamp: Callable[[Any], list[int | None]],
) -> dict[str, Any]:
    products = {str(row.get("_id")): row for row in data.rows("MasterGachaProduct")}
    lots: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterGachaLot"):
        lots[_number(row, "_lotGroupId")].append(row)
    prize_groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterGachaPrize"):
        prize_groups[_number(row, "_groupId")].append(row)
    currency_by_type = {
        int(item.get("itemType") or 0): item
        for item in documents["items"]["items"].values()
        if isinstance(item, dict)
    }
    entries = {}
    for row in data.rows("MasterGacha"):
        identity = _number(row, "_id")
        if not identity:
            continue
        lot_rows = sorted(lots[_number(row, "_lotGroupId")], key=lambda value: -_number(value, "_weight"))
        total_weight = sum(_number(value, "_weight") for value in lot_rows) or 1
        rates: list[dict[str, Any]] = []
        rewards: list[dict[str, Any]] = []
        featured: list[dict[str, Any]] = []
        for lot in lot_rows:
            group = _number(lot, "_prizeGroupId")
            prize_rows = prize_groups[group]
            group_weight = _number(lot, "_weight")
            shares = _prize_rate_rows(prize_rows, group_weight)
            group_rate = group_weight / total_weight
            group_prizes: list[dict[str, Any]] = []
            for value in shares:
                prize = value["prize"]
                reward = _resource(
                    data, documents, resource_types,
                    _number(prize, "_resourceType"), _number(prize, "_resourceId"),
                    _number(prize, "_amount") or 1,
                )
                reward["pickup"] = value["pickup"]
                reward["rate"] = value["weight"] / total_weight
                group_prizes.append(reward)
            rates.append({
                "rarity": _number(lot, "_rarityConstraint"),
                "resourceType": resource_types.get(_number(lot, "_resourceTypeConstraint"), ""),
                "weight": _number(lot, "_weight"),
                "rate": group_rate,
                "prizes": group_prizes,
            })
            rewards.extend(group_prizes)
            featured.extend(
                reward for value, reward in zip(shares, group_prizes, strict=True) if value["pickup"]
            )
        draw_options = []
        currencies: set[int] = set()
        for key in ("_productId1", "_productId2", "_productId3", "_productId4"):
            product = products.get(str(row.get(key) or ""))
            if not product:
                continue
            item_type = _number(product, "_itemType")
            currencies.add(item_type)
            currency = currency_by_type.get(item_type)
            draw_options.append({
                "drawCount": _number(product, "_drawCount"),
                "price": _number(product, "_price"),
                "firstPrice": _number(product, "_firstTimePrice"),
                "currency": currency.get("name") if currency else [],
                "currencyImage": currency.get("image") if currency else "",
                "guaranteedRarity": _number(product, "_ensuredRarity"),
                "guaranteedCount": _number(product, "_ensuredCount"),
                "guaranteedNew": bool(product.get("_isEnsuredNew")),
                "gachaPoint": _number(product, "_gachaPoint"),
                "limitCount": _number(product, "_limitConsumeCount"),
                "monthlyPassIds": [int(value) for value in product.get("_monthlyPassIds", [])],
            })
        ticket = currency_by_type.get(_number(row, "_gachaTicketItemId"))
        if 2 in currencies or ticket:
            category = "ticket"
        elif 15 in currencies:
            category = "ad"
        elif 24 in currencies:
            category = "bonus"
        elif currencies & {12, 13}:
            category = "stars"
        elif 23 in currencies or any(option["monthlyPassIds"] for option in draw_options):
            category = "pass"
        else:
            category = "other"
        entries[str(identity)] = _entry(
            str(identity),
            data.text(row.get("_nameTextId")),
            kind="gacha",
            image=_asset(data, row.get("_bannerAssetName")) or _asset(data, row.get("_logoAssetName")),
            logo=_asset(data, row.get("_logoAssetName")),
            description=data.text(row.get("_descriptionTextId")),
            appeal=data.text(row.get("_appealTextId")),
            warning=data.text(row.get("_warningTextId")) if row.get("_warningTextId") else [],
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            category=category,
            rates=rates,
            featured=featured,
            rewards=rewards,
            drawOptions=draw_options,
            limited=bool(row.get("_isLimited")),
            displayCondition=_number(row, "_gachaDisplayCondition"),
            ticketItem={
                "name": ticket.get("name"),
                "image": ticket.get("image"),
            } if ticket else None,
            pickUpSelectCount=_number(row, "_pickUpSelectCount"),
            beginnerHours=_number(row, "_beginnerHours"),
            comebackHours=_number(row, "_comebackHours"),
            isNewMember=bool(row.get("_isNewMember")),
            ceilings=[int(value) for value in row.get("_ceilingIds", [])],
            bonuses=[int(value) for key in ("_gachaBonusIds1", "_gachaBonusIds2", "_gachaBonusIds3", "_gachaBonusIds4") for value in row.get(key, [])],
        )
    return {"entries": entries}


def _login(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    stamp: Callable[[Any], list[int | None]],
) -> dict[str, Any]:
    slots: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterLoginBonusSlot"):
        reward = _resource(
            data, documents, resource_types,
            _number(row, "_resourceType"), _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        )
        slots[_number(row, "_loginBonusID")].append({
            "sheet": _number(row, "_sheetNo"),
            "day": _number(row, "_slotNo"),
            "reward": reward,
            "image": _asset(data, row.get("_thumbnailAsset")) or reward["image"],
        })
    entries = {}
    for row in data.rows("MasterLoginBonus"):
        identity = _number(row, "_id")
        if not identity:
            continue
        entries[str(identity)] = _entry(
            str(identity),
            data.text(row.get("_nameTextID")),
            kind="login",
            image=_asset(data, row.get("_sheetImageAsset")) or _asset(data, row.get("_backgroundImageAsset")),
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            rewards=sorted(slots[identity], key=lambda slot: (slot["sheet"], slot["day"])),
            recurring=bool(row.get("_isLoop")),
            premium=bool(row.get("_isPremium")),
            comeback=bool(row.get("_isComeback")),
            sheetType=_number(row, "_sheetType"),
        )
    return {"entries": entries}


def _shop(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    stamp: Callable[[Any], list[int | None]],
) -> dict[str, Any]:
    grants: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterShopProduct"):
        reward = _resource(
            data, documents, resource_types,
            _number(row, "_resourceType"), _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        )
        grants[_number(row, "_shopId")].append({**reward, "bonus": bool(row.get("_isBonus"))})
    currencies = {
        int(item.get("itemType") or 0): item
        for item in documents["items"]["items"].values()
        if isinstance(item, dict)
    }
    # Cash packs live in their own table (per-region prices, no window); the
    # game shows them in the same shop. Name and description follow the same
    # Shop_* text ids as every other listing.
    bili_pay = {row.get("_id"): row for row in data.rows("MasterShopBiliPay")}
    entries = {}
    for row in data.rows("MasterShop"):
        identity = _number(row, "_id")
        if not identity:
            continue
        currency = currencies.get(_number(row, "_paymentType"))
        rewards = grants[identity]
        name = data.text(row.get("_nameTextId"))
        description = data.text(row.get("_descriptionTextId"))
        entries[str(identity)] = _entry(
            str(identity),
            name if any(name) else description,
            kind="shop",
            # _thumbnailAsset is a bare name; the sprite lives under
            # Shop/ItemThumbnail (vip_thumb_*, shop_thumb_*, star, ...).
            image=_asset(data, f"Shop/ItemThumbnail/{row.get('_thumbnailAsset') or ''}")
            or (rewards[0]["image"] if rewards else ""),
            description=description if any(name) else [],
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            rewards=rewards,
            payment={
                "price": _number(row, "_price"),
                "currency": currency.get("name") if currency else [],
                "currencyImage": currency.get("image") if currency else "",
                "advertisement": _number(row, "_paymentType") == 15 and not _number(row, "_price"),
                "storePurchase": bool(row.get("_googlePlayPurchaseId") or row.get("_appStorePurchaseId")),
            },
            limit=_number(row, "_limitConsumeCount"),
            vipRank=_number(row, "_vipRank"),
            playerRank=_number(row, "_playerRank"),
            resetType=_number(row, "_resetType"),
            recommended=bool(row.get("_isRecommendBadge")),
        )
    for identity, pay in bili_pay.items():
        if str(identity) in entries or not grants.get(_number(pay, "_id")):
            continue
        rewards = grants[_number(pay, "_id")]
        name = data.text(f"Shop_Name_{identity}")
        description = data.text(f"Shop_Description_{identity}")
        banner = next(
            (
                row.get("_imageAsset")
                for row in data.rows("MasterHomeBanner")
                if _number(row, "_displayType") == 4 and _number(row, "_contentId") == identity
            ),
            None,
        )
        # Cash packs with no dedicated shop_thumb_bili: pass bundles map to
        # their tier's own sprite (premium/standard/lite), ticket bundles to
        # the ticket grant, star bundles to the star emblem, then the home
        # banner art — never a random first grant.
        subscription = next(
            (
                _number(row, "_resourceId")
                for row in data.rows("MasterShopProduct")
                if _number(row, "_shopId") == identity
                and _number(row, "_resourceType") == 6
            ),
            None,
        )
        tier_thumb = {1: "lite", 2: "standard", 3: "premium"}.get(subscription or 0)
        distinctive = next(
            (
                reward["image"]
                for reward in reversed(rewards)
                if reward.get("image") and not str((reward.get("name") or [""])[0]).startswith("スター")
            ),
            None,
        )
        entries[str(identity)] = _entry(
            str(identity),
            name if any(name) else description,
            kind="shop",
            image=_asset(data, f"Shop/ItemThumbnail/shop_thumb_bili_{identity}")
            or (tier_thumb and _asset(data, f"Shop/ItemThumbnail/{tier_thumb}"))
            or _asset(data, banner or "")
            or distinctive
            or (rewards[0]["image"] if rewards else ""),
            description=description if any(name) else [],
            rewards=rewards,
            payment={
                # Every column is minor units (cents); the US dollar price is
                # the headline, the rest ride along for the detail pane.
                "price": _number(pay, "_usd") / 100,
                "currency": ["US$", "US$", "US$", "US$", "US$"],
                "currencyImage": "",
                "prices": {
                    "usd": _number(pay, "_usd") / 100,
                    "twd": _number(pay, "_twd") / 100,
                    "hkd": _number(pay, "_hkd") / 100,
                    "krw": _number(pay, "_krw") / 100,
                },
                "storePurchase": True,
            },
        )
    return {"entries": entries}


def _exchange(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    stamp: Callable[[Any], list[int | None]],
) -> dict[str, Any]:
    categories = {
        _number(row, "_id"): row for row in data.rows("MasterExchangeCategory")
    }
    products: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterExchangeProduct"):
        reward = _resource(
            data, documents, resource_types,
            _number(row, "_resourceType"), _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        )
        products[_number(row, "_exchangeId")].append({
            "reward": reward,
            "cost": _number(row, "_paymentResourceCount"),
            "limit": _number(row, "_limitCount"),
            "recommended": bool(row.get("_isRecommended")),
            "startAt": stamp(row.get("_startAt")),
            "endAt": stamp(row.get("_endAt")),
        })
    entries = {}
    for row in data.rows("MasterExchange"):
        identity = _number(row, "_id")
        if not identity:
            continue
        category = categories.get(_number(row, "_exchangeCategoryId"))
        currency = _resource(
            data, documents, resource_types,
            _number(row, "_paymentResourceType"), _number(row, "_paymentResourceId"),
        )
        entries[str(identity)] = _entry(
            str(identity),
            data.text(row.get("_nameTextId")),
            kind="exchange",
            image=_asset(data, row.get("_bannerAsset")) or currency["image"],
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            category=data.text(category.get("_nameTextId")) if category else [],
            currency=currency,
            products=products[identity],
        )
    return {"entries": entries}


def _circle(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    stamp: Callable[[Any], list[int | None]],
) -> dict[str, Any]:
    rewards: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterCircleRankUpReward"):
        rank = _number(row, "_circleRankId", "_rank")
        rewards[rank].append(_resource(
            data, documents, resource_types,
            _number(row, "_resourceType"), _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        ))
    entries = {}
    for row in data.rows("MasterCircleRank"):
        identity = _number(row, "_id")
        if not identity:
            continue
        entries[str(identity)] = _entry(
            str(identity),
            data.text(row.get("_nameTextId")),
            kind="circle",
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            rewards=rewards[identity],
            rank=_number(row, "_rank"),
        )
    return {"entries": entries}


def _challenge(
    data: Any,
    documents: dict[str, Any],
    stamp: Callable[[Any], list[int | None]],
) -> dict[str, Any]:
    entries = {}
    for row in data.rows("MasterChallengeMusic"):
        identity = _number(row, "_id")
        music = documents["songs"].get(str(_number(row, "_musicId", "_liveMusicId")))
        if not identity or not music:
            continue
        entries[str(identity)] = _entry(
            str(identity),
            music.get("musicTitle") or [],
            kind="challenge",
            image=music.get("jacketThumbUrl") or music.get("jacketUrl"),
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            songHref=f"/catalog/songs?song={music.get('musicId')}",
            band=music.get("bandName"),
        )
    return {"entries": entries}


def _mission_description(data: Any, row: dict[str, Any], documents: dict[str, Any]) -> list[str]:
    text = data.text(row.get("_descriptionTextId"))
    bands = documents["bands"]
    characters = documents["characters"]
    songs = documents["songs"]
    chapters = documents["stories"].get("chapters", {})
    exchange = documents.get("exchange", {}).get("entries", {})
    chapter = chapters.get(str(_number(row, "_storyChapterId")))
    episode_row = next(
        (item for item in data.rows("MasterStoryEpisode") if _number(item, "_id") == _number(row, "_episodeId")),
        None,
    )
    episode = next(
        (
            item for item in documents["stories"].get("episodes", {}).values()
            if episode_row
            and _number(item, "chapterId") == _number(episode_row, "_chapterId")
            and _number(item, "episodeNumber") == _number(episode_row, "_episodeNumber")
        ),
        None,
    )
    band = bands.get(str(_number(row, "_bandId")))
    character = characters.get(str(_number(row, "_characterId")))
    music = songs.get(str(_number(row, "_musicId")))
    shop = exchange.get(str(_number(row, "_exchangeId")))
    score_ranks = {1: "E", 2: "D", 3: "C", 4: "B", 5: "A", 6: "S", 7: "SS"}
    difficulty_keys = ("easy", "normal", "hard", "expert", "master")
    color_keys = ("Red", "Blue", "Green", "Yellow", "Purple")
    card_type = _number(row, "_cardType")
    difficulty = _number(row, "_musicDifficulty")
    values: dict[str, Any] = {
        "AchievementCount": str(_number(row, "_achievementCount")),
        "BandRank": str(_number(row, "_bandRank", "_bandRankId")),
        "ScoreRank": score_ranks.get(_number(row, "_scoreRank"), ""),
        "Value": str(_number(row, "_value")),
        "EpisodeId.Value": str(_number(episode_row or {}, "_episodeNumber")),
        "BandId": band.get("bandName") if band else [],
        "CharacterId": character.get("characterName") if character else [],
        "StoryChapterId": chapter.get("chapterName") if chapter else [],
        "EpisodeId": episode.get("title") if episode else [],
        "MusicId": music.get("musicTitle") if music else [],
        "ExchangeId": shop.get("title") if shop else [],
        "CardType": data.text(f"CardType_{color_keys[card_type - 1]}_Name") if 1 <= card_type <= len(color_keys) else [],
        "MusicDifficulty": data.text(f"ui_difficulty_{difficulty_keys[difficulty]}") if 0 <= difficulty < len(difficulty_keys) else [],
        "MissionCategory": "",
    }
    rendered = []
    for index, raw in enumerate(text):
        line = str(raw or "")
        for key, value in values.items():
            replacement = str(value[index] or "") if isinstance(value, list) and index < len(value) else str(value or "")
            line = line.replace(f"{{{key}}}", replacement)
        line = re.sub(r"\{[^{}]+\}", "", line)
        rendered.append(re.sub(r"\s{2,}", " ", line).strip())
    return rendered


def _missions(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    stamp: Callable[[Any], list[int | None]],
) -> dict[str, Any]:
    rewards = {
        _number(row, "_id"): _resource(
            data, documents, resource_types,
            _number(row, "_resourceType"), _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        )
        for row in data.rows("MasterMissionReward")
    }
    groups = {_number(row, "_id"): row for row in data.rows("MasterLimitedMissionGroup")}
    entries = {}
    for table, kind in (("MasterMission", "regular-mission"), ("MasterLimitedMission", "limited-mission")):
        for row in data.rows(table):
            identity = _number(row, "_id")
            if not identity:
                continue
            group = groups.get(_number(row, "_limitedMissionGroupId"))
            prizes = [
                rewards[int(value)] for value in row.get("_missionRewardIds", [])
                if int(value) in rewards
            ]
            title = _mission_description(data, row, documents)
            entries[f"{kind}-{identity}"] = _entry(
                f"{kind}-{identity}",
                title,
                kind=kind,
                image=_asset(data, group.get("_bannerAsset")) if group else (prizes[0]["image"] if prizes else ""),
                start_at=stamp(row.get("_startAt") or (group or {}).get("_startAt")),
                end_at=stamp(row.get("_endAt") or (group or {}).get("_endAt")),
                group=data.text(group.get("_nameTextID")) if group else [],
                rewards=prizes,
                goal=_number(row, "_achievementCount"),
                missionType=_number(row, "_missionType"),
            )
    return {"entries": entries}


def _passes(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    stamp: Callable[[Any], list[int | None]],
) -> dict[str, Any]:
    season_rewards = {
        _number(row, "_id"): _resource(
            data, documents, resource_types,
            _number(row, "_resourceType"), _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        )
        for row in data.rows("MasterSeasonPassReward")
    }
    levels: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterSeasonPassLevelReward"):
        prizes = [
            season_rewards[int(value)] for value in row.get("_rewardIds", [])
            if int(value) in season_rewards
        ]
        levels[_number(row, "_seasonPassId")].append({
            "level": _number(row, "_level"),
            "premium": bool(row.get("_isPremium")),
            "rewards": prizes,
        })
    season_tasks: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterSeasonPassMission"):
        season_tasks[_number(row, "_seasonPassId")].append({
            "title": _mission_description(data, row, documents),
            "points": _number(row, "_seasonPassPoint"),
        })
    monthly_rewards: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterMonthlyPassDailyReward"):
        monthly_rewards[_number(row, "_monthlyPassId")].append({
            "day": _number(row, "_dayCount"),
            "reward": _resource(
                data, documents, resource_types,
                _number(row, "_resourceType"), _number(row, "_resourceId"),
                _number(row, "_resourceCount"),
            ),
        })
    entries = {}
    for row in data.rows("MasterSeasonPass"):
        identity = _number(row, "_id")
        entries[f"season-{identity}"] = _entry(
            f"season-{identity}",
            data.text(row.get("_nameTextId")),
            kind="season-pass",
            image=_asset(data, f"SeasonPass/Banner/{row.get('_bannerAsset') or ''}"),
            description=data.text(row.get("_descriptionTextId")),
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            levels=sorted(levels[identity], key=lambda value: (value["level"], value["premium"])),
            tasks=season_tasks[identity],
        )
    for row in data.rows("MasterMonthlyPass"):
        identity = _number(row, "_id")
        rewards = sorted(monthly_rewards[identity], key=lambda value: value["day"])
        # The client resolves each pass's banner by its id at
        # Shop/Pass/Banner/{id:05d}.png; the master table carries no pointer.
        banner = _asset(data, f"Shop/Pass/Banner/{identity:05d}")
        entries[f"monthly-{identity}"] = _entry(
            f"monthly-{identity}",
            data.text(row.get("_nameTextId")),
            kind="monthly-pass",
            image=banner or (rewards[0]["reward"]["image"] if rewards else ""),
            description=data.text(row.get("_descriptionTextId")),
            rewards=rewards,
            durationDays=_number(row, "_expireDays"),
            skipAds=bool(row.get("_canSkipAd")),
        )
    return {"entries": entries}


def _home_banners(data: Any, stamp: Callable[[Any], list[int | None]]) -> dict[str, Any]:
    """The carousel the game itself shows at the bottom-left of its home screen.

    ``MasterHomeBanner`` rows are pure images with a display window and a
    ``_displayType``/``_contentId`` pair naming where the banner leads. Link
    targets follow that pair; types whose destination is a server-side
    announcement stay unlinked rather than guessed.
    """
    targets = {
        2: ("gacha", "entry"),
        3: ("exchange", "entry"),
        25: ("passes", "entry"),
    }
    entries: dict[str, Any] = {}
    for row in data.rows("MasterHomeBanner"):
        identity = _number(row, "_id")
        image = _asset(data, row.get("_imageAsset"))
        if not identity or not image:
            continue
        display_type = _number(row, "_displayType")
        resource, param = targets.get(display_type, ("", ""))
        content = _number(row, "_contentId")
        key = str(content) if content else ""
        if resource == "passes":
            key = f"season-{content}" if content else ""
        entries[str(identity)] = _entry(
            str(identity),
            [],
            kind="home-banner",
            image=image,
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            displayOrder=_number(row, "_displayOrder"),
            displayType=display_type,
            contentId=content,
            href=f"/catalog/{resource}?{param}={key}" if resource and key else "",
        )
    return {"entries": entries}


def build_game_systems(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    stamp: Callable[[Any], list[int | None]],
) -> dict[str, dict[str, Any]]:
    base = {
        "events": _events(data, documents, stamp),
        "real-lives": _real_lives(data, documents, stamp),
        "home-banners": _home_banners(data, stamp),
        "gacha": _gacha(data, documents, resource_types, stamp),
        "login-campaigns": _login(data, documents, resource_types, stamp),
        "shop": _shop(data, documents, resource_types, stamp),
        "exchange": _exchange(data, documents, resource_types, stamp),
        "circle": _circle(data, documents, resource_types, stamp),
        "challenge": _challenge(data, documents, stamp),
    }
    joined = {**documents, **base}
    return {
        **base,
        "missions": _missions(data, joined, resource_types, stamp),
        "passes": _passes(data, joined, resource_types, stamp),
    }
