"""Merge Unity processing shards into one collision-checked build index."""

from __future__ import annotations

import ast
import json
import math
import os
import re
import sqlite3
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Callable, Iterable

from core.contracts import UNITY_INDEX_SCHEMA
from core.hashes import sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import build_layout, validate_unity_path
from core.process import hardlink_or_copy, walk_files
from core.unity_objects import iter_unity_object_archive

if TYPE_CHECKING:
    from core.delta import DeltaContext


MERGE_TREES = ("objects", "metadata/bundles")
RUNTIME_PROJECTION_PREFIXES = (
    "Assets/AddressableResources/Live/",
    "Assets/AddressableResources/Effect/Live/",
)
RUNTIME_PROJECTION_TYPES = {"AnimationClip", "ParticleSystem", "Sprite", "SpriteAtlas", "SpriteRenderer"}
LIVE_INTRO_ANIMATION_SOURCES = {
    f"Assets/AddressableResources/Band/{band}/timeline/{name}.anim"
    for band in range(6)
    for name in ("UILiveStartCanvas_hide", "UILiveStartCanvas_show", "live_game_view_in", "live_game_view_init",
                 "camera_track", "moving_light_root", "live_background_view", "live_game_lane_effect_in", "live_game_lane_effect_init")
}
# Each band's intro prefab references its own timeline materials and sprites
# (lane_line_color.mat, special_mygo.png, ...), so the whole directory is projected.
BAND_TIMELINE_ASSET = re.compile(r"Assets/AddressableResources/Band/[0-9]+/timeline/[^/]+\.(mat|png)")
# Original live intro data only. Shader programs are never projected here.
LIVE_INTRO_RUNTIME_SOURCES = {
    *LIVE_INTRO_ANIMATION_SOURCES,
    "Assets/AddressableResources/Live/Images/NonAtlas/LiveStartAnim/lane_mesh.fbx",
    *(
        f"Assets/AddressableResources/Band/{band}/timeline/{asset}"
        for band in range(6)
        for asset in ("live_start_playable_timeline.prefab", "live_start_timeline_asset.playable")
    ),
}
LIVE_INTRO_PROJECTION_TYPES = {
    "GameObject", "Transform", "RectTransform", "SkinnedMeshRenderer", "Mesh",
    "Animator", "AnimatorController", "MonoBehaviour", "PlayableDirector",
    "AnimationClip", "ParticleSystem", "ParticleSystemRenderer", "SpriteRenderer", "SortingGroup", "Material",
}
LIVE_INTRO_PROJECTION_POLICY = "live-intro-data-v4"
# Stable source and semantic object paths; serialized identities are discovered from each real build.
FX_SHARED_PREFAB_PARTICLE_PATHS = {'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_flick.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                              'root/ef_splash/ef_particle_star',
                                                                                              'root/ef_splash/ef_wall_center',
                                                                                              'root/ef_splash_move/ef_particl_splash',
                                                                                              'root/ef_splash_move/ef_particl_splash_line',
                                                                                              'root/ef_splash_move/ef_particl_splash_line02',
                                                                                              'root/ef_splash_move/ef_particle_point01',
                                                                                              'root/ef_splash_move/ef_particle_point02'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_flick_left.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                   'root/ef_splash/ef_particle_star',
                                                                                                   'root/ef_splash/ef_wall_center',
                                                                                                   'root/ef_splash_move/ef_splash',
                                                                                                   'root/ef_splash_move/ef_splash/ef_splash02'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_flick_right.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                    'root/ef_splash/ef_particle_star',
                                                                                                    'root/ef_splash/ef_wall_center',
                                                                                                    'root/ef_splash_move/ef_splash',
                                                                                                    'root/ef_splash_move/ef_splash/ef_splash02'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_just.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                             'root/ef_splash/ef_particle_star',
                                                                                             'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_normal.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                               'root/ef_splash/ef_particle_star',
                                                                                               'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_slide.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                              'root/ef_splash/ef_particle_star',
                                                                                              'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_slide_connect.prefab': frozenset({'root/ef_splash',
                                                                                                      'root/ef_splash/ef_particle_point',
                                                                                                      'root/ef_splash/ef_particle_star',
                                                                                                      'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_slide_loop.prefab': frozenset({'root/ef_slide_loop/ef_particle_point',
                                                                                                   'root/ef_slide_loop/ef_particle_point_frame',
                                                                                                   'root/ef_slide_loop/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_flick_left_light.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                              'root/ef_splash/ef_particle_star',
                                                                                                              'root/ef_splash/ef_wall_center',
                                                                                                              'root/ef_splash_move/ef_splash',
                                                                                                              'root/ef_splash_move/ef_splash/ef_splash02'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_flick_light.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                         'root/ef_splash/ef_particle_star',
                                                                                                         'root/ef_splash/ef_wall_center',
                                                                                                         'root/ef_splash_move/ef_particl_splash',
                                                                                                         'root/ef_splash_move/ef_particl_splash_line',
                                                                                                         'root/ef_splash_move/ef_particl_splash_line02',
                                                                                                         'root/ef_splash_move/ef_particle_point01',
                                                                                                         'root/ef_splash_move/ef_particle_point02'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_flick_right_light.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                               'root/ef_splash/ef_particle_star',
                                                                                                               'root/ef_splash/ef_wall_center',
                                                                                                               'root/ef_splash_move/ef_splash',
                                                                                                               'root/ef_splash_move/ef_splash/ef_splash02'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_just_light.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                        'root/ef_splash/ef_particle_star',
                                                                                                        'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_normal_light.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                          'root/ef_splash/ef_particle_star',
                                                                                                          'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_slide_connect_light.prefab': frozenset({'root/ef_splash',
                                                                                                                 'root/ef_splash/ef_particle_point',
                                                                                                                 'root/ef_splash/ef_particle_star',
                                                                                                                 'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_slide_light.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                         'root/ef_splash/ef_particle_star',
                                                                                                         'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_slide_loop_light.prefab': frozenset({'root/ef_slide_loop/ef_particle_point',
                                                                                                              'root/ef_slide_loop/ef_particle_point_frame',
                                                                                                              'root/ef_slide_loop/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_flick_left_simple.prefab': frozenset({'root/ef_splash/ef_wall_center',
                                                                                                                'root/ef_splash_move/ef_splash',
                                                                                                                'root/ef_splash_move/ef_splash/ef_splash02'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_flick_right_simple.prefab': frozenset({'root/ef_splash/ef_wall_center',
                                                                                                                 'root/ef_splash_move/ef_splash',
                                                                                                                 'root/ef_splash_move/ef_splash/ef_splash02'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_flick_simple.prefab': frozenset({'root/ef_splash/ef_wall_center',
                                                                                                           'root/ef_splash_move/ef_particle_point01',
                                                                                                           'root/ef_splash_move/ef_particle_point02'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_groove_simple.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                            'root/ef_splash/ef_particle_point_center',
                                                                                                            'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_normal_simple.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                            'root/ef_splash/ef_particle_point_center',
                                                                                                            'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_slide_simple.prefab': frozenset({'root/ef_splash/ef_particle_point',
                                                                                                           'root/ef_splash/ef_particle_point_center',
                                                                                                           'root/ef_splash/ef_wall_center'}),
 'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_slide_simple_loop.prefab': frozenset({'root/ef_slide_loop/ef_particle_point ',
                                                                                                                'root/ef_slide_loop/ef_particle_point_',
                                                                                                                'root/ef_slide_loop/ef_wall_center'})}
FX_SHARED_RUNTIME_SOURCES = frozenset({'Assets/AddressableResources/Effect/Live/NoteEffect/common/Material/ef_tap_normal_glow.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/Material/ef_tap_normal_long_glow.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/Material/ef_tap_pillar_glow.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/Material/ef_tap_pillar_glow02.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/Material/ef_tap_strong_glow.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/Material/ef_tap_wall.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/MaterialLight/tap_flame_light.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/MaterialLight/tap_normal_glow_light.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/MaterialLight/tap_pillar_light.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/MaterialLight/tap_wall_light.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/MaterialSimple/note_point_simple.mat',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/Texture/ef_tap_line.png',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/Texture/ef_tap_pillar.png',
           'Assets/AddressableResources/Effect/Live/NoteEffect/common/TextureLight/ef_tap_line_light.png',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_flick.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_flick_left.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_flick_right.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_just.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_normal.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_slide.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_slide_connect.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001/note_slide_loop.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_flick_left_light.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_flick_light.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_flick_right_light.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_just_light.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_normal_light.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_slide_connect_light.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_slide_light.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/note_slide_loop_light.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_flick_left_simple.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_flick_right_simple.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_flick_simple.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_groove_simple.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_normal_simple.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_slide_simple.prefab',
           'Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/note_slide_simple_loop.prefab',
           'Assets/AddressableResources/Live/Fbx/tap_wall_effect.fbx'})
LIVE_TAP_FADE_SOURCE = "Assets/AddressableResources/Scene/Live.unity"
TYPED_DATA_RUNTIME_SOURCES = LIVE_INTRO_RUNTIME_SOURCES | FX_SHARED_RUNTIME_SOURCES | {LIVE_TAP_FADE_SOURCE}

def _is_live_intro_source(source_path: str) -> bool:
    return source_path in LIVE_INTRO_RUNTIME_SOURCES or BAND_TIMELINE_ASSET.fullmatch(source_path) is not None

def _is_typed_data_source(source_path: str) -> bool:
    return source_path in TYPED_DATA_RUNTIME_SOURCES or _is_live_intro_source(source_path)

def _typed_data_projection_policy(source_path: str) -> str:
    if source_path == LIVE_TAP_FADE_SOURCE:
        return "live-tap-fade-data-v1"
    return "live-fx-shared-data-v2" if source_path in FX_SHARED_RUNTIME_SOURCES else LIVE_INTRO_PROJECTION_POLICY

HUD_FONT_RUNTIME_SOURCES = {
    "Assets/AddressableResources/Font/VibeMOPro-Medium/VibeMOPro-Medium SDF.asset",
    "Packages/com.fromtokyo.sirius-asset/AddressableResources/Font/"
    "VibeMOPro-Medium/VibeMOPro-Medium SDF.asset",
}


def _intro_projection_value(value: Any) -> Any:
    """Keep original 64-bit PPtr identity through JavaScript and Dart JSON readers."""
    if isinstance(value, list):
        return [_intro_projection_value(item) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key == "m_PostExtrapolationTime" and isinstance(item, float) and item == math.inf:
                # Timeline's authored unbounded Hold range; valid JSON retains its scalar type explicitly.
                result[key] = {"$unityFloat": "Infinity"}
            else:
                result[key] = _intro_projection_value(item)
        if "m_FileID" in value and "m_PathID" in value:
            path_id = value["m_PathID"]
            if isinstance(path_id, int) and not isinstance(path_id, bool):
                result["m_PathID"] = str(path_id)
        return result
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("non-finite Unity scalar requires its own field-specific runtime contract")
    return value


def _merge_tree(source: Path, target: Path) -> None:
    for file in walk_files(source):
        relative = file.relative_to(source)
        output = target / relative
        if output.exists():
            if output.stat().st_size != file.stat().st_size or sha256_file(output) != sha256_file(file):
                raise ValueError(f"shard output collision: {output}")
            continue
        hardlink_or_copy(file, output)


def _tree(entries: Iterable[str]) -> dict[str, Any]:
    root: dict[str, Any] = {}
    for value in sorted(entries):
        cursor = root
        parts = PurePosixPath(value).parts
        for part in parts[:-1]:
            cursor = cursor.setdefault(part, {})
        cursor[parts[-1]] = 1
    return root


def _descriptor_path(source_path: str) -> str:
    source = PurePosixPath(source_path)
    return PurePosixPath("metadata", "sources", *source.parts[:-1], f"{source.name}.json").as_posix()


def _canonical_source(candidates: list[dict[str, Any]], reports: dict[str, dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(
        candidates,
        key=lambda item: (
            0 if item["bundleOrigin"] == "remote-catalog" else 1,
            item["bundleSha256"],
            item["bundleFilename"],
        ),
    )
    selected_origin = "remote-catalog" if any(
        item["bundleOrigin"] == "remote-catalog" for item in ordered
    ) else "embedded-package"
    eligible = [item for item in ordered if item["bundleOrigin"] == selected_origin]
    fingerprints = {item["source"]["contentSha256"] for item in eligible}
    if len(fingerprints) != 1:
        # Locale variants now carry distinct namespaced source paths, so a single
        # source path resolving to several fingerprints is a genuine conflict (e.g.
        # two bundles both claim the same `(locale)` variant with different content)
        # rather than the expected multi-locale case. Keep the first deterministically
        # and warn rather than abort the whole merge.
        sys.stderr.write(
            f"warning: Unity source path resolves to {len(eligible)} conflicting "
            f"variants; keeping first: {eligible[0]['source']['sourcePath']} "
            f"({', '.join(item['bundleFilename'] for item in eligible)})\n"
        )
        eligible = eligible[:1]
    output_by_path: dict[str, dict[str, Any]] = {}
    for candidate in eligible:
        for output in candidate["source"].get("outputs", []):
            existing = output_by_path.get(output["path"])
            if existing and existing["sha256"] != output["sha256"]:
                # Locale variants in the same shard can produce the same output path
                # with different content. Keep the first rather than aborting.
                sys.stderr.write(
                    f"warning: Unity output path collision (locale variant), keeping first: {output['path']}\n"
                )
                continue
            output_by_path.setdefault(
                output["path"],
                {**output, "bundleSha256": candidate["bundleSha256"]},
            )
    selected = eligible[0]
    report = reports[selected["bundleSha256"]]
    source_path = selected["source"]["sourcePath"]
    return {
        "schema": "haneoka-unity-source-v1",
        "sourcePath": source_path,
        "basePath": selected["source"].get("basePath") or source_path,
        "serializedFile": selected["source"]["serializedFile"],
        "contentSha256": selected["source"]["contentSha256"],
        "selectedOrigin": selected_origin,
        "rootObjects": selected["source"]["rootObjects"],
        "preloadObjects": selected["source"].get("preloadObjects", []),
        "rootObjectReferences": selected["source"].get(
            "rootObjectReferences", []
        ),
        "preloadObjectReferences": selected["source"].get(
            "preloadObjectReferences", []
        ),
        "rootTypes": selected["source"]["rootTypes"],
        "preloadObjectCount": selected["source"]["preloadObjectCount"],
        "outputs": sorted(output_by_path.values(), key=lambda item: (item["path"], item["objectId"])),
        "selectedBundle": selected["bundleSha256"],
        "candidateBundles": [
            {
                "sha256": item["bundleSha256"],
                "originalFilename": item["bundleFilename"],
                "origin": item["bundleOrigin"],
            }
            for item in ordered
        ],
        "objectArchive": report["objectArchive"],
        "descriptor": _descriptor_path(source_path),
    }


def _materialize_outputs(
    layout,
    sources: list[dict[str, Any]],
    shard_count: int,
    delta: "DeltaContext | None" = None,
) -> tuple[int, dict[str, dict[str, Any]]]:
    """Materialize Unity media into the build tree.

    In delta mode, outputs of reusable bundles are not materialized: their
    bytes stay in the base release and the release composer references them.
    Each skipped output is validated against the base release manifest entry
    (path, sha256, bytes) before it may be composed, and it still participates
    in collision detection through the ``materialized`` map.
    """

    materialized: dict[str, str] = {}
    declared: dict[str, dict[str, Any]] = {}
    for source in sources:
        for output in source["outputs"]:
            relative = str(output["path"])
            if not relative.startswith(("assets/", "runtime/")):
                raise ValueError(f"invalid Unity media output path: {relative}")
            digest = str(output["bundleSha256"])
            reusable = delta is not None and delta.reusable(digest)
            if reusable:
                existing = materialized.get(relative)
                if existing and existing != output["sha256"]:
                    raise ValueError(f"canonical Unity media output collision: {relative}")
                entry = delta.require_entry(relative)
                if (
                    str(entry.get("sha256")) != str(output["sha256"])
                    or int(entry.get("bytes", -1)) != int(output["bytes"])
                ):
                    raise ValueError(
                        f"reusable Unity media output does not match the base release: {relative}"
                    )
                declared[relative] = {
                    "path": relative,
                    "sha256": str(output["sha256"]),
                    "bytes": int(output["bytes"]),
                }
            else:
                shard_index = int(digest[:16], 16) % shard_count
                candidate = layout.shards / f"{shard_index:03d}" / "candidates" / digest / relative
                if (
                    not candidate.is_file()
                    or candidate.stat().st_size != output["bytes"]
                    or sha256_file(candidate) != output["sha256"]
                ):
                    raise ValueError(f"Unity media candidate does not match its report: {candidate}")
                existing = materialized.get(relative)
                if existing and existing != output["sha256"]:
                    raise ValueError(f"canonical Unity media output collision: {relative}")
                if existing:
                    continue
                hardlink_or_copy(candidate, layout.root / Path(*PurePosixPath(relative).parts))
            materialized[relative] = output["sha256"]
    return len(materialized), declared


def _archive_records(file: Path) -> dict[str, dict[str, dict[str, Any]]]:
    records: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for _, value in iter_unity_object_archive(file):
        if value.get("record") == "object":
            serialized_file = str(value.get("serializedFile") or "")
            object_id = str(value["pathId"])
            if not serialized_file or object_id in records[serialized_file]:
                raise ValueError(
                    f"Unity archive repeats object identity "
                    f"{serialized_file}:{object_id}: {file}"
                )
            records[serialized_file][object_id] = value
    return dict(records)


def _discover_shared_fx_records(
    layout, sources: list[dict[str, Any]], delta: "DeltaContext | None" = None,
) -> dict[str, dict[tuple[str, str], str]]:
    """Resolve the shared renderer graph from this build's actual declared object identities."""
    available = {source["sourcePath"]: source for source in sources if source["sourcePath"] in FX_SHARED_RUNTIME_SOURCES}
    prefabs = set(available) & FX_SHARED_PREFAB_PARTICLE_PATHS.keys()
    if not prefabs:
        if available:
            raise ValueError("shared FX projection requires the coherent prefab source closure")
        return {}
    missing_sources = FX_SHARED_RUNTIME_SOURCES - available.keys()
    if missing_sources:
        raise ValueError(f"shared FX projection source closure missing: {sorted(missing_sources)}")
    loaded: dict[str, dict[str, dict[str, Any]]] = {}
    selected: dict[str, dict[tuple[str, str], str]] = defaultdict(dict)

    def records_for(source_path: str) -> dict[str, dict[str, Any]]:
        if source_path not in loaded:
            source = available[source_path]
            digest = source["selectedBundle"]
            archive = layout.objects / "unity" / f"{digest}.jsonl.gz"
            declared = source["objectArchive"]
            if not archive.is_file() and delta is not None and delta.reusable(digest):
                delta.fetch_archive(digest, archive)
            if (declared.get("path") != f"objects/unity/{digest}.jsonl.gz" or
                    not archive.is_file() or archive.stat().st_size != declared.get("bytes") or
                    sha256_file(archive) != declared.get("sha256")):
                raise ValueError(f"shared FX original archive identity mismatch: {source_path}")
            records = _archive_records(archive).get(source["serializedFile"], {})
            declared_ids = set(source["rootObjects"]) | set(source.get("preloadObjects", []))
            loaded[source_path] = {key: value for key, value in records.items() if key in declared_ids}
        return loaded[source_path]

    def take(source_path: str, path_id: str, expected_type: str) -> dict[str, Any]:
        record = records_for(source_path).get(path_id)
        if not record or record.get("type") != expected_type:
            raise ValueError(f"shared FX original declared object mismatch: {source_path}:{path_id}:{expected_type}")
        selected[source_path][(record["serializedFile"], path_id)] = expected_type
        return record

    external_references: dict[tuple[str, str], dict[str, Any]] = {}
    def collect_external(value: Any) -> None:
        if isinstance(value, dict):
            reference = value.get("reference")
            if isinstance(reference, dict) and reference.get("type") in {"Material", "Sprite", "Mesh"}:
                if reference.get("status") != "resolved" or str(value.get("m_PathID")) != reference.get("pathId"):
                    raise ValueError("shared FX external PPtr identity is unresolved")
                external_references[(reference["serializedFile"], reference["pathId"])] = reference
            for child in value.values():
                collect_external(child)
        elif isinstance(value, list):
            for child in value:
                collect_external(child)

    for source_path in sorted(prefabs):
        records = records_for(source_path)
        transforms: dict[str, str] = {}
        sorting: dict[str, list[str]] = defaultdict(list)
        renderers: dict[str, list[str]] = defaultdict(list)
        def local_pointer(value: Any) -> str:
            if not isinstance(value, dict) or value.get("m_FileID") != 0:
                raise ValueError(f"shared FX prefab hierarchy pointer is not local: {source_path}")
            return str(value["m_PathID"])
        for path_id, record in records.items():
            kind = record.get("type")
            if kind in {"Transform", "RectTransform", "SortingGroup", "ParticleSystemRenderer"}:
                owner = local_pointer(record["data"]["m_GameObject"])
                if kind in {"Transform", "RectTransform"}:
                    if owner in transforms:
                        raise ValueError(f"shared FX GameObject has duplicate transforms: {source_path}:{owner}")
                    transforms[owner] = path_id
                elif kind == "SortingGroup":
                    sorting[owner].append(path_id)
                else:
                    renderers[owner].append(path_id)
        def object_path(owner: str) -> str:
            names = []
            visited = set()
            while owner != "0":
                if owner in visited or owner not in transforms:
                    raise ValueError(f"shared FX transform hierarchy is cyclic or incomplete: {source_path}")
                visited.add(owner)
                game_object = records.get(owner)
                if not game_object or game_object.get("type") != "GameObject":
                    raise ValueError(f"shared FX hierarchy GameObject missing: {source_path}:{owner}")
                names.append(game_object["data"]["m_Name"])
                parent = local_pointer(records[transforms[owner]]["data"]["m_Father"])
                if parent == "0":
                    break
                owner = local_pointer(records[parent]["data"]["m_GameObject"])
            return "/".join(reversed(names[:-1]))
        def take_hierarchy(owner: str) -> None:
            visited = set()
            while owner != "0":
                if owner in visited or owner not in transforms:
                    raise ValueError(f"shared FX transform ancestry is cyclic or incomplete: {source_path}")
                visited.add(owner)
                take(source_path, owner, "GameObject")
                transform = records[transforms[owner]]
                take(source_path, transforms[owner], transform["type"])
                for group in sorting.get(owner, []):
                    take(source_path, group, "SortingGroup")
                parent = local_pointer(transform["data"]["m_Father"])
                owner = "0" if parent == "0" else local_pointer(records[parent]["data"]["m_GameObject"])
        expected_paths = FX_SHARED_PREFAB_PARTICLE_PATHS[source_path]
        found_paths = set()
        for path_id, record in records.items():
            kind = record.get("type")
            if kind not in {"ParticleSystem", "SpriteRenderer"}:
                continue
            owner = local_pointer(record["data"]["m_GameObject"])
            if kind == "ParticleSystem":
                path = object_path(owner)
                if path not in expected_paths:
                    continue
                if path in found_paths or len(renderers.get(owner, [])) != 1:
                    raise ValueError(f"shared FX active particle path/renderer is ambiguous: {source_path}:{path}")
                found_paths.add(path)
                take(source_path, path_id, kind)
                shape = record["data"].get("ShapeModule")
                if not isinstance(shape, dict):
                    raise ValueError(f"shared FX particle ShapeModule missing: {source_path}:{path}")
                for geometry_field, geometry_type in (("m_Mesh", "Mesh"), ("m_Sprite", "Sprite")):
                    pointer = shape.get(geometry_field)
                    if not isinstance(pointer, dict) or "m_PathID" not in pointer:
                        raise ValueError(f"shared FX particle geometry pointer missing: {source_path}:{geometry_field}")
                    if str(pointer["m_PathID"]) == "0":
                        continue
                    if pointer.get("m_FileID") == 0:
                        take(source_path, str(pointer["m_PathID"]), geometry_type)
                    elif not isinstance(pointer.get("reference"), dict) or pointer["reference"].get("type") != geometry_type:
                        raise ValueError(f"shared FX particle geometry class/reference unresolved: {source_path}:{geometry_field}")
                for unsupported_geometry_field in ("m_MeshRenderer", "m_SkinnedMeshRenderer", "m_SpriteRenderer", "m_Texture"):
                    pointer = shape.get(unsupported_geometry_field)
                    if not isinstance(pointer, dict) or "m_PathID" not in pointer or str(pointer["m_PathID"]) != "0":
                        raise ValueError(f"shared FX particle geometry requires another explicit source contract: {source_path}:{unsupported_geometry_field}")
                collect_external(record["data"])
                renderer = take(source_path, renderers[owner][0], "ParticleSystemRenderer")
                collect_external(renderer["data"])
            else:
                take(source_path, path_id, kind)
                collect_external(record["data"])
            take_hierarchy(owner)
        if found_paths != expected_paths:
            raise ValueError(f"shared FX semantic particle paths missing: {source_path}:{sorted(expected_paths - found_paths)}")
    for (owner_file, path_id), reference in external_references.items():
        matches = [source_path for source_path, source in available.items()
                   if source["serializedFile"] == owner_file and path_id in records_for(source_path)]
        if len(matches) != 1:
            raise ValueError(f"shared FX external object has no unique declared source: {owner_file}:{path_id}")
        take(matches[0], path_id, reference["type"])
    return dict(selected)


def _prefetch_base_descriptors(
    paths: Iterable[str], read_document: Callable[[str], Any],
) -> dict[str, tuple[Any, str | None]]:
    requests = list(dict.fromkeys(paths))
    if not requests:
        return {}

    def read(path: str) -> tuple[str, tuple[Any, str | None]]:
        try:
            return path, (read_document(path), None)
        except Exception as error:
            return path, (None, str(error))

    with ThreadPoolExecutor(max_workers=min(32, len(requests))) as executor:
        return dict(executor.map(read, requests))


def _runtime_projections(
    layout,
    sources: list[dict[str, Any]],
    delta: "DeltaContext | None" = None,
) -> tuple[int, int]:
    """Materialize the small Unity JSON surface consumed by the web runtime.

    Full object fidelity remains in the bundle JSONL archives.  These files are
    deterministic projections, named by real Unity source path and type ordinal;
    they do not recreate a processor-specific directory tree.

    In delta mode, projections of reusable bundles are adopted from the base
    release's descriptor documents instead of re-reading local archives; the
    base descriptor is cross-checked against the locally recomputed source
    identity before any of its fields are trusted.
    """

    fx_records = _discover_shared_fx_records(layout, sources, delta)
    fx_selection_documents = {
        path: [{"serializedFile": owner, "pathId": identity, "type": kind}
               for (owner, identity), kind in sorted(records.items())]
        for path, records in fx_records.items()
    }
    by_bundle: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for source in sources:
        source_path = source["sourcePath"]
        if (
            source_path.startswith(RUNTIME_PROJECTION_PREFIXES)
            or source_path in HUD_FONT_RUNTIME_SOURCES
            or _is_typed_data_source(source_path)
        ):
            by_bundle[source["selectedBundle"]].append(source)
    output_count = 0
    adopted_count = 0
    base_descriptors: dict[str, dict[str, Any] | None] = {}
    prefetched = _prefetch_base_descriptors(
        (str(source["descriptor"])
         for digest, bundle_sources in sorted(by_bundle.items()) if delta.reusable(digest)
         for source in bundle_sources), delta.base_document,
    ) if delta is not None else {}

    def base_descriptor(descriptor_path: str, label: str) -> dict[str, Any] | None:
        if descriptor_path not in base_descriptors:
            if descriptor_path in prefetched:
                document, diagnostic = prefetched.pop(descriptor_path)
            else:
                try:
                    document, diagnostic = delta.base_document(descriptor_path), None
                except Exception as error:
                    document, diagnostic = None, str(error)
            if diagnostic is not None:
                sys.stderr.write(
                    f"warning: base descriptor unavailable for {label}: {diagnostic}\n"
                )
            base_descriptors[descriptor_path] = document if isinstance(document, dict) else None
        return base_descriptors[descriptor_path]

    def adopt(source: dict[str, Any]) -> list[dict[str, Any]] | None:
        descriptor_path = str(source["descriptor"])
        document = base_descriptor(descriptor_path, source["sourcePath"])
        if document is None:
            return None
        for field in ("sourcePath", "contentSha256", "serializedFile", "selectedBundle"):
            if document.get(field) != source.get(field):
                raise ValueError(
                    f"base descriptor does not match the recomputed source identity: "
                    f"{source['sourcePath']} ({field})"
                )
        if _is_typed_data_source(source["sourcePath"]) and document.get("runtimeProjectionPolicy") != _typed_data_projection_policy(source["sourcePath"]):
            return None
        expected_fx = fx_selection_documents.get(source["sourcePath"])
        if expected_fx is not None and document.get("sharedFxProjectionRecords") != expected_fx:
            return None
        projections = document.get("runtimeObjects")
        if not isinstance(projections, list):
            return None
        return deepcopy(projections)

    for digest, bundle_sources in sorted(by_bundle.items()):
        pending_sources = []
        for source in bundle_sources:
            if delta is not None and delta.reusable(digest):
                projections = adopt(source)
                if projections is not None:
                    source["runtimeObjects"] = projections
                    if _is_typed_data_source(source["sourcePath"]):
                        source["runtimeProjectionPolicy"] = _typed_data_projection_policy(source["sourcePath"])
                    if source["sourcePath"] in fx_selection_documents:
                        source["sharedFxProjectionRecords"] = fx_selection_documents[source["sourcePath"]]
                    adopted_count += len(projections)
                    continue
                if not _is_typed_data_source(source["sourcePath"]):
                    raise ValueError(
                        f"base descriptor could not provide runtime projections: "
                        f"{source['sourcePath']}"
                    )
            pending_sources.append(source)
        if not pending_sources:
            continue
        archive_path = layout.objects / "unity" / f"{digest}.jsonl.gz"
        if not archive_path.is_file() and delta is not None and delta.reusable(digest):
            delta.fetch_archive(digest, archive_path)
        if not archive_path.is_file():
            raise ValueError(
                f"runtime projection policy requires the original local object archive: {digest}; "
                "refresh this real bundle's archive before rebuilding live intro projections"
            )
        for source in pending_sources:
            if not _is_typed_data_source(source["sourcePath"]):
                continue
            declared = source["objectArchive"]
            if (
                declared.get("path") != f"objects/unity/{digest}.jsonl.gz"
                or archive_path.stat().st_size != declared.get("bytes")
                or sha256_file(archive_path) != declared.get("sha256")
            ):
                raise ValueError(f"live intro object archive identity mismatch: {source['sourcePath']}")
        records_by_file = _archive_records(archive_path)
        for source in pending_sources:
            records = records_by_file.get(source["serializedFile"], {})
            object_ids = sorted(
                set(source["rootObjects"]) | set(source.get("preloadObjects", [])),
                key=int,
            )
            tap_ids: set[str] | None = None
            if source["sourcePath"] == LIVE_TAP_FADE_SOURCE:
                owners = [r for r in records.values() if r.get("type") == "MonoBehaviour"
                          and r.get("data", {}).get("m_Script", {}).get("reference", {}).get("name") == "LiveLaneView"
                          and "_tapAreaFadeInDuration" in r.get("data", {})]
                if len(owners) != 1:
                    raise ValueError("original tap-area fade owner is ambiguous or absent")
                owner = owners[0]
                tap_ids = {str(owner["pathId"])}
                for field, kind in (("m_GameObject", "GameObject"), ("_tapAreaAlphaController", "MonoBehaviour"),
                                    ("_tapAreaSpriteRenderer", "SpriteRenderer")):
                    pointer = owner["data"][field]
                    identity = str(pointer.get("m_PathID"))
                    if pointer.get("m_FileID") != 0 or records.get(identity, {}).get("type") != kind:
                        raise ValueError("original tap-area fade local owner pointer is unresolved")
                    tap_ids.add(identity)
                if len(tap_ids) != 4:
                    raise ValueError("original tap-area fade owner identities overlap")
                # Scene sources have no asset rootObjects: select only these four
                # records inside the exact descriptor-owned serialized file.
                object_ids = sorted(tap_ids, key=int)
            counters: dict[str, int] = defaultdict(int)
            projected = []
            for object_id in object_ids:
                record = records.get(object_id)
                if not record:
                    continue
                object_type = str(record.get("type") or "")
                identity = (str(record.get("serializedFile") or ""), str(record.get("pathId") or ""))
                declared_fx = fx_records.get(source["sourcePath"])
                allowed = object_type in RUNTIME_PROJECTION_TYPES
                if declared_fx is not None:
                    allowed = allowed or declared_fx.get(identity) == object_type
                # The live HUD consumes this one TMP_FontAsset descriptor.
                # Do not make MonoBehaviour a global projection type: Live
                # bundles contain many unrelated script objects.
                if tap_ids is not None:
                    allowed = object_id in tap_ids
                elif source["sourcePath"] in HUD_FONT_RUNTIME_SOURCES:
                    allowed = object_type == "MonoBehaviour"
                elif source["sourcePath"] in LIVE_INTRO_ANIMATION_SOURCES:
                    allowed = object_type == "AnimationClip"
                elif source["sourcePath"].endswith(".png") and BAND_TIMELINE_ASSET.fullmatch(source["sourcePath"]):
                    allowed = object_type == "Sprite"
                elif _is_live_intro_source(source["sourcePath"]):
                    allowed = object_type in LIVE_INTRO_PROJECTION_TYPES
                if not allowed:
                    continue
                ordinal = counters[object_type]
                counters[object_type] += 1
                filename = f"{object_type}{f'_{ordinal}' if ordinal else ''}.json"
                relative = PurePosixPath("unity-json", source["sourcePath"], filename)
                output = layout.runtime / Path(*relative.parts)
                output.parent.mkdir(parents=True, exist_ok=True)
                projection_record = (
                    _intro_projection_value(record)
                    if _is_live_intro_source(source["sourcePath"]) or tap_ids is not None or (declared_fx is not None and identity in declared_fx)
                    else record
                )
                if _is_live_intro_source(source["sourcePath"]) and object_type == "Material":
                    shader_pointer = record.get("data", {}).get("m_Shader", {})
                    if shader_pointer.get("m_FileID") == 0:
                        shader_id = str(shader_pointer.get("m_PathID") or "")
                        if not shader_id or shader_id == "0":
                            raise ValueError(f"intro material shader pointer is null: {identity}")
                        shader = records_by_file.get(identity[0], {}).get(shader_id)
                        if (
                            not shader or shader.get("type") != "Shader"
                            or shader.get("serializedFile") != identity[0]
                            or str(shader.get("pathId")) != shader_id
                        ):
                            raise ValueError(f"intro material local shader identity is unresolved: {identity}")
                        shader_data = shader.get("data", {})
                        root_name = shader_data.get("m_Name")
                        parsed_name = shader_data.get("m_ParsedForm", {}).get("m_Name")
                        if (not isinstance(root_name, str) or not isinstance(parsed_name, str)
                            or (root_name and parsed_name and root_name != parsed_name)
                            or not (root_name or parsed_name)):
                            raise ValueError(f"intro material shader name metadata is invalid: {identity}")
                        # Only original identity/name metadata crosses this boundary.
                        # Shader source, variants, subprograms and binary code remain in the verified archive.
                        projection_record["nativeShader"] = {
                            "type": "Shader", "name": root_name or parsed_name,
                            "serializedFile": identity[0], "pathId": shader_id,
                        }
                if _is_typed_data_source(source["sourcePath"]) and object_type in {"Mesh", "Sprite"}:
                    geometry_data = projection_record.get("data", {})
                    if object_type == "Sprite":
                        geometry_data = geometry_data.get("m_RD", {})
                    vertex_data = geometry_data.get("m_VertexData", {})
                    packed = vertex_data.get("m_DataSize")
                    if isinstance(packed, str) and packed.startswith(("b'", 'b"')):
                        packed_bytes = ast.literal_eval(packed)
                        if not isinstance(packed_bytes, bytes):
                            raise ValueError(f"live intro mesh vertex bytes are invalid: {source['sourcePath']}")
                        vertex_data["m_DataSize"] = list(packed_bytes)
                output.write_text(stable_json(projection_record), "utf-8")
                projected.append(
                    {
                        "pathId": object_id,
                        "type": object_type,
                        "ordinal": ordinal,
                        "path": f"runtime/{relative.as_posix()}",
                    }
                )
                output_count += 1
            source["runtimeObjects"] = projected
            if _is_typed_data_source(source["sourcePath"]):
                source["runtimeProjectionPolicy"] = _typed_data_projection_policy(source["sourcePath"])
            if source["sourcePath"] in fx_selection_documents:
                source["sharedFxProjectionRecords"] = fx_selection_documents[source["sourcePath"]]
    return output_count, adopted_count


def _write_database(file: Path, bundle_reports: list[dict[str, Any]], sources: list[dict[str, Any]]) -> None:
    temporary = file.with_name(f".{file.name}.{os.getpid()}.tmp")
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    try:
        connection.executescript(
            """
            PRAGMA journal_mode=OFF;
            PRAGMA synchronous=OFF;
            CREATE TABLE bundles (
              sha256 TEXT PRIMARY KEY,
              original_filename TEXT NOT NULL,
              bytes INTEGER NOT NULL,
              archive_path TEXT NOT NULL,
              archive_sha256 TEXT NOT NULL,
              object_count INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE sources (
              source_path TEXT PRIMARY KEY,
              content_sha256 TEXT NOT NULL,
              descriptor_path TEXT NOT NULL,
              selected_bundle_sha256 TEXT NOT NULL REFERENCES bundles(sha256),
              serialized_file TEXT NOT NULL
            ) STRICT;
            CREATE TABLE source_bundles (
              source_path TEXT NOT NULL REFERENCES sources(source_path),
              bundle_sha256 TEXT NOT NULL REFERENCES bundles(sha256),
              original_filename TEXT NOT NULL,
              PRIMARY KEY (source_path, bundle_sha256)
            ) STRICT;
            CREATE TABLE source_outputs (
              source_path TEXT NOT NULL REFERENCES sources(source_path),
              path TEXT NOT NULL,
              role TEXT NOT NULL,
              type TEXT NOT NULL,
              serialized_file TEXT NOT NULL,
              object_id TEXT NOT NULL,
              bytes INTEGER NOT NULL,
              sha256 TEXT NOT NULL,
              PRIMARY KEY (source_path, path, object_id)
            ) STRICT;
            """
        )
        for report in sorted(bundle_reports, key=lambda item: item["bundle"]["sha256"]):
            bundle = report["bundle"]
            archive = report["objectArchive"]
            connection.execute(
                "INSERT INTO bundles VALUES (?, ?, ?, ?, ?, ?)",
                (
                    bundle["sha256"],
                    bundle["originalFilename"],
                    bundle["bytes"],
                    archive["path"],
                    archive["sha256"],
                    archive["objectCount"],
                ),
            )
        for source in sources:
            connection.execute(
                "INSERT INTO sources VALUES (?, ?, ?, ?, ?)",
                (
                    source["sourcePath"],
                    source["contentSha256"],
                    source["descriptor"],
                    source["selectedBundle"],
                    source["serializedFile"],
                ),
            )
            connection.executemany(
                "INSERT INTO source_bundles VALUES (?, ?, ?)",
                (
                    (source["sourcePath"], bundle["sha256"], bundle["originalFilename"])
                    for bundle in source["candidateBundles"]
                ),
            )
            connection.executemany(
                "INSERT INTO source_outputs VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    (
                        source["sourcePath"],
                        output["path"],
                        output["role"],
                        output["type"],
                        output["serializedFile"],
                        output["objectId"],
                        output["bytes"],
                        output["sha256"],
                    )
                    for output in source["outputs"]
                ),
            )
        connection.commit()
        connection.execute("VACUUM")
    finally:
        connection.close()
    os.replace(temporary, file)


def merge_unity_shards(
    server: str,
    source_id: str,
    build_id: str,
    shard_count: int,
    delta: "DeltaContext | None" = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    begin = started
    timings = {}
    layout = build_layout(server, build_id)
    reports_by_sha: dict[str, dict[str, Any]] = {}
    candidates: dict[str, list[dict[str, Any]]] = defaultdict(list)
    shard_manifests = []
    for index in range(shard_count):
        shard = layout.shards / f"{index:03d}"
        descriptor_file = shard / "shard.json"
        if not descriptor_file.is_file():
            # Delta runs only materialize shards that had pending bundles; a
            # missing shard means every one of its bundles is reusable.
            if delta is not None:
                continue
            raise FileNotFoundError(f"missing Unity shard: {descriptor_file}")
        descriptor = read_json(descriptor_file)
        if (
            descriptor.get("sourceId") != source_id
            or descriptor.get("buildId") != build_id
            or descriptor.get("shardIndex") != index
            or descriptor.get("shardCount") != shard_count
        ):
            raise ValueError(f"Unity shard identity mismatch: {descriptor_file}")
        shard_manifests.append(descriptor)
        for tree in MERGE_TREES:
            _merge_tree(shard / tree, layout.root / tree)
        for file in sorted((shard / "metadata" / "bundles").glob("*.json")):
            report = json.loads(file.read_text("utf-8"))
            digest = report["bundle"]["sha256"]
            existing = reports_by_sha.get(digest)
            if existing and existing != report:
                raise ValueError(f"different reports for bundle {digest}")
            reports_by_sha[digest] = report
            for source in report.get("sources", []):
                validate_unity_path(source["sourcePath"])
                candidates[source["sourcePath"]].append(
                    {
                        "bundleSha256": digest,
                        "bundleFilename": report["bundle"]["originalFilename"],
                        "bundleOrigin": report["bundle"]["origin"],
                        "source": source,
                    }
                )
    timings["merge local shards"] = round(time.perf_counter() - begin, 3)
    begin = time.perf_counter()
    if delta is not None:
        missing = [
            digest for digest in delta.plan["bundles"] if digest not in reports_by_sha
        ]

        def fetch_report(digest: str) -> tuple[str, dict[str, Any]]:
            target = layout.metadata / "bundles" / f"{digest}.json"
            delta.fetch_report(digest, target)
            report = read_json(target)
            if str((report.get("bundle") or {}).get("sha256")) != digest:
                raise ValueError(f"fetched delta report does not match its bundle: {digest}")
            return digest, report

        with ThreadPoolExecutor(max_workers=max(1, min(32, len(missing) or 1))) as executor:
            for digest, report in executor.map(fetch_report, missing):
                reports_by_sha[digest] = report
        absent = sorted(
            digest for digest in delta.plan["pending"] if digest not in reports_by_sha
        )
        if absent:
            raise ValueError(f"delta shards did not produce pending bundle reports: {absent[:5]}")
        total = len(delta.plan["bundles"]) + len(delta.plan["pending"])
        if len(reports_by_sha) != total:
            raise ValueError(
                f"delta merge covered {len(reports_by_sha)} bundles, expected {total}"
            )
        # Reusable bundles never ran a shard locally, so their report sources
        # must feed the same candidate pool the shard loop fills; otherwise
        # source-index.json, the descriptors, and the api derivation would only
        # cover the pending shards' corpus.
        for digest in sorted(delta.plan["bundles"]):
            report = reports_by_sha[digest]
            for source in report.get("sources", []):
                validate_unity_path(source["sourcePath"])
                candidates[source["sourcePath"]].append(
                    {
                        "bundleSha256": digest,
                        "bundleFilename": report["bundle"]["originalFilename"],
                        "bundleOrigin": report["bundle"]["origin"],
                        "source": source,
                    }
                )

    timings["base bundle reports"] = round(time.perf_counter() - begin, 3)
    begin = time.perf_counter()
    sources = [_canonical_source(candidates[path], reports_by_sha) for path in sorted(candidates)]
    # Locale variants (`sourcePath != basePath`) are materialized as files so the
    # runtime can fetch e.g. stamp_illust_x(zh-Hans).png, but they stay out of
    # source-index.json and the database: api.py resolves each Unity media pointer
    # to a *unique* source, and indexing the locale siblings of a shared bundle
    # would make its pointers resolve to several sources and abort the build. The
    # canonical (locale-less ja base) source is the single indexed entry; variant
    # files ride along to the release via the assets tree walk.
    canonical_sources = [source for source in sources if source["sourcePath"] == source["basePath"]]
    timings["canonical sources"] = round(time.perf_counter() - begin, 3)
    begin = time.perf_counter()
    media_output_count, declared_media = _materialize_outputs(layout, sources, shard_count, delta)
    timings["materialize media"] = round(time.perf_counter() - begin, 3)
    begin = time.perf_counter()
    runtime_object_count, adopted_projection_count = _runtime_projections(layout, canonical_sources, delta)
    timings["runtime projections"] = round(time.perf_counter() - begin, 3)
    begin = time.perf_counter()
    declared_projections = {
        projection["path"]
        for source in canonical_sources
        for projection in source.get("runtimeObjects", [])
        if delta is not None and delta.reusable(str(source["selectedBundle"]))
    }
    for source in canonical_sources:
        write_json(layout.root / source["descriptor"], source)
    serialized_files: dict[str, dict[str, Any]] = {}
    for digest, report in sorted(reports_by_sha.items()):
        archive = report["objectArchive"]
        for serialized_file in report["bundle"].get("serializedFiles", []):
            object_count = int(
                archive.get("serializedFileObjectCounts", {}).get(
                    serialized_file, -1
                )
            )
            if object_count < 0:
                raise ValueError(
                    f"Unity archive has no object count for {serialized_file}"
                )
            value = {
                "bundleSha256": digest,
                "objectArchive": archive["path"],
                "objectCount": object_count,
                "archiveObjectCount": archive["objectCount"],
            }
            previous = serialized_files.get(serialized_file)
            if previous is not None and previous != value:
                # Locale-variant bundles share internal CAB/serialized-file identities.
                # Keep the first owner rather than aborting the multi-locale merge.
                sys.stderr.write(
                    f"warning: Unity serialized file {serialized_file} resolves to "
                    f"multiple archives; keeping first\n"
                )
                continue
            serialized_files[serialized_file] = value
    source_index = {
        "schema": UNITY_INDEX_SCHEMA,
        "server": server,
        "sourceId": source_id,
        "bundleCount": len(reports_by_sha),
        "sourceCount": len(canonical_sources),
        "objectCount": sum(report["objectArchive"]["objectCount"] for report in reports_by_sha.values()),
        # Counts include delta-adopted entries so a delta build's index is
        # byte-identical to a full rebuild of the same source.
        "runtimeObjectCount": runtime_object_count + adopted_projection_count,
        "mediaOutputCount": media_output_count + len(declared_media),
        "serializedFiles": serialized_files,
        "tree": _tree(source["sourcePath"] for source in canonical_sources),
        "sources": {
            source["sourcePath"]: {
                "descriptor": source["descriptor"].removeprefix("metadata/"),
                "contentSha256": source["contentSha256"],
                "serializedFile": source["serializedFile"],
                "rootTypes": source["rootTypes"],
                "outputs": source["outputs"],
            }
            for source in canonical_sources
        },
    }
    write_json(layout.metadata / "source-index.json", source_index)
    timings["source descriptors and index"] = round(time.perf_counter() - begin, 3)
    begin = time.perf_counter()
    _write_database(layout.database, list(reports_by_sha.values()), canonical_sources)
    timings["sqlite"] = round(time.perf_counter() - begin, 3)
    if delta is not None:
        # Persist what the release composer must take from the base release:
        # validated media outputs and adopted runtime projections.
        write_json(
            layout.reports / "delta-declared.json",
            {
                "schema": "haneoka-delta-declared-v1",
                "server": server,
                "sourceId": source_id,
                "buildId": build_id,
                "baseReleaseId": delta.base_release_id,
                "media": [declared_media[key] for key in sorted(declared_media)],
                "projectionPaths": sorted(declared_projections),
                "declaredMediaCount": len(declared_media),
                "declaredProjectionCount": len(declared_projections),
                "adoptedProjectionCount": adopted_projection_count,
            },
            pretty=True,
        )
    summary = {
        "schema": "haneoka-unity-merge-v1",
        "server": server,
        "sourceId": source_id,
        "buildId": build_id,
        "shardCount": shard_count,
        "bundleCount": len(reports_by_sha),
        "sourceCount": len(canonical_sources),
        "objectCount": source_index["objectCount"],
        "runtimeObjectCount": runtime_object_count + adopted_projection_count,
        "mediaOutputCount": media_output_count + len(declared_media),
        "timings": {**timings, "total": round(time.perf_counter() - started, 3)},
        **(
            {
                "deltaBaseReleaseId": delta.base_release_id,
                "deltaReusableBundleCount": len(delta.plan["bundles"]),
                "deltaPendingBundleCount": len(delta.plan["pending"]),
            }
            if delta is not None
            else {}
        ),
    }
    write_json(layout.reports / "unity.json", summary, pretty=True)
    return summary
