"""Identify birthday stories through the game's login-landing resource binding."""

from __future__ import annotations

from typing import Any, Callable


def enrich_story_birthdays(
    data: Any,
    chapters: dict[str, dict[str, Any]],
    episodes: dict[str, dict[str, Any]],
    timestamp: Callable[[Any], list[int | None]],
) -> dict[str, list[dict[str, Any]]]:
    native_chapters = {row["_id"]: row for row in data.rows("MasterStoryChapter")}
    native_episodes = {row["_id"]: row for row in data.rows("MasterStoryEpisode")}
    characters = {row["_id"]: row for row in data.rows("MasterCharacter")}
    adv_stories = {
        row["_id"]: str(row.get("_advEpisodeAsset", "")).removeprefix("adv_script_")
        for row in data.rows("MasterAdv")
    }
    index: dict[str, list[dict[str, Any]]] = {}
    for landing in data.rows("MasterStoryLoginLanding"):
        address = str(landing.get("_contentPrefabAddress") or "")
        # Birthday is an authored prefab address family, independent of titles,
        # chapter IDs and the date on which the catalog is compiled.
        if not address.startswith("Birthday/") or not address.removeprefix("Birthday/"):
            continue
        chapter_id = landing.get("_storyChapterId")
        chapter = native_chapters.get(chapter_id)
        native_episode = native_episodes.get(landing.get("_storyEpisodeId"))
        character_id = landing.get("_characterId")
        character = characters.get(character_id)
        if (
            not chapter
            or not native_episode
            or native_episode.get("_chapterId") != chapter_id
            or not character
        ):
            continue
        story_id = adv_stories.get(native_episode.get("_advId"))
        episode = episodes.get(story_id or "")
        if not episode or episode.get("chapterId") != chapter_id:
            continue
        if native_episode.get("_startAt"):
            episode["publishedAt"] = timestamp(native_episode["_startAt"])
        birthday = {
            "characterId": character_id,
            "month": character.get("_birthdayMonth"),
            "day": character.get("_birthdayDay"),
            "loginLandingId": landing["_id"],
            "startAt": timestamp(landing.get("_startAt")),
            "endAt": timestamp(landing.get("_endAt")),
            "contentPrefabAddress": address,
            "sourceTables": [
                "MasterStoryLoginLanding", "MasterStoryChapter",
                "MasterStoryEpisode", "MasterAdv", "MasterCharacter",
            ],
        }
        episode["storyCategory"] = "birthday"
        episode["birthday"] = birthday
        episode["characterIds"] = [character_id]
        index.setdefault(str(character_id), []).append({
            "storyId": story_id,
            "storyKey": story_id,
            "chapterId": chapter_id,
            "storyEpisodeId": native_episode["_id"],
            "characterId": character_id,
            "sourceServer": data.server,
            "publishedAt": episode.get("publishedAt"),
            "birthday": birthday,
        })
    for chapter in chapters.values():
        chapter_episodes = [episodes[key] for key in chapter.get("episodes", []) if key in episodes]
        if chapter_episodes and all(row.get("storyCategory") == "birthday" for row in chapter_episodes):
            chapter["storyCategory"] = "birthday"
    for rows in index.values():
        rows.sort(key=lambda row: (row.get("publishedAt") or [0])[0] or 0, reverse=True)
    return index
