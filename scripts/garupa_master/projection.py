from __future__ import annotations

import json
import re
from hashlib import sha256
from pathlib import Path
from typing import Any

from .archive import DecodedSuite, atomic_write_json
from .client import GarupaResponses


PROJECTION_FORMAT = "haneoka-garupa-master-projection-v1"
PLAYLIST_FORMAT = "haneoka-garupa-playlists-v1"
REQUIRED_TABLES = {
    1: "masterMusicList",
    16: "masterBandMap",
    1190: "masterStageChallengeList",
    1191: "masterStageChallengeStageNoMap",
}


class ProjectionError(ValueError):
    """Raised when verified playlist projections cannot be built."""


def _table(decoded: DecodedSuite, number: int) -> dict[str, Any]:
    duplicate_fields = decoded.coverage.get("duplicateTopLevelFields", [])
    if not isinstance(duplicate_fields, list):
        raise ProjectionError("duplicateTopLevelFields coverage is not a list")
    if any(str(value) == str(number) for value in duplicate_fields):
        expected = REQUIRED_TABLES.get(number, f"field {number}")
        raise ProjectionError(
            f"required Master table {expected} ({number}) occurred more than once"
        )
    table = decoded.tables.get(number)
    value = table.get("decoded") if isinstance(table, dict) else None
    if not isinstance(value, dict):
        expected = REQUIRED_TABLES.get(number, f"field {number}")
        raise ProjectionError(f"required Master table {expected} ({number}) was not decoded")
    return value


def _integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _required_entries(container: dict[str, Any], label: str) -> list[dict[str, Any]]:
    value = container.get("entries")
    if not isinstance(value, list):
        raise ProjectionError(f"{label}.entries is not a list")
    if any(not isinstance(entry, dict) for entry in value):
        raise ProjectionError(f"{label}.entries contains a non-object value")
    return value


