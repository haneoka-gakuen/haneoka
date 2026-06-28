"""Build the canonical catalog documents from Master data and real Unity paths.

This module deliberately has no knowledge of processor directory names. Media
references are emitted only when the corresponding ``Assets/`` or ``Packages/``
file exists in the normalized build.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from core.config import ServerConfig
from core.contracts import (
    CATALOG_PROVENANCE_SCHEMA,
    CATALOG_RESOURCES,
    STORY_ASSETS_SCHEMA,
)
from core.hashes import sha256_file
from core.manifests import read_json, write_json
from core.paths import build_layout
from core.unity_objects import iter_unity_object_archive
from build.unity_effect import serialize_unity_effect


LOCALE_FIELDS = (
    "_japanese",
    "_english",
    "_traditionalChinese",
    "_simplifiedChinese",
    "_korean",
)
JST = timezone(timedelta(hours=9))
DIFFICULTIES = ("easy", "normal", "hard", "expert", "special")
META_REFERENCE_DOWNTIME_SECONDS = 30.0
META_REFERENCE_SKILL_SECONDS = 7.0
FIX_UI_SPRITE_ATLAS_SOURCE = (
    "Assets/AddressableResources/UI/Atlas/FixUiSpriteAtlas.spriteatlasv2"
)
DEFAULT_TALK_WINDOW_SOURCE = (
    "Assets/AddressableResources/UI/Prefab/Parts/Adv/Talk/UIDefaultTalkWindow.prefab"
)
HOME_SPOT_BACKGROUND_SCHEMA = "haneoka-home-spot-background-build-v1"
HOME_SPOT_BACKGROUND_OUTPUT_TYPE = "SpotBackgroundSceneGLB"
HOME_SPOT_BACKGROUND_COORDINATE_SPACE = "background-root-local"
HOME_SPOT_BACKGROUND_PREVIEW_OUTPUT_TYPE = "SpotBackgroundPreviewPNG"
HOME_SPOT_BACKGROUND_PREVIEW_COORDINATE_SPACE = "camera-render"
HOME_SPOT_BACKGROUND_PREVIEW_WIDTH = 960
HOME_SPOT_BACKGROUND_PREVIEW_HEIGHT = 540
ADV_POST_EFFECT_ROOT = "Assets/AddressableResources/Adv/PostEffect"
ADV_FRAME_ROOT = "Assets/AddressableResources/Adv/Frame"
ADV_STILL_ROOT = "Assets/AddressableResources/Adv/Still"
ADV_EFFECT_ROOT = "Assets/AddressableResources/Adv/Effect"
ADV_STAGE_ROOT = "Assets/AddressableResources/Adv/Stage"
ADV_STAGE_POST_EFFECT_ROOT = f"{ADV_STAGE_ROOT}/_settings/posteffect"
CRI_AUDIO_SUFFIXES = (".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav")
CRI_SOUND_CATEGORIES = {0: "Bgm", 1: "Se", 2: "Voice"}
VGMSTREAM_SEQUENCE_PREFIX = re.compile(r"^\d+_")
VGMSTREAM_RANDOM_CUE_PREFIX = re.compile(r"^IntroRandom_\s*", re.IGNORECASE)
COMMAND_NAMES = {
    0: "characterIn", 1: "characterOut", 2: "talk", 3: "delay", 4: "shake",
    5: "fadeOut", 6: "fadeIn", 7: "focus", 9: "forward", 10: "back",
    11: "flash", 12: "brightness", 13: "moveToRight", 14: "moveToLeft",
    15: "bgm", 16: "soundVolume", 17: "expression", 18: "pause",
    19: "resume", 20: "location", 21: "motion", 23: "loadLive2d",
    24: "costume", 25: "background", 26: "movie", 27: "clip",
    28: "subtitles", 29: "wait", 30: "still", 31: "se", 32: "angle",
    33: "pan", 34: "fieldTilt", 35: "talkWindow", 36: "chatWindow",
    37: "chatTalk", 38: "chatStamp", 39: "chatRead", 40: "choiceSet",
    41: "choiceShow", 42: "goTo", 43: "postEffect", 44: "frame",
    45: "timeline", 46: "look", 47: "pedestal", 48: "track", 49: "dof",
    50: "role", 51: "cameraShake", 52: "voice", 53: "zoom",
    54: "effect", 55: "alpha", 56: "forceAuto", 57: "stageEnv",
    58: "rimLight", 59: "cancelDelay", 60: "moveToUp", 61: "moveToDown",
    62: "moveDepth", 63: "moveDepth", 64: "moveToDirection",
    65: "chatTyping", 66: "lookTarget", 67: "fieldPan",
}

# These enum names mirror the reference value labels. The integer is
# always emitted as well; callers must not infer new semantics for values
# absent from these maps.
CHARACTER_VOICE_TYPES = {
    0: "LevelUp", 1: "Awaken", 2: "SkillLevelUp", 3: "RankUp",
    4: "LiveClear", 5: "LiveFullCombo", 6: "LiveAllPerfect",
    7: "LiveResult", 8: "LiveBattleResultFirst",
    9: "LiveBattleResultHigh", 10: "LiveBattleResultLow",
}
CHARACTER_VOICE_MASTER_TYPES = {
    0: "Talk", 1: "CharacterVoice", 2: "MemberCard", 3: "LiveCharacter",
    4: "LiveGekisouVoice", 5: "LiveDialogueCommon",
    6: "LiveDialogueFixedPair", 7: "LiveStartCharacterVoice",
}
CHARACTER_VOICE_COLLECTION_TABS = {0: "Comment", 1: "Growth", 2: "Gacha", 3: "Live"}
CHARACTER_VOICE_COLLECTION_VOICE_TYPES = {
    0: "Normal", 1: "RealLive", 2: "Feature", 3: "Season", 4: "Birthday",
    5: "Growth", 6: "Gacha", 7: "LiveStart", 8: "GekisouStart",
    9: "GekisouEnd", 10: "LiveEnd", 11: "LiveDialogue",
    12: "LivePairDialoguea", 13: "LiveResult", 14: "LiveBattleResult",
}
LIVE_DIALOGUE_TYPES = {0: "None", 1: "Combo", 2: "LiveSkill"}
LIVE_DIALOGUE_CALL_TYPES = {0: "None", 1: "Call", 2: "Response"}
GEKISOU_VOICE_TYPES = {0: "StartCombo", 1: "StartJustCount", 2: "StartLuck", 3: "TopRank"}
GEKISOU_MISSION_TYPES = {0: "None", 1: "Combo", 2: "Luck", 3: "JustCount", 4: "All"}
GEKISOU_REWARD_TYPES = {0: "None", 1: "Total", 2: "Combo", 3: "Just", 4: "Luck"}
GEKISOU_SUPPORT_EXEC_TIMINGS = {
    0: "None", 1: "ParentMemberExecGekisouSKill", 2: "LiveStart",
    3: "ReachRankFirst", 4: "ReachRankSecondMore", 5: "ReachRankThirdMore",
}
GEKISOU_CALL_TYPES = {
    0: "None", 1: "GekisouCall01", 2: "GekisouCall02", 3: "GekisouCall03",
    4: "GekisouCall04", 5: "GekisouCall05",
}
LIVE_SCORE_RANKS = {0: "None", 1: "E", 2: "D", 3: "C", 4: "B", 5: "A", 6: "S", 7: "SS"}
LIVE_DIFFICULTIES = {0: "Easy", 1: "Normal", 2: "Hard", 3: "Expert", 4: "Master"}
LIVE_MUSIC_REWARD_COMBO_TYPES = {
    0: "Quarter", 1: "Half", 2: "ThreeQuarters", 3: "Full",
}
ITEM_TYPES = {
    1: "Common", 2: "GachaTicket", 3: "MemberExp", 4: "SnapExp",
    5: "CharacterExp", 6: "Awake", 7: "LB", 8: "SkillItem",
    9: "MemberPiece", 10: "SnapPiece", 11: "Exchange", 12: "FreeHC",
    13: "PaidHC", 14: "SC", 15: "CM", 16: "Cash", 17: "BandPiece",
    18: "CommonPiece", 19: "OfflineBonusSkip", 20: "ArenaSupportItem",
    21: "BandLevelItem",
}
RESOURCE_TYPES = {
    1: "Item", 2: "MemberCard", 3: "SupportCard",
    4: "Voice", 5: "LoginBonus", 6: "Subscription", 7: "GachaPoint",
    8: "Music", 9: "Stamp", 10: "PremiumPass", 11: "EventMedal",
    12: "LiveLaneSkin", 13: "LiveNoteSkin", 14: "LiveNoteEffectSkin",
    15: "LiveNoteSEGroup", 16: "VipPoint", 17: "Degree",
}
OBSERVED_CHARACTER_MISSION_TYPES = {
    12: "MemberCollectCharacter", 14: "SupportCollectCharacter",
    16: "StampCollectCharacter", 25: "FriendshipCharacterTotal",
    42: "MemberSkillLevelCharacterCount", 48: "MemberAwakeCharacterCount",
    54: "MemberRankCharacterCount", 66: "SupportRankCharacterCount",
    80: "LiveClearCharacter", 111: "LiveClearUniqueCharacter",
}
OPTION_ITEM_TYPES = {
    0: "None", 1: "NoteSpeed", 2: "NoteTiming", 3: "ChartPosition",
    4: "MirrorChart", 5: "AssistMode", 6: "LiveQuality", 7: "Vibration",
    100: "FastSlowDisplay", 101: "PerfectFastSlowDisplay",
    102: "JudgeOffsetMsDisplay", 103: "JudgeResultPositionType",
    104: "JudgePosition", 105: "JudgePositionDisplay", 106: "SlideOpacity",
    107: "GuideOpacity", 108: "SimultaneousLineDisplay",
    109: "MeasureLineDisplay", 110: "MvQuality", 111: "MvDataRetention",
    112: "LiveSkillEffect", 113: "ComboEffect", 114: "DamageEffect",
    115: "StageEffect", 116: "FcAcChallengeAssist", 117: "PreLiveSimpleOption",
    118: "FrameRate", 200: "ScreenMode", 201: "BackgroundBrightness",
    202: "MvModeBrightness", 203: "BackgroundSwitch", 205: "SkillEffectDisplay",
    206: "ComboCountDisplay", 207: "JudgeDetailDisplay",
    208: "ContinuationEffectDisplay", 300: "LaneOpacity",
    301: "GuidelineOpacity", 302: "GuidelineCount", 303: "GekisouDisplay",
    304: "GekisouDisplayPositionChange", 305: "LiveSkinId",
    306: "NoteDesignId", 307: "NoteEffectId", 308: "NoteStartPosition",
    309: "LiveSkillActivationPositionDisplay", 400: "SystemBgmVolume",
    401: "SystemSeVolume", 402: "SystemVoiceVolume", 403: "SystemBgmMute",
    404: "SystemSeMute", 405: "SystemVoiceMute", 410: "LiveMusicVolume",
    411: "LiveNoteSeVolume", 412: "LiveSeVolume", 413: "LiveVoiceVolume",
    414: "LiveMusicMute", 415: "LiveNoteSeMute", 416: "LiveSeMute",
    417: "LiveVoiceMute", 420: "NoteSePatternId", 421: "UseIndividualNoteSe",
    430: "EmptyTapSeId", 431: "EmptyTapSeVolume", 432: "TapSeId",
    433: "TapSeVolume", 434: "FlickSeId", 435: "FlickSeVolume",
    436: "SideFlickSeId", 437: "SideFlickSeVolume", 438: "SlideSeId",
    439: "SlideSeVolume", 440: "TraceSeId", 441: "TraceSeVolume",
    450: "GekisouTapSeId", 451: "GekisouTapSeVolume",
    452: "GekisouFlickSeId", 453: "GekisouFlickSeVolume",
    454: "GekisouSideFlickSeId", 455: "GekisouSideFlickSeVolume",
    456: "GekisouSlideSeId", 457: "GekisouSlideSeVolume",
    458: "GekisouTraceSeId", 459: "GekisouTraceSeVolume",
    460: "EmptyTapSeMute", 461: "TapSeMute", 462: "FlickSeMute",
    463: "SideFlickSeMute", 464: "SlideSeMute", 465: "TraceSeMute",
    466: "GekisouTapSeMute", 467: "GekisouFlickSeMute",
    468: "GekisouSideFlickSeMute", 469: "GekisouSlideSeMute",
    470: "GekisouTraceSeMute", 500: "BluetoothNoteTiming",
    501: "BluetoothNoteChartPosition", 510: "BluetoothSystemBgmVolume",
    511: "BluetoothSystemSeVolume", 512: "BluetoothSystemVoiceVolume",
    513: "BluetoothSystemBgmMute", 514: "BluetoothSystemSeMute",
    515: "BluetoothSystemVoiceMute", 520: "BluetoothLiveMusicVolume",
    521: "BluetoothLiveNoteSeVolume", 522: "BluetoothLiveSeVolume",
    523: "BluetoothLiveVoiceVolume", 524: "BluetoothLiveMusicMute",
    525: "BluetoothLiveNoteSeMute", 526: "BluetoothLiveSeMute",
    527: "BluetoothLiveVoiceMute", 600: "QualitySetting", 601: "PurchaseAlert",
    602: "LiveBoostFullRecoveryNotification", 603: "LateNightNotification",
}


def _rows(root: Path, name: str) -> list[dict[str, Any]]:
    file = root / f"{name}.json"
    if not file.is_file():
        return []
    value = read_json(file)
    if isinstance(value, list):
        return value
    return value.get("_allData", []) if isinstance(value, dict) else []


def _localized(row: dict[str, Any] | None, fallback: str = "") -> list[str]:
    values = [str((row or {}).get(field) or "") for field in LOCALE_FIELDS]
    return values if any(values) else [str(fallback), "", "", "", ""]


def _timestamp(value: Any) -> list[int | None]:
    text = str(value or "").strip().replace("/", "-")
    if not text:
        return [0, None, None, None, None]
    try:
        text = re.sub(r" (\d):", r" 0\1:", text)
        parsed = datetime.fromisoformat(text).replace(tzinfo=JST)
        milliseconds = int(parsed.timestamp() * 1000)
    except ValueError:
        milliseconds = 0
    return [milliseconds, None, None, None, None]


class BuildData:
    def __init__(self, server: str, root: Path):
        self.server = server
        self.root = root
        self.assets = root / "assets"
        self.runtime = root / "runtime"
        self.master = root / "master"
        self.tables = {file.stem: _rows(self.master, file.stem) for file in sorted(self.master.glob("*.json"))}
        self.texts = {str(row.get("_id")): row for row in self.tables.get("MasterText", [])}
        self.sounds = {int(row.get("_id") or 0): row for row in self.tables.get("MasterSound", [])}
        self.sound_sheets = {
            int(row.get("_id") or 0): row for row in self.tables.get("MasterSoundCueSheet", [])
        }
        source_index = self.root / "metadata" / "source-index.json"
        source_index_document = read_json(source_index) if source_index.is_file() else {}
        source_entries = source_index_document.get("sources", {})
        if not isinstance(source_entries, dict):
            raise ValueError(f"Unity source index has invalid sources: {source_index}")
        serialized_files = source_index_document.get("serializedFiles", {})
        if not isinstance(serialized_files, dict):
            raise ValueError(
                f"Unity source index has invalid serialized files: {source_index}"
            )
        self.source_index: dict[str, dict[str, Any]] = source_entries
        self.serialized_files: dict[str, dict[str, Any]] = serialized_files
        self.source_paths = sorted(self.source_index)
        self.source_path_set = set(self.source_paths)
        self._source_descriptor_cache: dict[str, dict[str, Any]] = {}
        self._object_archive_cache: dict[str, dict[str, dict[str, Any]]] = {}
        self._unity_output_index: dict[
            tuple[str, str, str], list[tuple[str, dict[str, Any]]]
        ] = {}
        # UnityPy attaches a resolved reference to pointers that occur in an
        # AssetBundle preload table.  The same external pointer can occur again
        # inside a Material, Renderer or ParticleSystem without that redundant
        # annotation.  Build an owner/path index from the canonical preload
        # evidence so nested pointers can resolve to the exact same object.
        self._external_pointer_candidates: dict[
            tuple[str, str], set[str]
        ] = {}
        self._source_paths_by_serialized_file: dict[str, list[str]] = {}
        self._external_pointer_owners_indexed: set[str] = set()
        for indexed_source_path, entry in self.source_index.items():
            owner = str(entry.get("serializedFile") or "")
            source_path = str(entry.get("sourcePath") or indexed_source_path)
            if owner and source_path:
                self._source_paths_by_serialized_file.setdefault(owner, []).append(
                    source_path
                )
            references = entry.get("preloadObjectReferences", [])
            if not owner or not isinstance(references, list):
                continue
            for reference in references:
                if not isinstance(reference, dict):
                    continue
                serialized_file = str(reference.get("serializedFile") or "")
                path_id = str(reference.get("pathId") or "")
                if serialized_file and serialized_file != owner and path_id:
                    self._external_pointer_candidates.setdefault(
                        (owner, str(int(path_id))), set()
                    ).add(serialized_file)
        for source_path, entry in self.source_index.items():
            for output in entry.get("outputs", []):
                if not isinstance(output, dict):
                    continue
                serialized_file = str(output.get("serializedFile") or "")
                object_id = str(output.get("objectId") or "")
                object_type = str(output.get("type") or "")
                if serialized_file and object_id and object_type:
                    self._unity_output_index.setdefault(
                        (serialized_file, object_id, object_type), []
                    ).append((source_path, output))
        self._volume_profile_cache: dict[str, dict[str, Any]] = {}
        self._stage_profile_index: dict[tuple[str, str], dict[str, Any]] | None = None
        self._stage_profile_name_index: dict[str, dict[str, Any]] | None = None
        self._adv_stage_cache: dict[str, dict[str, Any]] = {}
        self._adv_frame_cache: dict[str, dict[str, Any]] = {}
        self._adv_effect_cache: dict[str, dict[str, Any]] = {}
        self._home_spot_background_index: dict[int, dict[str, Any]] | None = None
        self.runtime_path_set = {
            file.relative_to(self.runtime).as_posix()
            for file in self.runtime.rglob("*")
            if file.is_file()
        }
        cri_manifest = self.root / "metadata" / "cri.json"
        self.cri_entries = read_json(cri_manifest).get("entries", []) if cri_manifest.is_file() else []
        self.cri_entries_by_runtime: dict[str, list[dict[str, Any]]] = {}
        self.cri_acb_entries_by_cue_sheet_name: dict[str, list[dict[str, Any]]] = {}
        for entry in self.cri_entries:
            runtime_path = str(entry.get("runtimePath") or "")
            if runtime_path:
                self.cri_entries_by_runtime.setdefault(runtime_path, []).append(entry)
                if entry.get("kind") == "acb":
                    cue_sheet_name = PurePosixPath(runtime_path).name.casefold()
                    self.cri_acb_entries_by_cue_sheet_name.setdefault(
                        cue_sheet_name, []
                    ).append(entry)
        self._sound_cache: dict[int, dict[str, Any] | None] = {}

    def _index_external_pointers(self, owner_serialized_file: str) -> None:
        if owner_serialized_file in self._external_pointer_owners_indexed:
            return
        self._external_pointer_owners_indexed.add(owner_serialized_file)
        paths = self._source_paths_by_serialized_file.get(owner_serialized_file, [])
        # Compact source-index entries intentionally omit preload references.
        # Read only descriptors that share the owner currently being resolved;
        # this avoids eagerly parsing every source descriptor in the release.
        for source_path in paths:
            descriptor = self.source_descriptor(source_path)
            references = descriptor.get("preloadObjectReferences", [])
            if not isinstance(references, list):
                continue
            for reference in references:
                if not isinstance(reference, dict):
                    continue
                serialized_file = str(reference.get("serializedFile") or "")
                path_id = str(reference.get("pathId") or "")
                if serialized_file and serialized_file != owner_serialized_file and path_id:
                    self._external_pointer_candidates.setdefault(
                        (owner_serialized_file, str(int(path_id))), set()
                    ).add(serialized_file)

    def home_spot_background(self, identity: int) -> dict[str, Any]:
        """Resolve one strict build-time Home Spot background derivative."""
        if self._home_spot_background_index is None:
            file = self.root / "metadata" / "home-spots.json"
            if not file.is_file():
                raise ValueError(f"Home Spot background metadata is missing: {file}")
            document = read_json(file)
            scenes = document.get("scenes") if isinstance(document, dict) else None
            if (
                not isinstance(document, dict)
                or document.get("schema") != HOME_SPOT_BACKGROUND_SCHEMA
                or document.get("server") != self.server
                or not isinstance(scenes, list)
                or int(document.get("sceneCount") or -1) != len(scenes)
            ):
                raise ValueError(f"Home Spot background metadata is invalid: {file}")
            index: dict[int, dict[str, Any]] = {}
            for scene in scenes:
                spot_id = int(scene.get("spotId") or 0) if isinstance(scene, dict) else 0
                if not spot_id or spot_id in index:
                    raise ValueError(
                        f"Home Spot background metadata has an empty or repeated id: {spot_id}"
                    )
                index[spot_id] = scene
            self._home_spot_background_index = index
        scene = self._home_spot_background_index.get(identity)
        if scene is None:
            raise ValueError(f"Home Spot {identity} has no background derivative")
        return scene

    def rows(self, name: str) -> list[dict[str, Any]]:
        return self.tables.get(name, [])

    def text(self, identifier: Any, fallback: str = "") -> list[str]:
        return _localized(self.texts.get(str(identifier)), fallback)

    def asset(self, value: str) -> str | None:
        path = PurePosixPath(value)
        if (
            not value.startswith(("Assets/", "Packages/"))
            or value not in self.source_path_set
            or not (self.assets / Path(*path.parts)).is_file()
        ):
            return None
        return f"/assets/{self.server}/" + "/".join(path.parts)

    def runtime_url(self, value: str) -> str | None:
        path = PurePosixPath(value)
        if value not in self.runtime_path_set or not (
            self.runtime / Path(*path.parts)
        ).is_file():
            return None
        return f"/runtime/{self.server}/" + "/".join(path.parts)

    def runtime_output_url(self, value: str) -> str | None:
        path = PurePosixPath(value)
        if path.parts[:1] != ("runtime",):
            return None
        return self.runtime_url(PurePosixPath(*path.parts[1:]).as_posix())

    def _read_object_archive(
        self,
        archive_relative: PurePosixPath,
        selected_bundle: str,
        serialized_file: str,
        object_count: int,
        archive_object_count: int,
    ) -> dict[str, dict[str, Any]]:
        archive_key = f"{archive_relative.as_posix()}#{serialized_file}"
        cached = self._object_archive_cache.get(archive_key)
        if cached is not None:
            return cached
        archive_file = self.root / Path(*archive_relative.parts)
        if not archive_file.is_file():
            raise ValueError(f"Unity object archive is missing: {archive_file}")
        objects: dict[str, dict[str, Any]] = {}
        header_seen = False
        archive_records = 0
        for line_number, record in iter_unity_object_archive(archive_file):
            if record.get("record") == "header":
                if (
                    header_seen
                    or record.get("format") != "haneoka-unity-objects-jsonl-v1"
                    or record.get("bundleSha256") != selected_bundle
                    or serialized_file not in record.get("serializedFiles", [])
                ):
                    raise ValueError(
                        f"Unity object archive header mismatch: {archive_file}"
                    )
                header_seen = True
                continue
            if record.get("record") != "object":
                raise ValueError(
                    f"Unity object archive has unknown record at {archive_file}:{line_number}"
                )
            archive_records += 1
            if record.get("serializedFile") != serialized_file:
                continue
            try:
                object_id = str(int(record.get("pathId")))
            except (TypeError, ValueError) as error:
                raise ValueError(
                    f"Unity object archive has invalid pathId at {archive_file}:{line_number}"
                ) from error
            if object_id in objects:
                raise ValueError(
                    f"Unity object archive repeats pathId {object_id}: {archive_file}"
                )
            objects[object_id] = record
        if (
            not header_seen
            or len(objects) != object_count
            or archive_records != archive_object_count
        ):
            raise ValueError(f"Unity object archive record count mismatch: {archive_file}")
        self._object_archive_cache[archive_key] = objects
        return objects

    def unity_pointer_identity(
        self, value: Any, owner_serialized_file: str
    ) -> tuple[str, str] | None:
        if not isinstance(value, dict):
            return None
        try:
            file_id = int(value.get("m_FileID") or 0)
            path_id = int(value.get("m_PathID") or 0)
        except (TypeError, ValueError):
            return None
        if not path_id:
            return None
        if not file_id:
            return owner_serialized_file, str(path_id)
        reference = value.get("reference")
        if isinstance(reference, dict) and reference.get("status") == "resolved":
            serialized_file = str(reference.get("serializedFile") or "")
            reference_path_id = str(reference.get("pathId") or "")
            if not serialized_file or not reference_path_id:
                raise ValueError(
                    f"Unity external pointer has no target identity: "
                    f"{owner_serialized_file}:{file_id}:{path_id}"
                )
            return serialized_file, str(int(reference_path_id))

        self._index_external_pointers(owner_serialized_file)
        candidates = self._external_pointer_candidates.get(
            (owner_serialized_file, str(path_id)), set()
        )
        if len(candidates) == 1:
            return next(iter(candidates)), str(path_id)
        if len(candidates) > 1:
            raise ValueError(
                f"Unity external pointer is ambiguous: "
                f"{owner_serialized_file}:{file_id}:{path_id} -> "
                f"{', '.join(sorted(candidates))}"
            )
        if not isinstance(reference, dict) or reference.get("status") != "resolved":
            raise ValueError(
                f"Unity external pointer is unresolved: "
                f"{owner_serialized_file}:{file_id}:{path_id}"
            )
        raise AssertionError("resolved Unity pointer returned before fallback lookup")

    def unity_object(
        self,
        value: Any,
        owner_serialized_file: str,
        expected_type: str | None = None,
    ) -> dict[str, Any] | None:
        identity = self.unity_pointer_identity(value, owner_serialized_file)
        if identity is None:
            return None
        serialized_file, object_id = identity
        index_entry = self.serialized_files.get(serialized_file)
        if not isinstance(index_entry, dict):
            raise ValueError(
                f"Unity serialized file is absent from the object index: {serialized_file}"
            )
        selected_bundle = str(index_entry.get("bundleSha256") or "")
        archive_relative = PurePosixPath(str(index_entry.get("objectArchive") or ""))
        expected_archive = PurePosixPath("objects/unity") / f"{selected_bundle}.jsonl.gz"
        if not selected_bundle or archive_relative != expected_archive:
            raise ValueError(
                f"Unity serialized file archive identity mismatch: {serialized_file}"
            )
        objects = self._read_object_archive(
            archive_relative,
            selected_bundle,
            serialized_file,
            int(index_entry.get("objectCount") or -1),
            int(index_entry.get("archiveObjectCount") or -1),
        )
        record = objects.get(object_id)
        if record is None:
            raise ValueError(
                f"Unity pointer target is missing: {serialized_file}:{object_id}"
            )
        if expected_type is not None and record.get("type") != expected_type:
            raise ValueError(
                f"Unity pointer target has type {record.get('type')}, expected "
                f"{expected_type}: {serialized_file}:{object_id}"
            )
        return record

    def unity_output_url(
        self,
        value: Any,
        owner_serialized_file: str,
        expected_type: str,
    ) -> str | None:
        identity = self.unity_pointer_identity(value, owner_serialized_file)
        if identity is None:
            return None
        matches = self._unity_output_index.get((*identity, expected_type), [])
        unique = {
            (source_path, str(output.get("path") or "")): output
            for source_path, output in matches
        }
        if len(unique) != 1:
            raise ValueError(
                f"Unity media pointer must resolve uniquely: "
                f"{identity[0]}:{identity[1]}:{expected_type}; found {len(unique)}"
            )
        (source_path, output_path), _ = next(iter(unique.items()))
        path = PurePosixPath(output_path)
        if path.parts[:1] == ("assets",):
            url = self.asset(PurePosixPath(*path.parts[1:]).as_posix())
        else:
            url = self.runtime_output_url(output_path)
        if not url:
            raise ValueError(
                f"Unity media pointer output is absent: {source_path}:{output_path}"
            )
        return url

    def portable_unity_pointer(
        self, value: Any, owner_serialized_file: str
    ) -> dict[str, Any] | None:
        identity = self.unity_pointer_identity(value, owner_serialized_file)
        if identity is None:
            return None
        record = self.unity_object(value, owner_serialized_file)
        if record is None:
            return None
        raw = record.get("data") if isinstance(record.get("data"), dict) else {}
        name = str(raw.get("m_Name") or "") or None
        object_type = str(record.get("type") or "")
        url = (
            self.unity_output_url(value, owner_serialized_file, object_type)
            if object_type in {"Texture2D", "Sprite"}
            else None
        )
        return {
            "serializedFile": identity[0],
            "pathId": identity[1],
            "type": object_type,
            "name": name,
            "url": url,
        }

    def source_descriptor(self, source_path: str) -> dict[str, Any]:
        """Read one canonical source descriptor and reject index divergence."""
        cached = self._source_descriptor_cache.get(source_path)
        if cached is not None:
            return cached
        index_entry = self.source_index.get(source_path)
        if not isinstance(index_entry, dict):
            raise ValueError(f"Unity source is missing from source-index.json: {source_path}")
        descriptor_value = str(index_entry.get("descriptor") or "")
        descriptor_relative = PurePosixPath(descriptor_value)
        if (
            descriptor_relative.is_absolute()
            or descriptor_relative.parts[:1] != ("sources",)
            or ".." in descriptor_relative.parts
        ):
            raise ValueError(
                f"Unity source descriptor path is invalid for {source_path}: {descriptor_value}"
            )
        descriptor_file = self.root / "metadata" / Path(*descriptor_relative.parts)
        if not descriptor_file.is_file():
            raise ValueError(f"Unity source descriptor is missing: {descriptor_file}")
        descriptor = read_json(descriptor_file)
        if not isinstance(descriptor, dict) or descriptor.get("sourcePath") != source_path:
            raise ValueError(f"Unity source descriptor identity mismatch: {descriptor_file}")
        if descriptor.get("serializedFile") != index_entry.get("serializedFile"):
            raise ValueError(
                f"Unity source serialized file diverges from source index: {source_path}"
            )
        if descriptor.get("outputs") != index_entry.get("outputs"):
            raise ValueError(
                f"Unity source outputs diverge between descriptor and source index: {source_path}"
            )
        self._source_descriptor_cache[source_path] = descriptor
        return descriptor

    def source_objects(
        self, source_path: str
    ) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
        """Read and validate the canonical Unity object archive for one source."""
        descriptor = self.source_descriptor(source_path)
        archive = descriptor.get("objectArchive")
        if (
            not isinstance(archive, dict)
            or archive.get("format") != "haneoka-unity-objects-jsonl-v1"
            or int(archive.get("failedObjectCount") or 0)
        ):
            raise ValueError(f"Unity object archive is missing or invalid: {source_path}")
        selected_bundle = str(descriptor.get("selectedBundle") or "")
        archive_relative = PurePosixPath(str(archive.get("path") or ""))
        expected_archive = PurePosixPath("objects/unity") / f"{selected_bundle}.jsonl.gz"
        if not selected_bundle or archive_relative != expected_archive:
            raise ValueError(f"Unity object archive identity mismatch: {source_path}")
        serialized_file = str(descriptor.get("serializedFile") or "")
        if serialized_file not in archive.get("serializedFiles", []):
            raise ValueError(f"Unity object archive file identity mismatch: {source_path}")
        serialized_file_entry = self.serialized_files.get(serialized_file)
        if (
            not isinstance(serialized_file_entry, dict)
            or serialized_file_entry.get("bundleSha256") != selected_bundle
        ):
            raise ValueError(
                f"Unity source serialized file is absent from the index: {source_path}"
            )
        objects = self._read_object_archive(
            archive_relative,
            selected_bundle,
            serialized_file,
            int(serialized_file_entry.get("objectCount") or -1),
            int(archive.get("objectCount") or -1),
        )
        root_ids = {str(int(value)) for value in descriptor.get("rootObjects", [])}
        if not root_ids or not root_ids.issubset(objects):
            raise ValueError(f"Unity source roots are missing from object archive: {source_path}")
        return descriptor, objects

    def exact_cri_output(
        self, entry: dict[str, Any] | None, suffixes: tuple[str, ...]
    ) -> dict[str, Any] | None:
        outputs = [
            output
            for output in (entry or {}).get("outputs", [])
            if PurePosixPath(str(output.get("path") or "")).suffix.casefold() in suffixes
            and self.runtime_output_url(str(output.get("path") or ""))
        ]
        return outputs[0] if len(outputs) == 1 else None

    def video_media(self, asset_name: str) -> dict[str, Any] | None:
        """Bind a video asset name to one exact normalized CRI runtime path."""
        asset_parts = tuple(part.casefold() for part in PurePosixPath(asset_name).parts)
        matches = []
        if asset_parts:
            for entry in self.cri_entries:
                if entry.get("kind") != "usm":
                    continue
                runtime_parts = tuple(
                    part.casefold()
                    for part in PurePosixPath(str(entry.get("runtimePath") or "")).parts
                )
                if (
                    len(runtime_parts) >= len(asset_parts)
                    and runtime_parts[-len(asset_parts):] == asset_parts
                ):
                    matches.append(entry)
        if len(matches) != 1:
            return None
        entry = matches[0]
        output = self.exact_cri_output(entry, (".webm", ".mp4"))
        if not output:
            return None
        return _present(
            runtimePath=entry.get("runtimePath"),
            outputPath=output.get("path"),
            playableUrl=self.runtime_output_url(str(output.get("path") or "")),
            hasAudio=bool(output.get("hasAudio")),
            videoCodec=output.get("videoCodec"),
            audioCodec=output.get("audioCodec"),
            musicVideoAudioBinding=output.get("musicVideoAudioBinding"),
        )

    def music_sound(self, identity: int) -> dict[str, Any] | None:
        """Resolve the live-song sound through the exact Master/CRI MusicScore chain."""
        identity = int(identity or 0)
        row = self.sounds.get(identity)
        if not row:
            return None
        cue_sheet_id = int(row.get("_soundCueSheetID") or 0)
        sheet = self.sound_sheets.get(cue_sheet_id)
        if not sheet:
            return None
        cue_sheet_name = str(sheet.get("_cueSheetName") or "")
        runtime_path = PurePosixPath(
            "cri", "sound", "musicscore", cue_sheet_name
        ).as_posix()
        matches = [
            entry
            for entry in self.cri_entries_by_runtime.get(runtime_path, [])
            if entry.get("kind") == "acb"
        ]
        entry = matches[0] if len(matches) == 1 else None
        output = self.exact_cri_output(entry, (".mp3",))
        playable = (
            self.runtime_output_url(str(output.get("path") or "")) if output else None
        )
        return _present(
            soundId=identity,
            soundCueSheetId=cue_sheet_id,
            cueName=str(row.get("_cueName") or ""),
            cueSheetName=cue_sheet_name,
            category=int(row.get("_category") or 0),
            categoryName=CRI_SOUND_CATEGORIES.get(int(row.get("_category") or 0), ""),
            runtimePath=runtime_path,
            outputPath=output.get("path") if output else None,
            playableUrl=playable,
            durationMs=output.get("durationMs") if output else None,
            sampleRate=output.get("sampleRate") if output else None,
            channels=output.get("channels") if output else None,
            totalSamples=output.get("totalSamples") if output else None,
            streamIndex=output.get("streamIndex") if output else None,
            streamCount=output.get("streamCount") if output else None,
            loopInfo=output.get("loopInfo") if output else None,
            missing=not bool(playable),
            binding="exact-master-sound-cue-sheet-to-music-score-runtime-path",
            sourceTables=["MasterSound", "MasterSoundCueSheet"],
            raw=row,
        )

    def _resolve_sound(
        self,
        identity: int,
        sound_rows: dict[int, dict[str, Any]],
        cue_sheet_rows: dict[int, dict[str, Any]],
        source_table: str,
    ) -> dict[str, Any] | None:
        identity = int(identity or 0)
        row = sound_rows.get(identity)
        if not row:
            return None
        cue_sheet_id = int(row.get("_soundCueSheetID") or 0)
        sheet = cue_sheet_rows.get(cue_sheet_id)
        cue_name = str(row.get("_cueName") or "")
        cue_sheet_name = str((sheet or {}).get("_cueSheetName") or "")
        entries = (
            self.cri_acb_entries_by_cue_sheet_name.get(cue_sheet_name.casefold(), [])
            if cue_sheet_name
            else []
        )
        output: dict[str, Any] | None = None
        runtime_path: str | None = None
        method: str | None = None
        status = "missing"
        reason = "master-cue-sheet-missing" if sheet is None else "acb-runtime-path-missing"
        candidate_runtime_paths = sorted(
            str(entry.get("runtimePath") or "") for entry in entries
        )
        candidate_output_paths: list[str] = []
        if len(entries) > 1:
            status = "ambiguous"
            reason = "multiple-exact-acb-runtime-paths"
        elif len(entries) == 1:
            entry = entries[0]
            runtime_path = str(entry.get("runtimePath") or "")
            audio_outputs = [
                value
                for value in entry.get("outputs", [])
                if PurePosixPath(str(value.get("path") or "")).suffix.casefold()
                in CRI_AUDIO_SUFFIXES
                and self.runtime_output_url(str(value.get("path") or ""))
            ]
            exact_outputs = [
                value
                for value in audio_outputs
                if VGMSTREAM_RANDOM_CUE_PREFIX.sub(
                    "",
                    VGMSTREAM_SEQUENCE_PREFIX.sub(
                        "",
                        PurePosixPath(str(value.get("path") or "")).stem,
                        count=1,
                    ),
                    count=1,
                ).casefold()
                == cue_name.casefold()
            ]
            if len(exact_outputs) == 1:
                output = exact_outputs[0]
                status = "resolved"
                reason = "exact-cue-name"
                method = "exact-cue-sheet-runtime-and-cue-name"
            elif len(exact_outputs) > 1:
                status = "ambiguous"
                reason = "multiple-exact-cue-outputs"
                candidate_output_paths = sorted(
                    str(value.get("path") or "") for value in exact_outputs
                )
            elif len(audio_outputs) == 1:
                output = audio_outputs[0]
                status = "resolved"
                reason = "unique-single-output-cue-sheet"
                method = "unique-single-output-cue-sheet"
            else:
                reason = (
                    "acb-runtime-output-missing"
                    if not audio_outputs
                    else "no-exact-cue-output-in-multi-output-sheet"
                )
                candidate_output_paths = sorted(
                    str(value.get("path") or "") for value in audio_outputs
                )
        output_path = str((output or {}).get("path") or "")
        playable = self.runtime_output_url(output_path) if output_path else None
        result = _present(
            soundId=identity,
            soundCueSheetId=cue_sheet_id,
            cueName=cue_name,
            cueSheetName=cue_sheet_name,
            category=int(row.get("_category") or 0),
            categoryName=CRI_SOUND_CATEGORIES.get(int(row.get("_category") or 0), ""),
            playableUrl=playable,
            durationMs=(output or {}).get("durationMs"),
            sampleRate=(output or {}).get("sampleRate"),
            channels=(output or {}).get("channels"),
            totalSamples=(output or {}).get("totalSamples"),
            streamIndex=(output or {}).get("streamIndex"),
            streamCount=(output or {}).get("streamCount"),
            loopInfo=(output or {}).get("loopInfo"),
            missing=not bool(playable),
            runtimePath=runtime_path,
            outputPath=output_path,
            binding=method,
            resolution=_present(
                status=status,
                reason=reason,
                candidateRuntimePaths=candidate_runtime_paths,
                candidateOutputPaths=candidate_output_paths,
            ),
            sourceTable=source_table,
            raw=row,
        )
        return result

    def sound(self, identity: int) -> dict[str, Any] | None:
        identity = int(identity or 0)
        if identity in self._sound_cache:
            return self._sound_cache[identity]
        result = self._resolve_sound(
            identity,
            self.sounds,
            self.sound_sheets,
            "MasterSound",
        )
        self._sound_cache[identity] = result
        return result

    def story_sound(
        self,
        identity: int,
        sound_rows: dict[int, dict[str, Any]],
        cue_sheet_rows: dict[int, dict[str, Any]],
        source_table: str = "AdvEpisodeSound",
    ) -> dict[str, Any] | None:
        return self._resolve_sound(
            identity,
            sound_rows,
            cue_sheet_rows,
            source_table,
        )


def _present(**values: Any) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value not in (None, "", [], {})}


def _enum_document(source_type: str, values: dict[int, str]) -> dict[str, Any]:
    return {
        "sourceType": source_type,
        "values": {str(value): name for value, name in sorted(values.items())},
    }


def _raw_record(table: str, row: dict[str, Any], **values: Any) -> dict[str, Any]:
    return _present(sourceTable=table, raw=row, **values)


def _optional_int(row: dict[str, Any], key: str) -> int | None:
    return int(row.get(key) or 0) if key in row else None


def _sorted_rows(data: BuildData, table: str, *keys: str) -> list[dict[str, Any]]:
    fields = keys or ("_id",)
    return sorted(
        data.rows(table),
        key=lambda row: tuple((row.get(field) is None, row.get(field)) for field in fields),
    )


def _reward_record(
    data: BuildData,
    table: str,
    row: dict[str, Any],
    items: dict[int, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    resource_type = int(row.get("_resourceType") or 0)
    resource_id = int(row.get("_resourceId") or 0)
    item = (items or {}).get(resource_id) if resource_type == 1 else None
    return _raw_record(
        table,
        row,
        rewardId=int(row.get("_id") or 0),
        group=int(row.get("_group") or 0),
        resourceType=resource_type,
        resourceTypeName=RESOURCE_TYPES.get(resource_type),
        resourceId=resource_id,
        resourceCount=int(row.get("_resourceCount") or 0),
        resolved=_present(
            kind=RESOURCE_TYPES.get(resource_type),
            itemId=item.get("itemId") if item else None,
            name=item.get("name") if item else None,
            image=item.get("image") if item else None,
        ),
    )


def _bands(data: BuildData) -> dict[str, Any]:
    output = {}
    for row in data.rows("MasterBand"):
        identity = int(row.get("_id") or 0)
        if not identity:
            continue
        base = f"Assets/AddressableResources/Band/{identity}"
        output[str(identity)] = _present(
            bandId=identity,
            bandName=data.text(row.get("_nameTextID"), f"Band {identity}"),
            color=row.get("_mainColorCode"),
            logo=data.asset(f"{base}/band_logo.png"),
            icon=data.asset(f"{base}/band_small_Icon.png"),
        )

    # The CBT MasterBand table stops at MyGO!!!!!/Ave Mujica, while the song
    # rows already reference bands 3..5.  Those same song rows bind each
    # missing band ID to an identically numbered MasterTag, which owns the
    # localized band name.  Keep this as an explicit Master relation rather
    # than inventing names or borrowing an unrelated asset.
    referenced_band_ids = {
        int(value)
        for song in data.rows("MasterLiveMusic")
        for value in song.get("_bandIDs", [])
        if int(value or 0)
    }
    tags = {
        int(row.get("_id") or 0): row
        for row in data.rows("MasterTag")
        if int(row.get("_id") or 0)
    }
    for identity in sorted(referenced_band_ids - {int(value) for value in output}):
        songs = [
            row
            for row in data.rows("MasterLiveMusic")
            if identity in {int(value or 0) for value in row.get("_bandIDs", [])}
        ]
        tag = tags.get(identity)
        if not tag or not songs or any(
            identity not in {int(value or 0) for value in row.get("_bestMusicTagIDs", [])}
            for row in songs
        ):
            continue
        tag_text = data.text(tag.get("_nameTextID"), f"Band {identity}")
        official_names = [
            row
            for text_id, row in data.texts.items()
            if text_id.startswith("Band_Name_")
            and str(row.get("_japanese") or "") == str(tag_text[0] or "")
        ]
        if len(official_names) != 1:
            continue
        output[str(identity)] = _present(
            bandId=identity,
            bandName=_localized(official_names[0], tag_text[0]),
            derivedFromSongTag=True,
            sourceTables=["MasterLiveMusic", "MasterTag", "MasterText"],
            evidence=(
                "Every MasterLiveMusic row carrying this missing _bandIDs value also carries "
                "the same _bestMusicTagIDs value; its MasterTag name has one exact Japanese "
                "match among official Band_Name_* MasterText rows."
            ),
        )
    unresolved = sorted(referenced_band_ids - {int(value) for value in output})
    if unresolved:
        raise ValueError(
            "MasterLiveMusic references band IDs without an auditable band catalog relation: "
            + ", ".join(str(value) for value in unresolved)
        )
    return output


def _characters(data: BuildData) -> dict[str, Any]:
    output = {}
    for row in data.rows("MasterCharacter"):
        identity = int(row.get("_id") or 0)
        if not identity:
            continue
        name = data.text(row.get("_nameTextID"), f"Character {identity}")
        english = data.text(row.get("_enDisplayNameTextId"), "")
        slug = re.sub(r"[^a-z0-9]+", "-", (english[0] or name[0]).casefold()).strip("-")
        base = f"Assets/AddressableResources/Character/Image/{identity}"
        output[str(identity)] = _present(
            characterId=identity,
            characterKey=str(identity).zfill(3),
            characterName=name,
            nickname=data.text(row.get("_shortNameTextID"), name[0]),
            englishName=english,
            slug=slug,
            bandId=int(row.get("_bandID") or 0),
            displayOrder=int(row.get("_displayOrder") or 0),
            characterType="unique",
            profileImage=data.asset(f"{base}/character_thumbnail.png"),
            spriteImage=data.asset(f"{base}/character_sprite.png"),
            faceImage=data.asset(f"{base}/character_face_icon.png"),
            thumbnailImage=data.asset(f"{base}/character_thumbnail.png"),
            colorCode=row.get("_mainColorCode"),
            bandPart=row.get("_bandPart"),
            birthday=_present(month=row.get("_birthdayMonth"), day=row.get("_birthdayDay")),
            voiceActor=data.text(row.get("_voiceActorTextId"), ""),
            description=data.text(row.get("_descriptionTextId"), ""),
            catchCopy=data.text(row.get("_catchCopyTextId"), ""),
            height=data.text(row.get("_heightTextId"), ""),
            constellation=data.text(row.get("_constellationTextId"), ""),
            school=data.text(row.get("_schoolTextId"), ""),
            schoolClass=data.text(row.get("_schoolClassTextId"), ""),
            favoriteFood=data.text(row.get("_favoriteFoodTextId"), ""),
            hatedFood=data.text(row.get("_hatedFoodTextId"), ""),
            hobby=data.text(row.get("_hobbyTextId"), ""),
        )
    return output


def _skill_entry(
    data: BuildData,
    row: dict[str, Any],
    table: str,
    effect_table: str,
    effect_foreign_key: str,
    id_key: str = "skillId",
) -> dict[str, Any]:
    identity = int(row.get("_id") or 0)
    skill_icon_id = int(row.get("_skillIconID") or 0)
    skill_icon_row = next(
        (
            item
            for item in data.rows("MasterSkillIcon")
            if int(item.get("_id") or 0) == skill_icon_id
        ),
        None,
    )
    skill_icon_asset_name = (
        str(skill_icon_row.get("_normalIconAssetName") or "")
        if skill_icon_row
        else ""
    )
    skill_icon = (
        data.asset(
            "Assets/AddressableResources/Character/Skill/"
            f"{skill_icon_asset_name}.png"
        )
        if skill_icon_asset_name
        else None
    )
    effects = [
        _raw_record(
            effect_table,
            effect,
            effectId=int(effect.get("_id") or 0),
            level=int(effect.get("_level") or 0),
            effectType=int(effect.get("_skillEffectType") or 0),
            effectValue=effect.get("_effectValue"),
            maxEffectValue=effect.get("_maxEffectValue"),
            activationTimeSecond=effect.get("_activationTimeSecond"),
            targetIds=[int(value) for value in effect.get("_skillTargetIDs", [])],
            conditionGroup=_optional_int(effect, "_skillConditionGroup"),
            releaseConditionGroup=_optional_int(effect, "_skillReleaseConditionGroup"),
            triggerType=_optional_int(effect, "_skillTriggerType"),
            triggerConditionGroup=_optional_int(effect, "_skillTriggerConditionGroup"),
            cumulativeConditionId=_optional_int(effect, "_skillCumulativeConditionID"),
            effectLimitCount=_optional_int(effect, "_effectLimitCount"),
            executeLimitCount=_optional_int(effect, "_effectExecuteLimitCount"),
            executeLimitResetConditionGroup=_optional_int(
                effect, "_effectExecuteLimitResetConditionGroup"
            ),
        )
        for effect in _sorted_rows(data, effect_table, effect_foreign_key, "_level", "_id")
        if int(effect.get(effect_foreign_key) or 0) == identity
    ]
    mission_type = (
        int(row.get("_gekisouMissionType") or 0)
        if "_gekisouMissionType" in row
        else None
    )
    execution_timing = (
        int(row.get("_gekisouSupportSkillExecTiming") or 0)
        if "_gekisouSupportSkillExecTiming" in row
        else None
    )
    return _raw_record(
        table,
        row,
        **{id_key: identity},
        id=identity,
        skillName=data.text(row.get("_nameTextID")),
        description=data.text(row.get("_descriptionTextFormatID")),
        skillIconId=skill_icon_id,
        skillIconAssetName=skill_icon_asset_name,
        icon=skill_icon,
        categories=[int(value) for value in row.get("_skillCategories", [])],
        gekisouMissionType=mission_type,
        gekisouMissionTypeName=GEKISOU_MISSION_TYPES.get(mission_type),
        gekisouSupportSkillExecTiming=execution_timing,
        gekisouSupportSkillExecTimingName=GEKISOU_SUPPORT_EXEC_TIMINGS.get(execution_timing),
        effects=effects,
    )


def _skills(
    data: BuildData,
    table: str,
    effect_table: str,
    effect_foreign_key: str,
    id_key: str = "skillId",
) -> dict[str, Any]:
    output = {}
    for row in _sorted_rows(data, table):
        identity = int(row.get("_id") or 0)
        if identity:
            output[str(identity)] = _skill_entry(
                data, row, table, effect_table, effect_foreign_key, id_key
            )
    return output


def _cards(data: BuildData, table: str, support: bool = False) -> dict[str, Any]:
    def resolve_skill(
        identity: int,
        skill_table: str,
        effect_table: str,
        foreign_key: str,
        id_key: str,
    ) -> dict[str, Any] | None:
        row = next(
            (item for item in data.rows(skill_table) if int(item.get("_id") or 0) == identity),
            None,
        )
        return (
            _skill_entry(data, row, skill_table, effect_table, foreign_key, id_key)
            if row and identity
            else None
        )

    output = {}
    for row in data.rows(table):
        identity = int(row.get("_id") or 0)
        if not identity:
            continue
        base = "SupportCard" if support else "MemberCard"
        image_base = f"Assets/AddressableResources/{base}/{identity}"
        images = {
            key: data.asset(f"{image_base}/{filename}")
            for key, filename in {
                "thumbnail": "snap_thumbnail.png" if support else "member_thumbnail.png",
                "full": "snap_full.png" if support else "member_full.png",
                "character": "member_character.png",
                "background": "member_background.png",
                "skill": "skill_sprite.png",
            }.items()
        }
        images = {key: value for key, value in images.items() if value}
        character_ids = [int(value) for value in row.get("_characterIDs", []) if int(value)] if support else []
        skill_id = int(row.get("_supportSkillId01" if support else "_liveSkillID") or 0)
        support_skill_ids = [
            int(row.get("_supportSkillId01") or 0),
            int(row.get("_supportSkillId02") or 0),
        ] if support else []
        support_skill_ids = [value for value in support_skill_ids if value]
        gekisou_support_skill_ids = [
            int(row.get("_gekisouSupportSkillId01") or 0),
            int(row.get("_gekisouSupportSkillId02") or 0),
        ] if support else []
        gekisou_support_skill_ids = [value for value in gekisou_support_skill_ids if value]
        leader_skill_id = int(row.get("_leaderSkillID") or 0)
        live_skill_id = int(row.get("_liveSkillID") or 0)
        gekisou_skill_id = int(row.get("_gekisouSkillID") or 0)
        resolved_skills = _present(
            leader=resolve_skill(
                leader_skill_id, "MasterLeaderSkill", "MasterLeaderSkillEffect",
                "_leaderSkillID", "leaderSkillId",
            ),
            live=resolve_skill(
                live_skill_id, "MasterLiveSkill", "MasterLiveSkillEffect",
                "_liveSkillID", "liveSkillId",
            ),
            gekisou=resolve_skill(
                gekisou_skill_id, "MasterGekisouSkill", "MasterGekisouSkillEffect",
                "_gekisouSkillID", "gekisouSkillId",
            ),
            support=[
                resolve_skill(
                    value, "MasterSupportSkill", "MasterSupportSkillEffect",
                    "_supportSkillID", "supportSkillId",
                )
                for value in support_skill_ids
            ],
            gekisouSupport=[
                resolve_skill(
                    value, "MasterGekisouSupportSkill", "MasterGekisouSupportSkillEffect",
                    "_gekisouSupportSkillID", "gekisouSupportSkillId",
                )
                for value in gekisou_support_skill_ids
            ],
        )
        record = _present(
            characterId=(character_ids[0] if character_ids else int(row.get("_characterID") or 0)),
            characterIds=character_ids,
            prefix=data.text(row.get("_descriptionTextID" if support else "_subtitleTextID"), ""),
            cardName=data.text(row.get("_nameTextID"), "") if support else None,
            diary=data.text(row.get("_diaryTextID"), "") if support else None,
            rarity=int(row.get("_rarity") or 0),
            cardType=int(row.get("_cardType") or 0),
            assetId=int(row.get("_assetID") or 0),
            type="initial",
            releasedAt=_timestamp(row.get("_startAt")),
            skillId=skill_id,
            liveSkillId=skill_id if not support else None,
            liveSupportSkillId=skill_id if support else None,
            leaderSkillId=_optional_int(row, "_leaderSkillID"),
            gekisouSkillId=_optional_int(row, "_gekisouSkillID"),
            supportSkillIds=support_skill_ids,
            gekisouSupportSkillIds=gekisou_support_skill_ids,
            memberCardLevelGroup=_optional_int(row, "_memberCardLevelGroup"),
            memberCardRankGroup=_optional_int(row, "_memberCardRankGroup"),
            memberCardAwakeGroup=_optional_int(row, "_memberCardAwakeGroup"),
            memberCardAwakeResourceGroup=_optional_int(row, "_memberCardAwakeResourceGroup"),
            supportCardLevelGroup=_optional_int(row, "_supportCardLevelGroup"),
            supportCardRankGroup=_optional_int(row, "_supportCardRankGroup"),
            liveSkillLevelResourceGroup=_optional_int(row, "_liveSkillLevelResourceGroup"),
            linkSkillLevelResourceGroup=_optional_int(row, "_linkSkillLevelResourceGroup"),
            gekisouSkillLevelResourceGroup=_optional_int(
                row, "_gekisouSkillLevelResourceGroup"
            ),
            rankUpItemId=int(row.get("_rankUpItemID") or 0),
            bestMusicTagIds=[int(value) for value in row.get("_bestMusicTagIDs", [])],
            resolvedSkills=resolved_skills,
            images=images,
            stat={
                "performance": int(row.get("_performancePowerMax") or 0),
                "technique": int(row.get("_technicPowerMax") or 0),
                "visual": int(row.get("_visualPowerMax") or 0),
            },
            sourceTable=table,
            raw=row,
        )
        record["supportCardId" if support else "cardId"] = identity
        output[str(identity)] = record
    return output


def _item_entries(data: BuildData) -> dict[int, dict[str, Any]]:
    output: dict[int, dict[str, Any]] = {}
    for row in _sorted_rows(data, "MasterItem"):
        identity = int(row.get("_id") or 0)
        if not identity:
            continue
        image_path = str(row.get("_imagePath") or "").strip("/")
        item_type = int(row.get("_type") or 0)
        output[identity] = _raw_record(
            "MasterItem",
            row,
            itemId=identity,
            name=data.text(row.get("_nameTextId")),
            phoneticName=data.text(row.get("_phoneticNameTextId")),
            description=data.text(row.get("_descriptionTextId")),
            itemType=item_type,
            itemTypeName=ITEM_TYPES.get(item_type),
            imagePath=image_path,
            image=data.asset(f"Assets/AddressableResources/{image_path}.png"),
            displayTargetIds=[int(value) for value in row.get("_displayTargetIds", [])],
            inventoryDisplayGroup=int(row.get("_inventoryDisplayGroup") or 0),
            order=int(row.get("_orderNum") or 0),
            max=int(row.get("_max") or 0),
            value=row.get("_value"),
            startAt=_timestamp(row.get("_startAt")),
            endAt=_timestamp(row.get("_endAt")),
        )
    return output


def _items(data: BuildData) -> dict[str, Any]:
    items = _item_entries(data)
    reward_tables = (
        "MasterReward", "MasterMissionReward", "MasterStoryReward",
        "MasterInvitationReward", "MasterLiveMusicScoreReward",
        "MasterLiveMusicComboReward", "MasterLiveFreeReward",
        "MasterBattleLiveReward", "MasterCharacterRankReward",
        "MasterCharacterFriendshipRankReward", "MasterGekisouLiveRankReward",
        "MasterLiveStamp", "MasterEventPickUpCard",
    )
    rewards = {
        table: [
            _reward_record(data, table, row, items)
            for row in _sorted_rows(data, table)
        ]
        for table in reward_tables
    }
    return {
        "items": {str(identity): row for identity, row in sorted(items.items())},
        "itemTypes": _enum_document("App.Master.ItemType", ITEM_TYPES),
        "resourceTypes": _enum_document("App.Master.GameResourceType", RESOURCE_TYPES),
        "rewards": rewards,
        "sourceTables": ["MasterItem", *reward_tables],
    }


def _canonical_score_charts(files: dict[str, Path]) -> dict[str, dict[str, Any]]:
    if not files:
        return {}
    helper = Path(__file__).with_name("song_metrics.ts")
    result = subprocess.run(
        ["node", str(helper)],
        input=json.dumps({key: str(file.resolve()) for key, file in files.items()}),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(
            "canonical song chart conversion failed:\n" + (result.stderr.strip() or result.stdout.strip())
        )
    try:
        charts = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("canonical song chart converter returned invalid JSON") from error
    missing = sorted(set(files) - set(charts))
    if missing:
        raise RuntimeError("canonical song chart converter omitted: " + ", ".join(missing))
    return charts


def _score_model(data: BuildData) -> dict[str, Any]:
    note_score_percents = {
        int(row.get("_noteOperateType") or 0): float(row.get("_scorePercent") or 0)
        for row in data.rows("MasterLiveNoteParameter")
    }
    combo_bonuses = sorted(
        (
            (int(row.get("_requiredComboCount") or 0), float(row.get("_bonusFactor") or 0))
            for row in data.rows("MasterLiveComboScoreBonus")
            if int(row.get("_comboBonusType") or 0) == 0
        ),
        key=lambda value: value[0],
    )
    numeric_setting_keys = {"note_score_adjustment_factor", "fever_bonus_percent"}
    settings = {
        str(row.get("_key") or ""): float(row.get("_value") or 0)
        for row in data.rows("MasterLiveSettings")
        if str(row.get("_key") or "") in numeric_setting_keys
    }
    judgement_percents = {
        int(row.get("_noteSimulateJudgement") or 0): float(row.get("_scorePercent") or 0)
        for row in data.rows("MasterLiveJudgementParameter")
    }
    missing_settings = sorted(numeric_setting_keys - set(settings))
    if not note_score_percents or not combo_bonuses or missing_settings or 5 not in judgement_percents:
        raise ValueError(
            "native score Master inputs are incomplete: "
            f"noteParameters={len(note_score_percents)}, comboBonuses={len(combo_bonuses)}, "
            f"missingSettings={missing_settings}, perfectJudgement={5 in judgement_percents}"
        )
    return {
        "noteScorePercents": note_score_percents,
        "comboBonuses": combo_bonuses,
        "scoreAdjustment": settings["note_score_adjustment_factor"],
        "feverMultiplier": 1 + settings["fever_bonus_percent"] / 100,
        "perfectFactor": judgement_percents[5] / 100,
    }


def _score_metrics(
    chart: dict[str, Any] | None,
    play_level: int,
    display_level: float,
    note_count: int,
    model: dict[str, Any],
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "r": math.trunc(display_level),
        "playLevel": play_level,
        "displayLevel": math.trunc(display_level),
        "sortLevel": display_level,
        "n": note_count,
        "metricSources": {
            "r": "trunc(MasterLiveMusicScore._musicScoreDisplayLevel)",
            "n": "MasterLiveMusicScore._fullComboCount",
        },
    }
    if not chart:
        metrics.update(metaStatus="unavailable", metaReason="canonical-score-file-missing")
        return metrics

    bpm_events = [
        value
        for value in chart.get("bpmChanges", [])
        if float(value.get("bpm") or 0) > 0
    ]
    if bpm_events:
        bpm_values = [float(value["bpm"]) for value in bpm_events]
        metrics.update(
            firstBpm=bpm_values[0],
            minBpm=min(bpm_values),
            maxBpm=max(bpm_values),
            bpmEvents=bpm_events,
        )
        metrics["metricSources"].update({
            "firstBpm": "canonical score.events.bpm[0]",
            "minBpm": "derived from canonical score.events.bpm",
            "maxBpm": "derived from canonical score.events.bpm",
            "bpmEvents": "canonical score.events.bpm",
        })

    events = chart.get("events", [])
    note_score_percents = model["noteScorePercents"]
    missing_operate_types = sorted({
        int(note.get("operateType") or 0)
        for note in events
        if int(note.get("operateType") or 0) not in note_score_percents
    })
    if missing_operate_types:
        raise ValueError(
            "MasterLiveNoteParameter has no score percentage for canonical note operate types: "
            + ", ".join(str(value) for value in missing_operate_types)
        )
    score_percent_total = sum(
        note_score_percents[int(note.get("operateType") or 0)] for note in events
    )
    converted_note_count = math.ceil(score_percent_total / 100)
    if not converted_note_count:
        raise ValueError("canonical chart has an empty converted note count")

    canonical_note_count = int(chart.get("canonicalNoteCount") or len(events))
    level_factor = 1 + (play_level - 5) * 0.005
    normalize = model["scoreAdjustment"] * level_factor / converted_note_count
    skill_starts = [float(value) for value in chart.get("skillTimesMs", [])]
    fever_ranges = [
        (float(value.get("startTick") or 0), float(value.get("endTick") or 0))
        for value in chart.get("feverRanges", [])
    ]
    inside_skill = 0.0
    outside_skill = 0.0
    combo_bonus = 0.0
    combo_index = 0
    for note in events:
        combo_index += 1
        for required_combo, bonus in model["comboBonuses"]:
            if required_combo > combo_index:
                break
            if required_combo == combo_index:
                combo_bonus += bonus
        contribution = (
            note_score_percents[int(note.get("operateType") or 0)]
            / 100
            * (1 + combo_bonus)
            * normalize
        )
        tick = float(note.get("tick") or 0)
        if any(start <= tick <= end for start, end in fever_ranges):
            contribution *= model["feverMultiplier"]
        time_ms = float(note.get("timeMs") or 0)
        if any(
            start <= time_ms <= start + META_REFERENCE_SKILL_SECONDS * 1000
            for start in skill_starts
        ):
            inside_skill += contribution
        else:
            outside_skill += contribution

    inside_skill = round(inside_skill, 8)
    outside_skill = round(outside_skill, 8)
    total = inside_skill + outside_skill
    relative_score = round(model["perfectFactor"] * total, 8)
    warnings = []
    if note_count and canonical_note_count != note_count:
        warnings.append("canonical-full-combo-mismatch")
    metrics.update(
        score=relative_score,
        sr=round(inside_skill / total, 8) if total else 0,
        convertedNoteCount=converted_note_count,
        canonicalNoteCount=canonical_note_count,
        levelFactor=level_factor,
        metaStatus="available",
        scoreKind="chart-relative-factor",
        absoluteScoreAvailable=False,
        reference={
            "fever": True,
            "perfectRate": 1,
            "scoreUpMultiplier": 1,
            "skillDurationSeconds": META_REFERENCE_SKILL_SECONDS,
            "downtimeSeconds": META_REFERENCE_DOWNTIME_SECONDS,
            "intervalEndInclusive": True,
        },
        _durationSeconds=float(chart.get("durationMs") or 0) / 1000,
    )
    if warnings:
        metrics["metaWarnings"] = warnings
    metrics["metricSources"].update({
        "score": (
            "canonical judged-note order + MasterLiveNoteParameter + MasterLiveComboScoreBonus + "
            "MasterLiveSettings + level factor + CalcNoteScoreCore"
        ),
        "sr": (
            "7-second closed skill intervals; SkillEffectUpdater.UpdateExecuting"
        ),
        "convertedNoteCount": (
            "ceil(sum(note score percent) / 100); LiveMusicScore.GetConvertedNoteCount"
        ),
        "canonicalNoteCount": "canonical native-backed chart conversion judged-note sequence",
    })
    return metrics


def _songs(data: BuildData) -> tuple[dict[str, Any], dict[str, Any]]:
    score_rows = {int(row.get("_id") or 0): row for row in data.rows("MasterLiveMusicScore")}
    score_paths = {
        str(identity): data.assets
        / Path(
            *PurePosixPath(
                "Assets/AddressableResources/Live/MusicScore/"
                + str(row.get("_musicScoreTextFileName") or "")
                + ".bytes"
            ).parts
        )
        for identity, row in score_rows.items()
    }
    canonical_charts = _canonical_score_charts({
        identity: file for identity, file in score_paths.items() if file.is_file()
    })
    score_model = _score_model(data)
    items = _item_entries(data)
    score_ranks_by_group: dict[int, list[dict[str, Any]]] = {}
    for score_rank in _sorted_rows(data, "MasterLiveScoreRank", "_group", "_liveScoreRank", "_id"):
        score_ranks_by_group.setdefault(int(score_rank.get("_group") or 0), []).append(
            _raw_record(
                "MasterLiveScoreRank", score_rank,
                scoreRankId=int(score_rank.get("_id") or 0),
                scoreRank=int(score_rank.get("_liveScoreRank") or 0),
                requiredScore=int(score_rank.get("_requiredScore") or 0),
                battleLiveRequiredScore=int(score_rank.get("_battleLiveRequiredScore") or 0),
            )
        )
    score_rewards_by_group: dict[int, list[dict[str, Any]]] = {}
    for reward in _sorted_rows(
        data, "MasterLiveMusicScoreReward", "_group", "_liveScoreRank", "_id"
    ):
        group = int(reward.get("_group") or 0)
        score_rewards_by_group.setdefault(group, []).append(
            {
                **_reward_record(data, "MasterLiveMusicScoreReward", reward, items),
                "liveScoreRank": int(reward.get("_liveScoreRank") or 0),
            }
        )
    combo_rewards_by_group: dict[int, dict[int, list[dict[str, Any]]]] = {}
    for reward in _sorted_rows(
        data, "MasterLiveMusicComboReward", "_group", "_difficulty", "_comboRateType", "_id"
    ):
        group = int(reward.get("_group") or 0)
        difficulty = int(reward.get("_difficulty") or 0)
        combo_rewards_by_group.setdefault(group, {}).setdefault(difficulty, []).append(
            {
                **_reward_record(data, "MasterLiveMusicComboReward", reward, items),
                "difficulty": difficulty,
                "comboRateType": int(reward.get("_comboRateType") or 0),
            }
        )
    light_colors = {
        int(row.get("_id") or 0): _raw_record(
            "MasterLiveMusicLightColor", row, lightColorId=int(row.get("_id") or 0)
        )
        for row in data.rows("MasterLiveMusicLightColor")
    }
    output = {}
    metadata = {}
    for row in data.rows("MasterLiveMusic"):
        identity = int(row.get("_id") or 0)
        if not identity:
            continue
        difficulties = []
        song_metadata = {}
        difficulty_metrics = []
        for index, name in enumerate(DIFFICULTIES):
            score_id = int(row.get(f"_{name}ID") or 0)
            score = score_rows.get(score_id)
            if not score:
                continue
            score_name = str(score.get("_musicScoreTextFileName") or "")
            score_path = f"Assets/AddressableResources/Live/MusicScore/{score_name}.bytes"
            score_file = data.asset(score_path)
            note_count = int(score.get("_fullComboCount") or 0)
            play_level = int(score.get("_musicScoreLevel") or 0)
            sort_level = float(score.get("_musicScoreDisplayLevel") or play_level)
            display_level = math.trunc(sort_level)
            difficulties.append(
                _present(
                    difficulty=index,
                    difficultyName=name,
                    playLevel=play_level,
                    displayLevel=display_level,
                    sortLevel=sort_level,
                    noteCount=note_count,
                    publishedAt=_timestamp(row.get("_startAt")),
                    file=score_file,
                )
            )
            metrics = _score_metrics(
                canonical_charts.get(str(score_id)),
                play_level,
                sort_level,
                note_count,
                score_model,
            )
            if metrics:
                song_metadata[str(index)] = {"chart": metrics}
                difficulty_metrics.append(metrics)
        song_seconds = max(
            (float(metrics.pop("_durationSeconds", 0)) for metrics in difficulty_metrics),
            default=0,
        )
        if song_seconds:
            for metrics in difficulty_metrics:
                metrics.update(
                    time=round(song_seconds, 3),
                    nps=round(float(metrics.get("n") or 0) / song_seconds, 3),
                )
                if metrics.get("score") is not None:
                    metrics["eff"] = round(
                        float(metrics["score"])
                        / (song_seconds + META_REFERENCE_DOWNTIME_SECONDS)
                        * 60,
                        8,
                    )
                metrics["metricSources"].update({
                    "time": "maximum canonical last-judged-note time across song difficulties",
                    "nps": "MasterLiveMusicScore._fullComboCount / song time",
                })
                if metrics.get("eff") is not None:
                    metrics["metricSources"]["eff"] = (
                        "relative score / (song time + 30-second reference downtime) * 60"
                    )
        sound = data.music_sound(int(row.get("_musicSoundID") or 0))
        music = sound.get("playableUrl") if sound else None
        jacket = str(row.get("_jacketAssetName") or "")
        output[str(identity)] = _present(
            musicId=identity,
            musicTitle=data.text(row.get("_titleTextID"), f"Music {identity}"),
            artistName=(
                data.text(row.get("_bandNameTextID"), "")
                if row.get("_bandNameTextID")
                else None
            ),
            bandId=int((row.get("_bandIDs") or [0])[0] or 0),
            bandIds=[int(value) for value in row.get("_bandIDs", [])],
            publishedAt=_timestamp(row.get("_startAt")),
            jacketUrl=data.asset(f"Assets/AddressableResources/Image/Jacket/{jacket}.png"),
            jacketThumbUrl=data.asset(f"Assets/AddressableResources/Image/Jacket/small/{jacket}.png"),
            musicUrl=music,
            musicSound=sound,
            difficulty=difficulties,
            lyricist=data.text(row.get("_lyricistTextID"), ""),
            composer=data.text(row.get("_composerTextID"), ""),
            arranger=data.text(row.get("_arrangerTextID"), ""),
            vocalCharacterIds=[int(value) for value in row.get("_vocalCharacterIDs", [])],
            musicType=int(row.get("_musicType") or 0),
            musicCategories=[int(value) for value in row.get("_musicCategories", [])],
            liveScoreRankGroup=int(row.get("_liveScoreRankGroup") or 0),
            scoreRankRewardGroup=int(row.get("_scoreRankRewardGroup") or 0),
            comboRewardGroup=int(row.get("_comboRewardGroup") or 0),
            scoreRanks=score_ranks_by_group.get(int(row.get("_liveScoreRankGroup") or 0), []),
            scoreRewards=score_rewards_by_group.get(int(row.get("_scoreRankRewardGroup") or 0), []),
            comboRewards={
                name: combo_rewards_by_group.get(
                    int(row.get("_comboRewardGroup") or 0), {}
                ).get(difficulty, [])
                for name, difficulty in (
                    ("easy", 0), ("normal", 1), ("hard", 2), ("expert", 3),
                )
            },
            lightColors=_present(
                normal=light_colors.get(int(row.get("_musicLightColorIDNormal") or 0)),
                chorus=light_colors.get(int(row.get("_musicLightColorIDChorus") or 0)),
            ),
            gekisou=_present(
                missionTypes=[
                    int(row.get(f"_gekisouMission{index}") or 0) for index in range(1, 4)
                ],
                callSe=int(row.get("_gekisouCallSe") or 0),
            ),
            videoIds=[int(value) for value in row.get("_musicVideoIDs", [])],
            evidence={
                "musicSoundBinding": (
                    "MasterLiveMusic._musicSoundID -> MasterSound._soundCueSheetID -> "
                    "MasterSoundCueSheet._cueSheetName -> exact MusicScore CRI ACB runtimePath"
                ),
            },
            sourceTable="MasterLiveMusic",
            raw=row,
        )
        metadata[str(identity)] = {
            **song_metadata,
            "scoreRanks": score_ranks_by_group.get(int(row.get("_liveScoreRankGroup") or 0), []),
            "scoreRewards": output[str(identity)].get("scoreRewards", []),
            "comboRewards": output[str(identity)].get("comboRewards", {}),
            "expRewards": [
                _raw_record(
                    "MasterLiveMusicExpReward", reward,
                    liveScoreRank=int(reward.get("_liveScoreRank") or 0),
                    playerExp=int(reward.get("_playerExp") or 0),
                    memberCardExp=int(reward.get("_memberCardExp") or 0),
                    characterRankExp=int(reward.get("_characterRankExp") or 0),
                    friendshipExp=int(reward.get("_friendshipExp") or 0),
                    livePoint=int(reward.get("_livePoint") or 0),
                    eventPoint=int(reward.get("_eventPoint") or 0),
                )
                for reward in _sorted_rows(data, "MasterLiveMusicExpReward", "_liveScoreRank", "_id")
            ],
            "lightColors": output[str(identity)].get("lightColors"),
            "sourceTables": [
                "MasterLiveMusic", "MasterLiveMusicScore", "MasterLiveScoreRank",
                "MasterLiveMusicScoreReward", "MasterLiveMusicComboReward",
                "MasterLiveMusicExpReward", "MasterLiveMusicLightColor",
                "MasterLiveNoteParameter", "MasterLiveJudgementParameter",
                "MasterLiveComboScoreBonus", "MasterLiveSettings",
            ],
        }
    return output, metadata


def _comics(data: BuildData) -> dict[str, Any]:
    output = {}
    for row in data.rows("MasterLoadingComics"):
        identity = int(row.get("_id") or 0)
        asset = str(row.get("_imageAsset") or f"comic_{identity:03d}_1")
        url = data.asset(f"Assets/AddressableResources/Image/Comic/{asset}.png")
        output[str(identity)] = _present(
            comicId=identity,
            title=data.text(row.get("_titleTextId"), f"Comic {identity}"),
            publicStartAt=_timestamp(row.get("_startAt")),
            characters=[int(value) for value in row.get("_characterIds", [])],
            thumbnail=url,
            image=url,
        )
    return output


def _stamps(data: BuildData) -> dict[str, Any]:
    output = {}
    for row in data.rows("MasterStamp"):
        identity = int(row.get("_id") or 0)
        asset = PurePosixPath(str(row.get("_stampAsset") or "")).name
        output[str(identity)] = _present(
            stampId=identity,
            name=data.text(row.get("_nameTextId"), f"Stamp {identity}"),
            characterIds=[int(value) for value in row.get("_characterIds", [])],
            releasedAt=_timestamp(row.get("_startAt")),
            image=data.asset(f"Assets/AddressableResources/Stamp/illust/{asset}.png"),
        )
    return output


def _unity_pointer_id(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    try:
        file_id = int(value.get("m_FileID") or 0)
        path_id = int(value.get("m_PathID") or 0)
    except (TypeError, ValueError):
        return None
    if file_id:
        raise ValueError(
            f"Unity external pointer requires an exact serialized-file resolver: "
            f"{file_id}:{path_id}"
        )
    return str(path_id) if path_id else None


def _unity_component_ids(game_object: dict[str, Any]) -> list[str]:
    output = []
    for entry in game_object.get("m_Component", []):
        pointer = entry.get("component") if isinstance(entry, dict) else None
        object_id = _unity_pointer_id(pointer if pointer is not None else entry)
        if object_id:
            output.append(object_id)
    return output


def _volume_profile_from_objects(
    data: BuildData,
    descriptor: dict[str, Any],
    objects: dict[str, dict[str, Any]],
    root_id: str,
    source_path: str,
) -> dict[str, Any]:
    root = objects.get(root_id)
    root_data = root.get("data", {}) if isinstance(root, dict) else {}
    component_pointers = root_data.get("components")
    if (
        not isinstance(root, dict)
        or root.get("type") != "MonoBehaviour"
        or not isinstance(component_pointers, list)
    ):
        raise ValueError(f"Unity VolumeProfile root is invalid: {source_path}::{root_id}")

    components: dict[str, dict[str, Any]] = {}
    component_order = []
    for pointer in component_pointers:
        if not isinstance(pointer, dict) or int(pointer.get("m_FileID") or 0) != 0:
            raise ValueError(
                f"Unity VolumeProfile has an external component: {source_path}::{root_id}"
            )
        component_id = _unity_pointer_id(pointer)
        component = objects.get(component_id or "")
        component_data = component.get("data", {}) if isinstance(component, dict) else {}
        name = str(component_data.get("m_Name") or "")
        if component.get("type") != "MonoBehaviour" or not name:
            raise ValueError(
                f"Unity VolumeProfile component is invalid: {source_path}::{component_id}"
            )
        if name in components:
            raise ValueError(f"Unity VolumeProfile repeats component {name}: {source_path}")
        fields = {}
        for field_name, field in component_data.items():
            if not isinstance(field, dict) or "m_Value" not in field:
                continue
            field_value = field.get("m_Value")
            if (
                isinstance(field_value, dict)
                and "m_FileID" in field_value
                and "m_PathID" in field_value
            ):
                field_value = data.portable_unity_pointer(
                    field_value, str(descriptor.get("serializedFile") or "")
                )
            fields[field_name] = {
                "override": bool(field.get("m_OverrideState")),
                "value": field_value,
            }
        components[name] = {
            "name": name,
            "active": bool(component_data.get("active", component_data.get("m_Enabled", 1))),
            "fields": fields,
        }
        component_order.append(name)

    name = str(root_data.get("m_Name") or PurePosixPath(source_path).stem)
    profile = {
        "name": name,
        "componentOrder": component_order,
        "components": components,
        "sourcePath": source_path,
        "unityObject": {
            "serializedFile": descriptor.get("serializedFile"),
            "pathId": root_id,
        },
    }
    curved_lens = components.get("AdvCurvedLens")
    if curved_lens is not None:
        profile["curvedLens"] = {
            "active": curved_lens["active"],
            **{
                field_name: field["value"]
                for field_name, field in curved_lens["fields"].items()
                if field["override"]
            },
        }
    return profile


def _volume_profile(data: BuildData, source_path: str) -> dict[str, Any]:
    cached = data._volume_profile_cache.get(source_path)
    if cached is not None:
        return cached
    descriptor, objects = data.source_objects(source_path)
    root_ids = [str(int(value)) for value in descriptor.get("rootObjects", [])]
    if len(root_ids) != 1:
        raise ValueError(f"Unity VolumeProfile must have exactly one root: {source_path}")
    profile = _volume_profile_from_objects(
        data, descriptor, objects, root_ids[0], source_path
    )
    data._volume_profile_cache[source_path] = profile
    return profile


def _stage_volume_profiles(
    data: BuildData,
) -> tuple[dict[tuple[str, str], dict[str, Any]], dict[str, dict[str, Any]]]:
    if data._stage_profile_index is not None and data._stage_profile_name_index is not None:
        return data._stage_profile_index, data._stage_profile_name_index
    by_object_id: dict[tuple[str, str], dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    prefix = ADV_STAGE_POST_EFFECT_ROOT + "/"
    for source_path in data.source_paths:
        if not source_path.startswith(prefix) or not source_path.endswith(".asset"):
            continue
        descriptor = data.source_descriptor(source_path)
        root_ids = [str(int(value)) for value in descriptor.get("rootObjects", [])]
        if len(root_ids) != 1:
            raise ValueError(f"Stage VolumeProfile must have exactly one root: {source_path}")
        profile = _volume_profile(data, source_path)
        identity = (str(descriptor.get("serializedFile") or ""), root_ids[0])
        previous = by_object_id.get(identity)
        if previous is not None and previous != profile:
            raise ValueError(
                f"Stage VolumeProfile identity collision: {identity[0]}:{identity[1]}"
            )
        if profile["name"] in by_name and by_name[profile["name"]] != profile:
            raise ValueError(f"Stage VolumeProfile name collision: {profile['name']}")
        by_object_id[identity] = profile
        by_name[profile["name"]] = profile
    if not by_object_id:
        raise ValueError("No ADV stage VolumeProfiles were loaded")
    data._stage_profile_index = by_object_id
    data._stage_profile_name_index = by_name
    return by_object_id, by_name


def _unity_quaternion(value: Any) -> tuple[float, float, float, float]:
    raw = value if isinstance(value, dict) else {}
    quaternion = tuple(float(raw.get(key) or 0) for key in ("x", "y", "z")) + (
        float(raw.get("w") if raw.get("w") is not None else 1),
    )
    length = math.sqrt(sum(component * component for component in quaternion))
    return tuple(component / length for component in quaternion) if length else (0, 0, 0, 1)


def _unity_quaternion_multiply(
    left: tuple[float, float, float, float], right: tuple[float, float, float, float]
) -> tuple[float, float, float, float]:
    lx, ly, lz, lw = left
    rx, ry, rz, rw = right
    return _unity_quaternion(
        {
            "x": lw * rx + lx * rw + ly * rz - lz * ry,
            "y": lw * ry - lx * rz + ly * rw + lz * rx,
            "z": lw * rz + lx * ry - ly * rx + lz * rw,
            "w": lw * rw - lx * rx - ly * ry - lz * rz,
        }
    )


def _unity_quaternion_rotate(
    quaternion: tuple[float, float, float, float], vector: tuple[float, float, float]
) -> tuple[float, float, float]:
    x, y, z, w = quaternion
    vx, vy, vz = vector
    cross_x = y * vz - z * vy
    cross_y = z * vx - x * vz
    cross_z = x * vy - y * vx
    second_x = y * cross_z - z * cross_y
    second_y = z * cross_x - x * cross_z
    second_z = x * cross_y - y * cross_x
    return (
        vx + 2 * (w * cross_x + second_x),
        vy + 2 * (w * cross_y + second_y),
        vz + 2 * (w * cross_z + second_z),
    )


def _unity_vector3(value: Any, default: float = 0) -> tuple[float, float, float]:
    raw = value if isinstance(value, dict) else {}
    return tuple(
        float(raw.get(key) if raw.get(key) is not None else default)
        for key in ("x", "y", "z")
    )


def _unity_world_transform(
    objects: dict[str, dict[str, Any]],
    transform_id: str,
    source_path: str,
    cache: dict[str, dict[str, Any]],
    stack: set[str] | None = None,
) -> dict[str, Any]:
    cached = cache.get(transform_id)
    if cached is not None:
        return cached
    active_stack = set() if stack is None else stack
    if transform_id in active_stack:
        raise ValueError(f"ADV stage Transform hierarchy is cyclic: {source_path}::{transform_id}")
    transform = objects.get(transform_id)
    raw = transform.get("data", {}) if isinstance(transform, dict) else {}
    if not isinstance(transform, dict) or transform.get("type") not in ("Transform", "RectTransform"):
        raise ValueError(f"ADV stage Transform is invalid: {source_path}::{transform_id}")

    active_stack.add(transform_id)
    local_position = _unity_vector3(raw.get("m_LocalPosition"))
    local_rotation = _unity_quaternion(raw.get("m_LocalRotation"))
    local_scale = _unity_vector3(raw.get("m_LocalScale"), 1)
    parent_id = _unity_pointer_id(raw.get("m_Father"))
    if parent_id:
        parent = _unity_world_transform(objects, parent_id, source_path, cache, active_stack)
        scaled_position = tuple(
            local_position[index] * parent["scale"][index] for index in range(3)
        )
        rotated_position = _unity_quaternion_rotate(parent["rotation"], scaled_position)
        position = tuple(
            parent["position"][index] + rotated_position[index] for index in range(3)
        )
        rotation = _unity_quaternion_multiply(parent["rotation"], local_rotation)
        scale = tuple(
            parent["scale"][index] * local_scale[index] for index in range(3)
        )
    else:
        position, rotation, scale = local_position, local_rotation, local_scale
    active_stack.remove(transform_id)
    world = {"position": position, "rotation": rotation, "scale": scale}
    cache[transform_id] = world
    return world


def _unity_vector_document(value: tuple[float, ...], keys: str) -> dict[str, float]:
    return dict(zip(keys, value, strict=True))


def _stage_light(
    objects: dict[str, dict[str, Any]],
    pointer: Any,
    source_path: str,
    transform_cache: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    wrapper_id = _unity_pointer_id(pointer)
    wrapper = objects.get(wrapper_id or "")
    wrapper_data = wrapper.get("data", {}) if isinstance(wrapper, dict) else {}
    game_object_id = _unity_pointer_id(wrapper_data.get("m_GameObject"))
    game_object = objects.get(game_object_id or "")
    game_object_data = game_object.get("data", {}) if isinstance(game_object, dict) else {}
    if game_object.get("type") != "GameObject":
        raise ValueError(f"ADV stage light has no GameObject: {source_path}::{wrapper_id}")
    component_ids = _unity_component_ids(game_object_data)
    light = next(
        (
            objects[value]
            for value in component_ids
            if objects.get(value, {}).get("type") == "Light"
        ),
        None,
    )
    transform_id = next(
        (
            value
            for value in component_ids
            if objects.get(value, {}).get("type") in ("Transform", "RectTransform")
        ),
        None,
    )
    if light is None or transform_id is None:
        raise ValueError(f"ADV stage light components are incomplete: {source_path}::{wrapper_id}")
    light_data = light.get("data", {})
    transform = _unity_world_transform(objects, transform_id, source_path, transform_cache)
    forward = _unity_quaternion_rotate(transform["rotation"], (0, 0, 1))
    light_type = int(light_data.get("m_Type") or 0)
    return {
        "active": bool(game_object_data.get("m_IsActive", 1))
        and bool(light_data.get("m_Enabled", 1)),
        "name": str(game_object_data.get("m_Name") or ""),
        "type": light_type,
        "typeName": {0: "Spot", 1: "Directional", 2: "Point", 3: "Area"}.get(
            light_type, str(light_type)
        ),
        "color": light_data.get("m_Color"),
        "intensity": float(light_data.get("m_Intensity") or 0),
        "range": float(light_data.get("m_Range") or 0),
        "spotAngle": float(light_data.get("m_SpotAngle") or 0),
        "innerSpotAngle": float(light_data.get("m_InnerSpotAngle") or 0),
        "worldPosition": _unity_vector_document(transform["position"], "xyz"),
        "worldRotation": _unity_vector_document(transform["rotation"], "xyzw"),
        "worldForward": _unity_vector_document(forward, "xyz"),
    }


def _stage_background_sprite(
    data: BuildData,
    pointer: Any,
    owner_serialized_file: str,
    source_path: str,
    asset_name: str,
) -> dict[str, Any]:
    identity = data.unity_pointer_identity(pointer, owner_serialized_file)
    sprite = data.unity_object(pointer, owner_serialized_file, "Sprite")
    sprite_data = sprite.get("data", {}) if isinstance(sprite, dict) else {}
    if identity is None or not isinstance(sprite, dict) or sprite.get("type") != "Sprite":
        raise ValueError(
            f"ADV stage background Sprite is unresolved: {source_path}"
        )
    serialized_file, object_id = identity
    sprite_source = f"{ADV_STAGE_ROOT}/{asset_name}/data/{asset_name}.png"
    descriptor, sprite_objects = data.source_objects(sprite_source)
    root_ids = {str(int(value)) for value in descriptor.get("rootObjects", [])}
    if (
        descriptor.get("serializedFile") != serialized_file
        or object_id not in root_ids
        or sprite_objects.get(object_id, {}).get("type") != "Sprite"
    ):
        raise ValueError(
            f"ADV stage background Sprite source mismatch: {sprite_source}::{object_id}"
        )
    source_data = sprite_objects[object_id].get("data", {})
    if source_data != sprite_data:
        raise ValueError(
            f"ADV stage background Sprite archive diverges: {sprite_source}::{object_id}"
        )
    rect = source_data.get("m_Rect", {})
    width = float(rect.get("width") or 0)
    height = float(rect.get("height") or 0)
    pixels_to_units = float(source_data.get("m_PixelsToUnits") or 0)
    if width <= 0 or height <= 0 or pixels_to_units <= 0:
        raise ValueError(f"ADV stage background Sprite geometry is invalid: {sprite_source}")
    return {
        "name": str(source_data.get("m_Name") or asset_name),
        "sourcePath": sprite_source,
        "serializedFile": serialized_file,
        "objectId": object_id,
        "rect": {
            "x": float(rect.get("x") or 0),
            "y": float(rect.get("y") or 0),
            "width": width,
            "height": height,
        },
        "pivot": source_data.get("m_Pivot"),
        "pixelsToUnits": pixels_to_units,
        "worldSize": {
            "width": width / pixels_to_units,
            "height": height / pixels_to_units,
        },
    }


def _stage_runtime(data: BuildData, asset_name: str) -> dict[str, Any]:
    cached = data._adv_stage_cache.get(asset_name)
    if cached is not None:
        return cached
    source_path = f"{ADV_STAGE_ROOT}/{asset_name}/{asset_name}.prefab"
    descriptor, objects = data.source_objects(source_path)
    root_ids = [str(int(value)) for value in descriptor.get("rootObjects", [])]
    if len(root_ids) != 1 or objects[root_ids[0]].get("type") != "GameObject":
        raise ValueError(f"ADV stage must have exactly one GameObject root: {source_path}")
    stage_candidates = [
        value.get("data", {})
        for value in objects.values()
        if value.get("type") == "MonoBehaviour"
        and "_backgroundSprite" in value.get("data", {})
        and "_focusPointsCollection" in value.get("data", {})
    ]
    if len(stage_candidates) != 1:
        raise ValueError(
            f"ADV stage settings must resolve uniquely: {source_path}; found {len(stage_candidates)}"
        )
    raw = stage_candidates[0]
    background_sprite = _stage_background_sprite(
        data,
        raw.get("_backgroundSprite"),
        str(descriptor.get("serializedFile") or ""),
        source_path,
        asset_name,
    )
    profiles_by_object_id, _ = _stage_volume_profiles(data)
    profile_refs = []
    for pointer in raw.get("_allVolumeProfileCollection", {}).get("_profiles", []):
        profile_identity = data.unity_pointer_identity(
            pointer, str(descriptor.get("serializedFile") or "")
        )
        profile = profiles_by_object_id.get(profile_identity) if profile_identity else None
        if profile is None:
            raise ValueError(
                f"ADV stage references an unknown VolumeProfile: "
                f"{source_path}::{profile_identity}"
            )
        profile_refs.append(profile["name"])

    light_groups = []
    transform_cache: dict[str, dict[str, Any]] = {}
    for group in raw.get("_lightGroupCollection", {}).get("_groups", []):
        light_groups.append(
            {
                "lights": [
                    _stage_light(objects, pointer, source_path, transform_cache)
                    for pointer in group.get("_lights", [])
                ]
            }
        )

    focus_groups = [
        entry.get("_focusPointPositions", [])
        for entry in raw.get("_focusPointsCollection", {}).get("_entries", [])
    ]
    stage = {
        "assetName": asset_name,
        "sourcePath": source_path,
        "backgroundColor": raw.get("_backgroundColor"),
        "backgroundSprite": background_sprite,
        "backgroundSize": background_sprite["worldSize"],
        "backgroundFieldPosition": raw.get("_backgroundFieldPosition"),
        "backgroundFieldScale": float(raw.get("_backgroundFieldScale") or 0),
        "characterFieldPosition": raw.get("_characterFieldPosition"),
        "characterFieldScale": float(raw.get("_characterFieldScale") or 0),
        "focusPointGroups": focus_groups,
        "fov": float(raw.get("_fov") or 0),
        "initialCameraPosition": raw.get("_initialCameraPosition"),
        "initialCameraRotation": raw.get("_initialCameraRotation"),
        "usingFocusDataSettingsKey": str(raw.get("_usingFocusDataSettingsKey") or ""),
        "environmentPostEffectRefs": profile_refs,
        "environmentLightGroups": light_groups,
        "shadowTextureUv": raw.get("_shadowTextureUv"),
        "shadowTextureAmplitude": raw.get("_shadowTextureAmplitude"),
        "shadowTextureFrequency": float(raw.get("_shadowTextureFrequency") or 0),
        "shadowTextureIntensity": float(raw.get("_shadowTextureIntensity") or 0),
    }
    data._adv_stage_cache[asset_name] = stage
    return stage


def _story_commands(data: BuildData, asset_name: str) -> list[dict[str, Any]]:
    base = data.assets / "Assets" / "AddressableResources" / "Adv" / "Episode" / asset_name
    episode_file = base / f"{asset_name}-Episode.txt"
    text_file = base / f"{asset_name}-Text.txt"
    if not episode_file.is_file():
        return []
    text_rows = read_json(text_file).get("_allData", []) if text_file.is_file() else []
    texts = {str(row.get("_id")): _localized(row) for row in text_rows}
    output = []
    for row in read_json(episode_file).get("_allData", []):
        code = int(row.get("_command") or 0)
        text_id = str(row.get("_advTextID") or "")
        target_text_ids = [
            str(value) for value in row.get("_targetTextIDs", []) if str(value)
        ]
        unresolved_target_text_ids = [
            value for value in target_text_ids if value not in texts
        ]
        if unresolved_target_text_ids:
            raise ValueError(
                f"ADV command has unresolved target text IDs: {asset_name}::"
                f"{int(row.get('_index') or 0)} ({', '.join(unresolved_target_text_ids)})"
            )
        output.append(
            _present(
                index=int(row.get("_index") or 0),
                advId=int(row.get("_advID") or 0),
                command=code,
                type=COMMAND_NAMES.get(code, "unknown"),
                targetName=row.get("_targetName"),
                targetAssetName=row.get("_targetAssetName"),
                targetAssetIndex=int(row.get("_targetAssetIndex") or 0),
                targetStatus=int(row.get("_targetStatus") or 0),
                targetTextIds=target_text_ids,
                targetTextColors=[
                    str(value) for value in row.get("_targetTextColors", [])
                ],
                targetTextNames=[texts[value] for value in target_text_ids],
                targetChatID=int(row.get("_targetChatID") or 0),
                positionType=int(row.get("_positionType") or 0),
                cameraDistance=int(row.get("_cameraDistance") or 0),
                duration=float(row.get("_duration") or 0),
                delaySeconds=float(row.get("_delaySeconds") or 0),
                noWait=bool(row.get("_isNoWait")),
                motionWait=float(row.get("_motionWait") or 0),
                motionName=row.get("_motionName"),
                expressionName=row.get("_expressionName"),
                motionFadeIn=float(row.get("_motionFadeIn") or 0),
                advTextId=text_id,
                text=texts.get(text_id, ["", "", "", "", ""]),
                canvasLayers=row.get("_canvasLayers") or [],
                params=[row.get(f"_parameter{index}") or "" for index in range(1, 5)],
                key=row.get("_key"),
                ignoreLipSync=bool(row.get("_ignoreLipSync")),
                ignoreData=bool(row.get("_ignoreData")),
                voiceIds=[int(value) for value in row.get("_voiceIDs", [])],
                bgmId=int(row.get("_bgmID") or 0),
                seId=int(row.get("_seID") or 0),
                videoId=int(row.get("_videoID") or 0),
                raw=row,
            )
        )
    return output


def _adv_sound_maps(
    sound_file: Path, cue_sheet_file: Path
) -> tuple[dict[int, dict[str, Any]], dict[int, dict[str, Any]]]:
    sound_rows = {
        int(row.get("_id") or 0): row
        for row in (read_json(sound_file).get("_allData", []) if sound_file.is_file() else [])
        if int(row.get("_id") or 0)
    }
    cue_sheet_rows = {
        int(row.get("_id") or 0): row
        for row in (
            read_json(cue_sheet_file).get("_allData", [])
            if cue_sheet_file.is_file()
            else []
        )
        if int(row.get("_id") or 0)
    }
    return sound_rows, cue_sheet_rows


def _story_sound_maps(
    data: BuildData, asset_name: str
) -> tuple[dict[int, dict[str, Any]], dict[int, dict[str, Any]]]:
    base = data.assets / "Assets" / "AddressableResources" / "Adv" / "Episode" / asset_name
    return _adv_sound_maps(
        base / f"{asset_name}-Sound.txt",
        base / f"{asset_name}-SoundCueSheet.txt",
    )


def _frame_game_objects(
    objects: dict[str, dict[str, Any]],
) -> dict[str, tuple[str, dict[str, Any]]]:
    return {
        str(record.get("data", {}).get("m_Name") or ""): (object_id, record)
        for object_id, record in objects.items()
        if record.get("type") == "GameObject"
    }


def _frame_component(
    objects: dict[str, dict[str, Any]], game_object: dict[str, Any], component_type: str
) -> dict[str, Any] | None:
    for object_id in _unity_component_ids(game_object.get("data", {})):
        component = objects.get(object_id)
        if component and component.get("type") == component_type:
            return component
    return None


def _frame_image_component(
    objects: dict[str, dict[str, Any]], game_object: dict[str, Any]
) -> dict[str, Any] | None:
    for object_id in _unity_component_ids(game_object.get("data", {})):
        component = objects.get(object_id)
        raw = component.get("data", {}) if isinstance(component, dict) else {}
        if (
            component
            and component.get("type") == "MonoBehaviour"
            and "m_Color" in raw
            and "m_Sprite" in raw
            and "m_Maskable" in raw
        ):
            return component
    return None


def _frame_color(value: Any) -> str:
    raw = value if isinstance(value, dict) else {}
    channels = tuple(float(raw.get(key) or 0) for key in ("r", "g", "b"))
    return "#" + "".join(f"{max(0, min(255, round(channel * 255))):02x}" for channel in channels)


def _unity_min_max(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    mode = int(raw.get("minMaxState") or 0)
    maximum = float(raw.get("scalar") or 0)
    minimum = maximum if mode == 0 else float(raw.get("minScalar") or 0)
    return {
        "mode": mode,
        "min": min(minimum, maximum),
        "max": max(minimum, maximum),
    }


def _unity_rotation_z(value: Any) -> float:
    x, y, z, w = _unity_quaternion(value)
    return math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


def _rain_frame_runtime(
    data: BuildData,
    target_asset: str,
    source_path: str,
    objects: dict[str, dict[str, Any]],
    root: dict[str, Any],
    canvas_alpha: float,
) -> dict[str, Any]:
    leaf = PurePosixPath(target_asset).name.casefold()
    variant = "heavy" if "heavy" in leaf else "light" if "light" in leaf else "usually"
    direction = "left" if "left" in leaf else "vertical" if "vertical" in leaf else "slant"
    root_rect = _frame_component(objects, root, "RectTransform")
    frame_root_raw = root_rect.get("data", {}) if root_rect else {}
    effect_root = _frame_game_objects(objects).get("Root", ("", {}))[1]
    effect_rect = _frame_component(objects, effect_root, "RectTransform") if effect_root else None
    layers = []
    for particle in objects.values():
        if particle.get("type") != "ParticleSystem":
            continue
        raw = particle.get("data", {})
        emission = raw.get("EmissionModule", {})
        if not emission.get("enabled"):
            continue
        game_object_id = _unity_pointer_id(raw.get("m_GameObject"))
        game_object = objects.get(game_object_id or "")
        if not game_object or game_object.get("type") != "GameObject":
            raise ValueError(f"ADV rain frame ParticleSystem has no GameObject: {source_path}")
        initial = raw.get("InitialModule", {})
        shape = raw.get("ShapeModule", {})
        velocity = raw.get("VelocityModule", {})
        rect = _frame_component(objects, game_object, "RectTransform")
        renderer = _frame_component(objects, game_object, "ParticleSystemRenderer")
        rect_raw = rect.get("data", {}) if rect else {}
        renderer_raw = renderer.get("data", {}) if renderer else {}
        start_color = initial.get("startColor", {})
        layers.append(
            {
                "name": str(game_object.get("data", {}).get("m_Name") or ""),
                "rate": float(emission.get("rateOverTime", {}).get("scalar") or 0),
                "duration": float(raw.get("lengthInSec") or 0),
                "prewarm": bool(raw.get("prewarm")),
                "lifetime": _unity_min_max(initial.get("startLifetime")),
                "speed": _unity_min_max(initial.get("startSpeed")),
                "size": _unity_min_max(initial.get("startSize")),
                "sizeY": _unity_min_max(initial.get("startSizeY")),
                "rotation": _unity_min_max(initial.get("startRotation")),
                "maxParticles": int(initial.get("maxNumParticles") or 0),
                "alpha": {
                    "mode": int(start_color.get("minMaxState") or 0),
                    "min": float(start_color.get("minColor", {}).get("a") or 0),
                    "max": float(start_color.get("maxColor", {}).get("a") or 0),
                },
                "shape": {
                    "type": int(shape.get("type") or 0),
                    "position": shape.get("m_Position"),
                    "scale": shape.get("m_Scale"),
                },
                "velocity": {
                    "x": _unity_min_max(velocity.get("x")),
                    "y": _unity_min_max(velocity.get("y")),
                    "z": _unity_min_max(velocity.get("z")),
                },
                "transform": {
                    "position": rect_raw.get("m_AnchoredPosition"),
                    "scale": rect_raw.get("m_LocalScale"),
                    "rotation": _unity_rotation_z(rect_raw.get("m_LocalRotation")),
                },
                "renderer": {
                    "renderMode": int(renderer_raw.get("m_RenderMode") or 0),
                    "lengthScale": float(renderer_raw.get("m_LengthScale") or 0),
                    "maxParticleSize": float(renderer_raw.get("m_MaxParticleSize") or 0),
                },
            }
        )
    if not layers:
        raise ValueError(f"ADV rain frame has no enabled particle layers: {source_path}")
    texture_source = f"{ADV_FRAME_ROOT}/adv_frame_rain/data/Texture/adv_frame_rain_smallglow.png"
    texture = data.asset(texture_source)
    if not texture:
        raise ValueError(f"ADV rain frame texture is missing: {texture_source}")
    return {
        "type": "rain",
        "variant": variant,
        "direction": direction,
        "canvasAlpha": canvas_alpha,
        "texture": texture,
        "rootTransform": {
            "position": frame_root_raw.get("m_AnchoredPosition"),
            "rotation": _unity_rotation_z(
                (effect_rect or {}).get("data", {}).get("m_LocalRotation")
            ),
        },
        "layers": layers,
        "rate": sum(float(layer["rate"]) for layer in layers),
    }


def _frame_runtime(data: BuildData, target_asset: str) -> dict[str, Any]:
    cached = data._adv_frame_cache.get(target_asset)
    if cached is not None:
        return cached
    source_path = f"{ADV_FRAME_ROOT}/{target_asset}.prefab"
    descriptor, objects = data.source_objects(source_path)
    root_ids = [str(int(value)) for value in descriptor.get("rootObjects", [])]
    if len(root_ids) != 1 or objects[root_ids[0]].get("type") != "GameObject":
        raise ValueError(f"ADV frame must have exactly one GameObject root: {source_path}")
    root = objects[root_ids[0]]
    leaf = PurePosixPath(target_asset).name
    root_name = str(root.get("data", {}).get("m_Name") or "")
    if root_name.casefold() != leaf.casefold():
        raise ValueError(f"ADV frame root identity mismatch: {source_path}::{root_name}")
    canvas_group = _frame_component(objects, root, "CanvasGroup")
    canvas_alpha = float((canvas_group or {}).get("data", {}).get("m_Alpha", 1))
    lower = leaf.casefold()
    result: dict[str, Any] = {
        "name": leaf,
        "assetName": target_asset,
        "sourcePath": source_path,
        "canvasAlpha": canvas_alpha,
    }
    game_objects = _frame_game_objects(objects)
    image_colors = [
        image.get("data", {}).get("m_Color")
        for _, game_object in game_objects.values()
        if (image := _frame_image_component(objects, game_object)) is not None
    ]
    color = _frame_color(image_colors[0]) if image_colors else "#000000"
    if lower.startswith("adv_frame_fill"):
        result.update(type="fill", color=color)
    elif lower.startswith("adv_frame_letterbox"):
        band_heights = []
        for name in ("Top", "Bottom"):
            game_object = game_objects.get(name, ("", {}))[1]
            rect = _frame_component(objects, game_object, "RectTransform") if game_object else None
            child_id = _unity_pointer_id((rect or {}).get("data", {}).get("m_Children", [{}])[0])
            child = objects.get(child_id or "")
            height = float((child or {}).get("data", {}).get("m_SizeDelta", {}).get("y") or 0)
            if height > 0:
                band_heights.append(height)
        if len(band_heights) != 2 or not math.isclose(
            band_heights[0], band_heights[1], rel_tol=0, abs_tol=1e-6
        ):
            raise ValueError(f"ADV letterbox band geometry is invalid: {source_path}")
        result.update(
            type="letterbox",
            color=color,
            bandHeight=band_heights[0],
            referenceWidth=1920,
            referenceHeight=1080,
            slideDistance=200,
            clips={"show": 0.5, "hide": 0.5, "loop": 0, "hideImmediate": 0},
        )
    elif lower.startswith("adv_frame_pillarbox"):
        result.update(type="pillarbox", color=color, bandWidth=400, referenceWidth=1920)
    elif lower.startswith("adv_frame_rain"):
        result.update(
            _rain_frame_runtime(
                data, target_asset, source_path, objects, root, canvas_alpha
            )
        )
    elif lower.startswith("adv_frame_fog"):
        textures = {
            name: data.asset(f"{ADV_FRAME_ROOT}/adv_frame_fog/data/Texture/{filename}")
            for name, filename in (
                ("top", "frame_fog_top.png"),
                ("right", "frame_fog_right.png"),
                ("left", "frame_fog_left.png"),
                ("down", "frame_fog_down.png"),
            )
        }
        if not all(textures.values()):
            raise ValueError(f"ADV fog frame textures are incomplete: {source_path}")
        result.update(type="fog", textures=textures, referenceWidth=1920, referenceHeight=1080)
    elif lower.startswith("adv_frame_lensflare"):
        texture_paths = {
            "flare01": "adv_frame_lensflare_1_flare_01.png",
            "flare02": "adv_frame_Lensflare_1_flare_02.png",
            "glow01": "adv_frame_Lensflare_1_glow_01.png",
            "halo01": "adv_frame_Lensflare_1_halo_01.png",
            "halo02": "adv_frame_Lensflare_1_halo_02.png",
            "fog": "adv_frame_lensflare_1_fog.png",
        }
        textures = {
            name: data.asset(
                f"{ADV_FRAME_ROOT}/adv_frame_lensflare_1/data/Texture/{filename}"
            )
            for name, filename in texture_paths.items()
        }
        if not all(textures.values()):
            raise ValueError(f"ADV lens flare textures are incomplete: {source_path}")
        result.update(type="lensflare", textures=textures, referenceWidth=1920, referenceHeight=1080)
    else:
        raise ValueError(f"Unsupported ADV frame prefab: {source_path}")
    data._adv_frame_cache[target_asset] = result
    return result


def _effect_runtime(data: BuildData, target_asset: str) -> dict[str, Any]:
    """Resolve any AdvEffectCommand target through the shared Unity runtime."""
    cached = data._adv_effect_cache.get(target_asset)
    if cached is not None:
        return cached
    target = PurePosixPath(target_asset.strip("/"))
    if not target.parts or ".." in target.parts:
        raise ValueError(f"ADV effect target is invalid: {target_asset}")
    relative = target.as_posix()
    source_path = f"{ADV_EFFECT_ROOT}/{relative}"
    if not source_path.casefold().endswith(".prefab"):
        source_path += ".prefab"
    if source_path not in data.source_path_set:
        raise ValueError(f"ADV effect prefab is missing: {source_path}")

    effect_root = PurePosixPath(source_path).parent
    textures = {}
    for candidate in data.source_paths:
        path = PurePosixPath(candidate)
        if effect_root not in path.parents or path.suffix.casefold() not in {
            ".png",
            ".jpg",
            ".jpeg",
            ".webp",
        }:
            continue
        url = data.asset(candidate)
        if url:
            textures[path.name] = url
    name = PurePosixPath(source_path).stem
    result = {
        "assetName": target_asset,
        "name": name,
        "source": source_path,
        "textures": textures,
        "runtime": serialize_unity_effect(data, source_path),
    }
    data._adv_effect_cache[target_asset] = result
    return result


def _require_story_sound_role(
    sound: dict[str, Any] | None,
    expected_category: int,
    label: str,
) -> dict[str, Any]:
    expected_name = CRI_SOUND_CATEGORIES[expected_category]
    if sound is None:
        raise ValueError(f"ADV command references an unknown {expected_name} sound: {label}")
    category = sound.get("category")
    category_name = str(sound.get("categoryName") or "")
    if category != expected_category or category_name != expected_name:
        raise ValueError(
            f"ADV command sound role mismatch: {label}; expected "
            f"{expected_category}/{expected_name}, got {category}/{category_name}"
        )
    return sound


def _story_sound_resource(sound: dict[str, Any], label: str) -> dict[str, Any]:
    """Give an exact resolved ADV sound a stable, human-readable authoring key."""
    cue_sheet_name = str(sound.get("cueSheetName") or "").strip("/")
    cue_name = str(sound.get("cueName") or "").strip("/")
    if not cue_sheet_name or not cue_name:
        raise ValueError(
            f"ADV sound has no exact cue-sheet/cue authoring identity: {label}"
        )
    return {**sound, "resourceRef": f"{cue_sheet_name}/{cue_name}"}


def _story_assets(
    data: BuildData,
    asset_name: str,
    commands: list[dict[str, Any]],
    live2d: dict[str, dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    models_by_source = {str(model.get("sourcePath") or "").casefold(): model for model in live2d.values()}
    target_models: dict[str, dict[str, Any]] = {}
    used_models: set[str] = set()
    backgrounds: dict[str, dict[str, Any]] = {}
    stills: dict[str, dict[str, Any]] = {}
    frames: dict[str, dict[str, Any]] = {}
    effects: dict[str, dict[str, Any]] = {}
    sounds: dict[int, dict[str, Any]] = {}
    sound_id_by_resource_ref: dict[str, int] = {}
    videos: dict[int, dict[str, Any]] = {}
    story_sounds, story_cue_sheets = _story_sound_maps(data, asset_name)
    chat_root = data.assets / "Assets" / "AddressableResources" / "Adv" / "Chat"
    chat_sounds, chat_cue_sheets = _adv_sound_maps(
        chat_root / "AdvChat-Sound.txt",
        chat_root / "AdvChat-SoundCueSheet.txt",
    )
    chat_masters = {
        int(row.get("_id") or 0): row
        for row in data.rows("MasterAdvChat")
        if int(row.get("_id") or 0)
    }
    video_file = (
        data.assets
        / "Assets"
        / "AddressableResources"
        / "Adv"
        / "Episode"
        / asset_name
        / f"{asset_name}-Video.txt"
    )
    story_videos = {
        int(row.get("_id") or 0): row
        for row in (read_json(video_file).get("_allData", []) if video_file.is_file() else [])
        if int(row.get("_id") or 0)
    }

    def resolve_sound(identity: int) -> dict[str, Any] | None:
        if identity in story_sounds:
            return data.story_sound(identity, story_sounds, story_cue_sheets)
        return data.sound(identity)

    def resolve_chat_sound(identity: int) -> dict[str, Any] | None:
        # MasterAdvChat chat sounds are packaged with the episode in the
        # prepared release. Retain the standalone Chat table as an exact
        # fallback for builds which declare one there.
        if identity in story_sounds:
            return data.story_sound(identity, story_sounds, story_cue_sheets)
        if identity in chat_sounds:
            return data.story_sound(
                identity,
                chat_sounds,
                chat_cue_sheets,
                source_table="AdvChatSound",
            )
        return data.sound(identity)

    def register_sound(identity: int, sound: dict[str, Any], label: str) -> str:
        resource = _story_sound_resource(sound, label)
        resource_ref = str(resource["resourceRef"])
        previous_id = sound_id_by_resource_ref.get(resource_ref)
        if previous_id is not None and previous_id != identity:
            raise ValueError(
                f"ADV sound authoring identity is ambiguous: {asset_name}::{resource_ref}; "
                f"sound IDs {previous_id} and {identity}"
            )
        sound_id_by_resource_ref[resource_ref] = identity
        sounds[identity] = resource
        return resource_ref

    for command in commands:
        target_name = str(command.get("targetName") or "")
        target_asset = str(command.get("targetAssetName") or "").strip("/")
        if int(command.get("command") or -1) == 23 and target_asset:
            source_path = target_asset
            if not source_path.startswith("Assets/"):
                source_path = f"Assets/AddressableResources/Character/Live2D/{source_path}"
            if not source_path.casefold().endswith(".prefab"):
                source_path += ".prefab"
            model = models_by_source.get(source_path.casefold())
            if model:
                command["live2dKey"] = model["live2dKey"]
                used_models.add(model["live2dKey"])
                if target_name:
                    target_models[target_name] = model
        model = target_models.get(target_name)
        target_names = [
            value.strip() for value in target_name.split("・") if value.strip()
        ]
        if len(target_names) > 1:
            target_text_names = command.get("targetTextNames")
            if not isinstance(target_text_names, list):
                target_text_names = []
            targets = []
            for index, target in enumerate(target_names):
                target_model = target_models.get(target)
                text_name = (
                    target_text_names[index]
                    if index < len(target_text_names)
                    else None
                )
                if isinstance(text_name, list) and not any(
                    str(value or "").strip() for value in text_name
                ):
                    text_name = None
                elif not isinstance(text_name, list) and not str(
                    text_name or ""
                ).strip():
                    text_name = None
                model_name = (
                    target_model.get("nickname")
                    or target_model.get("characterName")
                    if target_model
                    else None
                )
                targets.append(
                    _present(
                        target=target,
                        characterId=(
                            target_model.get("characterId")
                            if target_model
                            else None
                        ),
                        name=text_name or model_name or target,
                    )
                )
            command["targets"] = targets
        elif target_name and model:
            command["targets"] = [
                _present(
                    target=target_name,
                    characterId=model.get("characterId"),
                    name=model.get("nickname") or model.get("characterName") or target_name,
                )
            ]

        code = int(command.get("command") or -1)
        chat_id = int(command.get("targetChatID") or 0)
        if chat_id:
            chat_master = chat_masters.get(chat_id)
            if chat_master is None:
                raise ValueError(
                    f"ADV command references an unknown MasterAdvChat row: "
                    f"{asset_name}::{command.get('index')}::{chat_id}"
                )
            window_asset = str(chat_master.get("_chatWindowAssetName") or "")
            icon_asset = str(chat_master.get("_chatIconAssetName") or "")
            chat_preset_ref = window_asset or icon_asset
            if not chat_preset_ref:
                raise ValueError(
                    f"MasterAdvChat row has no semantic preset asset: {chat_id}"
                )
            command["chatPresetRef"] = chat_preset_ref
            if window_asset:
                command["chatWindowAssetName"] = window_asset
            if icon_asset:
                command["chatIconAssetName"] = icon_asset
            chat_sound_id = int(chat_master.get("_chatSoundId") or 0)
            if chat_sound_id and code in {37, 38, 65}:
                chat_sound = _require_story_sound_role(
                    resolve_chat_sound(chat_sound_id),
                    1,
                    f"{asset_name}::{command.get('index')}::chatSoundId={chat_sound_id}",
                )
                command["chatSound"] = _story_sound_resource(
                    chat_sound,
                    f"{asset_name}::{command.get('index')}::chatSoundId={chat_sound_id}",
                )
        if code == 43 and target_asset:
            post_effect_source = f"{ADV_POST_EFFECT_ROOT}/{target_asset}.asset"
            if post_effect_source not in data.source_path_set:
                raise ValueError(
                    f"ADV command references a missing post effect: {post_effect_source}"
                )
            command["postEffectRef"] = target_asset
        if code == 44 and target_asset:
            frame = _frame_runtime(data, target_asset)
            frames[target_asset] = frame
            command["frameName"] = PurePosixPath(target_asset).name
            command["frameRef"] = target_asset
        if code == 54 and target_asset:
            effects[target_asset] = _effect_runtime(data, target_asset)
            command["effectRef"] = target_asset
        if code == 25 and target_asset:
            stage_asset_name = target_asset.split("/", 1)[0]
            source_path = (
                f"Assets/AddressableResources/Adv/Stage/{stage_asset_name}/"
                f"data/{stage_asset_name}.png"
            )
            stage_source = f"{ADV_STAGE_ROOT}/{stage_asset_name}/{stage_asset_name}.prefab"
            if stage_source not in data.source_path_set:
                raise ValueError(f"ADV background stage is missing: {stage_source}")
            background = _present(
                assetName=stage_asset_name,
                url=data.asset(source_path),
                sourcePath=source_path,
                stageRef=stage_asset_name,
            )
            if background.get("url"):
                backgrounds[stage_asset_name] = background
                command["backgroundRef"] = stage_asset_name
        if code == 30 and target_asset:
            target_path = PurePosixPath(target_asset)
            source_path = (
                f"{ADV_STILL_ROOT}/{target_path.parent}/data/{target_path.name}.png"
            )
            if source_path not in data.source_path_set:
                raise ValueError(f"ADV still is missing: {source_path}")
            still = _present(
                assetName=target_asset,
                url=data.asset(source_path),
                sourcePath=source_path,
            )
            if still.get("url"):
                stills[target_asset] = still
                command["stillRef"] = target_asset

        bgm_id = int(command.get("bgmId") or 0)
        se_id = int(command.get("seId") or 0)
        voice_ids = [int(value) for value in command.get("voiceIds", []) if int(value)]
        if bgm_id:
            label = f"{asset_name}::{command.get('index')}::bgmId={bgm_id}"
            sound = _require_story_sound_role(
                resolve_sound(bgm_id), 0, label
            )
            command["bgmRef"] = register_sound(bgm_id, sound, label)
        if se_id:
            label = f"{asset_name}::{command.get('index')}::seId={se_id}"
            sound = _require_story_sound_role(
                resolve_sound(se_id), 1, label
            )
            command["seRef"] = register_sound(se_id, sound, label)
        voice_refs = []
        for identity in voice_ids:
            label = f"{asset_name}::{command.get('index')}::voiceId={identity}"
            sound = _require_story_sound_role(
                resolve_sound(identity),
                2,
                label,
            )
            voice_refs.append(register_sound(identity, sound, label))
        if voice_refs:
            command["voiceRefs"] = voice_refs

        video_id = int(command.get("videoId") or 0)
        if video_id:
            video_row = story_videos.get(video_id)
            if not video_row:
                raise ValueError(
                    f"ADV command references a missing story video: {asset_name}::{video_id}"
                )
            video_asset_name = str(video_row.get("_assetName") or "").strip("/")
            media = data.video_media(video_asset_name)
            # Story-local Video.txt names are relative to Cri/Video and retain
            # their `adv/` category. The embedded CRI payload filename used by
            # this build drops that one directory, so accept only the exact
            # component suffix after removing the known category prefix.
            if not media and video_asset_name.casefold().startswith("adv/"):
                media = data.video_media(video_asset_name.split("/", 1)[1])
            if not media or not media.get("playableUrl"):
                raise ValueError(
                    f"ADV story video has no exact playable CRI output: "
                    f"{asset_name}::{video_id}::{video_asset_name}"
                )
            playable_url = str(media["playableUrl"])
            video = _present(
                videoId=video_id,
                assetName=video_asset_name,
                resourceRef=video_asset_name,
                autoStop=bool(video_row.get("_autoStop")),
                width=int(video_row.get("_width") or 0),
                height=int(video_row.get("_height") or 0),
                hasAudio=bool(media.get("hasAudio")),
                masterDeclaredHasAudio=bool(video_row.get("_hasAudio")),
                note=video_row.get("_note"),
                playableUrl=playable_url,
                url=playable_url,
                type=(
                    "video/webm"
                    if PurePosixPath(playable_url).suffix.casefold() == ".webm"
                    else "video/mp4"
                ),
                runtimePath=media.get("runtimePath"),
                outputPath=media.get("outputPath"),
                videoCodec=media.get("videoCodec"),
                audioCodec=media.get("audioCodec"),
            )
            videos[video_id] = video
            command["videoRef"] = video_asset_name

    return {
        "backgrounds": list(backgrounds.values()),
        "stills": list(stills.values()),
        "frames": list(frames.values()),
        "effects": list(effects.values()),
        "sounds": list(sounds.values()),
        "videos": list(videos.values()),
        "live2d": [{"live2dKey": key} for key in sorted(used_models)],
    }


def _synthetic_story_chapter(
    identity: int, key: str, name: str | list[str]
) -> dict[str, Any]:
    # A plain label is source metadata, not a translation.  Never duplicate it
    # into another locale slot; UI-specific fallbacks belong in frontend i18n.
    localized_name = name if isinstance(name, list) else [name, "", "", "", ""]
    return {
        "chapterId": identity,
        "chapterKey": key,
        "chapterName": localized_name,
        "chapterSort": identity,
        "description": ["", "", "", "", ""],
        "episodes": [],
    }


def _unity_trs_matrix(transform: dict[str, Any]) -> list[float]:
    """Serialize one Unity world TRS as a row-major Matrix4 document."""
    px, py, pz = transform["position"]
    x, y, z, w = transform["rotation"]
    sx, sy, sz = transform["scale"]
    return [
        (1 - 2 * y * y - 2 * z * z) * sx,
        (2 * x * y - 2 * z * w) * sy,
        (2 * x * z + 2 * y * w) * sz,
        px,
        (2 * x * y + 2 * z * w) * sx,
        (1 - 2 * x * x - 2 * z * z) * sy,
        (2 * y * z - 2 * x * w) * sz,
        py,
        (2 * x * z - 2 * y * w) * sx,
        (2 * y * z + 2 * x * w) * sy,
        (1 - 2 * x * x - 2 * y * y) * sz,
        pz,
        0,
        0,
        0,
        1,
    ]


def _unity_matrix_multiply(left: list[float], right: list[float]) -> list[float]:
    """Multiply two row-major Unity Matrix4 documents."""
    return [
        sum(left[row * 4 + inner] * right[inner * 4 + column] for inner in range(4))
        for row in range(4)
        for column in range(4)
    ]


def _unity_local_matrix(transform: dict[str, Any]) -> list[float]:
    return _unity_trs_matrix(
        {
            "position": _unity_vector3(transform.get("m_LocalPosition")),
            "rotation": _unity_quaternion(transform.get("m_LocalRotation")),
            "scale": _unity_vector3(transform.get("m_LocalScale"), 1),
        }
    )


def _unity_world_matrix(
    objects: dict[str, dict[str, Any]],
    transform_id: str,
    source_path: str,
    cache: dict[str, list[float]],
    stack: set[str] | None = None,
) -> list[float]:
    """Recover exact local-to-world matrices without decomposing parent products."""
    cached = cache.get(transform_id)
    if cached is not None:
        return cached
    active_stack = set() if stack is None else stack
    if transform_id in active_stack:
        raise ValueError(f"Unity Transform hierarchy is cyclic: {source_path}::{transform_id}")
    transform = objects.get(transform_id)
    raw = transform.get("data", {}) if isinstance(transform, dict) else {}
    if not isinstance(transform, dict) or transform.get("type") not in (
        "Transform",
        "RectTransform",
    ):
        raise ValueError(f"Unity Transform is invalid: {source_path}::{transform_id}")

    active_stack.add(transform_id)
    local = _unity_local_matrix(raw)
    parent_id = _unity_pointer_id(raw.get("m_Father"))
    world = (
        _unity_matrix_multiply(
            _unity_world_matrix(objects, parent_id, source_path, cache, active_stack),
            local,
        )
        if parent_id
        else local
    )
    active_stack.remove(transform_id)
    cache[transform_id] = world
    return world


def _unity_affine_inverse(matrix: list[float], label: str) -> list[float]:
    """Invert an affine row-major Matrix4, retaining scale/rotation shear exactly."""
    m00, m01, m02, tx = matrix[0:4]
    m10, m11, m12, ty = matrix[4:8]
    m20, m21, m22, tz = matrix[8:12]
    inverse00 = m11 * m22 - m12 * m21
    inverse01 = m02 * m21 - m01 * m22
    inverse02 = m01 * m12 - m02 * m11
    inverse10 = m12 * m20 - m10 * m22
    inverse11 = m00 * m22 - m02 * m20
    inverse12 = m02 * m10 - m00 * m12
    inverse20 = m10 * m21 - m11 * m20
    inverse21 = m01 * m20 - m00 * m21
    inverse22 = m00 * m11 - m01 * m10
    determinant = m00 * inverse00 + m01 * inverse10 + m02 * inverse20
    if abs(determinant) <= 1e-12:
        raise ValueError(f"Unity Transform matrix is singular: {label}")
    inverse = [
        value / determinant
        for value in (
            inverse00,
            inverse01,
            inverse02,
            inverse10,
            inverse11,
            inverse12,
            inverse20,
            inverse21,
            inverse22,
        )
    ]
    return [
        inverse[0],
        inverse[1],
        inverse[2],
        -(inverse[0] * tx + inverse[1] * ty + inverse[2] * tz),
        inverse[3],
        inverse[4],
        inverse[5],
        -(inverse[3] * tx + inverse[4] * ty + inverse[5] * tz),
        inverse[6],
        inverse[7],
        inverse[8],
        -(inverse[6] * tx + inverse[7] * ty + inverse[8] * tz),
        0,
        0,
        0,
        1,
    ]


def _unity_transform_point(matrix: list[float], point: tuple[float, float, float]) -> list[float]:
    x, y, z = point
    return [
        matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
        matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
        matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
    ]


def _home_spot_character_key(value: Any) -> str:
    key = re.sub(r"[^a-z0-9]+", "_", str(value or "").casefold()).strip("_")
    previous = ""
    while key and key != previous:
        previous = key
        key = re.sub(r"_(?:back|before|over)(?:_?\d+)?$|_\d+$", "", key)
    return key


def _home_spot_spine_runtime(
    data: BuildData, row: dict[str, Any]
) -> dict[str, Any]:
    identity = int(row.get("_id") or 0)
    situation_asset = str(row.get("_situationAssetPath") or "").strip("/")
    if not situation_asset.startswith("Spot/"):
        raise ValueError(
            f"Home Spot {identity} has an invalid situation asset: {situation_asset}"
        )
    source_path = f"Assets/AddressableResources/{situation_asset}.prefab"
    background_asset = str(row.get("_backgroundAssetPath") or "").strip("/")
    if not background_asset.startswith("Spot/"):
        raise ValueError(
            f"Home Spot {identity} has an invalid background asset: {background_asset}"
        )
    background_source_path = f"Assets/AddressableResources/{background_asset}.prefab"
    background_document = data.home_spot_background(identity)
    if (
        background_document.get("sourcePath") != background_source_path
        or background_document.get("situationSourcePath") != source_path
    ):
        raise ValueError(
            f"Home Spot {identity} background mapping diverges from MasterHomeSpot"
        )
    background_output = background_document.get("output")
    background_preview = background_document.get("preview")
    background_transform = background_document.get("backgroundTransform")
    background_matrix = (
        background_transform.get("matrix")
        if isinstance(background_transform, dict)
        else None
    )
    if (
        not isinstance(background_output, dict)
        or background_output.get("role") != "derivative"
        or background_output.get("type") != HOME_SPOT_BACKGROUND_OUTPUT_TYPE
        or background_output.get("coordinateSpace")
        != HOME_SPOT_BACKGROUND_COORDINATE_SPACE
        or background_output.get("situationName")
        != background_document.get("situationName")
        or not isinstance(background_matrix, list)
        or len(background_matrix) != 16
        or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in background_matrix)
    ):
        raise ValueError(f"Home Spot {identity} background derivative is invalid")
    background_output_path = str(background_output.get("path") or "")
    background_url = data.runtime_output_url(background_output_path)
    background_file = data.root / Path(*PurePosixPath(background_output_path).parts)
    if (
        not background_url
        or background_output.get("runtime") != background_url
        or int(background_output.get("bytes") or -1) != background_file.stat().st_size
        or str(background_output.get("sha256") or "") != sha256_file(background_file)
    ):
        raise ValueError(f"Home Spot {identity} background output fails integrity checks")
    if (
        not isinstance(background_preview, dict)
        or background_preview.get("role") != "derivative"
        or background_preview.get("type")
        != HOME_SPOT_BACKGROUND_PREVIEW_OUTPUT_TYPE
        or background_preview.get("coordinateSpace")
        != HOME_SPOT_BACKGROUND_PREVIEW_COORDINATE_SPACE
        or background_preview.get("situationName")
        != background_document.get("situationName")
        or str(background_preview.get("objectId") or "")
        != str(background_output.get("objectId") or "")
        or int(background_preview.get("width") or 0)
        != HOME_SPOT_BACKGROUND_PREVIEW_WIDTH
        or int(background_preview.get("height") or 0)
        != HOME_SPOT_BACKGROUND_PREVIEW_HEIGHT
        or int(background_preview.get("renderTriangleCount") or 0) <= 0
        or int(background_preview.get("visiblePixelCount") or 0) <= 0
        or int(background_preview.get("visiblePixelCount") or 0)
        > HOME_SPOT_BACKGROUND_PREVIEW_WIDTH
        * HOME_SPOT_BACKGROUND_PREVIEW_HEIGHT
    ):
        raise ValueError(f"Home Spot {identity} background preview is invalid")
    background_preview_path = str(background_preview.get("path") or "")
    background_preview_url = data.runtime_output_url(background_preview_path)
    background_preview_file = data.root / Path(
        *PurePosixPath(background_preview_path).parts
    )
    if (
        not background_preview_url
        or background_preview.get("runtime") != background_preview_url
        or int(background_preview.get("bytes") or -1)
        != background_preview_file.stat().st_size
        or str(background_preview.get("sha256") or "")
        != sha256_file(background_preview_file)
    ):
        raise ValueError(
            f"Home Spot {identity} background preview fails integrity checks"
        )
    descriptor, objects = data.source_objects(source_path)
    game_object_roots = [
        str(int(value))
        for value in descriptor.get("rootObjects", [])
        if objects.get(str(int(value)), {}).get("type") == "GameObject"
    ]
    if len(game_object_roots) != 1:
        raise ValueError(
            f"Home Spot situation must have one GameObject root: {source_path}"
        )

    scene_candidates = [
        (object_id, value.get("data", {}))
        for object_id, value in objects.items()
        if value.get("type") == "MonoBehaviour"
        and "_spotSpineCharacters" in value.get("data", {})
    ]
    settings_candidates = [
        (object_id, value.get("data", {}))
        for object_id, value in objects.items()
        if value.get("type") == "MonoBehaviour"
        and "fieldOfView" in value.get("data", {})
        and "backgroundPosition" in value.get("data", {})
    ]
    if len(scene_candidates) != 1 or len(settings_candidates) != 1:
        raise ValueError(
            f"Home Spot scene/settings must resolve uniquely: {source_path}; "
            f"found {len(scene_candidates)}/{len(settings_candidates)}"
        )
    scene = scene_candidates[0][1]
    settings = settings_candidates[0][1]

    def local_pointer(value: Any, label: str) -> str:
        if not isinstance(value, dict) or int(value.get("m_FileID") or 0) != 0:
            raise ValueError(f"Home Spot {label} is not a local pointer: {source_path}")
        object_id = _unity_pointer_id(value)
        if not object_id or object_id not in objects:
            raise ValueError(f"Home Spot {label} is unresolved: {source_path}")
        return object_id

    def game_object_for(component: dict[str, Any], label: str) -> tuple[str, dict[str, Any]]:
        game_object_id = local_pointer(component.get("m_GameObject"), f"{label} GameObject")
        game_object = objects.get(game_object_id, {})
        if game_object.get("type") != "GameObject":
            raise ValueError(f"Home Spot {label} has no GameObject: {source_path}")
        return game_object_id, game_object.get("data", {})

    def only_component(
        game_object: dict[str, Any], component_type: str, label: str
    ) -> tuple[str, dict[str, Any]]:
        matches = [
            component_id
            for component_id in _unity_component_ids(game_object)
            if objects.get(component_id, {}).get("type") == component_type
        ]
        if len(matches) != 1:
            raise ValueError(
                f"Home Spot {label} must have one {component_type}: {source_path}; "
                f"found {len(matches)}"
            )
        component_id = matches[0]
        return component_id, objects[component_id].get("data", {})

    allowed_character_ids = {
        int(value) for value in row.get("_characterIds", []) if int(value)
    }
    character_ids_by_key: dict[str, int] = {}
    character_labels: dict[str, str] = {}
    for pointer in scene.get("_characters", []):
        component_id = local_pointer(pointer, "character")
        component = objects.get(component_id, {})
        raw = component.get("data", {})
        if component.get("type") != "MonoBehaviour" or "_characterId" not in raw:
            raise ValueError(
                f"Home Spot character component is invalid: {source_path}::{component_id}"
            )
        _, game_object = game_object_for(raw, "character")
        name = str(game_object.get("m_Name") or "")
        key = _home_spot_character_key(name)
        if not key or key in character_ids_by_key:
            raise ValueError(
                f"Home Spot character name is empty or repeated: {source_path}::{name}"
            )
        serialized_id = int(raw.get("_characterId") or 0)
        character_id = serialized_id if serialized_id in allowed_character_ids else 0
        character_ids_by_key[key] = character_id
        if character_id:
            character_labels[str(character_id)] = name

    spine_parent = PurePosixPath(source_path).parent / "Spine"
    spine_prefix = spine_parent.as_posix() + "/"
    atlas_sources = [
        value
        for value in data.source_paths
        if value.startswith(spine_prefix) and value.endswith(".atlas.txt")
    ]
    texture_sources = [
        value
        for value in data.source_paths
        if value.startswith(spine_prefix)
        and PurePosixPath(value).parent == spine_parent
        and value.endswith(".png")
    ]
    skeleton_sources = [
        value
        for value in data.source_paths
        if value.startswith(spine_prefix) and value.endswith("_SkeletonData.asset")
    ]
    if len(atlas_sources) != 1 or len(texture_sources) != 1 or not skeleton_sources:
        raise ValueError(
            f"Home Spot Spine sources are incomplete: {source_path}; "
            f"atlas={len(atlas_sources)}, texture={len(texture_sources)}, "
            f"skeletons={len(skeleton_sources)}"
        )
    atlas_source = atlas_sources[0]
    texture_source = texture_sources[0]
    atlas = data.asset(atlas_source)
    texture = data.asset(texture_source)
    if not atlas or not texture:
        raise ValueError(f"Home Spot atlas/texture assets are absent: {source_path}")
    atlas_file = data.assets / Path(*PurePosixPath(atlas_source).parts)
    atlas_pages = {
        line.strip()
        for line in atlas_file.read_text(encoding="utf-8").splitlines()
        if re.fullmatch(r"[^/\\]+\.png", line.strip(), re.IGNORECASE)
    }
    if atlas_pages != {PurePosixPath(texture_source).name}:
        raise ValueError(
            f"Home Spot atlas page does not match its canonical texture: {atlas_source}"
        )

    skeletons_by_root: dict[tuple[str, str], dict[str, Any]] = {}
    scales: set[float] = set()
    for skeleton_source in skeleton_sources:
        skeleton_descriptor, skeleton_objects = data.source_objects(skeleton_source)
        root_ids = [str(int(value)) for value in skeleton_descriptor.get("rootObjects", [])]
        if len(root_ids) != 1:
            raise ValueError(
                f"Home Spot SkeletonData must have one root: {skeleton_source}"
            )
        root_id = root_ids[0]
        skeleton_serialized_file = str(
            skeleton_descriptor.get("serializedFile") or ""
        )
        if not skeleton_serialized_file:
            raise ValueError(
                f"Home Spot SkeletonData has no serialized-file identity: "
                f"{skeleton_source}"
            )
        skeleton_identity = (skeleton_serialized_file, root_id)
        root_object = skeleton_objects.get(root_id, {})
        root_data = root_object.get("data", {})
        outputs = [
            output
            for output in skeleton_descriptor.get("outputs", [])
            if output.get("type") == "TextAsset" and output.get("role") == "derivative"
        ]
        if root_object.get("type") != "MonoBehaviour" or len(outputs) != 1:
            raise ValueError(f"Home Spot SkeletonData is invalid: {skeleton_source}")
        output = outputs[0]
        json_id = _unity_pointer_id(root_data.get("skeletonJSON"))
        try:
            output_id = str(int(output.get("objectId")))
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"Home Spot skeleton JSON output has an invalid id: {skeleton_source}"
            ) from error
        runtime_url = data.runtime_output_url(str(output.get("path") or ""))
        scale = float(root_data.get("scale") or 0)
        output_serialized_file = str(output.get("serializedFile") or "")
        if (
            json_id != output_id
            or output_serialized_file != skeleton_serialized_file
            or not runtime_url
            or scale <= 0
        ):
            raise ValueError(
                f"Home Spot skeleton JSON binding is incomplete: {skeleton_source}"
            )
        if skeleton_identity in skeletons_by_root:
            raise ValueError(
                f"Home Spot repeats SkeletonData root "
                f"{skeleton_serialized_file}:{root_id}: {source_path}"
            )
        skeletons_by_root[skeleton_identity] = {
            "sourcePath": skeleton_source,
            "url": runtime_url,
        }
        scales.add(scale)
    if len(scales) != 1:
        raise ValueError(f"Home Spot SkeletonData scales diverge: {source_path}")

    transform_to_game_object: dict[str, dict[str, Any]] = {}
    transform_children: dict[str, list[str]] = {}
    for value in objects.values():
        if value.get("type") != "GameObject":
            continue
        game_object = value.get("data", {})
        transform_id, transform = only_component(game_object, "Transform", "GameObject")
        transform_to_game_object[transform_id] = game_object
        parent_id = _unity_pointer_id(transform.get("m_Father"))
        if parent_id:
            transform_children.setdefault(parent_id, []).append(transform_id)

    matrix_cache: dict[str, list[float]] = {}

    def collider_hit_polygon(
        transform_id: str, label: str
    ) -> list[list[float]] | None:
        descendants = [transform_id]
        for value in descendants:
            descendants.extend(transform_children.get(value, []))
        colliders: list[tuple[str, dict[str, Any]]] = []
        for value in descendants:
            game_object = transform_to_game_object.get(value)
            if not game_object:
                continue
            colliders.extend(
                (value, objects[component_id].get("data", {}))
                for component_id in _unity_component_ids(game_object)
                if objects.get(component_id, {}).get("type") == "BoxCollider2D"
            )
        if len(colliders) > 1:
            raise ValueError(
                f"Home Spot {label} has multiple BoxCollider2D hit areas: {source_path}"
            )
        if not colliders:
            return None
        collider_transform_id, collider = colliders[0]
        offset = collider.get("m_Offset", {})
        size = collider.get("m_Size", {})
        width = float(size.get("x") or 0)
        height = float(size.get("y") or 0)
        if width <= 0 or height <= 0:
            raise ValueError(f"Home Spot {label} has an invalid hit area: {source_path}")
        center_x = float(offset.get("x") or 0)
        center_y = float(offset.get("y") or 0)
        animation_world = _unity_world_matrix(
            objects, transform_id, source_path, matrix_cache
        )
        collider_world = _unity_world_matrix(
            objects, collider_transform_id, source_path, matrix_cache
        )
        collider_to_animation = _unity_matrix_multiply(
            _unity_affine_inverse(
                animation_world, f"{source_path}::{transform_id}"
            ),
            collider_world,
        )
        half_width = width / 2
        half_height = height / 2
        return [
            _unity_transform_point(collider_to_animation, corner)
            for corner in (
                (center_x - half_width, center_y - half_height, 0),
                (center_x + half_width, center_y - half_height, 0),
                (center_x + half_width, center_y + half_height, 0),
                (center_x - half_width, center_y + half_height, 0),
            )
        ]

    layer_documents: list[dict[str, Any]] = []
    hit_polygons_by_key: dict[str, list[list[float]]] = {}
    layer_keys: set[str] = set()
    referenced_skeletons: set[str] = set()
    for pointer in scene.get("_spotSpineCharacters", []):
        wrapper_id = local_pointer(pointer, "Spine layer")
        wrapper = objects.get(wrapper_id, {})
        wrapper_data = wrapper.get("data", {})
        if wrapper.get("type") != "MonoBehaviour":
            raise ValueError(
                f"Home Spot Spine layer wrapper is invalid: {source_path}::{wrapper_id}"
            )
        _, wrapper_game_object = game_object_for(wrapper_data, "Spine layer")
        layer_key = str(wrapper_game_object.get("m_Name") or "")
        if not layer_key or layer_key in layer_keys:
            raise ValueError(
                f"Home Spot Spine layer name is empty or repeated: {source_path}::{layer_key}"
            )
        layer_keys.add(layer_key)
        character_key = _home_spot_character_key(layer_key)

        animation_id = local_pointer(wrapper_data.get("_animation"), "Spine animation")
        animation_object = objects.get(animation_id, {})
        animation_data = animation_object.get("data", {})
        if animation_object.get("type") != "MonoBehaviour":
            raise ValueError(
                f"Home Spot Spine animation is invalid: {source_path}::{animation_id}"
            )
        _, animation_game_object = game_object_for(animation_data, "Spine animation")
        transform_id, _ = only_component(
            animation_game_object, "Transform", f"Spine animation {layer_key}"
        )
        _, renderer = only_component(
            animation_game_object, "MeshRenderer", f"Spine animation {layer_key}"
        )
        skeleton_identity = data.unity_pointer_identity(
            animation_data.get("skeletonDataAsset"),
            str(descriptor.get("serializedFile") or ""),
        )
        skeleton = skeletons_by_root.get(skeleton_identity) if skeleton_identity else None
        if skeleton is None:
            rendered_identity = (
                ":".join(skeleton_identity) if skeleton_identity else "0"
            )
            raise ValueError(
                f"Home Spot Spine animation references an unknown SkeletonData: "
                f"{source_path}::{rendered_identity}"
            )
        referenced_skeletons.add(skeleton["sourcePath"])
        hit_polygon = collider_hit_polygon(transform_id, layer_key)
        if hit_polygon:
            if (
                character_key in hit_polygons_by_key
                and hit_polygons_by_key[character_key] != hit_polygon
            ):
                raise ValueError(
                    f"Home Spot character hit areas diverge: {source_path}::{character_key}"
                )
            hit_polygons_by_key[character_key] = hit_polygon
        layer_documents.append(
            {
                "key": layer_key,
                "characterId": character_ids_by_key.get(character_key, 0),
                "sortingOrder": int(renderer.get("m_SortingOrder") or 0),
                "animation": str(animation_data.get("_animationName") or ""),
                "skeleton": skeleton["url"],
                "skeletonSourcePath": skeleton["sourcePath"],
                "transform": _unity_world_matrix(
                    objects, transform_id, source_path, matrix_cache
                ),
                "_characterKey": character_key,
            }
        )
    if not layer_documents or len(referenced_skeletons) != len(layer_documents):
        raise ValueError(
            f"Home Spot Spine layers are empty or reuse SkeletonData: {source_path}"
        )
    for layer in layer_documents:
        character_key = layer.pop("_characterKey")
        hit_polygon = hit_polygons_by_key.get(character_key)
        if hit_polygon:
            layer["hitPolygon"] = hit_polygon

    def vector(name: str) -> list[float]:
        value = settings.get(name)
        if not isinstance(value, dict) or any(key not in value for key in ("x", "y", "z")):
            raise ValueError(
                f"Home Spot setting {name} is not a Vector3: {source_path}"
            )
        return [float(value[key]) for key in ("x", "y", "z")]

    return _present(
        supported=True,
        sourcePath=source_path,
        backgroundSourcePath=background_source_path,
        backgroundPreview=background_preview_url,
        atlas=atlas,
        texture=texture,
        backgroundScene=background_url,
        backgroundTransform=background_matrix,
        scale=next(iter(scales)),
        fadeInDuration=float(settings.get("characterFadeInDuration") or 0),
        characterLabels=character_labels,
        camera={
            "position": vector("defaultPositionOffset"),
            "target": vector("originalOffset"),
            "startPosition": vector("zoomOutStartPosition"),
            "fieldOfView": float(settings.get("fieldOfView") or 0),
            "aspect": 16 / 9,
            "orbitRatio": float(settings.get("orbitRatio") or 0),
            "introDuration": float(settings.get("zoomOutDuration") or 0),
            "introEase": int(settings.get("zoomOutEase") or 0),
            "mouseFollow": {
                "sensitivity": float(settings.get("gyroSensitivity") or 0),
                "threshold": float(settings.get("gyroThreshold") or 0),
                "maxLeft": float(settings.get("maxLeftShift") or 0),
                "maxRight": float(settings.get("maxRightShift") or 0),
                "maxUp": float(settings.get("maxUpShift") or 0),
                "maxDown": float(settings.get("maxDownShift") or 0),
                "smoothTime": float(settings.get("zoomSmoothTime") or 0),
            },
        },
        layers=layer_documents,
    )


def _stories(data: BuildData, live2d: dict[str, dict[str, Any]]) -> dict[str, Any]:
    advs = {int(row.get("_id") or 0): row for row in data.rows("MasterAdv")}
    adv_play_times = {
        int(row.get("_id") or 0): int(row.get("_playTime") or 0)
        for row in data.rows("MasterAdvPlayTime")
    }
    chapters: dict[str, dict[str, Any]] = {}
    episode_metadata: dict[int, dict[str, Any]] = {}
    for row in data.rows("MasterStoryChapter"):
        identity = int(row.get("_id") or 0)
        chapter = _present(
            chapterId=identity,
            chapterKey=str(identity),
            chapterName=data.text(row.get("_nameTextId"), f"Story {identity}"),
            chapterSort=identity,
            description=data.text(row.get("_descriptionTextId"), ""),
            bandId=int(row.get("_bandId") or 0),
            mainCharacterIds=[int(value) for value in row.get("_mainCharacterIds", [])],
            musicId=int(row.get("_musicId") or 0),
            startAt=_timestamp(row.get("_startAt")),
            endAt=_timestamp(row.get("_endAt")),
            banner=data.asset(f"Assets/AddressableResources/Story/Banner/Chapter/{row.get('_banner')}.png"),
            image=data.asset(f"Assets/AddressableResources/Story/Image/Chapter/{row.get('_image')}.png"),
            icon=data.asset(f"Assets/AddressableResources/Story/Icon/{row.get('_icon')}.png"),
        )
        chapter["episodes"] = []
        chapters[str(identity)] = chapter

    for row in data.rows("MasterStoryEpisode"):
        adv_id = int(row.get("_advId") or 0)
        chapter_id = int(row.get("_chapterId") or 0)
        episode_metadata[adv_id] = {
            "chapterId": chapter_id,
            "episodeNumber": int(row.get("_episodeNumber") or 0),
            "description": data.text(row.get("_descriptionTextId"), ""),
            "characterIds": chapters.get(str(chapter_id), {}).get("mainCharacterIds", []),
            "publishedAt": chapters.get(str(chapter_id), {}).get("startAt", [0, None, None, None, None]),
            "closedAt": chapters.get(str(chapter_id), {}).get("endAt", [0, None, None, None, None]),
            "banner": data.asset(f"Assets/AddressableResources/Story/Banner/Episode/{row.get('_banner')}.png"),
            "image": data.asset(f"Assets/AddressableResources/Story/Image/Episode/{row.get('_image')}.png"),
        }

    chapters.update(
        {
            "900000": _synthetic_story_chapter(900000, "asset_afterlive", "After Live"),
            "900001": _synthetic_story_chapter(900001, "asset_home", data.text("999993")),
            "900002": _synthetic_story_chapter(
                900002,
                "asset_linkstory",
                data.text("1000184"),
            ),
            "900003": _synthetic_story_chapter(
                900003, "asset_tutorial", data.text("ui_user_support_contact_report_category_7")
            ),
        }
    )
    for row in data.rows("MasterStoryLiveResultEpisode"):
        episode_metadata[int(row.get("_advId") or 0)] = {
            "chapterId": 900000,
            "episodeNumber": int(row.get("_id") or 0),
            "characterIds": [int(value) for value in row.get("_characterIds", [])],
            "unlockCharacterFriendshipLevel": int(row.get("_unlockCharacterFriendshipLevel") or 0),
        }
    home_spots = {int(row.get("_id") or 0): row for row in data.rows("MasterHomeSpot")}
    for row in data.rows("MasterStoryHomeSpotTapTalkEpisode"):
        spot = home_spots.get(int(row.get("_spotId") or 0), {})
        episode_metadata[int(row.get("_advId") or 0)] = {
            "chapterId": 900001,
            "episodeNumber": int(row.get("_id") or 0),
            "characterIds": [int(row.get("_characterId") or 0)],
            "publishedAt": _timestamp(spot.get("_startAt")),
        }
    for spot in home_spots.values():
        adv_id = int(spot.get("_advId") or 0)
        if adv_id:
            episode_metadata[adv_id] = {
                "chapterId": 900001,
                "episodeNumber": adv_id,
                "characterIds": [int(value) for value in spot.get("_characterIds", [])],
                "publishedAt": _timestamp(spot.get("_startAt")),
            }
    friendships = {
        int(row.get("_id") or 0): row for row in data.rows("MasterCharacterFriendship")
    }
    for row in data.rows("MasterStoryFriendshipEpisode"):
        friendship = friendships.get(int(row.get("_characterFriendshipId") or 0), {})
        episode_metadata[int(row.get("_advId") or 0)] = {
            "chapterId": 900002,
            "episodeNumber": int(row.get("_episodeNumber") or 0),
            "characterIds": [
                int(friendship.get("_masterCharacterIdA") or 0),
                int(friendship.get("_masterCharacterIdB") or 0),
            ],
            "unlockCharacterFriendshipLevel": int(row.get("_unlockCharacterFriendshipLevel") or 0),
            "banner": data.asset(
                f"Assets/AddressableResources/Story/Banner/Episode/{row.get('_banner')}.png"
            ),
        }

    episodes = {}
    for adv_id, adv in sorted(advs.items()):
        asset_name = str(adv.get("_advEpisodeAsset") or "")
        if not asset_name:
            continue
        story_id = asset_name.removeprefix("adv_script_")
        metadata = episode_metadata.get(adv_id)
        if metadata is None:
            chapter_id = 900003 if story_id.startswith("tutorial_") else 900001
            metadata = {"chapterId": chapter_id, "episodeNumber": adv_id, "characterIds": []}
        chapter_id = int(metadata.get("chapterId") or 0)
        chapter = chapters[str(chapter_id)]
        commands = _story_commands(data, asset_name)
        assets = _story_assets(data, asset_name, commands, live2d)
        story = _present(
            storyId=story_id,
            storyKey=story_id,
            episodeNumber=int(metadata.get("episodeNumber") or 0),
            chapterId=chapter_id,
            chapterKey=str(chapter.get("chapterKey") or chapter_id),
            chapterName=chapter.get("chapterName", ["", "", "", "", ""]),
            storySort=int(metadata.get("episodeNumber") or adv_id),
            title=data.text(adv.get("_titleTextId"), story_id),
            description=metadata.get("description", ["", "", "", "", ""]),
            bandId=chapter.get("bandId", 0),
            characterIds=[value for value in metadata.get("characterIds", []) if value],
            unlockCharacterFriendshipLevel=metadata.get("unlockCharacterFriendshipLevel"),
            publishedAt=metadata.get("publishedAt", [0, None, None, None, None]),
            closedAt=metadata.get("closedAt", [0, None, None, None, None]),
            playTime=adv_play_times.get(adv_id),
            scriptAsset=f"Assets/AddressableResources/Adv/Episode/{asset_name}/{asset_name}-Episode.txt",
            banner=metadata.get("banner"),
            image=metadata.get("image"),
            commands=commands,
            assets=assets,
        )
        episodes[story_id] = story
        chapter["episodes"].append(story_id)

    spots = {}
    tap_rows = data.rows("MasterStoryHomeSpotTapTalkEpisode")
    bands = {int(row.get("_id") or 0): row for row in data.rows("MasterBand")}
    for identity, row in home_spots.items():
        talks = []
        intro_adv_id = int(row.get("_advId") or 0)
        if intro_adv_id in advs:
            talks.append(
                {"id": f"intro-{identity}", "type": "spot", "advId": intro_adv_id, "storyKey": str(advs[intro_adv_id]["_advEpisodeAsset"]).removeprefix("adv_script_")}
            )
        for talk in tap_rows:
            if int(talk.get("_spotId") or 0) != identity:
                continue
            adv_id = int(talk.get("_advId") or 0)
            if adv_id not in advs:
                continue
            talks.append(
                {
                    "id": int(talk.get("_id") or 0),
                    "type": "tap",
                    "characterId": int(talk.get("_characterId") or 0),
                    "advId": adv_id,
                    "storyKey": str(advs[adv_id]["_advEpisodeAsset"]).removeprefix("adv_script_"),
                }
            )
        band_id = int(row.get("_bandId") or 0)
        background_path = str(row.get("_backgroundAssetPath") or "")
        spots[str(identity)] = _present(
            spotId=identity,
            bandId=band_id,
            bandName=data.text(bands.get(band_id, {}).get("_nameTextID"), ""),
            name=data.text(row.get("_advNameTextId"), str(identity)),
            assetName=background_path.split("/")[1] if "/" in background_path else background_path,
            characterIds=[int(value) for value in row.get("_characterIds", [])],
            talks=talks,
            spine=_home_spot_spine_runtime(data, row),
        )
    return {"chapters": chapters, "episodes": episodes, "homeSpots": spots}


def _sprite_outputs(
    data: BuildData,
    descriptor: dict[str, Any],
    source_path: str,
    logical_name: str,
) -> list[tuple[dict[str, Any], str]]:
    """Return exact runtime-backed Sprite outputs for one Unity logical name."""
    expected_parent = PurePosixPath("runtime/unity") / PurePosixPath(source_path)
    matches: list[tuple[dict[str, Any], str]] = []
    for output in descriptor.get("outputs", []):
        if not isinstance(output, dict) or output.get("type") != "Sprite":
            continue
        raw_object_id = str(output.get("objectId") or "")
        try:
            object_id = str(int(raw_object_id))
        except ValueError:
            continue
        output_path = PurePosixPath(str(output.get("path") or ""))
        if (
            output_path.parent != expected_parent
            or output_path.name != f"{logical_name}--Sprite-{object_id}.png"
        ):
            continue
        runtime_url = data.runtime_output_url(output_path.as_posix())
        if not runtime_url:
            raise ValueError(
                f"Unity Sprite output is absent from the exact runtime tree: {output_path}"
            )
        matches.append((output, runtime_url))
    return matches


def _unique_sprite_url(
    data: BuildData,
    descriptor: dict[str, Any],
    source_path: str,
    logical_name: str,
) -> str:
    matches = _sprite_outputs(data, descriptor, source_path, logical_name)
    if len(matches) != 1:
        paths = sorted(str(output.get("path") or "") for output, _ in matches)
        raise ValueError(
            f"Unity Sprite must resolve uniquely: {source_path}::{logical_name}; "
            f"found {len(matches)} ({', '.join(paths)})"
        )
    return matches[0][1]


def _external_sprite_pointer_identities(
    data: BuildData, value: Any, owner_serialized_file: str
) -> Iterable[tuple[str, str]]:
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "m_Sprite" and isinstance(child, dict):
                identity = data.unity_pointer_identity(child, owner_serialized_file)
                if identity:
                    yield identity
            yield from _external_sprite_pointer_identities(
                data, child, owner_serialized_file
            )
    elif isinstance(value, list):
        for child in value:
            yield from _external_sprite_pointer_identities(
                data, child, owner_serialized_file
            )


def _prefab_sprite_pointer_identities(
    data: BuildData, descriptor: dict[str, Any], source_path: str
) -> set[tuple[str, str]]:
    loaded_descriptor, objects = data.source_objects(source_path)
    if loaded_descriptor != descriptor:
        raise ValueError(f"Unity source descriptor changed while reading: {source_path}")
    root_objects = descriptor.get("rootObjects")
    preload_objects = descriptor.get("preloadObjects")
    if not isinstance(root_objects, list) or not isinstance(preload_objects, list):
        raise ValueError(f"Unity source object lists are invalid: {source_path}")
    source_object_ids: set[str] = set()
    for value in [*root_objects, *preload_objects]:
        try:
            source_object_ids.add(str(int(value)))
        except (TypeError, ValueError):
            raise ValueError(f"Unity source has an invalid object ID: {source_path}::{value}")
    root_object_ids = {str(int(value)) for value in root_objects}
    if not root_object_ids:
        raise ValueError(f"Unity source has no root objects: {source_path}")

    owner_serialized_file = str(descriptor.get("serializedFile") or "")
    if not owner_serialized_file:
        raise ValueError(f"Unity source has no serialized-file identity: {source_path}")
    pointer_identities: set[tuple[str, str]] = set()
    seen_source_objects: set[str] = set()
    for object_id in source_object_ids:
        record = objects.get(object_id)
        if record is not None:
            seen_source_objects.add(object_id)
            pointer_identities.update(
                _external_sprite_pointer_identities(
                    data, record.get("data"), owner_serialized_file
                )
            )
    if not root_object_ids.issubset(seen_source_objects):
        raise ValueError(f"Unity source roots are missing from object archive: {source_path}")
    return pointer_identities


def _story_ui_sprites(data: BuildData) -> dict[str, str]:
    fix_ui = data.source_descriptor(FIX_UI_SPRITE_ATLAS_SOURCE)
    default_talk_window = data.source_descriptor(DEFAULT_TALK_WINDOW_SOURCE)

    tap_candidates = _sprite_outputs(
        data, fix_ui, FIX_UI_SPRITE_ATLAS_SOURCE, "IconTapNext"
    )
    referenced_sprite_identities = _prefab_sprite_pointer_identities(
        data, default_talk_window, DEFAULT_TALK_WINDOW_SOURCE
    )
    tap_matches = [
        (output, url)
        for output, url in tap_candidates
        if (
            str(output.get("serializedFile") or ""),
            str(int(str(output.get("objectId") or "0"))),
        )
        in referenced_sprite_identities
    ]
    if len(tap_matches) != 1:
        paths = sorted(str(output.get("path") or "") for output, _ in tap_matches)
        raise ValueError(
            "UIDefaultTalkWindow m_Sprite must identify exactly one IconTapNext output; "
            f"found {len(tap_matches)} ({', '.join(paths)})"
        )

    return {
        "tapNext": tap_matches[0][1],
        "tapNextGlow": _unique_sprite_url(
            data, fix_ui, FIX_UI_SPRITE_ATLAS_SOURCE, "IconTapNextGlow"
        ),
        "next": _unique_sprite_url(
            data, fix_ui, FIX_UI_SPRITE_ATLAS_SOURCE, "sp_adv_next"
        ),
        "psychEdge": _unique_sprite_url(
            data, fix_ui, FIX_UI_SPRITE_ATLAS_SOURCE, "sp_adv_text_alt_edge"
        ),
        "psychLine": _unique_sprite_url(
            data, fix_ui, FIX_UI_SPRITE_ATLAS_SOURCE, "sp_adv_line"
        ),
        "choice": _unique_sprite_url(
            data, fix_ui, FIX_UI_SPRITE_ATLAS_SOURCE, "NormalButtonFrame_H96"
        ),
        "choiceActive": _unique_sprite_url(
            data, fix_ui, FIX_UI_SPRITE_ATLAS_SOURCE, "NormalButtonFrame_H96_Blue"
        ),
    }


def _adv_chat_window_rect(
    data: BuildData, prefab_source: str, sprite_source: str
) -> dict[str, float]:
    _, prefab_objects = data.source_objects(prefab_source)
    game_object_names = {
        object_id: str(record.get("data", {}).get("m_Name") or "")
        for object_id, record in prefab_objects.items()
        if record.get("type") == "GameObject"
    }
    mask_rects: list[dict[str, Any]] = []
    for record in prefab_objects.values():
        if record.get("type") != "RectTransform":
            continue
        raw = record.get("data", {})
        game_object_id = _unity_pointer_id(raw.get("m_GameObject"))
        anchor_min = raw.get("m_AnchorMin", {})
        anchor_max = raw.get("m_AnchorMax", {})
        pivot = raw.get("m_Pivot", {})
        if (
            game_object_names.get(game_object_id or "") == "Mask"
            and float(anchor_min.get("x") or 0) == 0.5
            and float(anchor_min.get("y") or 0) == 1
            and float(anchor_max.get("x") or 0) == 0.5
            and float(anchor_max.get("y") or 0) == 1
            and float(pivot.get("x") or 0) == 0.5
            and float(pivot.get("y") or 0) == 1
        ):
            mask_rects.append(raw)
    if len(mask_rects) != 1:
        raise ValueError(
            f"ADV chat prefab must contain one top-center Mask RectTransform: "
            f"{prefab_source}; found {len(mask_rects)}"
        )
    mask = mask_rects[0]
    size = mask.get("m_SizeDelta", {})
    position = mask.get("m_AnchoredPosition", {})
    mask_width = float(size.get("x") or 0)
    mask_height = float(size.get("y") or 0)
    mask_top = -float(position.get("y") or 0)
    if mask_width <= 0 or mask_height <= 0 or mask_top < 0:
        raise ValueError(f"ADV chat Mask geometry is invalid: {prefab_source}")

    _, sprite_objects = data.source_objects(sprite_source)
    sprites = [
        record.get("data", {})
        for record in sprite_objects.values()
        if record.get("type") == "Sprite"
        and record.get("data", {}).get("m_Name") == "chatwindow_image"
    ]
    if len(sprites) != 1:
        raise ValueError(
            f"ADV chat window sprite must resolve uniquely: {sprite_source}; "
            f"found {len(sprites)}"
        )
    rect = sprites[0].get("m_Rect", {})
    width = float(rect.get("width") or 0)
    height = float(rect.get("height") or 0)
    if width <= 0 or height <= 0:
        raise ValueError(f"ADV chat window sprite geometry is invalid: {sprite_source}")
    return {
        "width": width,
        "height": height,
        "maskTop": mask_top,
        "maskHeight": mask_height,
        "maskWidth": mask_width,
    }


def _adv_chat_assets(data: BuildData) -> dict[str, Any]:
    chat_root = "Assets/AddressableResources/Adv/Chat"
    template_data_root = f"{chat_root}/Data/_template/data/ChatLINE"
    template_prefab = f"{chat_root}/Prefabs/_template/_template.prefab"
    template_sprite = f"{chat_root}/Data/_template/data/chatwindow_image.png"
    if not all(
        source in data.source_path_set
        for source in (template_prefab, template_sprite, template_data_root + "/ADVChatIconLine_Plus.png")
    ):
        raise ValueError("ADV chat template assets are incomplete")

    masters: dict[str, dict[str, Any]] = {}
    presets_by_ref: dict[str, dict[str, Any]] = {}
    data_roots_by_window_asset: dict[str, str] = {}
    icon_images_by_asset: dict[str, str] = {}
    window_rects_by_data_root = {
        template_data_root: _adv_chat_window_rect(
            data, template_prefab, template_sprite
        )
    }
    prefab_prefix = f"{chat_root}/Prefabs/"
    for row in _sorted_rows(data, "MasterAdvChat", "_id"):
        identity = int(row.get("_id") or 0)
        window_asset = str(row.get("_chatWindowAssetName") or "")
        icon_asset = str(row.get("_chatIconAssetName") or "")
        preset_ref = window_asset or icon_asset
        if not preset_ref:
            raise ValueError(f"MasterAdvChat row has no semantic preset asset: {identity}")
        master = {
            "id": identity,
            "chatSoundId": int(row.get("_chatSoundId") or 0),
            "inOutSoundId": int(row.get("_inOutSoundId") or 0),
            "chatWindowAssetName": window_asset,
            "chatIconAssetName": icon_asset,
        }
        existing_preset = presets_by_ref.get(preset_ref)
        if existing_preset is not None and existing_preset.get("id") != identity:
            raise ValueError(
                f"MasterAdvChat semantic preset is ambiguous: {preset_ref}; "
                f"IDs {existing_preset.get('id')} and {identity}"
            )
        masters[str(identity)] = master
        presets_by_ref[preset_ref] = master
        if icon_asset:
            icon_source = f"{chat_root}/Icon/{icon_asset}.png"
            if icon_source in data.source_path_set:
                icon_images_by_asset[icon_asset] = icon_source
        if not window_asset:
            continue
        prefab_matches = [
            source
            for source in data.source_paths
            if source.startswith(prefab_prefix)
            and source.endswith(f"/{window_asset}.prefab")
        ]
        if not prefab_matches:
            continue
        if len(prefab_matches) != 1:
            raise ValueError(
                f"ADV chat window prefab is ambiguous: {window_asset}; "
                f"found {len(prefab_matches)}"
            )
        prefab_source = prefab_matches[0]
        directory = PurePosixPath(prefab_source).parent.name
        data_root = f"{chat_root}/Data/{directory}/data"
        sprite_source = f"{data_root}/chatwindow_image.png"
        if sprite_source not in data.source_path_set:
            raise ValueError(
                f"ADV chat window data is missing for prefab: {prefab_source}"
            )
        existing = data_roots_by_window_asset.get(window_asset)
        if existing is not None and existing != data_root:
            raise ValueError(f"ADV chat window data root diverges: {window_asset}")
        data_roots_by_window_asset[window_asset] = data_root
        window_rects_by_data_root[data_root] = _adv_chat_window_rect(
            data, prefab_source, sprite_source
        )

    return {
        "defaultDataRoot": template_data_root,
        "masters": masters,
        "presetsByRef": dict(sorted(presets_by_ref.items())),
        "dataRootsByWindowAsset": dict(sorted(data_roots_by_window_asset.items())),
        "windowRectsByDataRoot": dict(sorted(window_rects_by_data_root.items())),
        "iconImagesByAsset": dict(sorted(icon_images_by_asset.items())),
    }


def _story_runtime(data: BuildData, stories: dict[str, Any]) -> dict[str, Any]:
    transition = "Assets/AddressableResources/Adv/Transition/adv_transition_0001/texture.png"
    episodes = stories.get("episodes", {})
    post_effect_refs = {
        str(command.get("postEffectRef") or "")
        for episode in episodes.values()
        for command in episode.get("commands", [])
        if command.get("postEffectRef")
    }
    stage_refs = {
        str(background.get("stageRef") or "")
        for episode in episodes.values()
        for background in episode.get("assets", {}).get("backgrounds", [])
        if background.get("stageRef")
    }
    stages = {name: _stage_runtime(data, name) for name in sorted(stage_refs)}
    post_effects = {}
    for name in sorted(post_effect_refs):
        profile = _volume_profile(data, f"{ADV_POST_EFFECT_ROOT}/{name}.asset")
        if profile.get("name") != name:
            raise ValueError(
                f"ADV post effect identity mismatch: {name} != {profile.get('name')}"
            )
        post_effects[name] = profile
    _, stage_profiles = _stage_volume_profiles(data)
    for stage in stages.values():
        for name in stage.get("environmentPostEffectRefs", []):
            profile = stage_profiles.get(str(name))
            if profile is None:
                raise ValueError(f"ADV stage references an unknown post effect: {name}")
            post_effects[str(name)] = profile
    return {
        "allowUnityLighting": True,
        "allowCharacterPhysics": True,
        "allowCharacterBreathMotion": True,
        "allowCharacterBlur": True,
        "allowBackgroundBlur": True,
        "allowStageParticleEffect": True,
        "allowStagePostEffect": True,
        "renderScaleByQuality": [1, 1, 1, 1, 1],
        "targetFrameRateByQuality": [30, 30, 45, 60, 60],
        "targetNameSplitKey": "・",
        "uiSprites": _story_ui_sprites(data),
        "chatAssets": _adv_chat_assets(data),
        "postEffects": dict(sorted(post_effects.items())),
        "stages": stages,
        "waitTalkTextUnitTime": 0.04,
        "minTalkDisplayTime": 1.6,
        "waitVideoLingeringTimeOnAutoPlay": 0.3,
        "waitSubtitlesLingeringTimeOnAutoPlay": 0.1,
        "waitCommandLingeringTimeOnAutoPlay": 2,
        "stage": {
            "positions": {str(value): {"x": (value - 5) * 0.4, "y": 0, "z": 0} for value in (1, 3, 5, 7, 9)},
            "focusAnchors": {str(value): {"x": (value - 5) * 0.4, "y": 0, "z": 0} for value in range(1, 10)},
            "minX": -1.6,
            "maxX": 1.6,
            "width": 3.2,
        },
        "layout": {"designViewportAspect": 13 / 6},
        "audio": {"categoryVolumes": {"Bgm": 0.7, "Se": 1, "Voice": 1, "LiveBgm": 1, "LiveSe": 1, "LiveNotesSe": 1, "LiveVoice": 1}},
        "defaultRuleTransition": {
            "name": "adv_transition_0001",
            "texture": data.asset(transition),
            "maskTexture": data.asset(transition),
            "gradient": False,
        },
    }


def _story_asset_id(kind: str, identity: str) -> str:
    digest = hashlib.sha256(f"{kind}\0{identity}".encode("utf-8")).hexdigest()[:20]
    return f"{kind}-{digest}"


def _story_effect_catalog_entry(data: BuildData, target_asset: str) -> dict[str, Any]:
    source_path = f"{ADV_EFFECT_ROOT}/{target_asset}.prefab"
    asset_id = _story_asset_id("effect", source_path)
    try:
        runtime = dict(_effect_runtime(data, target_asset))
    except ValueError as error:
        if not str(error).startswith("Unity external pointer is unresolved:"):
            raise
        effect_root = PurePosixPath(source_path).parent
        textures = {}
        for candidate in data.source_paths:
            path = PurePosixPath(candidate)
            if effect_root not in path.parents or path.suffix.casefold() not in {
                ".png",
                ".jpg",
                ".jpeg",
                ".webp",
            }:
                continue
            url = data.asset(candidate)
            if url:
                textures[path.name] = url
        return {
            "assetId": asset_id,
            "kind": "effect",
            "assetName": target_asset,
            "name": PurePosixPath(target_asset).name,
            "source": source_path,
            "sourcePath": source_path,
            "textures": textures,
            "runtimeAvailable": False,
            "resolution": {
                "status": "unavailable",
                "reason": "unity-effect-runtime-unresolved",
            },
        }
    runtime_evidence = runtime.get("runtime", {}).get("evidence", {})
    uses_engine_fallback = bool(
        runtime_evidence.get("engineBuiltinMeshes")
        or runtime_evidence.get("missingMediaOutputs")
    )
    runtime.update(
        {
            "assetId": asset_id,
            "kind": "effect",
            "sourcePath": source_path,
            "runtimeAvailable": True,
            "resolution": {
                "status": "resolved",
                "reason": (
                    "unity-effect-runtime-serialized-with-engine-fallback"
                    if uses_engine_fallback
                    else "unity-effect-runtime-serialized"
                ),
                "fidelity": "adapted" if uses_engine_fallback else "exact-archive",
            },
        }
    )
    return runtime


def _story_assets_catalog(
    data: BuildData,
    stories: dict[str, Any],
    source_id: str,
) -> dict[str, Any]:
    """Build the editor-facing ADV inventory directly from normalized sources."""

    backgrounds: dict[str, dict[str, Any]] = {}
    stills: dict[str, dict[str, Any]] = {}
    frames: dict[str, dict[str, Any]] = {}
    effects: dict[str, dict[str, Any]] = {}
    post_effects: dict[str, dict[str, Any]] = {}
    videos: dict[str, dict[str, Any]] = {}
    bgms: dict[str, dict[str, Any]] = {}
    sound_effects: dict[str, dict[str, Any]] = {}
    voices: dict[str, dict[str, Any]] = {}

    _, stage_profiles = _stage_volume_profiles(data)
    stage_prefix = PurePosixPath(ADV_STAGE_ROOT).parts
    still_prefix = PurePosixPath(ADV_STILL_ROOT).parts
    frame_prefix = PurePosixPath(ADV_FRAME_ROOT).parts
    effect_prefix = PurePosixPath(ADV_EFFECT_ROOT).parts

    for source_path in data.source_paths:
        path = PurePosixPath(source_path)
        parts = path.parts
        if parts[: len(stage_prefix)] == stage_prefix:
            relative = parts[len(stage_prefix) :]
            if (
                len(relative) == 2
                and not relative[0].startswith("_")
                and relative[1] == f"{relative[0]}.prefab"
            ):
                asset_name = relative[0]
                stage = _stage_runtime(data, asset_name)
                background_source = str(stage["backgroundSprite"]["sourcePath"])
                url = data.asset(background_source)
                if not url:
                    raise ValueError(f"ADV stage background media is missing: {background_source}")
                asset_id = _story_asset_id("background", source_path)
                environment_profiles = {}
                for profile_name in stage.get("environmentPostEffectRefs", []):
                    profile = stage_profiles.get(str(profile_name))
                    if profile is None:
                        raise ValueError(
                            f"ADV stage references an unknown post effect: {asset_name}::{profile_name}"
                        )
                    environment_profiles[str(profile_name)] = profile
                backgrounds[asset_id] = {
                    "assetId": asset_id,
                    "kind": "background",
                    "assetName": asset_name,
                    "url": url,
                    "sourcePath": background_source,
                    "stageSourcePath": source_path,
                    "stageRef": asset_name,
                    "stage": stage,
                    "postEffects": dict(sorted(environment_profiles.items())),
                }
            continue
        if parts[: len(still_prefix)] == still_prefix:
            relative = parts[len(still_prefix) :]
            if (
                len(relative) == 4
                and not relative[0].startswith("_")
                and not relative[1].startswith("_")
                and relative[2].casefold() == "data"
                and PurePosixPath(relative[3]).suffix.casefold() == ".png"
                and PurePosixPath(relative[3]).stem == relative[1]
            ):
                asset_name = PurePosixPath(relative[0], relative[1]).as_posix()
                url = data.asset(source_path)
                if not url:
                    raise ValueError(f"ADV still media is missing: {source_path}")
                asset_id = _story_asset_id("still", source_path)
                stills[asset_id] = {
                    "assetId": asset_id,
                    "kind": "still",
                    "assetName": asset_name,
                    "url": url,
                    "sourcePath": source_path,
                }
            continue
        if (
            parts[: len(frame_prefix)] == frame_prefix
            and path.suffix.casefold() == ".prefab"
        ):
            target_asset = PurePosixPath(*parts[len(frame_prefix) :]).with_suffix("").as_posix()
            frame = dict(_frame_runtime(data, target_asset))
            asset_id = _story_asset_id("frame", source_path)
            frame.update(
                {
                    "assetId": asset_id,
                    "kind": "frame",
                    "sourcePath": source_path,
                }
            )
            frames[asset_id] = frame
            continue
        if (
            parts[: len(effect_prefix)] == effect_prefix
            and path.suffix.casefold() == ".prefab"
        ):
            target_asset = PurePosixPath(*parts[len(effect_prefix) :]).with_suffix("").as_posix()
            effect = _story_effect_catalog_entry(data, target_asset)
            effects[str(effect["assetId"])] = effect

    for scope, prefix in (
        ("command", ADV_POST_EFFECT_ROOT),
        ("stage-environment", ADV_STAGE_POST_EFFECT_ROOT),
    ):
        root_parts = PurePosixPath(prefix).parts
        for source_path in data.source_paths:
            path = PurePosixPath(source_path)
            relative = path.parts[len(root_parts) :]
            if (
                path.parts[: len(root_parts)] != root_parts
                or len(relative) != 1
                or path.suffix.casefold() != ".asset"
            ):
                continue
            profile = _volume_profile(data, source_path)
            asset_name = path.stem
            if profile.get("name") != asset_name:
                raise ValueError(
                    f"ADV post effect identity mismatch: {source_path}::{profile.get('name')}"
                )
            asset_id = _story_asset_id("post-effect", source_path)
            post_effects[asset_id] = {
                "assetId": asset_id,
                "kind": "post-effect",
                "assetName": asset_name,
                "sourcePath": source_path,
                "scope": scope,
                "profile": profile,
            }

    episode_story_ids: dict[str, str] = {}
    usage_by_episode_sound: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for story_id, story in stories.get("episodes", {}).items():
        script_asset = PurePosixPath(str(story.get("scriptAsset") or ""))
        episode_asset_name = script_asset.parent.name
        if not episode_asset_name:
            continue
        previous = episode_story_ids.get(episode_asset_name)
        if previous is not None and previous != story_id:
            raise ValueError(f"ADV episode asset is shared by multiple stories: {episode_asset_name}")
        episode_story_ids[episode_asset_name] = str(story_id)
        for command in story.get("commands", []):
            for field, role, expected_category in (
                ("bgmId", "story-bgm", 0),
                ("seId", "story-se", 1),
            ):
                sound_id = int(command.get(field) or 0)
                if sound_id:
                    usage_by_episode_sound.setdefault(
                        (episode_asset_name, sound_id), []
                    ).append(
                        {
                            "storyId": str(story_id),
                            "commandIndex": int(command.get("index") or 0),
                            "commandCode": int(command.get("command") or 0),
                            "sourceField": field,
                            "role": role,
                            "expectedCategory": expected_category,
                        }
                    )
            for sound_id in command.get("voiceIds", []):
                identity = int(sound_id or 0)
                if identity:
                    usage_by_episode_sound.setdefault(
                        (episode_asset_name, identity), []
                    ).append(
                        {
                            "storyId": str(story_id),
                            "commandIndex": int(command.get("index") or 0),
                            "commandCode": int(command.get("command") or 0),
                            "sourceField": "voiceIds",
                            "role": "story-voice",
                            "expectedCategory": 2,
                        }
                    )

    episode_root = PurePosixPath(
        "Assets/AddressableResources/Adv/Episode"
    ).parts
    for source_path in data.source_paths:
        path = PurePosixPath(source_path)
        if path.parts[: len(episode_root)] != episode_root:
            continue
        relative = path.parts[len(episode_root) :]
        if len(relative) != 2 or relative[1] != f"{relative[0]}-Sound.txt":
            continue
        episode_asset_name = relative[0]
        cue_sheet_source = (
            f"Assets/AddressableResources/Adv/Episode/{episode_asset_name}/"
            f"{episode_asset_name}-SoundCueSheet.txt"
        )
        if cue_sheet_source not in data.source_path_set:
            raise ValueError(f"ADV episode sound cue-sheet table is missing: {cue_sheet_source}")
        sound_rows, cue_sheet_rows = _story_sound_maps(data, episode_asset_name)
        for sound_id, row in sorted(sound_rows.items()):
            if "_category" not in row:
                raise ValueError(
                    f"ADV episode sound has no declared category: {source_path}::{sound_id}"
                )
            category = int(row["_category"])
            if category not in CRI_SOUND_CATEGORIES:
                raise ValueError(
                    f"ADV episode sound has an unknown category: {source_path}::{sound_id}::{category}"
                )
            usages = usage_by_episode_sound.get((episode_asset_name, sound_id), [])
            if any(value["expectedCategory"] != category for value in usages):
                raise ValueError(
                    f"ADV episode sound usage/category mismatch: {source_path}::{sound_id}"
                )
            sound = data.story_sound(sound_id, sound_rows, cue_sheet_rows)
            if sound is None:
                raise ValueError(f"ADV episode sound is unresolved: {source_path}::{sound_id}")
            kind = {0: "bgm", 1: "sound-effect", 2: "voice"}[category]
            asset_id = _story_asset_id(kind, f"{source_path}\0{sound_id}")
            story_id = episode_story_ids.get(episode_asset_name)
            entry = dict(sound)
            entry.update(
                {
                    "assetId": asset_id,
                    "kind": kind,
                    "sourceScope": "story",
                    "sourcePath": source_path,
                    "sourceStoryId": story_id,
                    "storyIds": [story_id] if story_id else [],
                    "declaredCategoryCode": category,
                    "declaredCategory": CRI_SOUND_CATEGORIES[category],
                    "usages": sorted({str(value["role"]) for value in usages}),
                    "usageEvidence": usages,
                }
            )
            {0: bgms, 1: sound_effects, 2: voices}[category][asset_id] = entry

    chat_sound_source = "Assets/AddressableResources/Adv/Chat/AdvChat-Sound.txt"
    chat_cue_sheet_source = (
        "Assets/AddressableResources/Adv/Chat/AdvChat-SoundCueSheet.txt"
    )
    if chat_sound_source in data.source_path_set:
        if chat_cue_sheet_source not in data.source_path_set:
            raise ValueError(
                f"ADV chat sound cue-sheet table is missing: {chat_cue_sheet_source}"
            )
        chat_root = data.assets / "Assets" / "AddressableResources" / "Adv" / "Chat"
        sound_rows, cue_sheet_rows = _adv_sound_maps(
            chat_root / "AdvChat-Sound.txt",
            chat_root / "AdvChat-SoundCueSheet.txt",
        )
        chat_usage: dict[int, list[dict[str, Any]]] = {}
        for row in _sorted_rows(data, "MasterAdvChat", "_id"):
            for field, role in (
                ("_chatSoundId", "adv-chat-message-se"),
                ("_inOutSoundId", "adv-chat-window-se"),
            ):
                sound_id = int(row.get(field) or 0)
                if sound_id:
                    chat_usage.setdefault(sound_id, []).append(
                        {
                            "sourceTable": "MasterAdvChat",
                            "sourceId": int(row.get("_id") or 0),
                            "sourceField": field,
                            "role": role,
                            "expectedCategory": 1,
                        }
                    )
        for sound_id, row in sorted(sound_rows.items()):
            if "_category" not in row or int(row["_category"]) != 1:
                raise ValueError(
                    f"ADV chat sound is not declared as SE: {chat_sound_source}::{sound_id}"
                )
            sound = data.story_sound(
                sound_id,
                sound_rows,
                cue_sheet_rows,
                source_table="AdvChatSound",
            )
            if sound is None:
                raise ValueError(f"ADV chat sound is unresolved: {sound_id}")
            usages = chat_usage.get(sound_id, [])
            asset_id = _story_asset_id(
                "sound-effect", f"{chat_sound_source}\0{sound_id}"
            )
            entry = dict(sound)
            entry.update(
                {
                    "assetId": asset_id,
                    "kind": "sound-effect",
                    "sourceScope": "adv-chat",
                    "sourcePath": chat_sound_source,
                    "storyIds": [],
                    "declaredCategoryCode": 1,
                    "declaredCategory": "Se",
                    "usages": sorted({str(value["role"]) for value in usages}),
                    "usageEvidence": usages,
                }
            )
            sound_effects[asset_id] = entry

    video_suffix = "-Video.txt"
    for source_path in data.source_paths:
        path = PurePosixPath(source_path)
        if path.parts[: len(episode_root)] != episode_root:
            continue
        relative = path.parts[len(episode_root) :]
        if len(relative) != 2 or relative[1] != f"{relative[0]}{video_suffix}":
            continue
        video_file = data.assets / Path(*path.parts)
        rows = read_json(video_file).get("_allData", []) if video_file.is_file() else []
        for row in rows:
            video_id = int(row.get("_id") or 0)
            asset_name = str(row.get("_assetName") or "").strip("/")
            if not video_id or not asset_name:
                raise ValueError(f"ADV story video has an empty identity: {source_path}")
            media = data.video_media(asset_name)
            if not media and asset_name.casefold().startswith("adv/"):
                media = data.video_media(asset_name.split("/", 1)[1])
            playable_url = str((media or {}).get("playableUrl") or "")
            asset_id = _story_asset_id("video", f"{source_path}\0{video_id}")
            story_id = episode_story_ids.get(relative[0])
            videos[asset_id] = _present(
                assetId=asset_id,
                kind="video",
                videoId=video_id,
                assetName=asset_name,
                sourcePath=source_path,
                sourceStoryId=story_id,
                storyIds=[story_id] if story_id else [],
                autoStop=bool(row.get("_autoStop")),
                width=int(row.get("_width") or 0),
                height=int(row.get("_height") or 0),
                hasAudio=bool(media and media.get("hasAudio")),
                masterDeclaredHasAudio=bool(row.get("_hasAudio")),
                note=row.get("_note"),
                playableUrl=playable_url,
                url=playable_url,
                type=(
                    "video/webm"
                    if PurePosixPath(playable_url).suffix.casefold() == ".webm"
                    else "video/mp4"
                ),
                runtimePath=(media or {}).get("runtimePath"),
                outputPath=(media or {}).get("outputPath"),
                videoCodec=(media or {}).get("videoCodec"),
                audioCodec=(media or {}).get("audioCodec"),
                missing=not bool(playable_url),
                resolution={
                    "status": "resolved" if playable_url else "missing",
                    "reason": (
                        "exact-story-video-runtime"
                        if playable_url
                        else "story-video-runtime-missing"
                    ),
                },
            )

    collections = {
        "backgrounds": dict(sorted(backgrounds.items())),
        "stills": dict(sorted(stills.items())),
        "frames": dict(sorted(frames.items())),
        "effects": dict(sorted(effects.items())),
        "postEffects": dict(sorted(post_effects.items())),
        "videos": dict(sorted(videos.items())),
        "bgms": dict(sorted(bgms.items())),
        "soundEffects": dict(sorted(sound_effects.items())),
        "voices": dict(sorted(voices.items())),
    }
    all_ids = [asset_id for values in collections.values() for asset_id in values]
    if len(all_ids) != len(set(all_ids)):
        raise ValueError("ADV story asset IDs collide across collections")
    expected_audio_categories = {
        "bgms": (0, "Bgm"),
        "soundEffects": (1, "Se"),
        "voices": (2, "Voice"),
    }
    for collection, (category, category_name) in expected_audio_categories.items():
        if any(
            entry.get("category") != category
            or entry.get("categoryName") != category_name
            or entry.get("declaredCategoryCode") != category
            or entry.get("declaredCategory") != category_name
            for entry in collections[collection].values()
        ):
            raise ValueError(
                f"ADV story asset audio category mismatch: {collection}::{category_name}"
            )
    expected_kinds = {
        "backgrounds": "background",
        "stills": "still",
        "frames": "frame",
        "effects": "effect",
        "postEffects": "post-effect",
        "videos": "video",
        "bgms": "bgm",
        "soundEffects": "sound-effect",
        "voices": "voice",
    }
    for collection, kind in expected_kinds.items():
        for asset_id, entry in collections[collection].items():
            if entry.get("assetId") != asset_id or entry.get("kind") != kind:
                raise ValueError(
                    f"ADV story asset collection identity mismatch: {collection}::{asset_id}"
                )
    return {
        "schema": STORY_ASSETS_SCHEMA,
        "server": data.server,
        "sourceId": source_id,
        **collections,
        "counts": {name: len(values) for name, values in collections.items()},
        "evidence": {
            "visualDiscovery": (
                "Direct source-index enumeration under Adv/Stage, Still, Frame, Effect, "
                "PostEffect, and Stage/_settings/posteffect; story-runtime usage is not used."
            ),
            "audioClassification": (
                "Adv Sound rows are partitioned only by declared numeric category 0/Bgm, "
                "1/Se, or 2/Voice; command bgmId, seId, and voiceIds are checked for exact "
                "category agreement."
            ),
            "videoDiscovery": "Direct enumeration of every Adv/Episode/*/*-Video.txt row.",
        },
    }


def _enrich_live2d(data: BuildData, models: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    characters = _characters(data)
    costumes = {}
    for row in data.rows("MasterCharacterCostume"):
        model_name = PurePosixPath(str(row.get("_live2dPath") or "")).name.casefold()
        if not model_name:
            continue
        previous = costumes.get(model_name)
        if previous is None or (row.get("_isDefault") and not previous.get("_isDefault")):
            costumes[model_name] = row
    output = {}
    for key, source in models.items():
        model = dict(source)
        character = characters.get(str(model.get("characterId") or ""), {})
        costume = costumes.get(PurePosixPath(str(model.get("sourcePath") or "")).stem.casefold())
        model.update(
            _present(
                title=model.get("live2dName"),
                label=model.get("live2dName"),
                characterName=character.get("characterName"),
                nickname=character.get("nickname"),
                bandId=character.get("bandId"),
                faceImage=character.get("faceImage"),
                thumbnailImage=character.get("thumbnailImage"),
                costumeId=int(costume.get("_costumeID") or 0) if costume else None,
                assetId=int(costume.get("_id") or 0) if costume else None,
            )
        )
        output[key] = model
    return output


def _voices(data: BuildData) -> dict[str, Any]:
    entries: dict[str, dict[str, Any]] = {}

    for row in _sorted_rows(data, "MasterTalk"):
        identity = int(row.get("_id") or 0)
        character_id = int(row.get("_characterId") or 0)
        key = f"talk:{identity}"
        entries[key] = _raw_record(
            "MasterTalk", row,
            voiceKey=key,
            masterId=identity,
            masterType=0,
            masterTypeName=CHARACTER_VOICE_MASTER_TYPES[0],
            characterIds=[character_id],
            talkCategory=int(row.get("_category") or 0),
            costumeId=int(row.get("_costumeId") or 0),
            expressionName=row.get("_expressionName"),
            motionName=row.get("_motionName"),
            seasonStartAt=row.get("_seasonStartAt"),
            seasonEndAt=row.get("_seasonEndAt"),
            year=int(row.get("_year") or 0),
            birthdayCharacterId=int(row.get("_birthdayCharacterId") or 0),
            unlockCharacterRank=int(row.get("_unlockCharacterRank") or 0),
            text=data.text(row.get("_textId")),
            sound=data.sound(int(row.get("_voiceSoundId") or 0)),
        )

    for row in _sorted_rows(data, "MasterCharacterVoice"):
        identity = int(row.get("_id") or 0)
        voice_type = int(row.get("_type") or 0)
        key = f"character:{identity}"
        entries[key] = _raw_record(
            "MasterCharacterVoice", row,
            voiceKey=key,
            masterId=identity,
            masterType=1,
            masterTypeName=CHARACTER_VOICE_MASTER_TYPES[1],
            characterIds=[int(row.get("_characterId") or 0)],
            characterVoiceType=voice_type,
            characterVoiceTypeName=CHARACTER_VOICE_TYPES.get(voice_type),
            scoreRank=int(row.get("_scoreRank") or 0),
            text=data.text(row.get("_textId")),
            sound=data.sound(int(row.get("_soundId") or 0)),
            startAt=_timestamp(row.get("_startAt")),
        )

    for row in _sorted_rows(data, "MasterMemberCard"):
        sound_id = int(row.get("_gachaVoiceSoundId") or 0)
        text_id = str(row.get("_gachaVoiceTextId") or "")
        if not sound_id and not text_id:
            continue
        identity = int(row.get("_id") or 0)
        key = f"member-card:{identity}"
        entries[key] = _raw_record(
            "MasterMemberCard", row,
            voiceKey=key,
            masterId=identity,
            masterType=2,
            masterTypeName=CHARACTER_VOICE_MASTER_TYPES[2],
            characterIds=[int(row.get("_characterID") or 0)],
            cardId=identity,
            assetId=int(row.get("_assetID") or 0),
            cardType=int(row.get("_cardType") or 0),
            rarity=int(row.get("_rarity") or 0),
            title=data.text(row.get("_subtitleTextID")),
            text=data.text(text_id),
            sound=data.sound(sound_id),
            startAt=_timestamp(row.get("_startAt")),
        )

    for row in _sorted_rows(data, "MasterLiveCharacter"):
        identity = int(row.get("_id") or 0)
        key = f"live-character:{identity}"
        entries[key] = _raw_record(
            "MasterLiveCharacter", row,
            voiceKey=key,
            masterId=identity,
            masterType=3,
            masterTypeName=CHARACTER_VOICE_MASTER_TYPES[3],
            characterIds=[int(row.get("_characterID") or 0)],
            characterAssetId=int(row.get("_characterAssetId") or 0),
            liveVoiceCueSheetId=int(row.get("_liveVoiceCueSheetID") or 0),
            performanceTimeVideoId=int(row.get("_performanceTimeVideoId") or 0),
            text=data.text(row.get("_liveSkillVoiceTextID")),
            sound=data.sound(int(row.get("_liveSkillVoiceSoundID") or 0)),
        )

    for row in _sorted_rows(data, "MasterLiveDialogueCommon"):
        identity = int(row.get("_id") or 0)
        dialogue_type = int(row.get("_dialogueType") or 0)
        call_type = int(row.get("_dialogueCallType") or 0)
        character_id = int(row.get("_characterID") or 0)
        key = f"dialogue-common:{identity}"
        entries[key] = _raw_record(
            "MasterLiveDialogueCommon", row,
            voiceKey=key,
            masterId=identity,
            masterType=5,
            masterTypeName=CHARACTER_VOICE_MASTER_TYPES[5],
            characterIds=[character_id],
            dialogueType=dialogue_type,
            dialogueTypeName=LIVE_DIALOGUE_TYPES.get(dialogue_type),
            dialogueCallType=call_type,
            dialogueCallTypeName=LIVE_DIALOGUE_CALL_TYPES.get(call_type),
            lines=[
                _present(
                    characterId=character_id,
                    text=data.text(row.get("_comboVoiceTextID")),
                    sound=data.sound(int(row.get("_comboVoiceSoundID") or 0)),
                )
            ],
        )

    for row in _sorted_rows(data, "MasterLiveDialogueFixedPair"):
        identity = int(row.get("_id") or 0)
        dialogue_type = int(row.get("_dialogueType") or 0)
        first_character = int(row.get("_characterID01") or 0)
        second_character = int(row.get("_characterID02") or 0)
        key = f"dialogue-pair:{identity}"
        entries[key] = _raw_record(
            "MasterLiveDialogueFixedPair", row,
            voiceKey=key,
            masterId=identity,
            masterType=6,
            masterTypeName=CHARACTER_VOICE_MASTER_TYPES[6],
            characterIds=[first_character, second_character],
            dialogueType=dialogue_type,
            dialogueTypeName=LIVE_DIALOGUE_TYPES.get(dialogue_type),
            unlockFriendshipRank=int(row.get("_unlockFriendshipRank") or 0),
            lines=[
                _present(
                    characterId=first_character,
                    text=data.text(row.get("_character01ComboVoiceTextID")),
                    sound=data.sound(int(row.get("_character01ComboVoiceSoundID") or 0)),
                ),
                _present(
                    characterId=second_character,
                    text=data.text(row.get("_character02ComboVoiceTextID")),
                    sound=data.sound(int(row.get("_character02ComboVoiceSoundID") or 0)),
                ),
            ],
        )

    for row in _sorted_rows(data, "MasterLiveStartCharacterVoice"):
        identity = int(row.get("_id") or 0)
        key = f"live-start:{identity}"
        entries[key] = _raw_record(
            "MasterLiveStartCharacterVoice", row,
            voiceKey=key,
            masterId=identity,
            masterType=7,
            masterTypeName=CHARACTER_VOICE_MASTER_TYPES[7],
            characterIds=[int(row.get("_characterId") or 0)],
            unlockCharacterRank=int(row.get("_unlockCharacterRank") or 0),
            text=data.text(row.get("_voiceTextId")),
            sound=data.sound(int(row.get("_voiceSoundId") or 0)),
        )

    for row in _sorted_rows(data, "MasterLiveGekisouVoice"):
        identity = int(row.get("_id") or 0)
        voice_type = int(row.get("_gekisouVoiceType") or 0)
        key = f"gekisou:{identity}"
        entries[key] = _raw_record(
            "MasterLiveGekisouVoice", row,
            voiceKey=key,
            masterId=identity,
            masterType=4,
            masterTypeName=CHARACTER_VOICE_MASTER_TYPES[4],
            characterIds=[int(row.get("_characterID") or 0)],
            gekisouVoiceType=voice_type,
            gekisouVoiceTypeName=GEKISOU_VOICE_TYPES.get(voice_type),
            text=data.text(row.get("_voiceTextID")),
            sound=data.sound(int(row.get("_voiceID") or 0)),
        )

    return {
        "entries": entries,
        "enums": {
            "characterVoiceType": _enum_document(
                "App.Master.CharacterVoiceType", CHARACTER_VOICE_TYPES
            ),
            "masterType": _enum_document(
                "App.Local.CharacterVoiceMasterType", CHARACTER_VOICE_MASTER_TYPES
            ),
            "collectionTabType": _enum_document(
                "App.UI.CharacterVoiceCollectionTabType", CHARACTER_VOICE_COLLECTION_TABS
            ),
            "collectionVoiceType": _enum_document(
                "App.Display.Presenter.CharacterVoiceCollectionDisplayPresenter.VoiceType",
                CHARACTER_VOICE_COLLECTION_VOICE_TYPES,
            ),
            "dialogueType": _enum_document("App.Master.LiveDialogueType", LIVE_DIALOGUE_TYPES),
            "dialogueCallType": _enum_document(
                "App.Master.LiveDialogueCallType", LIVE_DIALOGUE_CALL_TYPES
            ),
            "gekisouVoiceType": _enum_document(
                "App.Master.GekisouVoiceType", GEKISOU_VOICE_TYPES
            ),
        },
        "evidence": {
            "fieldBindings": {
                "MasterTalk._textId": "MasterText._id",
                "MasterTalk._voiceSoundId": "MasterSound._id",
                "MasterCharacterVoice._type": "App.Master.CharacterVoiceType",
                "MasterMemberCard._gachaVoiceTextId": "MasterText._id",
                "MasterMemberCard._gachaVoiceSoundId": "MasterSound._id",
                "MasterLiveCharacter._liveSkillVoiceTextID": "MasterText._id",
                "MasterLiveCharacter._liveSkillVoiceSoundID": "MasterSound._id",
                "MasterLiveDialogueCommon._dialogueType": "App.Master.LiveDialogueType",
                "MasterLiveDialogueCommon._dialogueCallType": "App.Master.LiveDialogueCallType",
                "MasterLiveGekisouVoice._gekisouVoiceType": "App.Master.GekisouVoiceType",
            },
            "masterTypeBindings": {
                "MasterTalk": 0,
                "MasterCharacterVoice": 1,
                "MasterMemberCard": 2,
                "MasterLiveCharacter": 3,
                "MasterLiveGekisouVoice": 4,
                "MasterLiveDialogueCommon": 5,
                "MasterLiveDialogueFixedPair": 6,
                "MasterLiveStartCharacterVoice": 7,
            },
            "warning": (
                "The UI presenter's private VoiceType is a separate presentation enum and is not "
                "used to interpret MasterCharacterVoice._type."
            ),
            "soundBinding": (
                "Voice sounds use the same strict MasterSound -> MasterSoundCueSheet -> unique ACB "
                "runtimePath -> exact cue output binding as audio.masterSounds. Unresolved or "
                "ambiguous cues remain missing."
            ),
        },
        "sourceTables": [
            "MasterTalk", "MasterCharacterVoice", "MasterMemberCard",
            "MasterLiveCharacter", "MasterLiveGekisouVoice",
            "MasterLiveDialogueCommon", "MasterLiveDialogueFixedPair",
            "MasterLiveStartCharacterVoice", "MasterSound", "MasterSoundCueSheet",
        ],
    }


def _audio_category(name: str) -> str:
    value = name.casefold().replace("\\", "/")
    if value.startswith("adv_voice_"):
        return "story-voice"
    if "voice" in value:
        return "voice"
    if value.startswith(("sound_bgm_", "bgm_")) or "/bgm" in value:
        return "bgm"
    if value.startswith(("sound_se_", "se_")) or any(
        token in value for token in ("/se", "notese", "livese")
    ):
        return "sound-effect"
    if value.startswith(("sound_music_", "music_")) or "/music" in value:
        return "music"
    return "uncategorized"


def _audio(data: BuildData) -> dict[str, Any]:
    entries: dict[str, dict[str, Any]] = {}
    category_counts: dict[str, int] = {}
    audio_suffixes = set(CRI_AUDIO_SUFFIXES)
    for entry in data.cri_entries:
        source = dict(entry.get("source") or {})
        outputs = []
        for output in entry.get("outputs", []):
            path = str(output.get("path") or "")
            suffix = PurePosixPath(path).suffix.casefold()
            if suffix not in audio_suffixes:
                continue
            outputs.append(
                _present(
                    path=path,
                    url=data.runtime_output_url(path),
                    bytes=int(output.get("bytes") or 0),
                    sha256=output.get("sha256"),
                    extension=suffix,
                )
            )
        if not outputs:
            continue
        original = str(source.get("originalFilename") or "")
        logical_name = re.sub(r"_[0-9a-f]{32}$", "", original, flags=re.IGNORECASE)
        key = str(
            source.get("artifactSha256")
            or source.get("unitySourcePath")
            or source.get("originalFilename")
            or entry.get("runtimePath")
            or logical_name
        )
        category = _audio_category(
            " ".join(
                value
                for value in (
                    logical_name,
                    str(source.get("unitySourcePath") or ""),
                    str(entry.get("runtimePath") or ""),
                )
                if value
            )
        )
        category_counts[category] = category_counts.get(category, 0) + 1
        entries[key] = _present(
            entityId=f"audio-{hashlib.sha256(key.encode('utf-8')).hexdigest()}",
            audioKey=key,
            kind=entry.get("kind"),
            category=category,
            logicalName=logical_name,
            source=source,
            runtimePath=entry.get("runtimePath"),
            outputs=sorted(outputs, key=lambda value: str(value.get("path") or "")),
            classificationEvidence="conservative filename prefix",
        )
    master_sounds = {
        str(identity): data.sound(identity)
        for identity in sorted(data.sounds)
    }
    sound_status_counts: dict[str, int] = {}
    sound_reason_counts: dict[str, int] = {}
    for sound in master_sounds.values():
        resolution = (sound or {}).get("resolution") or {}
        status = str(resolution.get("status") or "missing")
        reason = str(resolution.get("reason") or "unspecified")
        sound_status_counts[status] = sound_status_counts.get(status, 0) + 1
        sound_reason_counts[reason] = sound_reason_counts.get(reason, 0) + 1
    return {
        "entries": {key: entries[key] for key in sorted(entries)},
        "masterSounds": master_sounds,
        "categories": [
            {"id": category, "count": count}
            for category, count in sorted(category_counts.items())
        ],
        "sourceTables": ["MasterSound", "MasterSoundCueSheet"],
        "evidence": {
            "media": "metadata/cri.json outputs verified against the normalized runtime tree",
            "classification": "No semantic category is invented beyond conservative filename rules.",
            "masterSoundBinding": (
                "MasterSound._soundCueSheetID selects MasterSoundCueSheet._cueSheetName; that name "
                "must equal exactly one normalized ACB runtimePath basename. Within that entry, the "
                "MasterSound._cueName must exactly equal the output stem after removing only the "
                "vgmstream numeric sequence prefix. A unique single-output cue sheet is the only "
                "fallback. No substring or global cue-sheet search is used."
            ),
            "masterSoundResolution": {
                "total": len(master_sounds),
                "statusCounts": {
                    key: sound_status_counts[key] for key in sorted(sound_status_counts)
                },
                "reasonCounts": {
                    key: sound_reason_counts[key] for key in sorted(sound_reason_counts)
                },
            },
        },
    }


def _progression(data: BuildData) -> dict[str, Any]:
    items = _item_entries(data)

    def exact(table: str, rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        return [_raw_record(table, row) for row in rows]

    player_ranks = [
        _raw_record(
            "MasterPlayerRank", row,
            rankId=int(row.get("_id") or 0), rank=int(row.get("_rank") or 0),
            exp=int(row.get("_exp") or 0), friendMax=int(row.get("_friendMax") or 0),
        )
        for row in _sorted_rows(data, "MasterPlayerRank", "_rank", "_id")
    ]
    character_ranks = [
        _raw_record(
            "MasterCharacterRank", row,
            rankId=int(row.get("_id") or 0), rank=int(row.get("_rank") or 0),
            exp=int(row.get("_exp") or 0), bonus=int(row.get("_bonus") or 0),
        )
        for row in _sorted_rows(data, "MasterCharacterRank", "_rank", "_id")
    ]
    friendship_ranks = [
        _raw_record(
            "MasterCharacterFriendshipRank", row,
            rankId=int(row.get("_id") or 0), rank=int(row.get("_rank") or 0),
            exp=int(row.get("_exp") or 0),
        )
        for row in _sorted_rows(data, "MasterCharacterFriendshipRank", "_rank", "_id")
    ]
    character_rank_rewards = [
        _raw_record(
            "MasterCharacterRankReward", row,
            characterRankRewardId=int(row.get("_id") or 0),
            characterId=int(row.get("_characterId") or 0),
            rank=int(row.get("_rank") or 0),
            reward=_reward_record(data, "MasterCharacterRankReward", row, items),
        )
        for row in _sorted_rows(data, "MasterCharacterRankReward", "_characterId", "_rank", "_id")
    ]
    friendship_rank_rewards = [
        _raw_record(
            "MasterCharacterFriendshipRankReward", row,
            friendshipRankRewardId=int(row.get("_id") or 0),
            friendshipId=int(row.get("_characterFriendshipId") or 0),
            rank=int(row.get("_rank") or 0),
            reward=_reward_record(data, "MasterCharacterFriendshipRankReward", row, items),
        )
        for row in _sorted_rows(
            data, "MasterCharacterFriendshipRankReward",
            "_characterFriendshipId", "_rank", "_id",
        )
    ]

    def card_levels(table: str) -> list[dict[str, Any]]:
        return [
            _raw_record(
                table, row,
                levelId=int(row.get("_id") or 0), group=int(row.get("_group") or 0),
                level=int(row.get("_level") or 0), exp=int(row.get("_exp") or 0),
                performanceRate=int(row.get("_performanceRate") or 0),
                technicRate=int(row.get("_technicRate") or 0),
                visualRate=int(row.get("_visualRate") or 0),
            )
            for row in _sorted_rows(data, table, "_group", "_level", "_id")
        ]

    awake_resources = []
    for row in _sorted_rows(data, "MasterMemberCardAwakeResource", "_group", "_awakeCount", "_id"):
        item = items.get(int(row.get("_itemId") or 0))
        awake_resources.append(
            _raw_record(
                "MasterMemberCardAwakeResource", row,
                awakeResourceId=int(row.get("_id") or 0),
                group=int(row.get("_group") or 0),
                awakeCount=int(row.get("_awakeCount") or 0),
                itemId=int(row.get("_itemId") or 0),
                count=int(row.get("_count") or 0),
                item=_present(
                    itemId=item.get("itemId") if item else None,
                    name=item.get("name") if item else None,
                    image=item.get("image") if item else None,
                ),
            )
        )
    skill_resources = []
    for row in _sorted_rows(data, "MasterSkillLevelResource", "_group", "_level", "_id"):
        item = items.get(int(row.get("_itemID") or 0))
        skill_resources.append(
            _raw_record(
                "MasterSkillLevelResource", row,
                skillResourceId=int(row.get("_id") or 0),
                group=int(row.get("_group") or 0),
                level=int(row.get("_level") or 0),
                itemId=int(row.get("_itemID") or 0),
                count=int(row.get("_count") or 0),
                item=_present(
                    itemId=item.get("itemId") if item else None,
                    name=item.get("name") if item else None,
                    image=item.get("image") if item else None,
                ),
            )
        )

    source_tables = [
        "MasterPlayerRank", "MasterCharacterRank", "MasterCharacterTotalRank",
        "MasterCharacterRankReward", "MasterCharacterFriendshipRank",
        "MasterCharacterFriendshipRankReward", "MasterBandRank", "MasterBandTypeRank",
        "MasterMemberCardLevel", "MasterSupportCardLevel", "MasterMemberCardRank",
        "MasterSupportCardRank", "MasterMemberCardAwake", "MasterMemberCardLevelLimit",
        "MasterMemberCardAwakeResource", "MasterSkillLevelResource",
    ]
    return {
        "playerRanks": player_ranks,
        "characterRanks": character_ranks,
        "characterTotalRanks": exact(
            "MasterCharacterTotalRank",
            _sorted_rows(data, "MasterCharacterTotalRank", "_totalRank", "_id"),
        ),
        "characterRankRewards": character_rank_rewards,
        "friendshipRanks": friendship_ranks,
        "friendshipRankRewards": friendship_rank_rewards,
        "bandRanks": exact("MasterBandRank", _sorted_rows(data, "MasterBandRank", "_rank", "_id")),
        "bandTypeRanks": exact(
            "MasterBandTypeRank", _sorted_rows(data, "MasterBandTypeRank", "_rank", "_id")
        ),
        "memberCardLevels": card_levels("MasterMemberCardLevel"),
        "supportCardLevels": card_levels("MasterSupportCardLevel"),
        "memberCardRanks": exact(
            "MasterMemberCardRank",
            _sorted_rows(data, "MasterMemberCardRank", "_group", "_rank", "_id"),
        ),
        "supportCardRanks": exact(
            "MasterSupportCardRank",
            _sorted_rows(data, "MasterSupportCardRank", "_group", "_rank", "_id"),
        ),
        "memberCardAwake": exact(
            "MasterMemberCardAwake",
            _sorted_rows(data, "MasterMemberCardAwake", "_group", "_awakeCount", "_id"),
        ),
        "memberCardLevelLimits": exact(
            "MasterMemberCardLevelLimit",
            _sorted_rows(data, "MasterMemberCardLevelLimit", "_rarity", "_awakeCount", "_id"),
        ),
        "memberCardAwakeResources": awake_resources,
        "skillLevelResources": skill_resources,
        "sourceTables": source_tables,
        "evidence": {
            "semantics": (
                "Every value is copied from its named Master table. Whether an EXP field is "
                "incremental or cumulative is intentionally not inferred by this catalog."
            )
        },
    }


def _character_missions(data: BuildData) -> dict[str, Any]:
    items = _item_entries(data)
    rewards = {
        int(row.get("_id") or 0): _reward_record(data, "MasterMissionReward", row, items)
        for row in data.rows("MasterMissionReward")
    }
    missions = []
    observed_types: set[int] = set()
    for row in _sorted_rows(data, "MasterCharacterMission", "_missionType", "_priority", "_id"):
        mission_type = int(row.get("_missionType") or 0)
        observed_types.add(mission_type)
        reward_ids = [int(value) for value in row.get("_missionRewardIds", [])]
        missions.append(
            _raw_record(
                "MasterCharacterMission", row,
                missionId=int(row.get("_id") or 0),
                missionType=mission_type,
                missionTypeName=OBSERVED_CHARACTER_MISSION_TYPES.get(mission_type),
                title=data.text(row.get("_titleTextId")),
                description=data.text(row.get("_descriptionTextId")),
                achievementCount=int(row.get("_achievementCount") or 0),
                value=row.get("_value"),
                priority=int(row.get("_priority") or 0),
                isAlwaysShow=bool(row.get("_isAlwaysShow")),
                rewardIds=reward_ids,
                rewards=[rewards[value] for value in reward_ids if value in rewards],
                startAt=_timestamp(row.get("_startAt")),
                endAt=_timestamp(row.get("_endAt")),
            )
        )
    enum_values = {
        value: OBSERVED_CHARACTER_MISSION_TYPES[value]
        for value in sorted(observed_types)
        if value in OBSERVED_CHARACTER_MISSION_TYPES
    }
    return {
        "missions": missions,
        "missionTypes": _enum_document("App.Master.MissionType", enum_values),
        "sourceTables": ["MasterCharacterMission", "MasterMissionReward"],
        "evidence": {
            "scope": "Only MissionType values observed in MasterCharacterMission are enumerated."
        },
    }


def _friendships(data: BuildData) -> dict[str, Any]:
    items = _item_entries(data)
    story_keys_by_adv = {
        int(row.get("_id") or 0): str(row.get("_advEpisodeAsset") or "").removeprefix("adv_script_")
        for row in data.rows("MasterAdv")
        if row.get("_advEpisodeAsset")
    }
    rank_rows = [
        _raw_record(
            "MasterCharacterFriendshipRank", row,
            rank=int(row.get("_rank") or 0), exp=int(row.get("_exp") or 0),
        )
        for row in _sorted_rows(data, "MasterCharacterFriendshipRank", "_rank", "_id")
    ]
    rewards_by_friendship: dict[int, list[dict[str, Any]]] = {}
    for row in _sorted_rows(
        data, "MasterCharacterFriendshipRankReward", "_characterFriendshipId", "_rank", "_id"
    ):
        identity = int(row.get("_characterFriendshipId") or 0)
        rewards_by_friendship.setdefault(identity, []).append(
            _raw_record(
                "MasterCharacterFriendshipRankReward", row,
                rank=int(row.get("_rank") or 0),
                reward=_reward_record(data, "MasterCharacterFriendshipRankReward", row, items),
            )
        )
    episodes_by_friendship: dict[int, list[dict[str, Any]]] = {}
    for row in _sorted_rows(
        data, "MasterStoryFriendshipEpisode", "_characterFriendshipId", "_episodeNumber", "_id"
    ):
        identity = int(row.get("_characterFriendshipId") or 0)
        banner = str(row.get("_banner") or "")
        thumbnail = str(row.get("_thumbnail") or "")
        episodes_by_friendship.setdefault(identity, []).append(
            _raw_record(
                "MasterStoryFriendshipEpisode", row,
                episodeId=int(row.get("_id") or 0),
                episodeNumber=int(row.get("_episodeNumber") or 0),
                advId=int(row.get("_advId") or 0),
                storyKey=story_keys_by_adv.get(int(row.get("_advId") or 0)),
                unlockFriendshipLevel=int(row.get("_unlockCharacterFriendshipLevel") or 0),
                storyRewardGroupId=int(row.get("_storyRewardGroupId") or 0),
                banner=data.asset(f"Assets/AddressableResources/Story/Banner/Episode/{banner}.png"),
                thumbnail=data.asset(
                    f"Assets/AddressableResources/Story/Image/Episode/{thumbnail}.png"
                ),
            )
        )
    friendships = {}
    for row in _sorted_rows(data, "MasterCharacterFriendship"):
        identity = int(row.get("_id") or 0)
        asset = str(row.get("_storyBanner") or "")
        episodes = episodes_by_friendship.get(identity, [])
        friendships[str(identity)] = _raw_record(
            "MasterCharacterFriendship", row,
            friendshipId=identity,
            characterIds=[
                int(row.get("_masterCharacterIdA") or 0),
                int(row.get("_masterCharacterIdB") or 0),
            ],
            storyBannerAssetName=asset,
            storyBanner=(episodes[0].get("banner") if episodes else None),
            ranks=rank_rows,
            rewards=[
                *rewards_by_friendship.get(0, []),
                *rewards_by_friendship.get(identity, []),
            ],
            episodes=episodes,
        )
    return {
        "friendships": friendships,
        "sourceTables": [
            "MasterCharacterFriendship", "MasterCharacterFriendshipRank",
            "MasterCharacterFriendshipRankReward", "MasterStoryFriendshipEpisode", "MasterAdv",
        ],
    }


def _band_items(data: BuildData) -> dict[str, Any]:
    output = {}
    skill_targets = {
        int(row.get("_id") or 0): row for row in data.rows("MasterSkillTarget")
    }
    for row in _sorted_rows(data, "MasterBandItem", "_bandId", "_displayOrder", "_id"):
        identity = int(row.get("_id") or 0)
        levels = [
            _raw_record(
                "MasterBandItemLevel", level,
                levelId=int(level.get("_id") or 0),
                level=int(level.get("_level") or 0),
            )
            for level in _sorted_rows(data, "MasterBandItemLevel", "_bandItemId", "_level", "_id")
            if int(level.get("_bandItemId") or 0) == identity
        ]
        effects = [
            _raw_record(
                "MasterBandItemSkillEffect", effect,
                effectId=int(effect.get("_id") or 0),
                level=int(effect.get("_level") or 0),
                effectType=int(effect.get("_skillEffectType") or 0),
                effectValue=effect.get("_effectValue"),
                targetIds=[int(value) for value in effect.get("_skillTargetIDs", [])],
                targets=[
                    _raw_record(
                        "MasterSkillTarget",
                        skill_targets[target_id],
                        targetId=target_id,
                        targetType=int(skill_targets[target_id].get("_skillTargetType") or 0),
                        bandId=int(skill_targets[target_id].get("_bandID") or 0),
                        characterId=int(skill_targets[target_id].get("_characterID") or 0),
                        cardType=int(skill_targets[target_id].get("_cardType") or 0),
                        tagId=int(skill_targets[target_id].get("_tagID") or 0),
                    )
                    for target_id in [int(value) for value in effect.get("_skillTargetIDs", [])]
                    if target_id in skill_targets
                ],
            )
            for effect in _sorted_rows(
                data, "MasterBandItemSkillEffect", "_bandItemId", "_level", "_id"
            )
            if int(effect.get("_bandItemId") or 0) == identity
        ]
        output[str(identity)] = _raw_record(
            "MasterBandItem", row,
            bandItemId=identity,
            bandId=int(row.get("_bandId") or 0),
            name=data.text(row.get("_nameTextId")),
            description=data.text(row.get("_descriptionTextId")),
            displayOrder=int(row.get("_displayOrder") or 0),
            resourceGroupId=int(row.get("_resourceGroupId") or 0),
            levels=levels,
            effects=effects,
        )
    return {
        "items": output,
        "sourceTables": [
            "MasterBandItem", "MasterBandItemLevel", "MasterBandItemSkillEffect", "MasterSkillTarget"
        ],
        "evidence": {
            "skillEffectType": "Numeric value retained because no unambiguous source enum was proven."
        },
    }


def _skill_reference(data: BuildData) -> dict[str, Any]:
    def raw(table: str, *keys: str) -> list[dict[str, Any]]:
        return [_raw_record(table, row) for row in _sorted_rows(data, table, *keys)]

    effect_settings = [
        _raw_record(
            "MasterSkillEffectSetting", row,
            effectSettingId=int(row.get("_id") or 0),
            skillEffectType=int(row.get("_skillEffectType") or 0),
            phase=int(row.get("_phase") or 0),
            name=data.text(row.get("_nameTextId")),
        )
        for row in _sorted_rows(data, "MasterSkillEffectSetting", "_skillEffectType", "_id")
    ]
    bands = {
        int(row.get("_id") or 0): data.text(row.get("_nameTextID"))
        for row in data.rows("MasterBand")
        if int(row.get("_id") or 0)
    }
    targets = [
        _raw_record(
            "MasterSkillTarget",
            row,
            name=bands.get(int(row.get("_bandID") or 0)),
        )
        for row in _sorted_rows(data, "MasterSkillTarget")
    ]
    source_tables = [
        "MasterSkillCondition", "MasterSkillConditionSet", "MasterSkillCumulativeCondition",
        "MasterSkillTarget", "MasterSkillEffectGroup", "MasterSkillEffectSetting",
        "MasterSkillRating", "MasterSkillIcon", "MasterBand", "MasterText",
    ]
    return {
        "conditions": raw("MasterSkillCondition"),
        "conditionSets": raw("MasterSkillConditionSet", "_group", "_id"),
        "cumulativeConditions": raw("MasterSkillCumulativeCondition"),
        "targets": targets,
        "effectGroups": raw("MasterSkillEffectGroup", "_groupId", "_id"),
        "effectSettings": effect_settings,
        "ratings": raw("MasterSkillRating", "_skillType", "_skillLevel", "_id"),
        "icons": raw("MasterSkillIcon"),
        "sourceTables": source_tables,
        "evidence": {
            "interpretation": (
                "Condition, target, trigger and effect integers are exact Master values. This "
                "document does not claim activation, stacking or score formula semantics."
            )
        },
    }


def _gekisou(data: BuildData) -> dict[str, Any]:
    items = _item_entries(data)
    rank_rewards = []
    for row in _sorted_rows(data, "MasterGekisouLiveRankReward", "_group", "_type", "_liveScoreRank", "_id"):
        reward_type = int(row.get("_type") or 0)
        rank_rewards.append(
            _raw_record(
                "MasterGekisouLiveRankReward", row,
                rankRewardId=int(row.get("_id") or 0),
                group=int(row.get("_group") or 0),
                rewardType=reward_type,
                rewardTypeName=GEKISOU_REWARD_TYPES.get(reward_type),
                liveScoreRank=int(row.get("_liveScoreRank") or 0),
                probability=int(row.get("_probability") or 0),
                reward=_reward_record(data, "MasterGekisouLiveRankReward", row, items),
            )
        )
    calls = []
    for row in _sorted_rows(data, "MasterLiveGekisouCall", "_callType", "_id"):
        call_type = int(row.get("_callType") or 0)
        calls.append(
            _raw_record(
                "MasterLiveGekisouCall", row,
                callId=int(row.get("_id") or 0),
                callType=call_type,
                callTypeName=GEKISOU_CALL_TYPES.get(call_type),
                sound=data.sound(int(row.get("_seId") or 0)),
            )
        )
    tables = {
        "rankRewards": rank_rewards,
        "luckBasePoints": [
            _raw_record("MasterLiveGekisouLuckBasePoint", row)
            for row in _sorted_rows(data, "MasterLiveGekisouLuckBasePoint")
        ],
        "luckBonusLots": [
            _raw_record("MasterLiveGekisouLuckBonusLot", row)
            for row in _sorted_rows(data, "MasterLiveGekisouLuckBonusLot")
        ],
        "matchingBuckets": [
            _raw_record("MasterLiveGekisouMatchingBucket", row)
            for row in _sorted_rows(data, "MasterLiveGekisouMatchingBucket")
        ],
        "rankingScoreBonuses": [
            _raw_record("MasterLiveGekisouRankingScoreBonus", row)
            for row in _sorted_rows(data, "MasterLiveGekisouRankingScoreBonus", "_count", "_rank", "_id")
        ],
        "calls": calls,
    }
    return {
        **tables,
        "enums": {
            "missionType": _enum_document("App.LiveBase.GekisouMissionType", GEKISOU_MISSION_TYPES),
            "rankRewardType": _enum_document("App.Master.GekisouRankRewardType", GEKISOU_REWARD_TYPES),
            "supportExecTiming": _enum_document(
                "App.LiveLogic.Skill.GekisouSupportSkillExecTiming",
                GEKISOU_SUPPORT_EXEC_TIMINGS,
            ),
            "callType": _enum_document("App.LiveBase.GekisouCallType", GEKISOU_CALL_TYPES),
        },
        "sourceTables": [
            "MasterGekisouLiveRankReward", "MasterLiveGekisouLuckBasePoint",
            "MasterLiveGekisouLuckBonusLot", "MasterLiveGekisouMatchingBucket",
            "MasterLiveGekisouRankingScoreBonus", "MasterLiveGekisouCall",
        ],
        "evidence": {
            "interpretation": "Exact reference tables only; no complete Gekisou simulator formula is claimed."
        },
    }


def _video_category(asset_name: str) -> str:
    value = asset_name.casefold()
    if "/mv/" in value:
        return "music-video"
    if "/vj/" in value:
        return "stage-vj"
    if value.startswith("live_tutorial/"):
        return "live-tutorial"
    if value.startswith("live_top/"):
        return "live-top"
    if value.startswith("live/battle/character/"):
        return "gekisou-character"
    if value.startswith("movie_title"):
        return "title"
    if value.startswith("common/") or value.endswith("/background"):
        return "background"
    return "uncategorized"


def _videos(data: BuildData) -> dict[str, Any]:
    output = {}
    excluded = []
    for row in _sorted_rows(data, "MasterVideo"):
        identity = int(row.get("_id") or 0)
        asset_name = str(row.get("_assetName") or "")
        value = asset_name.casefold()
        reasons = []
        if any(token in value for token in ("/debug/", "/test/", "_test", "importtest", "conte")):
            reasons.append("debug-or-test-name")
        if value.endswith("_adjust"):
            reasons.append("adjustment-name")
        if reasons:
            excluded.append(
                _raw_record(
                    "MasterVideo", row, videoId=identity, assetName=asset_name, reasons=reasons
                )
            )
            continue
        media = data.video_media(asset_name)
        output[str(identity)] = _raw_record(
            "MasterVideo", row,
            videoId=identity,
            assetName=asset_name,
            displayName=data.text(row.get("_displayNameTextId")),
            hasAudio=bool(media and media.get("hasAudio")),
            masterDeclaredHasAudio=bool(row.get("_hasAudio")),
            autoStop=bool(row.get("_autoStop")),
            width=int(row.get("_width") or 0),
            height=int(row.get("_height") or 0),
            overrideShaderName=row.get("_overrideShaderName"),
            category=_video_category(asset_name),
            playableUrl=media.get("playableUrl") if media else None,
            runtimePath=media.get("runtimePath") if media else None,
            outputPath=media.get("outputPath") if media else None,
            videoCodec=media.get("videoCodec") if media else None,
            audioCodec=media.get("audioCodec") if media else None,
            musicVideoAudioBinding=(
                media.get("musicVideoAudioBinding") if media else None
            ),
        )
    return {
        "videos": output,
        "excluded": excluded,
        "stageVideos": [
            _raw_record("MasterLiveStageVideo", row)
            for row in _sorted_rows(data, "MasterLiveStageVideo", "_stageID", "_vjVideoPattern", "_id")
        ],
        "liveTopVideos": [
            _raw_record("MasterVideoLiveTop", row)
            for row in _sorted_rows(data, "MasterVideoLiveTop", "_order", "_id")
        ],
        "sourceTables": ["MasterVideo", "MasterLiveStageVideo", "MasterVideoLiveTop"],
        "evidence": {
            "filter": (
                "Rows with explicit debug/test/conte/import/adjustment names are retained only "
                "in excluded and never presented as production videos."
            ),
            "runtimeBinding": (
                "MasterVideo._assetName is matched only by exact normalized path-component suffix "
                "equality against one CRI USM runtimePath; filename substring search is not used."
            ),
            "hasAudio": (
                "hasAudio is derived from ffprobe-verified CRI runtime output metadata. "
                "MasterVideo._hasAudio is retained separately as masterDeclaredHasAudio."
            ),
        },
    }


def _help(data: BuildData) -> dict[str, Any]:
    subcategories_by_category: dict[int, list[dict[str, Any]]] = {}
    for row in _sorted_rows(data, "MasterHelpSubCategory", "_helpCategoryId", "_order", "_id"):
        category_id = int(row.get("_helpCategoryId") or 0)
        subcategories_by_category.setdefault(category_id, []).append(
            _raw_record(
                "MasterHelpSubCategory", row,
                helpSubcategoryId=int(row.get("_id") or 0),
                helpCategoryId=category_id,
                title=data.text(row.get("_titleTextId")),
                description=data.text(row.get("_descriptionTextId")),
                order=int(row.get("_order") or 0),
                startAt=_timestamp(row.get("_startAt")),
                endAt=_timestamp(row.get("_endAt")),
            )
        )
    categories = {}
    for row in _sorted_rows(data, "MasterHelpCategory", "_order", "_id"):
        identity = int(row.get("_id") or 0)
        categories[str(identity)] = _raw_record(
            "MasterHelpCategory", row,
            categoryId=identity,
            title=data.text(row.get("_titleTextId")),
            order=int(row.get("_order") or 0),
            startAt=_timestamp(row.get("_startAt")),
            endAt=_timestamp(row.get("_endAt")),
            subcategories=subcategories_by_category.get(identity, []),
        )
    tips = {}
    for row in _sorted_rows(data, "MasterLoadingTips"):
        identity = int(row.get("_id") or 0)
        tips[str(identity)] = _raw_record(
            "MasterLoadingTips", row,
            tipId=identity,
            title=data.text(row.get("_title")),
            description=data.text(row.get("_description")),
            startAt=_timestamp(row.get("_startAt")),
            endAt=_timestamp(row.get("_endAt")),
        )
    return {
        "categories": categories,
        "loadingTips": tips,
        "sourceTables": ["MasterHelpCategory", "MasterHelpSubCategory", "MasterLoadingTips"],
    }


def _options(data: BuildData) -> dict[str, Any]:
    defaults = []
    for row in _sorted_rows(data, "MasterOptionDefault", "_optionItemType", "_presetId", "_id"):
        option_type = int(row.get("_optionItemType") or 0)
        defaults.append(
            _raw_record(
                "MasterOptionDefault", row,
                optionDefaultId=int(row.get("_id") or 0),
                optionItemType=option_type,
                optionItemTypeName=OPTION_ITEM_TYPES.get(option_type),
                presetId=int(row.get("_presetId") or 0),
                valueString=str(row.get("_valueString") or ""),
                addedOptionVersion=row.get("_addedOptionVersion"),
            )
        )
    ranges = []
    for row in _sorted_rows(data, "MasterOptionRange", "_optionItemType", "_id"):
        option_type = int(row.get("_optionItemType") or 0)
        ranges.append(
            _raw_record(
                "MasterOptionRange", row,
                optionRangeId=int(row.get("_id") or 0),
                optionItemType=option_type,
                optionItemTypeName=OPTION_ITEM_TYPES.get(option_type),
                minValue=row.get("_minValue"),
                maxValue=row.get("_maxValue"),
            )
        )
    presets = [
        _raw_record(
            "MasterOptionPresetDefault", row,
            optionPresetDefaultId=int(row.get("_id") or 0),
            presetId=int(row.get("_presetId") or 0),
            name=data.text(row.get("_defaultNameTextId")),
        )
        for row in _sorted_rows(data, "MasterOptionPresetDefault", "_presetId", "_id")
    ]
    note_se = []
    for row in _sorted_rows(data, "MasterLiveNoteSe", "_groupID", "_liveNoteSeType", "_id"):
        note_se.append(
            _raw_record(
                "MasterLiveNoteSe", row,
                noteSeId=int(row.get("_id") or 0),
                groupId=int(row.get("_groupID") or 0),
                liveNoteSeType=int(row.get("_liveNoteSeType") or 0),
                sound=data.sound(int(row.get("_seId") or 0)),
            )
        )

    def exact(table: str, *keys: str) -> list[dict[str, Any]]:
        return [_raw_record(table, row) for row in _sorted_rows(data, table, *keys)]

    source_tables = [
        "MasterOptionDefault", "MasterOptionRange", "MasterOptionPresetDefault",
        "MasterLiveSettings", "MasterLiveJudgementTiming", "MasterLiveJudgementAreaOffset",
        "MasterLiveJudgementParameter", "MasterLiveJudgementSprite",
        "MasterLiveNoteParameter", "MasterLiveNoteSe", "MasterLiveNoteSeGroup",
        "MasterLiveNoteSkin", "MasterLiveNoteEffectSkin", "MasterLiveLaneSkin",
        "MasterLiveQualitySettings", "MasterLiveCharacterOption",
    ]
    return {
        "optionItemTypes": _enum_document("App.Options.OptionItemType", OPTION_ITEM_TYPES),
        "defaults": defaults,
        "ranges": ranges,
        "presets": presets,
        "liveSettings": exact("MasterLiveSettings", "_key", "_id"),
        "judgementTiming": exact(
            "MasterLiveJudgementTiming", "_assistLevel", "_noteJudgementType",
            "_noteSimulateJudgement", "_judgementPriority", "_id",
        ),
        "judgementAreaOffsets": exact(
            "MasterLiveJudgementAreaOffset", "_assistLevel", "_offsetType", "_id"
        ),
        "judgementParameters": exact(
            "MasterLiveJudgementParameter", "_noteSimulateJudgement", "_id"
        ),
        "judgementSprites": exact(
            "MasterLiveJudgementSprite", "_noteSimulateJudgement", "_id"
        ),
        "noteParameters": exact("MasterLiveNoteParameter", "_noteOperateType", "_id"),
        "noteSe": note_se,
        "noteSeGroups": exact("MasterLiveNoteSeGroup"),
        "noteSkins": exact("MasterLiveNoteSkin"),
        "noteEffectSkins": exact("MasterLiveNoteEffectSkin"),
        "laneSkins": exact("MasterLiveLaneSkin"),
        "qualitySettings": exact("MasterLiveQualitySettings", "_quality", "_id"),
        "characterOptions": exact("MasterLiveCharacterOption", "_characterID", "_id"),
        "sourceTables": source_tables,
        "evidence": {
            "values": "String defaults and numeric ranges are emitted exactly; units are not inferred."
        },
    }


def _live_tools(data: BuildData) -> dict[str, Any]:
    items = _item_entries(data)

    def exact(table: str, *keys: str) -> list[dict[str, Any]]:
        return [_raw_record(table, row) for row in _sorted_rows(data, table, *keys)]

    def rewards(table: str, *keys: str) -> list[dict[str, Any]]:
        return [
            _reward_record(data, table, row, items)
            for row in _sorted_rows(data, table, *keys)
        ]

    source_tables = [
        "MasterLiveScoreRank", "MasterLiveMusicScoreReward", "MasterLiveMusicComboReward",
        "MasterLiveMusicExpReward", "MasterLiveFreeReward", "MasterBattleLiveReward",
        "MasterLiveComboScoreBonus", "MasterLiveMusicBoostBonus",
        "MasterChallengeMusicBoostBonus", "MasterLiveBandHighScoreRating",
        "MasterLiveTotalHighScoreRating", "MasterLiveSettings",
        "MasterLiveJudgementTiming", "MasterLiveJudgementParameter",
        "MasterLiveNoteParameter", "MasterSkillRating",
    ]
    return {
        "enums": {
            "liveScoreRank": _enum_document("App.LiveBase.LiveScoreRank", LIVE_SCORE_RANKS),
            "liveDifficulty": _enum_document("App.LiveBase.LiveDifficulty", LIVE_DIFFICULTIES),
            "comboRewardType": _enum_document(
                "App.LiveBase.LiveMusicRewardComboType", LIVE_MUSIC_REWARD_COMBO_TYPES
            ),
        },
        "scoreRanks": exact("MasterLiveScoreRank", "_group", "_liveScoreRank", "_id"),
        "scoreRewards": rewards(
            "MasterLiveMusicScoreReward", "_group", "_liveScoreRank", "_id"
        ),
        "comboRewards": rewards(
            "MasterLiveMusicComboReward", "_group", "_difficulty", "_comboRateType", "_id"
        ),
        "expRewards": exact("MasterLiveMusicExpReward", "_liveScoreRank", "_id"),
        "freeRewards": rewards("MasterLiveFreeReward", "_group", "_liveScoreRank", "_id"),
        "battleRewards": rewards("MasterBattleLiveReward", "_group", "_liveScoreRank", "_id"),
        "comboScoreBonuses": exact(
            "MasterLiveComboScoreBonus", "_comboBonusType", "_requiredComboCount", "_id"
        ),
        "liveBoostBonuses": exact(
            "MasterLiveMusicBoostBonus", "_consumedLiveBoostCount", "_id"
        ),
        "challengeBoostBonuses": exact(
            "MasterChallengeMusicBoostBonus", "_consumedChallengePointCount", "_id"
        ),
        "bandHighScoreRatings": exact(
            "MasterLiveBandHighScoreRating", "_bandId", "_step", "_id"
        ),
        "totalHighScoreRatings": exact("MasterLiveTotalHighScoreRating", "_step", "_id"),
        "liveSettings": exact("MasterLiveSettings", "_key", "_id"),
        "judgementTiming": exact("MasterLiveJudgementTiming"),
        "judgementParameters": exact("MasterLiveJudgementParameter"),
        "noteParameters": exact("MasterLiveNoteParameter"),
        "skillRatings": exact("MasterSkillRating", "_skillType", "_skillLevel", "_id"),
        "sourceTables": source_tables,
        "evidence": {
            "formulaStatus": "reference-only",
            "rewardLookup": (
                "MasterLiveMusic.GetMusicScoreReward uses ScoreRankRewardGroup + score rank; "
                "GetMusicComboReward uses ComboRewardGroup + difficulty + combo rate type."
            ),
            "warning": (
                "The native score and auto-formation algorithms are not represented as a complete "
                "formula by these tables, so this document must not be advertised as a simulator."
            ),
        },
    }


def _provenance(data: BuildData, source_id: str) -> dict[str, Any]:
    source_index_file = data.root / "metadata" / "source-index.json"
    source_index = read_json(source_index_file) if source_index_file.is_file() else {}
    table_rows = {name: len(rows) for name, rows in sorted(data.tables.items())}
    kind_counts: dict[str, int] = {}
    output_count = 0
    output_bytes = 0
    for entry in data.cri_entries:
        kind = str(entry.get("kind") or "unknown")
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
        for output in entry.get("outputs", []):
            output_count += 1
            output_bytes += int(output.get("bytes") or 0)
    return {
        "schema": CATALOG_PROVENANCE_SCHEMA,
        "server": data.server,
        "sourceId": source_id,
        "localeSlots": [
            {"index": 0, "masterField": "_japanese", "locale": "ja"},
            {"index": 1, "masterField": "_english", "locale": "en"},
            {"index": 2, "masterField": "_traditionalChinese", "locale": "zh-Hant"},
            {"index": 3, "masterField": "_simplifiedChinese", "locale": "zh-Hans"},
            {"index": 4, "masterField": "_korean", "locale": "ko"},
        ],
        "master": {
            "tableCount": len(table_rows),
            "nonEmptyTableCount": sum(count > 0 for count in table_rows.values()),
            "rowCount": sum(table_rows.values()),
            "tableRows": table_rows,
        },
        "cri": {
            "entryCount": len(data.cri_entries),
            "outputCount": output_count,
            "outputBytes": output_bytes,
            "kindCounts": dict(sorted(kind_counts.items())),
        },
        "sourceIndex": {
            key: source_index.get(key)
            for key in (
                "schema", "server", "sourceId", "sourceCount", "bundleCount",
                "objectCount", "runtimeObjectCount", "mediaOutputCount",
            )
            if source_index.get(key) is not None
        },
        "evidence": {
            "masterTables": "decoded package Master JSON in the immutable normalized build",
            "unityAssets": "source-index paths resolved only when the normalized asset exists",
            "media": "CRI processing manifest outputs resolved only when the runtime file exists",
            "enums": "managed metadata enum names are paired with their original numeric values",
            "localePolicy": "Missing locale slots remain empty and are never copied from another locale.",
        },
    }


def _feature_status(data: BuildData) -> dict[str, Any]:
    features = {
        "events": (
            "MasterEvent", "MasterEventAchievementReward", "MasterEventBoxGacha",
            "MasterEventBoxGachaReward", "MasterEventEffect", "MasterEventPickUpCard",
            "MasterEventRankingReward",
        ),
        "gacha": (
            "MasterGacha", "MasterGachaBonus", "MasterGachaBonusLot", "MasterGachaLot",
            "MasterGachaPrize", "MasterGachaProduct", "MasterGachaStepUp", "MasterGachaView",
            "MasterGachaViewLabel",
        ),
        "login": ("MasterLoginBonus", "MasterLoginBonusSlot"),
        "missions": (
            "MasterMission", "MasterMissionReward", "MasterLimitedMission",
            "MasterLimitedMissionGroup",
        ),
        "shop": ("MasterShop", "MasterShopProduct", "MasterShopTrigger"),
        "exchange": (
            "MasterExchange", "MasterExchangeCategory", "MasterExchangeProduct",
            "MasterPieceExchange",
        ),
        "circle": (
            "MasterCircleMission", "MasterCircleMissionReward", "MasterCircleRank",
            "MasterCircleRankUpReward", "MasterCircleRankingReward",
            "MasterCircleWeeklyRankingSettings",
        ),
        "challenge": (
            "MasterChallengeMusic", "MasterChallengeMusicBoostBonus",
            "MasterChallengeMusicRankingReward",
        ),
    }
    primary_tables = {
        "events": "MasterEvent", "gacha": "MasterGacha", "login": "MasterLoginBonus",
        "missions": "MasterMission", "shop": "MasterShop", "exchange": "MasterExchange",
        "circle": "MasterCircleRank", "challenge": "MasterChallengeMusic",
    }
    output = {}
    for feature, tables in features.items():
        row_counts = {table: len(data.rows(table)) for table in tables}
        primary_count = row_counts.get(primary_tables[feature], 0)
        output[feature] = {
            "feature": feature,
            "status": "available" if primary_count else "construction",
            "illustrationKey": "maintenance-characters",
            "primaryTable": primary_tables[feature],
            "sourceTables": list(tables),
            "rowCounts": row_counts,
            "reason": (
                "primary-master-table-empty" if not primary_count else "primary-master-table-present"
            ),
        }
    return {
        "features": output,
        "evidence": {
            "statusRule": (
                "A feature remains construction when its primary Master table is empty, even if "
                "a supporting reward or boost table contains rows."
            )
        },
    }


def _resource_count(name: str, document: Any) -> int:
    if name == "stories" and isinstance(document, dict):
        return len(document.get("episodes", {}))
    if name == "story-runtime":
        return 1 if document else 0
    if name == "story-assets" and isinstance(document, dict):
        backgrounds = document.get("backgrounds", {})
        return len(backgrounds) if isinstance(backgrounds, dict) else 0
    collection_key = {
        "voices": "entries",
        "audio": "entries",
        "items": "items",
        "progression": "playerRanks",
        "character-missions": "missions",
        "friendships": "friendships",
        "band-items": "items",
        "skill-reference": "conditions",
        "gekisou": "rankRewards",
        "videos": "videos",
        "help": "categories",
        "options": "defaults",
        "live-tools": "scoreRanks",
        "feature-status": "features",
    }.get(name)
    if collection_key and isinstance(document, dict):
        value = document.get(collection_key, {})
        return len(value) if isinstance(value, (dict, list)) else 0
    if name == "provenance":
        return 1 if document else 0
    return len(document) if isinstance(document, dict) else 0


def build_api(config: ServerConfig, source_id: str, build_id: str) -> dict[str, Any]:
    layout = build_layout(config.id, build_id)
    data = BuildData(config.id, layout.root)
    live2d_file = layout.metadata / "live2d.json"
    live2d_raw = read_json(live2d_file).get("models", {}) if live2d_file.is_file() else {}
    live2d = _enrich_live2d(data, live2d_raw)
    songs, song_metadata = _songs(data)
    videos = _videos(data)
    video_records = videos.get("videos", {})
    for music_id, song in songs.items():
        resolved_videos = {
            str(video_id): video_records[str(video_id)]
            for video_id in song.get("videoIds", [])
            if str(video_id) in video_records and video_records[str(video_id)].get("playableUrl")
        }
        if resolved_videos:
            music_videos = {
                key: _present(
                    id=value.get("videoId"),
                    title=value.get("displayName"),
                    playableUrl=value.get("playableUrl"),
                    url=value.get("playableUrl"),
                    type=(
                        "video/webm"
                        if PurePosixPath(str(value.get("playableUrl") or "")).suffix.casefold() == ".webm"
                        else "video/mp4"
                    ),
                    width=value.get("width"),
                    height=value.get("height"),
                    hasAudio=value.get("hasAudio"),
                    videoCodec=value.get("videoCodec"),
                    audioCodec=value.get("audioCodec"),
                    musicVideoAudioBinding=value.get("musicVideoAudioBinding"),
                    sourceTable=value.get("sourceTable"),
                )
                for key, value in resolved_videos.items()
            }
            song["musicVideos"] = music_videos
            song["mvUrl"] = next(iter(music_videos.values()))["playableUrl"]
            song_metadata.setdefault(music_id, {})["musicVideos"] = music_videos
    leader_skills = _skills(
        data, "MasterLeaderSkill", "MasterLeaderSkillEffect", "_leaderSkillID", "leaderSkillId"
    )
    live_skills = _skills(
        data, "MasterLiveSkill", "MasterLiveSkillEffect", "_liveSkillID", "liveSkillId"
    )
    support_skills = _skills(
        data, "MasterSupportSkill", "MasterSupportSkillEffect",
        "_supportSkillID", "supportSkillId",
    )
    gekisou_skills = _skills(
        data, "MasterGekisouSkill", "MasterGekisouSkillEffect",
        "_gekisouSkillID", "gekisouSkillId",
    )
    gekisou_support_skills = _skills(
        data, "MasterGekisouSupportSkill", "MasterGekisouSupportSkillEffect",
        "_gekisouSupportSkillID", "gekisouSupportSkillId",
    )
    stories = _stories(data, live2d)
    story_runtime = _story_runtime(data, stories)
    story_assets = _story_assets_catalog(data, stories, source_id)
    documents = {
        "bands": _bands(data),
        "characters": _characters(data),
        "cards": _cards(data, "MasterMemberCard"),
        "support-cards": _cards(data, "MasterSupportCard", True),
        "songs": songs,
        "song-meta": song_metadata,
        "comics": _comics(data),
        "stamps": _stamps(data),
        "stories": stories,
        "story-runtime": story_runtime,
        "story-assets": story_assets,
        "live2d": live2d,
        "voices": _voices(data),
        "audio": _audio(data),
        "items": _items(data),
        "progression": _progression(data),
        "character-missions": _character_missions(data),
        "friendships": _friendships(data),
        "band-items": _band_items(data),
        "leader-skills": leader_skills,
        "skills": live_skills,
        "support-skills": support_skills,
        "gekisou-skills": gekisou_skills,
        "gekisou-support-skills": gekisou_support_skills,
        "skill-reference": _skill_reference(data),
        "gekisou": _gekisou(data),
        "videos": videos,
        "help": _help(data),
        "options": _options(data),
        "live-tools": _live_tools(data),
        "provenance": _provenance(data, source_id),
        "feature-status": _feature_status(data),
    }
    if tuple(documents) != CATALOG_RESOURCES:
        raise AssertionError("catalog resource contract and builder are out of sync")
    layout.api.mkdir(parents=True, exist_ok=True)
    for resource, document in documents.items():
        write_json(layout.api / f"{resource}.json", document)
    result = {
        "schema": "haneoka-catalog-build-v1",
        "server": config.id,
        "sourceId": source_id,
        "buildId": build_id,
        "resources": {name: _resource_count(name, value) for name, value in documents.items()},
    }
    write_json(layout.reports / "api.json", result, pretty=True)
    return result
