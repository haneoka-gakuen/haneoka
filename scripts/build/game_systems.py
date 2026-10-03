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


def _master_row(data: Any, table: str, identity: int) -> dict[str, Any] | None:
    return next(
        (
            row
            for row in data.rows(table)
            if _number(row, "_id") == identity
        ),
        None,
    )


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
        character = (
            documents["characters"].get(str(source.get("characterId")))
            if source
            else None
        )
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
        image = (
            source.get("jacketThumbUrl") or source.get("jacketUrl") if source else None
        )
        secondary = source.get("bandName") if source else None
    elif resource_type == 9:
        source = documents["stamps"].get(key)
        route = f"/catalog/stamps?stamp={resource_id}"
        name = source.get("name") if source else None
        image = source.get("image") if source else None
    elif resource_type == 7:
        gacha = next(
            (
                row
                for row in data.rows("MasterGacha")
                if _number(row, "_id") == resource_id
            ),
            None,
        )
        name = data.text(gacha.get("_nameTextId")) if gacha else None
        image = None
    elif resource_type == 6:
        source = _master_row(data, "MasterMonthlyPass", resource_id)
        name = data.text(source.get("_nameTextId")) if source else None
        image = (
            _asset(data, f"Shop/Pass/Banner/{resource_id:05d}")
            if source
            else None
        )
        route = f"/catalog/passes?entry=monthly-{resource_id}" if source else ""
    elif resource_type == 10:
        source = _master_row(data, "MasterSeasonPass", resource_id)
        name = data.text(source.get("_nameTextId")) if source else None
        image = (
            _asset(data, f"SeasonPass/Banner/{source.get('_bannerAsset') or ''}")
            if source
            else None
        )
        route = f"/catalog/passes?entry=season-{resource_id}" if source else ""
    elif resource_type == 17:
        source = _master_row(data, "MasterDegree", resource_id)
        name = data.text(source.get("_nameTextId")) if source else None
        image = _asset(data, source.get("_imagePath")) if source else None
        # Degree is a native reward object without a registered public
        # catalogue collection. Keep its source-backed label and art without
        # inventing a noncanonical route.
    else:
        name = None
        image = None
    card_details: dict[str, Any] = {}
    if source and resource_type in (2, 3):
        character_ids = source.get("characterIds") or [source.get("characterId")]
        card_details["characterDetails"] = [
            {
                "characterId": int(character_id),
                **{
                    field: character[field]
                    for field in (
                        "characterName",
                        "englishName",
                        "faceImage",
                        "thumbnailImage",
                    )
                    if field in character
                },
            }
            for character_id in character_ids
            if character_id
            and (character := documents["characters"].get(str(character_id)))
        ]
    song_details: dict[str, Any] = {}
    if source and resource_type == 8:
        song_details = {
            field: source[field]
            for field in (
                "musicId",
                "musicTitle",
                "jacketThumbUrl",
                "jacketUrl",
                "bandId",
                "bandIds",
                "musicType",
                "musicCategories",
                "bandName",
                "artistName",
            )
            if field in source
        }
        band = documents.get("bands", {}).get(str(source.get("bandId")))
        if band:
            song_details["bandDetails"] = {
                field: band[field]
                for field in ("bandId", "bandName", "icon", "logo")
                if field in band
            }
            song_details.setdefault("bandName", band.get("bandName", []))
    return {
        "kind": resource_types.get(resource_type, ""),
        **card_details,
        **song_details,
        "resourceType": resource_type,
        "resourceId": resource_id,
        **(
            {
                key: source[key]
                for key in ("rarity", "cardType", "characterId", "characterIds")
                if key in source
            }
            if source and resource_type in (2, 3)
            else {}
        ),
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


EVENT_REWARD_TABLES = (
    "MasterChallengeLiveEventReward",
    "MasterEventAchievementReward",
    "MasterEventBoxGachaReward",
    "MasterEventRankingReward",
    "MasterLiveEventReward",
    "MasterEventAchievementLoopReward",
)
EVENT_SUPPORT_TABLES = (
    "MasterChallengeLiveEventPoint",
    "MasterEventBoxGacha",
    "MasterEventEffect",
    "MasterLiveEventPoint",
    "MasterEventMission",
    *EVENT_REWARD_TABLES,
)


def _event_id(row: dict[str, Any]) -> int:
    """Read the current Master event foreign key exactly as authored."""

    return _number(row, "_eventId")


def _event_resource(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    table: str,
    row: dict[str, Any],
    resource_row: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Project one event row while retaining parent and linked reward rows.

    Most event reward tables point at ``MasterReward`` through ``_rewardIds``;
    live/challenge rewards carry the resource columns directly.  The caller
    passes the linked MasterReward row only for the former shape, so no
    inferred foreign key is needed for either case.
    """

    source = resource_row or row
    resource_type = _number(source, "_resourceType")
    resource_id = _number(source, "_resourceId")
    resource_count = _number(source, "_resourceCount") or 1
    value = {
        "sourceTable": table,
        "sourceId": _number(row, "_id"),
        "resourceType": resource_type,
        "resourceTypeName": resource_types.get(resource_type, ""),
        "resourceId": resource_id,
        "resourceCount": max(0, resource_count),
        "reward": _resource(
            data,
            documents,
            resource_types,
            resource_type,
            resource_id,
            resource_count,
        ),
        # Keep the exact source row available for future table-specific UI.
        # The projected reward above remains the only display contract.
        "raw": row,
    }
    if resource_row is not None:
        value["rewardId"] = _number(resource_row, "_id")
        value["resourceRaw"] = resource_row
    return value


def _event_story(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    chapter_id: int,
) -> dict[str, Any] | None:
    if not chapter_id:
        return None
    stories = documents.get("stories", {})
    chapters = stories.get("chapters", {}) if isinstance(stories, dict) else {}
    chapter = chapters.get(str(chapter_id)) if isinstance(chapters, dict) else None
    if not isinstance(chapter, dict):
        return None
    episodes = stories.get("episodes", {}) if isinstance(stories, dict) else {}
    episode_rows = []
    reward_groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterStoryReward"):
        reward_groups[_number(row, "_group")].append(row)
    sources = {
        (
            _number(row, "_episodeNumber"),
            bool(row.get("_isExtraEpisode")),
            bool(row.get("_isAnotherEpisode")),
        ): row
        for row in data.rows("MasterStoryEpisode")
        if _number(row, "_chapterId") == chapter_id
    }
    for story_id in chapter.get("episodes", []):
        episode = episodes.get(str(story_id)) if isinstance(episodes, dict) else None
        if not isinstance(episode, dict):
            continue
        source = sources.get(
            (
                _number(episode, "episodeNumber"),
                bool(episode.get("isExtraEpisode")),
                bool(episode.get("isAnotherEpisode")),
            ),
            {},
        )
        episode_rows.append(
            {
                "eventPoint": _number(source, "_eventPoint"),
                "unlockEpisodeNumber": _number(source, "_unlockEpisodeNumber"),
                "rewardTracks": [
                    {
                        "kind": kind,
                        "rewards": [
                            _event_resource(
                                data,
                                documents,
                                resource_types,
                                "MasterStoryReward",
                                reward,
                            )
                            for reward in reward_groups[_number(source, field)]
                        ],
                    }
                    for kind, field in (
                        ("story", "_storyRewardGroupId"),
                        ("event", "_eventStoryRewardGroupId"),
                    )
                    if _number(source, field)
                ],
                **{
                    key: episode.get(key)
                    for key in (
                        "storyId",
                        "storyKey",
                        "chapterId",
                        "chapterName",
                        "bandId",
                        "titleText",
                        "caption",
                        "title",
                        "episodeNumber",
                        "isExtraEpisode",
                        "isAnotherEpisode",
                        "banner",
                        "image",
                        "description",
                        "episodeImage",
                        "thumbnail",
                        "playTime",
                    )
                    if episode.get(key) is not None
                },
            }
        )
    # The client presents the authored Main → Extra → Another groups.  The
    # Master episode list is usually already grouped by Adv id, but that is
    # an implementation detail and must not define the public ordering.
    episode_rows.sort(
        key=lambda episode: (
            2
            if episode.get("isAnotherEpisode")
            else 1
            if episode.get("isExtraEpisode")
            else 0,
            _number(episode, "episodeNumber"),
            str(episode.get("storyId") or episode.get("storyKey") or ""),
        )
    )
    return {
        "chapterId": chapter_id,
        "chapterName": chapter.get("chapterName", []),
        "mainCharacterIds": list(chapter.get("mainCharacterIds") or []),
        "bandId": _number(chapter, "bandId"),
        "bandDetails": {
            field: band[field]
            for field in ("bandId", "bandName", "icon", "logo")
            if field in band
        }
        if (band := documents.get("bands", {}).get(str(chapter.get("bandId"))))
        else {},
        "description": chapter.get("description", []),
        "banner": chapter.get("banner"),
        "image": chapter.get("image"),
        "episodes": episode_rows,
    }


def _event_cover_image(
    data: Any,
    documents: dict[str, Any],
    event: dict[str, Any],
    story_chapter_id: int,
) -> str | None:
    """Resolve the native event cover before falling back to source art.

    ``MasterHomeBanner`` display type 1 is the event-title banner.  Its
    ``_contentId`` is the owning ``MasterEvent`` id, and its ``_imageAsset``
    points at the already-composed native banner used by the home UI.  The
    story chapter banner is the same source-backed relation when a build has
    the story document but not the home-banner table.
    """

    event_id = _number(event, "_id")
    for row in sorted(
        data.rows("MasterHomeBanner"),
        key=lambda value: (_number(value, "_displayOrder"), _number(value, "_id")),
        reverse=True,
    ):
        if (
            _number(row, "_displayType") == 1
            and _number(row, "_contentId") == event_id
        ):
            image = _asset(data, row.get("_imageAsset"))
            if image:
                return image

    stories = documents.get("stories", {})
    chapters = stories.get("chapters", {}) if isinstance(stories, dict) else {}
    chapter = chapters.get(str(story_chapter_id)) if isinstance(chapters, dict) else None
    if isinstance(chapter, dict) and chapter.get("banner"):
        return str(chapter["banner"])

    story_row = _master_row(data, "MasterStoryChapter", story_chapter_id)
    if story_row:
        image = _asset(
            data,
            f"Story/Banner/Chapter/{story_row.get('_banner') or ''}",
        )
        if image:
            return image

    # Older sources may not carry the home-banner relation or story chapter
    # projection. Preserve the event's own authored art as the final fallback.
    return _asset(data, f"Image/Event/{event.get('_backgroundAsset')}") or _asset(
        data, event.get("_bannerAssetName") or event.get("_bannerAsset")
    )


def _event_support(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    event: dict[str, Any],
) -> dict[str, Any]:
    event_id = _number(event, "_id")
    live_point_group = _number(event, "_liveEventPointGroup")
    live_reward_group = _number(event, "_liveEventRewardGroup")
    challenge_point_group = _number(event, "_challengeLiveEventPointGroup")
    challenge_reward_group = _number(event, "_challengeLiveEventRewardGroup")
    reward_rows = {
        _number(row, "_id"): row
        for row in data.rows("MasterReward")
        if _number(row, "_id")
    }

    def belongs(table: str, row: dict[str, Any]) -> bool:
        explicit = _event_id(row)
        if explicit:
            return explicit == event_id
        if table == "MasterLiveEventPoint":
            return bool(live_point_group and _number(row, "_group") == live_point_group)
        if table == "MasterLiveEventReward":
            # Reward _group identifies a lottery subgroup, not the point group.
            return bool(
                live_reward_group
                and _number(row, "_eventGroup") == live_reward_group
            )
        if table == "MasterChallengeLiveEventPoint":
            return bool(
                challenge_point_group
                and _number(row, "_group") == challenge_point_group
            )
        if table == "MasterChallengeLiveEventReward":
            return bool(
                challenge_reward_group
                and _number(row, "_eventGroup") == challenge_reward_group
            )
        return False

    support: dict[str, list[dict[str, Any]]] = {}
    rewards: list[dict[str, Any]] = []
    effects: list[dict[str, Any]] = []
    missions: list[dict[str, Any]] = []
    for table in EVENT_SUPPORT_TABLES:
        rows = []
        for row in data.rows(table):
            if not belongs(table, row):
                continue
            value = {
                "sourceTable": table,
                "sourceId": _number(row, "_id"),
                "raw": row,
            }
            if table in EVENT_REWARD_TABLES:
                reward_ids = row.get("_rewardIds")
                if isinstance(reward_ids, list):
                    for reward_id in reward_ids:
                        reward_identity = _number({"value": reward_id}, "value")
                        linked = reward_rows.get(reward_identity)
                        if linked is None:
                            # Preserve an unresolved identifier in the API
                            # contract; the UI renders its localized fallback.
                            value.setdefault("unresolvedRewardIds", []).append(
                                reward_identity
                            )
                            rewards.append(
                                {
                                    "sourceTable": table,
                                    "sourceId": _number(row, "_id"),
                                    "rewardId": reward_identity,
                                    "resourceType": 0,
                                    "resourceTypeName": "",
                                    "resourceId": 0,
                                    "resourceCount": 0,
                                    "reward": {
                                        "name": [],
                                        "secondary": [],
                                        "image": "",
                                        "href": "",
                                        "count": 0,
                                    },
                                    "raw": row,
                                    "unresolvedRewardId": reward_identity,
                                }
                            )
                            continue
                        rewards.append(
                            _event_resource(
                                data,
                                documents,
                                resource_types,
                                table,
                                row,
                                linked,
                            )
                        )
                elif _number(row, "_resourceType") or _number(row, "_resourceId"):
                    value = _event_resource(data, documents, resource_types, table, row)
                    rewards.append(value)
            elif table == "MasterEventEffect":
                targets: dict[str, Any] = {}
                member_card_id = _number(row, "_memberCardId")
                support_card_id = _number(row, "_supportCardId")
                band_id = _number(row, "_bandId")
                if member_card_id:
                    targets["memberCard"] = _resource(
                        data, documents, resource_types, 2, member_card_id
                    )
                if support_card_id:
                    targets["supportCard"] = _resource(
                        data, documents, resource_types, 3, support_card_id
                    )
                if band_id:
                    band = documents.get("bands", {}).get(str(band_id))
                    if isinstance(band, dict):
                        targets["band"] = {
                            "name": band.get("bandName", []),
                            "image": band.get("logo") or band.get("icon") or "",
                            "href": f"/catalog/bands?band={band_id}",
                        }
                character_id = _number(row, "_characterId")
                if character_id:
                    character = documents.get("characters", {}).get(str(character_id))
                    if isinstance(character, dict):
                        targets["character"] = {
                            "name": character.get("characterName", []),
                            "image": character.get("faceImage", ""),
                            "href": f"/catalog/characters?character={character_id}",
                        }
                card_type = _number(row, "_cardType")
                colors = ("Red", "Blue", "Green", "Yellow", "Purple")
                if 1 <= card_type <= len(colors):
                    targets["attribute"] = {
                        "name": data.text(f"CardType_{colors[card_type - 1]}_Name"),
                        "image": "",
                        "href": "",
                    }
                tag_id = _number(row, "_tagId")
                if tag_id:
                    tag = next(
                        (
                            tag
                            for tag in data.rows("MasterTag")
                            if _number(tag, "_id") == tag_id
                        ),
                        None,
                    )
                    if tag:
                        targets["tag"] = {
                            "name": data.text(tag.get("_nameTextID")),
                            "image": "",
                            "href": "",
                        }
                value["resourceTypeConstraint"] = _number(
                    row, "_resourceTypeConstraint"
                )
                value["bonusType"] = _number(row, "_eventBonusType")
                value["cardType"] = card_type
                if targets:
                    value["targets"] = targets
                per_rank = []
                for rank in range(1, 6):
                    field = f"_rank{rank}EffectValue"
                    if field in row:
                        basis_points = _number(row, field)
                        per_rank.append(
                            {
                                "rank": rank,
                                "value": basis_points,
                                "percent": basis_points / 100,
                            }
                        )
                if per_rank:
                    value["perRank"] = per_rank
                effects.append(value)
            elif table == "MasterEventMission":
                missions.append(value)
            rows.append(value)
        if rows:
            support[table] = rows
    rankings: list[dict[str, Any]] = []
    ranking_pairs = (
        ("live", "MasterLiveEventPoint", "MasterLiveEventReward"),
        (
            "challenge",
            "MasterChallengeLiveEventPoint",
            "MasterChallengeLiveEventReward",
        ),
    )
    for kind, point_table, reward_table in ranking_pairs:
        point_rows = support.get(point_table, [])
        reward_rows = [row for row in rewards if row.get("sourceTable") == reward_table]
        for point in point_rows:
            point_raw = point.get("raw", {})
            score_rank = _number(point_raw, "_scoreRank")
            group = _number(point_raw, "_group")
            linked = [
                reward
                for reward in reward_rows
                if _number(reward.get("raw", {}), "_scoreRank") == score_rank
            ]
            rankings.append(
                {
                    "kind": kind,
                    "group": group,
                    "scoreRank": score_rank,
                    "pointValue": _number(point_raw, "_value"),
                    "pointSourceId": _number(point_raw, "_id"),
                    "rewards": linked,
                    "raw": point_raw,
                }
            )
    return {
        "support": support,
        "rewards": rewards,
        "effects": effects,
        "missions": missions,
        "rankings": rankings,
        "sourceTables": list(EVENT_SUPPORT_TABLES),
        "groups": {
            "liveEventPoint": live_point_group,
            "liveEventReward": live_reward_group,
            "challengeLiveEventPoint": challenge_point_group,
            "challengeLiveEventReward": challenge_reward_group,
        },
    }


def _event_recruitments(
    data: Any, event_id: int, gacha: dict[str, Any]
) -> list[dict[str, Any]]:
    """Recruitments with pickup prizes explicitly targeted by this event.

    Card identity includes its resource type. Dates never establish a relation.
    Keep the exact prize/lot/effect evidence with the compact linked projection.
    """
    targets: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterEventPickUpCard"):
        if _event_id(row) == event_id:
            targets[
                (_number(row, "_resourceType"), _number(row, "_resourceId"))
            ].append({"table": "MasterEventPickUpCard", "id": _number(row, "_id")})
    for row in data.rows("MasterEventEffect"):
        if _event_id(row) != event_id:
            continue
        for resource_type, field in ((2, "_memberCardId"), (3, "_supportCardId")):
            card_id = _number(row, field)
            if card_id:
                targets[(resource_type, card_id)].append(
                    {"table": "MasterEventEffect", "id": _number(row, "_id")}
                )
    prizes: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterGachaPrize"):
        if _number(row, "_pickUpType") == 2:
            prizes[_number(row, "_groupId")].append(row)
    lots: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterGachaLot"):
        lots[_number(row, "_lotGroupId")].append(row)
    related = []
    for row in data.rows("MasterGacha"):
        identity = str(_number(row, "_id"))
        projection = gacha.get("entries", {}).get(identity)
        if not projection:
            continue
        evidence = []
        for lot in lots[_number(row, "_lotGroupId")]:
            for prize in prizes[_number(lot, "_prizeGroupId")]:
                key = (_number(prize, "_resourceType"), _number(prize, "_resourceId"))
                if key in targets:
                    evidence.append(
                        {
                            "resourceType": key[0],
                            "resourceId": key[1],
                            "eventSources": targets[key],
                            "lotId": _number(lot, "_id"),
                            "prizeId": _number(prize, "_id"),
                        }
                    )
        if evidence:
            related.append(
                {
                    **{
                        key: projection[key]
                        for key in (
                            "id",
                            "title",
                            "image",
                            "startAt",
                            "endAt",
                            "featured",
                        )
                    },
                    "href": f"/catalog/gacha?entry={identity}",
                    "relation": "event-bonus-pickup",
                    "evidence": evidence,
                }
            )
    return related


def _events(
    data: Any,
    documents: dict[str, Any],
    resource_types: dict[int, str],
    stamp: Callable[[Any], list[int | None]],
) -> dict[str, Any]:
    entries: dict[str, Any] = {}
    gacha = documents.get("gacha") or _gacha(data, documents, resource_types, stamp)
    for row in data.rows("MasterEvent"):
        identity = _number(row, "_id")
        if not identity:
            continue
        story_chapter_id = _number(row, "_storyChapterId")
        support = _event_support(data, documents, resource_types, row)
        event_item_id = _number(row, "_eventItemId")
        music_id = _number(row, "_musicId")
        pickup_cards = []
        for pickup in data.rows("MasterEventPickUpCard"):
            if _event_id(pickup) != identity:
                continue
            pickup_value = _event_resource(
                data,
                documents,
                resource_types,
                "MasterEventPickUpCard",
                pickup,
            )
            pickup_value["card"] = pickup_value.pop("reward")
            pickup_cards.append(pickup_value)
        entries[str(identity)] = _entry(
            str(identity),
            data.text(row.get("_nameTextId")),
            kind="game-event",
            image=_event_cover_image(data, documents, row, story_chapter_id),
            backgroundImage=_asset(data, f"Image/Event/{row.get('_backgroundAsset')}"),
            logo=_asset(data, f"Image/Event/{row.get('_logoAsset')}"),
            description=data.text(row.get("_descriptionTextId")),
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            displayEndAt=stamp(row.get("_displayEndAt")),
            storyChapterId=story_chapter_id,
            story=_event_story(data, documents, resource_types, story_chapter_id),
            eventType=_number(row, "_eventType"),
            musicId=music_id,
            song=(
                _resource(data, documents, resource_types, 8, music_id)
                if music_id
                else None
            ),
            eventItem=(
                _resource(data, documents, resource_types, 1, event_item_id)
                if event_item_id
                else None
            ),
            rankingDisabled=bool(row.get("_isRankingDisabled")),
            musicRankingDisabled=bool(row.get("_isMusicRankingDisabled")),
            totalMusicRankingDisabled=bool(row.get("_isTotalMusicRankingDisabled")),
            rewardGroups=support["groups"],
            pickupCards=pickup_cards,
            recruitments=_event_recruitments(data, identity, gacha),
            rewards=support["rewards"],
            effects=support["effects"],
            bonusNote=data.text("ui_event_bonus_item_num_truncate_message"),
            missions=support["missions"],
            rankings=support["rankings"],
            support=support["support"],
            sourceTables=[
                "MasterEvent",
                "MasterEventPickUpCard",
                "MasterGacha",
                "MasterGachaLot",
                "MasterGachaPrize",
                "MasterStoryEpisode",
                "MasterStoryReward",
                *support["sourceTables"],
            ],
        )
    return {"entries": entries, "hasGameEvents": bool(data.rows("MasterEvent"))}


def _real_lives(
    data: Any, documents: dict[str, Any], stamp: Callable[[Any], list[int | None]]
) -> dict[str, Any]:
    entries: dict[str, Any] = {}
    for row in data.rows("MasterRealLiveSchedule"):
        identity = _number(row, "_id")
        if not identity:
            continue
        bands = [
            documents["bands"].get(str(value)) for value in row.get("_bandIds", [])
        ]
        bands = [band for band in bands if isinstance(band, dict)]
        if not bands:
            continue
        title = [
            " / ".join(
                str((band.get("bandName") or [""] * 5)[index] or "") for band in bands
            )
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
            bands=[
                {
                    "name": band.get("bandName"),
                    "icon": band.get("icon"),
                    "logo": band.get("logo"),
                }
                for band in bands
            ],
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
    regular = [row for row in prize_rows if _number(row, "_pickUpType") != 2 or _number(row, "_pickUpFixedRate") == 0]
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
        lot_rows = sorted(
            lots[_number(row, "_lotGroupId")],
            key=lambda value: -_number(value, "_weight"),
        )
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
                    data,
                    documents,
                    resource_types,
                    _number(prize, "_resourceType"),
                    _number(prize, "_resourceId"),
                    _number(prize, "_amount") or 1,
                )
                reward["pickup"] = value["pickup"]
                reward["rate"] = value["weight"] / total_weight
                group_prizes.append(reward)
            rates.append(
                {
                    "rarity": _number(lot, "_rarityConstraint"),
                    "resourceType": resource_types.get(
                        _number(lot, "_resourceTypeConstraint"), ""
                    ),
                    "weight": _number(lot, "_weight"),
                    "rate": group_rate,
                    "prizes": group_prizes,
                }
            )
            rewards.extend(group_prizes)
            featured.extend(
                reward
                for value, reward in zip(shares, group_prizes, strict=True)
                if value["pickup"]
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
            draw_options.append(
                {
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
                    "monthlyPassIds": [
                        int(value) for value in product.get("_monthlyPassIds", [])
                    ],
                }
            )
        ticket = currency_by_type.get(_number(row, "_gachaTicketItemId"))
        if 2 in currencies or ticket:
            category = "ticket"
        elif 15 in currencies:
            category = "ad"
        elif 24 in currencies:
            category = "bonus"
        elif currencies & {12, 13}:
            category = "stars"
        elif 23 in currencies or any(
            option["monthlyPassIds"] for option in draw_options
        ):
            category = "pass"
        else:
            category = "other"
        entries[str(identity)] = _entry(
            str(identity),
            data.text(row.get("_nameTextId")),
            kind="gacha",
            image=_asset(data, row.get("_bannerAssetName"))
            or _asset(data, row.get("_logoAssetName")),
            logo=_asset(data, row.get("_logoAssetName")),
            description=data.text(row.get("_descriptionTextId")),
            appeal=data.text(row.get("_appealTextId")),
            warning=data.text(row.get("_warningTextId"))
            if row.get("_warningTextId")
            else [],
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
            }
            if ticket
            else None,
            pickUpSelectCount=_number(row, "_pickUpSelectCount"),
            beginnerHours=_number(row, "_beginnerHours"),
            comebackHours=_number(row, "_comebackHours"),
            isNewMember=bool(row.get("_isNewMember")),
            ceilings=[int(value) for value in row.get("_ceilingIds", [])],
            bonuses=[
                int(value)
                for key in (
                    "_gachaBonusIds1",
                    "_gachaBonusIds2",
                    "_gachaBonusIds3",
                    "_gachaBonusIds4",
                )
                for value in row.get(key, [])
            ],
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
            data,
            documents,
            resource_types,
            _number(row, "_resourceType"),
            _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        )
        slots[_number(row, "_loginBonusID")].append(
            {
                "sheet": _number(row, "_sheetNo"),
                "day": _number(row, "_slotNo"),
                "reward": reward,
                "image": _asset(data, row.get("_thumbnailAsset")) or reward["image"],
            }
        )
    entries = {}
    for row in data.rows("MasterLoginBonus"):
        identity = _number(row, "_id")
        if not identity:
            continue
        entries[str(identity)] = _entry(
            str(identity),
            data.text(row.get("_nameTextID")),
            kind="login",
            image=_asset(data, row.get("_sheetImageAsset"))
            or _asset(data, row.get("_backgroundImageAsset")),
            start_at=stamp(row.get("_startAt")),
            end_at=stamp(row.get("_endAt")),
            rewards=sorted(
                slots[identity], key=lambda slot: (slot["sheet"], slot["day"])
            ),
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
            data,
            documents,
            resource_types,
            _number(row, "_resourceType"),
            _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        )
        grants[_number(row, "_shopId")].append(
            {**reward, "bonus": bool(row.get("_isBonus"))}
        )
    currencies = {
        int(item.get("itemType") or 0): item
        for item in documents["items"]["items"].values()
        if isinstance(item, dict)
    }
    # Cash packs live in their own table (per-region prices, no window) and
    # join onto the shop lineup by id: the lineup row owns the name and the
    # _thumbnailAsset the client formats into Shop/ItemThumbnail/{0}. Shipped
    # master snapshots can predate the current lineup, so ids without a
    # MasterShop row are synthesized from the BiliPay row plus its grants,
    # and their thumbnail follows the lineup's own art numbering:
    #   1-7   gem packs, one slot per price tier (120/360/.../8000)
    #   8-10  reserved for tiers the shipped lineup doesn't sell
    #   11-15 first-purchase/SSR-guarantee packs, in id order
    bili_pay = {row.get("_id"): row for row in data.rows("MasterShopBiliPay")}
    # The lineup classification reads the raw product columns; the grants
    # above are already projected into reward shapes for rendering.
    products_by_shop: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterShopProduct"):
        products_by_shop[_number(row, "_shopId")].append(row)

    def _is_subscription(identity: int) -> bool:
        return any(
            _number(row, "_resourceType") == 6
            for row in products_by_shop.get(identity, [])
        )

    def _is_plain_gem_pack(products: list[dict[str, Any]]) -> bool:
        # Paid/free stars only — bundles that toss in passes, stamps or
        # tickets are their own thing and stay out of the ladder.
        return all(
            _number(row, "_resourceType") == 1 and _number(row, "_resourceId") in (1, 2)
            for row in products
        )

    ticket_ids = {
        identity
        for identity in bili_pay
        if any(
            _number(row, "_resourceType") == 1
            and _number(row, "_resourceId") >= 2000004
            for row in products_by_shop.get(identity, [])
        )
    }
    # The gem ladder is read off the lineup itself: packs whose grants are
    # paid/free stars only, one pack per tier.
    gem_tiers = sorted(
        {
            _number(row, "_resourceCount")
            for identity, products in products_by_shop.items()
            if identity in bili_pay
            and identity not in ticket_ids
            and not _is_subscription(identity)
            and _is_plain_gem_pack(products)
            for row in products
            if _number(row, "_resourceType") == 1
            and _number(row, "_resourceId") == 2
            and not row.get("_isBonus")
        }
    )

    def _store_thumbnail(identity: int) -> str | None:
        if identity in ticket_ids:
            order = sorted(ticket_ids)
            return f"shop_thumb_{11 + order.index(identity):05d}"
        if _is_subscription(identity):
            return None
        products = products_by_shop.get(identity, [])
        if not _is_plain_gem_pack(products):
            return None
        gems = [
            row
            for row in products
            if _number(row, "_resourceType") == 1
            and _number(row, "_resourceId") == 2
            and not row.get("_isBonus")
        ]
        if len(gems) == 1 and gem_tiers:
            tier = _number(gems[0], "_resourceCount")
            if tier in gem_tiers:
                return f"shop_thumb_{gem_tiers.index(tier) + 1:05d}"
        return None

    def _regional_prices(row: dict[str, Any]) -> dict[str, float]:
        # Every column is minor units (cents); the US dollar price is the
        # headline, the rest ride along for the detail pane.
        return {
            "usd": _number(row, "_usd") / 100,
            "twd": _number(row, "_twd") / 100,
            "hkd": _number(row, "_hkd") / 100,
            "krw": _number(row, "_krw") / 100,
        }

    entries = {}
    for row in data.rows("MasterShop"):
        identity = _number(row, "_id")
        if not identity:
            continue
        currency = currencies.get(_number(row, "_paymentType"))
        rewards = grants[identity]
        name = data.text(row.get("_nameTextId"))
        description = data.text(row.get("_descriptionTextId"))
        regional = bili_pay.get(identity)
        payment = {
            "price": _number(row, "_price"),
            "currency": currency.get("name") if currency else [],
            "currencyImage": currency.get("image") if currency else "",
            "advertisement": _number(row, "_paymentType") == 15
            and not _number(row, "_price"),
            "storePurchase": bool(
                row.get("_googlePlayPurchaseId") or row.get("_appStorePurchaseId")
            ),
        }
        if regional is not None:
            payment.update(
                {
                    "price": _number(regional, "_usd") / 100,
                    "currency": ["US$", "US$", "US$", "US$", "US$"],
                    "currencyImage": "",
                    "prices": _regional_prices(regional),
                    "storePurchase": True,
                }
            )
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
            payment=payment,
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
                if _number(row, "_displayType") == 4
                and _number(row, "_contentId") == identity
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
                if reward.get("image")
                and not str((reward.get("name") or [""])[0]).startswith("スター")
            ),
            None,
        )
        lineup_thumb = _store_thumbnail(identity)
        entries[str(identity)] = _entry(
            str(identity),
            name if any(name) else description,
            kind="shop",
            image=(lineup_thumb and _asset(data, f"Shop/ItemThumbnail/{lineup_thumb}"))
            or _asset(data, f"Shop/ItemThumbnail/shop_thumb_bili_{identity}")
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
            data,
            documents,
            resource_types,
            _number(row, "_resourceType"),
            _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        )
        products[_number(row, "_exchangeId")].append(
            {
                "reward": reward,
                "cost": _number(row, "_paymentResourceCount"),
                "limit": _number(row, "_limitCount"),
                "recommended": bool(row.get("_isRecommended")),
                "startAt": stamp(row.get("_startAt")),
                "endAt": stamp(row.get("_endAt")),
            }
        )
    entries = {}
    for row in data.rows("MasterExchange"):
        identity = _number(row, "_id")
        if not identity:
            continue
        category = categories.get(_number(row, "_exchangeCategoryId"))
        currency = _resource(
            data,
            documents,
            resource_types,
            _number(row, "_paymentResourceType"),
            _number(row, "_paymentResourceId"),
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
        rewards[rank].append(
            _resource(
                data,
                documents,
                resource_types,
                _number(row, "_resourceType"),
                _number(row, "_resourceId"),
                _number(row, "_resourceCount"),
            )
        )
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


def _mission_description(
    data: Any, row: dict[str, Any], documents: dict[str, Any]
) -> list[str]:
    text = data.text(row.get("_descriptionTextId"))
    bands = documents["bands"]
    characters = documents["characters"]
    songs = documents["songs"]
    chapters = documents["stories"].get("chapters", {})
    exchange = documents.get("exchange", {}).get("entries", {})
    chapter = chapters.get(str(_number(row, "_storyChapterId")))
    episode_row = next(
        (
            item
            for item in data.rows("MasterStoryEpisode")
            if _number(item, "_id") == _number(row, "_episodeId")
        ),
        None,
    )
    episode = next(
        (
            item
            for item in documents["stories"].get("episodes", {}).values()
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
        "CardType": data.text(f"CardType_{color_keys[card_type - 1]}_Name")
        if 1 <= card_type <= len(color_keys)
        else [],
        "MusicDifficulty": data.text(f"ui_difficulty_{difficulty_keys[difficulty]}")
        if 0 <= difficulty < len(difficulty_keys)
        else [],
        "MissionCategory": "",
    }
    rendered = []
    for index, raw in enumerate(text):
        line = str(raw or "")
        for key, value in values.items():
            replacement = (
                str(value[index] or "")
                if isinstance(value, list) and index < len(value)
                else str(value or "")
            )
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
            data,
            documents,
            resource_types,
            _number(row, "_resourceType"),
            _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        )
        for row in data.rows("MasterMissionReward")
    }
    groups = {
        _number(row, "_id"): row for row in data.rows("MasterLimitedMissionGroup")
    }
    entries = {}
    for table, kind in (
        ("MasterMission", "regular-mission"),
        ("MasterLimitedMission", "limited-mission"),
    ):
        for row in data.rows(table):
            identity = _number(row, "_id")
            if not identity:
                continue
            group = groups.get(_number(row, "_limitedMissionGroupId"))
            prizes = [
                rewards[int(value)]
                for value in row.get("_missionRewardIds", [])
                if int(value) in rewards
            ]
            title = _mission_description(data, row, documents)
            entries[f"{kind}-{identity}"] = _entry(
                f"{kind}-{identity}",
                title,
                kind=kind,
                image=_asset(data, group.get("_bannerAsset"))
                if group
                else (prizes[0]["image"] if prizes else ""),
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
            data,
            documents,
            resource_types,
            _number(row, "_resourceType"),
            _number(row, "_resourceId"),
            _number(row, "_resourceCount"),
        )
        for row in data.rows("MasterSeasonPassReward")
    }
    levels: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterSeasonPassLevelReward"):
        prizes = [
            season_rewards[int(value)]
            for value in row.get("_rewardIds", [])
            if int(value) in season_rewards
        ]
        levels[_number(row, "_seasonPassId")].append(
            {
                "level": _number(row, "_level"),
                "premium": bool(row.get("_isPremium")),
                "rewards": prizes,
            }
        )
    season_tasks: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterSeasonPassMission"):
        season_tasks[_number(row, "_seasonPassId")].append(
            {
                "title": _mission_description(data, row, documents),
                "points": _number(row, "_seasonPassPoint"),
            }
        )
    monthly_rewards: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in data.rows("MasterMonthlyPassDailyReward"):
        monthly_rewards[_number(row, "_monthlyPassId")].append(
            {
                "day": _number(row, "_dayCount"),
                "reward": _resource(
                    data,
                    documents,
                    resource_types,
                    _number(row, "_resourceType"),
                    _number(row, "_resourceId"),
                    _number(row, "_resourceCount"),
                ),
            }
        )
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
            levels=sorted(
                levels[identity], key=lambda value: (value["level"], value["premium"])
            ),
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


def _home_banners(
    data: Any, stamp: Callable[[Any], list[int | None]]
) -> dict[str, Any]:
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
    gacha = _gacha(data, documents, resource_types, stamp)
    base = {
        "events": _events(data, {**documents, "gacha": gacha}, resource_types, stamp),
        "real-lives": _real_lives(data, documents, stamp),
        "home-banners": _home_banners(data, stamp),
        "gacha": gacha,
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