def _positive_integer(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise ProjectionError(f"{label} is not a positive integer")
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ProjectionError(f"{label} is not a positive integer") from exc
    if result <= 0 or (isinstance(value, str) and str(result) != value):
        raise ProjectionError(f"{label} is not a positive integer")
    return result


def _validated_map(value: Any, label: str) -> dict[int, dict[str, Any]]:
    if not isinstance(value, list):
        raise ProjectionError(f"{label} is not a dictionary-entry list")
    result: dict[int, dict[str, Any]] = {}
    for index, entry in enumerate(value):
        if not isinstance(entry, dict) or "key" not in entry:
            raise ProjectionError(f"{label}[{index}] is not a dictionary entry")
        key = _positive_integer(entry["key"], f"{label}[{index}].key")
        mapped = entry.get("value")
        if not isinstance(mapped, dict):
            raise ProjectionError(f"{label}[{index}].value is not an object")
        if key in result:
            raise ProjectionError(f"{label} contains duplicate key {key}")
        result[key] = mapped
    return result


def _stage_title(challenge: dict[str, Any]) -> str:
    identifier = _integer(challenge.get("id"))
    description = _text(challenge.get("description"))
    if description:
        cleaned = re.sub(r"<[^>]+>", "", description)
        first_line = next((line.strip() for line in cleaned.splitlines() if line.strip()), "")
        if first_line and len(first_line) <= 160:
            return first_line
    asset_name = _text(challenge.get("assetBundleName"))
    if asset_name:
        words = re.sub(r"^(stage[_-]?challenge[_-]?)", "", asset_name, flags=re.IGNORECASE)
        words = re.sub(r"[_-]+", " ", words).strip()
        if words and not words.isdigit():
            return words
    return f"Stage Challenge {identifier}"


def build_projections(
    projection_dir: Path,
    responses: GarupaResponses,
    decoded: DecodedSuite,
    schema: dict[str, Any],
) -> dict[str, Any]:
    music_table = _table(decoded, 1)
    band_table = _table(decoded, 16)
    challenge_table = _table(decoded, 1190)
    stage_map_table = _table(decoded, 1191)

    raw_songs = _required_entries(music_table, "masterMusicList")
    songs: list[dict[str, Any]] = []
    song_ids: set[int] = set()
    for index, source in enumerate(raw_songs):
        music_id = _positive_integer(
            source.get("musicId"),
            f"masterMusicList.entries[{index}].musicId",
        )
        if music_id in song_ids:
            raise ProjectionError(f"masterMusicList contains duplicate musicId {music_id}")
        song_ids.add(music_id)
        band_id = _positive_integer(
            source.get("bandId"),
            f"masterMusicList.entries[{index}].bandId",
        )
        songs.append(
            {
                "musicId": music_id,
                "title": _text(source.get("musicTitle")) or f"Music #{music_id}",
                "language": "ja",
                "bandId": band_id,
                "jacketImage": _text(source.get("jacketImage")) or None,
                "seq": _integer(source.get("seq")),
                "publishedAt": _integer(source.get("publishedAt")) or None,
                "closedAt": _integer(source.get("closedAt")) or None,
                "musicDataType": _text(source.get("musicDataType")) or None,
                "assetRef": {
                    "provider": "bestdori",
                    "server": "jp",
                    "kind": "song",
                    "musicId": music_id,
                },
            }
        )
    songs.sort(key=lambda item: (item["seq"], item["musicId"]))
    songs_by_id = {item["musicId"]: item for item in songs}

    raw_bands = _validated_map(band_table.get("entries"), "masterBandMap.entries")
    bands: list[dict[str, Any]] = []
    for key, source in raw_bands.items():
        band_id = _positive_integer(source.get("bandId"), f"masterBandMap[{key}].bandId")
        if band_id != key:
            raise ProjectionError(
                f"masterBandMap key {key} does not match its bandId {band_id}"
            )
        bands.append(
            {
                "bandId": band_id,
                "name": _text(source.get("bandName")) or f"Band #{band_id}",
                "language": "ja",
                "color": _text(source.get("color")) or None,
                "seq": _integer(source.get("seq")),
                "bandType": _text(source.get("bandType")) or None,
                "phonetic": _text(source.get("phonetic")) or None,
            }
        )
    bands.sort(key=lambda item: (item["seq"], item["bandId"]))
    bands_by_id = {item["bandId"]: item for item in bands}
    missing_song_band_ids = sorted(
        {
            int(song["bandId"])
            for song in songs
            if song["bandId"] not in bands_by_id
        }
    )
    if missing_song_band_ids:
        raise ProjectionError(
            "masterMusicList references unknown band ids: "
            + ", ".join(str(value) for value in missing_song_band_ids)
        )
    primary_band_ids = {
        band["bandId"]
        for band in bands
        if band.get("bandType") == "normal" or band.get("name") == "Ave Mujica"
    }
    for band in bands:
        band["isPrimaryBand"] = band["bandId"] in primary_band_ids

    def playlist_track(position: int, music_id: int) -> dict[str, Any]:
        song = songs_by_id.get(music_id)
        if song is None:
            return {
                "position": position,
                "musicId": music_id,
                "title": f"Music #{music_id}",
                "language": "ja",
                "available": False,
                "missingReason": "music-not-in-master",
            }
        band_id = song.get("bandId")
        band = bands_by_id.get(band_id) if isinstance(band_id, int) else None
        return {
            "position": position,
            "musicId": music_id,
            "title": song["title"],
            "language": "ja",
            "bandId": band_id,
            "bandName": band.get("name") if band else None,
            "jacketImage": song.get("jacketImage"),
            "available": True,
            "assetRef": song["assetRef"],
        }

    playlists: list[dict[str, Any]] = []
    for band in bands:
        if band["bandId"] not in primary_band_ids:
            continue
        band_songs = [song for song in songs if song.get("bandId") == band["bandId"]]
        tracks = [playlist_track(index, song["musicId"]) for index, song in enumerate(band_songs, 1)]
        playlists.append(
            {
                "id": f"catalog:jp:band:{band['bandId']}",
                "kind": "system",
                "source": "band",
                "sourceId": band["bandId"],
                "title": band["name"],
                "language": "ja",
                "description": None,
                "bandId": band["bandId"],
                "color": band.get("color"),
                "tracks": tracks,
            }
        )

    stage_map = _validated_map(
        stage_map_table.get("entries"),
        "masterStageChallengeStageNoMap.entries",
    )
    challenges = _required_entries(challenge_table, "masterStageChallengeList")
    challenge_ids: set[int] = set()
    for index, challenge in enumerate(challenges):
        challenge_id = _positive_integer(
            challenge.get("id"),
            f"masterStageChallengeList.entries[{index}].id",
        )
        if challenge_id in challenge_ids:
            raise ProjectionError(
                f"masterStageChallengeList contains duplicate id {challenge_id}"
            )
        challenge_ids.add(challenge_id)
    extra_stage_maps = sorted(set(stage_map) - challenge_ids)
    if extra_stage_maps:
        raise ProjectionError(
            "masterStageChallengeStageNoMap contains unknown challenge ids: "
            + ", ".join(str(value) for value in extra_stage_maps)
        )
    missing_stage_maps = sorted(challenge_ids - set(stage_map))
    if missing_stage_maps:
        raise ProjectionError(
            "masterStageChallengeStageNoMap is missing challenge ids: "
            + ", ".join(str(value) for value in missing_stage_maps)
        )
    challenges.sort(key=lambda item: _positive_integer(item.get("id"), "stage challenge id"))
    stage_playlists: list[dict[str, Any]] = []
    for challenge in challenges:
        challenge_id = _positive_integer(challenge.get("id"), "stage challenge id")
        stage_list = stage_map[challenge_id]
        stages = _required_entries(
            stage_list,
            f"masterStageChallengeStageNoMap[{challenge_id}]",
        )
        if not stages:
            raise ProjectionError(f"stage challenge {challenge_id} has no stages")
        stage_numbers: set[int] = set()
        normalized_stages: list[tuple[int, int, dict[str, Any]]] = []
        for index, stage in enumerate(stages):
            stage_number = _positive_integer(
                stage.get("stageChallengeStageNo"),
                f"stage challenge {challenge_id} entry {index} stage number",
            )
            music_id = _positive_integer(
                stage.get("musicId"),
                f"stage challenge {challenge_id} entry {index} musicId",
            )
            if stage_number in stage_numbers:
                raise ProjectionError(
                    f"stage challenge {challenge_id} contains duplicate stage {stage_number}"
                )
            stage_numbers.add(stage_number)
            normalized_stages.append((stage_number, music_id, stage))
        expected_stage_numbers = set(range(1, len(stages) + 1))
        if stage_numbers != expected_stage_numbers:
            raise ProjectionError(
                f"stage challenge {challenge_id} stage numbers are not contiguous from 1"
            )
        normalized_stages.sort(key=lambda item: item[0])
        tracks = [
            playlist_track(stage_number, music_id)
            for stage_number, music_id, _ in normalized_stages
        ]
        playlist = {
            "id": f"catalog:jp:stage-challenge:{challenge_id}",
            "kind": "game",
            "source": "stage-challenge",
            "sourceId": challenge_id,
            "title": _stage_title(challenge),
            "language": "ja",
            "description": _text(challenge.get("description")) or None,
            "bandId": _integer(challenge.get("bandId")) or None,
            "stageChallengeType": _text(challenge.get("stageChallengeType")) or None,
            "assetBundleName": _text(challenge.get("assetBundleName")) or None,
            "startsAt": _integer(challenge.get("startAt")) or None,
            "endsAt": _integer(challenge.get("endAt")) or None,
            "tracks": tracks,
        }
        stage_playlists.append(playlist)
    playlists.extend(stage_playlists)

    projection_bytes = json.dumps(
        {"bands": bands, "songs": songs, "playlists": playlists},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    projection_sha256 = sha256(projection_bytes).hexdigest()
    unknown_top = decoded.coverage.get("unknownTopLevelFields", [])
    manifest = {
        "format": PROJECTION_FORMAT,
        "server": "jp",
        "packageName": schema.get("packageName"),
        "archiveComplete": decoded.coverage.get("archiveComplete") is True,
        "schemaComplete": decoded.coverage.get("schemaComplete") is True,
        "semanticMasterStatus": decoded.coverage.get("semanticStatus"),
        "unknownTopLevelFields": unknown_top,
        "projectionSha256": projection_sha256,
        "counts": {
            "bands": len(bands),
            "songs": len(songs),
            "bandPlaylists": len(playlists) - len(stage_playlists),
            "stageChallengePlaylists": len(stage_playlists),
            "playlists": len(playlists),
            "playlistTracks": sum(len(playlist["tracks"]) for playlist in playlists),
            "unavailablePlaylistTracks": sum(
                1
                for playlist in playlists
                for track in playlist["tracks"]
                if not track.get("available")
            ),
        },
        "assetPolicy": "bestdori-on-demand-only",
    }
    common = {
        "server": "jp",
        "projectionSha256": projection_sha256,
    }
    atomic_write_json(projection_dir / "manifest.json", manifest)
    atomic_write_json(
        projection_dir / "bands.json",
        {"format": PROJECTION_FORMAT, **common, "bands": bands},
    )
    atomic_write_json(
        projection_dir / "songs.json",
        {"format": PROJECTION_FORMAT, **common, "songs": songs},
    )
    atomic_write_json(
        projection_dir / "stage-challenges.json",
        {
            "format": PROJECTION_FORMAT,
            **common,
            "stageChallenges": stage_playlists,
        },
    )
    atomic_write_json(
        projection_dir / "playlists.json",
        {
            "format": PLAYLIST_FORMAT,
            **common,
            "playlists": playlists,
        },
    )
    return manifest
