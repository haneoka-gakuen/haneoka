"""Compile canonical catalog documents into immutable, partitioned R2 read models."""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from core.contracts import (
    CATALOG_PARTITION_ALGORITHM,
    CATALOG_PARTITION_SHARDS,
    CATALOG_PROVENANCE_SCHEMA,
    CATALOG_RESOURCES,
    CATALOG_STORAGE_SCHEMA,
    CATALOG_SUMMARY_SCHEMA,
    SOURCE_INDEX_STORAGE_SCHEMA,
    UNITY_INDEX_SCHEMA,
)
from core.manifests import read_json, write_json
from core.paths import normalize_release_path
from core.storage import fnv1a32_shard


JsonObject = dict[str, Any]


@dataclass(frozen=True)
class RelationSpec:
    name: str
    fields: tuple[tuple[str, ...], ...]
    value_mode: str = "records"


@dataclass(frozen=True)
class ProjectionSpec:
    include: tuple[str, ...] | None = None
    exclude: tuple[str, ...] = ()
    compact_skills: bool = False


@dataclass(frozen=True)
class ViewSpec:
    name: str
    collection: tuple[str, ...]
    id_fields: tuple[tuple[str, ...], ...]
    projection: ProjectionSpec
    filter_equals: tuple[tuple[tuple[str, ...], Any], ...] = ()
    replace_collection_in_index: bool = True


@dataclass(frozen=True)
class ResourceSpec:
    collection: tuple[str, ...] | None = None
    id_fields: tuple[tuple[str, ...], ...] = ()
    projection: ProjectionSpec = ProjectionSpec()
    relations: tuple[RelationSpec, ...] = ()
    dependencies: tuple[str, ...] = ()
    views: tuple[ViewSpec, ...] = ()


CHARACTER_RELATION = RelationSpec("character", (("characterId",), ("characterIds",)))
CATALOG_ROUTE_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}")


def valid_catalog_route_key(value: object) -> bool:
    return (
        isinstance(value, str)
        and value not in {".", ".."}
        and CATALOG_ROUTE_KEY.fullmatch(value) is not None
    )


AUDIO_MASTER_SOUNDS_VIEW = ViewSpec(
    "master-sounds",
    ("masterSounds",),
    (("soundId",), ("raw", "_id")),
    ProjectionSpec(
        include=(
            "binding",
            "category",
            "categoryName",
            "channels",
            "cueName",
            "cueSheetName",
            "durationMs",
            "loopInfo",
            "missing",
            "outputPath",
            "playableUrl",
            "resolution",
            "runtimePath",
            "sampleRate",
            "soundCueSheetId",
            "soundId",
            "streamCount",
            "streamIndex",
            "totalSamples",
        )
    ),
)


def _audio_master_sounds_view(name: str, category_name: str) -> ViewSpec:
    return ViewSpec(
        name,
        ("masterSounds",),
        (("soundId",), ("raw", "_id")),
        AUDIO_MASTER_SOUNDS_VIEW.projection,
        filter_equals=((("categoryName",), category_name),),
        replace_collection_in_index=False,
    )


AUDIO_MASTER_SOUND_VIEWS = (
    AUDIO_MASTER_SOUNDS_VIEW,
    _audio_master_sounds_view("master-bgms", "Bgm"),
    _audio_master_sounds_view("master-sound-effects", "Se"),
    _audio_master_sounds_view("master-voices", "Voice"),
)

STORY_ASSET_BACKGROUND_PROJECTION = ProjectionSpec(
    include=(
        "assetId",
        "assetName",
        "kind",
        "sourcePath",
        "stageRef",
        "stageSourcePath",
        "url",
    )
)
STORY_ASSET_VISUAL_PROJECTION = ProjectionSpec(
    include=(
        "assetId",
        "assetName",
        "kind",
        "missing",
        "name",
        "playableUrl",
        "resolution",
        "runtimeAvailable",
        "scope",
        "sourcePath",
        "type",
        "url",
        "videoId",
    )
)
STORY_ASSET_AUDIO_PROJECTION = ProjectionSpec(
    include=(
        "assetId",
        "category",
        "categoryName",
        "cueName",
        "cueSheetName",
        "declaredCategory",
        "declaredCategoryCode",
        "durationMs",
        "kind",
        "missing",
        "playableUrl",
        "resolution",
        "soundId",
        "sourcePath",
        "sourceScope",
        "storyIds",
        "usages",
    )
)
STORY_ASSET_VIEWS = (
    ViewSpec(
        "backgrounds",
        ("backgrounds",),
        (("assetId",),),
        STORY_ASSET_BACKGROUND_PROJECTION,
        replace_collection_in_index=False,
    ),
    ViewSpec(
        "stills",
        ("stills",),
        (("assetId",),),
        STORY_ASSET_VISUAL_PROJECTION,
    ),
    ViewSpec(
        "frames",
        ("frames",),
        (("assetId",),),
        STORY_ASSET_VISUAL_PROJECTION,
    ),
    ViewSpec(
        "effects",
        ("effects",),
        (("assetId",),),
        STORY_ASSET_VISUAL_PROJECTION,
    ),
    ViewSpec(
        "post-effects",
        ("postEffects",),
        (("assetId",),),
        STORY_ASSET_VISUAL_PROJECTION,
    ),
    ViewSpec(
        "videos",
        ("videos",),
        (("assetId",),),
        STORY_ASSET_VISUAL_PROJECTION,
    ),
    ViewSpec(
        "bgms",
        ("bgms",),
        (("assetId",),),
        STORY_ASSET_AUDIO_PROJECTION,
    ),
    ViewSpec(
        "sound-effects",
        ("soundEffects",),
        (("assetId",),),
        STORY_ASSET_AUDIO_PROJECTION,
    ),
    ViewSpec(
        "voices",
        ("voices",),
        (("assetId",),),
        STORY_ASSET_AUDIO_PROJECTION,
    ),
)

PROGRESSION_VIEWS = (
    ViewSpec(
        "character-rank-rewards",
        ("characterRankRewards",),
        (("characterRankRewardId",), ("raw", "_id")),
        ProjectionSpec(
            include=("characterId", "characterRankRewardId", "rank", "reward")
        ),
    ),
    ViewSpec(
        "member-card-awake-resources",
        ("memberCardAwakeResources",),
        (("awakeResourceId",), ("raw", "_id")),
        ProjectionSpec(
            include=(
                "awakeCount",
                "awakeResourceId",
                "count",
                "group",
                "item",
                "itemId",
            )
        ),
    ),
    ViewSpec(
        "member-card-levels",
        ("memberCardLevels",),
        (("levelId",), ("raw", "_id")),
        ProjectionSpec(
            include=(
                "exp",
                "group",
                "level",
                "levelId",
                "performanceRate",
                "technicRate",
                "visualRate",
            )
        ),
    ),
    ViewSpec(
        "skill-level-resources",
        ("skillLevelResources",),
        (("skillResourceId",), ("raw", "_id")),
        ProjectionSpec(
            include=(
                "count",
                "group",
                "item",
                "itemId",
                "level",
                "skillResourceId",
            )
        ),
    ),
    ViewSpec(
        "support-card-levels",
        ("supportCardLevels",),
        (("levelId",), ("raw", "_id")),
        ProjectionSpec(
            include=(
                "exp",
                "group",
                "level",
                "levelId",
                "performanceRate",
                "technicRate",
                "visualRate",
            )
        ),
    ),
)


def _release_value(value: Any) -> Any:
    """Copy JSON data while removing build-local identity from public documents."""

    if isinstance(value, dict):
        return {
            key: _release_value(child)
            for key, child in value.items()
            if key != "buildId"
        }
    if isinstance(value, list):
        return [_release_value(child) for child in value]
    return value


RESOURCE_SPECS: dict[str, ResourceSpec] = {
    "bands": ResourceSpec(()),
    "characters": ResourceSpec((), dependencies=("bands",)),
    "cards": ResourceSpec(
        (),
        projection=ProjectionSpec(
            include=(
                "assetId",
                "cardId",
                "cardType",
                "characterId",
                "gekisouSkillId",
                "images",
                "leaderSkillId",
                "levelLimit",
                "liveSkillId",
                "memberCardLevelGroup",
                "prefix",
                "rarity",
                "releasedAt",
                "resolvedSkills",
                "skillId",
                "stat",
                "type",
            ),
            compact_skills=True,
        ),
        relations=(RelationSpec("character", (("characterId",),)),),
        dependencies=("characters", "gekisou-skills", "leader-skills", "progression", "skills"),
    ),
    "support-cards": ResourceSpec(
        (),
        projection=ProjectionSpec(
            include=(
                "assetId",
                "cardName",
                "cardType",
                "characterId",
                "characterIds",
                "images",
                "levelLimit",
                "liveSupportSkillId",
                "prefix",
                "rarity",
                "releasedAt",
                "resolvedSkills",
                "stat",
                "supportCardId",
                "supportCardLevelGroup",
                "type",
            ),
            compact_skills=True,
        ),
        relations=(CHARACTER_RELATION,),
        dependencies=("characters", "gekisou-support-skills", "progression", "support-skills"),
    ),
    "songs": ResourceSpec(
        (),
        projection=ProjectionSpec(
            include=(
                "arranger",
                "bandId",
                "bandIds",
                "composer",
                "difficulty",
                "jacketThumbUrl",
                "jacketUrl",
                "lyricist",
                "musicCategories",
                "musicId",
                "musicTitle",
                "musicType",
                "musicUrl",
                "mvUrl",
                "publishedAt",
                "videoIds",
                "vocalCharacterIds",
            )
        ),
        relations=(RelationSpec("band", (("bandId",), ("bandIds",))),),
        dependencies=("bands", "items", "song-meta", "videos"),
    ),
    "song-meta": ResourceSpec(
        (),
        projection=ProjectionSpec(include=("0", "1", "2", "3")),
    ),
    "comics": ResourceSpec(
        (),
        relations=(RelationSpec("character", (("characters",),)),),
        dependencies=("bands", "characters"),
    ),
    "stamps": ResourceSpec(
        (),
        relations=(RelationSpec("character", (("characterIds",),)),),
        dependencies=("bands", "characters"),
    ),
    "stories": ResourceSpec(
        ("episodes",),
        projection=ProjectionSpec(exclude=("assets", "commands")),
        relations=(RelationSpec("character", (("characterIds",),)),),
        dependencies=("bands", "characters", "live2d", "story-runtime"),
    ),
    "story-runtime": ResourceSpec(),
    "story-assets": ResourceSpec(
        ("backgrounds",),
        (("assetId",),),
        projection=STORY_ASSET_BACKGROUND_PROJECTION,
        dependencies=("story-runtime",),
        views=STORY_ASSET_VIEWS,
    ),
    "live2d": ResourceSpec(
        (),
        projection=ProjectionSpec(
            exclude=("expressions", "harmonicMotion", "motions", "profile", "runtime")
        ),
        relations=(RelationSpec("character", (("characterId",),)),),
        dependencies=("bands", "characters"),
    ),
    "voices": ResourceSpec(
        ("entries",),
        projection=ProjectionSpec(exclude=("lines", "raw", "sound")),
        relations=(RelationSpec("character", (("characterIds",),), value_mode="ids"),),
        dependencies=("audio", "characters"),
    ),
    "audio": ResourceSpec(
        ("entries",),
        id_fields=(("entityId",),),
        projection=ProjectionSpec(
            include=(
                "audioKey",
                "category",
                "classificationEvidence",
                "entityId",
                "kind",
                "logicalName",
                "runtimePath",
                "source",
            )
        ),
        views=AUDIO_MASTER_SOUND_VIEWS,
    ),
    "items": ResourceSpec(("items",)),
    "progression": ResourceSpec(
        ("playerRanks",),
        (("rankId",), ("raw", "_id")),
        views=PROGRESSION_VIEWS,
    ),
    "character-missions": ResourceSpec(
        ("missions",),
        (("missionId",), ("raw", "_id")),
        projection=ProjectionSpec(
            exclude=("isAlwaysShow", "raw", "rewardIds", "sourceTable")
        ),
        dependencies=("items",),
    ),
    "friendships": ResourceSpec(
        ("friendships",),
        projection=ProjectionSpec(exclude=("episodes", "ranks", "rewards")),
        relations=(RelationSpec("character", (("characterIds",),), value_mode="ids"),),
        dependencies=("characters", "items", "stories"),
    ),
    "band-items": ResourceSpec(("items",), dependencies=("bands", "characters")),
    "leader-skills": ResourceSpec(()),
    "skills": ResourceSpec(()),
    "support-skills": ResourceSpec(()),
    "gekisou-skills": ResourceSpec(()),
    "gekisou-support-skills": ResourceSpec(()),
    "skill-reference": ResourceSpec(("conditions",), (("id",), ("raw", "_id"))),
    "gekisou": ResourceSpec(("rankRewards",), (("rankRewardId",), ("raw", "_id"))),
    "videos": ResourceSpec(("videos",), dependencies=("audio",)),
    "help": ResourceSpec(("categories",)),
    "options": ResourceSpec(("defaults",), (("optionDefaultId",), ("raw", "_id"))),
    "live-tools": ResourceSpec(("scoreRanks",), (("id",), ("raw", "_id"))),
    "provenance": ResourceSpec(),
    "feature-status": ResourceSpec(("features",)),
}


if tuple(RESOURCE_SPECS) != CATALOG_RESOURCES:
    raise AssertionError("catalog storage registry and canonical resource contract are out of sync")
for _resource, _spec in RESOURCE_SPECS.items():
    if (
        _spec.dependencies != tuple(sorted(set(_spec.dependencies)))
        or _resource in _spec.dependencies
        or any(dependency not in RESOURCE_SPECS for dependency in _spec.dependencies)
    ):
        raise AssertionError(f"invalid catalog dependency declaration: {_resource}")
    if any(relation.value_mode not in {"ids", "records"} for relation in _spec.relations):
        raise AssertionError(f"invalid catalog relation materialization: {_resource}")
    _view_names = [view.name for view in _spec.views]
    _replace_view_paths = [view.collection for view in _spec.views if view.replace_collection_in_index]
    if (
        len(_view_names) != len(set(_view_names))
        or len(_replace_view_paths) != len(set(_replace_view_paths))
        or any(not re.fullmatch(r"[a-z][a-z0-9-]*", name) for name in _view_names)
        or any(not view.collection or not view.id_fields for view in _spec.views)
        or (_spec.collection is not None and _spec.collection in _replace_view_paths)
    ):
        raise AssertionError(f"invalid catalog view declaration: {_resource}")


def _nested(value: Any, path: tuple[str, ...]) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _replace_nested(document: JsonObject, path: tuple[str, ...], value: Any) -> JsonObject:
    if not path:
        if not isinstance(value, dict):
            raise ValueError("a root catalog index must be an object")
        return value
    output = dict(document)
    current = output
    source: Any = document
    for key in path[:-1]:
        child = source.get(key) if isinstance(source, dict) else None
        if not isinstance(child, dict):
            raise ValueError(f"catalog collection path is not an object: {'.'.join(path)}")
        copied = dict(child)
        current[key] = copied
        current = copied
        source = child
    current[path[-1]] = value
    return output


def _entity_id(
    value: Any,
    key: Any,
    id_fields: tuple[tuple[str, ...], ...],
    label: str,
) -> str:
    identifier = ""
    for path in id_fields:
        candidate = _nested(value, path)
        if isinstance(candidate, (str, int)) and not isinstance(candidate, bool):
            identifier = str(candidate)
            break
    if not identifier and key is not None:
        identifier = str(key)
    if not valid_catalog_route_key(identifier):
        raise ValueError(f"catalog entity has no URL-safe stable id: {label}")
    return identifier


def _entities(
    document: JsonObject,
    collection_path: tuple[str, ...],
    id_fields: tuple[tuple[str, ...], ...],
    label: str,
) -> tuple[dict[str, Any], bool, dict[str, str]]:
    collection = _nested(document, collection_path)
    if isinstance(collection, dict):
        output: dict[str, Any] = {}
        source_keys: dict[str, str] = {}
        for key, value in collection.items():
            identifier = _entity_id(value, key, id_fields, label)
            if identifier in output:
                raise ValueError(f"duplicate catalog entity id: {label}/{identifier}")
            output[identifier] = value
            source_keys[identifier] = str(key)
        return output, False, source_keys
    if isinstance(collection, list):
        output: dict[str, Any] = {}
        for value in collection:
            identifier = _entity_id(value, None, id_fields, label)
            if identifier in output:
                raise ValueError(f"duplicate catalog entity id: {label}/{identifier}")
            output[identifier] = value
        return output, True, {}
    raise ValueError(f"catalog collection is not an object or array: {label}")


SKILL_SUMMARY_FIELDS = {
    "gekisouSkillId",
    "gekisouSupportSkillId",
    "icon",
    "id",
    "leaderSkillId",
    "liveSkillId",
    "skillIconAssetName",
    "skillIconId",
    "skillId",
    "skillName",
    "supportSkillId",
}


def _compact_skills(value: Any) -> Any:
    if isinstance(value, list):
        return [_compact_skills(item) for item in value]
    if not isinstance(value, dict):
        return value
    if any(key in value for key in ("description", "effects", "skillName")):
        return {key: child for key, child in value.items() if key in SKILL_SUMMARY_FIELDS}
    return {key: _compact_skills(child) for key, child in value.items()}


def _summary(entity: Any, projection: ProjectionSpec) -> Any:
    if not isinstance(entity, dict):
        return entity
    included = projection.include
    output = {
        key: value
        for key, value in entity.items()
        if (included is None or key in included) and key not in projection.exclude
    }
    if projection.compact_skills and "resolvedSkills" in output:
        output["resolvedSkills"] = _compact_skills(output["resolvedSkills"])
    return output


def _projected_collection(
    summaries: dict[str, Any],
    was_array: bool,
    source_keys: dict[str, str],
) -> Any:
    if was_array:
        return list(summaries.values())
    return {
        source_keys.get(identifier, identifier): summary
        for identifier, summary in summaries.items()
    }


def _relation_values(entity: Any, spec: RelationSpec) -> list[str]:
    output: set[str] = set()
    for field in spec.fields:
        value = _nested(entity, field)
        values: Iterable[Any] = value if isinstance(value, list) else (value,)
        for item in values:
            if isinstance(item, (str, int)) and not isinstance(item, bool) and str(item):
                output.add(str(item))
    return sorted(output)


def _write_partitions(root: Path, prefix: str, records: dict[str, Any]) -> dict[str, Any]:
    partitions: dict[str, dict[str, Any]] = {}
    for key, value in records.items():
        if not valid_catalog_route_key(key):
            raise ValueError(f"catalog partition has an invalid route key: {prefix}{key}")
        shard = fnv1a32_shard(key, CATALOG_PARTITION_SHARDS)
        partitions.setdefault(shard, {})[key] = value
    for shard, values in sorted(partitions.items()):
        write_json(root / f"{prefix}{shard}.json", values)
    return {
        "algorithm": CATALOG_PARTITION_ALGORITHM,
        "count": len(records),
        "prefix": normalize_release_path(f"api/v1/catalog/{prefix}") + "/",
        "shards": sorted(partitions),
    }


def _compile_resource(
    resource: str,
    document: JsonObject,
    target: Path,
) -> tuple[dict[str, Any], int]:
    spec = RESOURCE_SPECS[resource]
    resource_root = target / resource
    index_path = f"api/v1/catalog/{resource}/index.json"
    if spec.collection is None:
        entities: dict[str, Any] = {}
        summaries: dict[str, Any] = {}
        index = document
        kind = "document"
        count = 1 if document else 0
    else:
        entities, was_array, source_keys = _entities(
            document,
            spec.collection,
            spec.id_fields,
            resource,
        )
        summaries = {
            identifier: _summary(entity, spec.projection)
            for identifier, entity in entities.items()
        }
        projected = _projected_collection(summaries, was_array, source_keys)
        index = _replace_nested(document, spec.collection, projected)
        kind = "collection"
        count = len(entities)
    descriptor: dict[str, Any] = {
        "count": count,
        "dependencies": list(spec.dependencies),
        "index": index_path,
        "kind": kind,
    }
    if entities:
        descriptor["entities"] = _write_partitions(
            target,
            f"{resource}/entities/",
            entities,
        )
    views: dict[str, Any] = {}
    for view in spec.views:
        view_entities, view_was_array, view_source_keys = _entities(
            document,
            view.collection,
            view.id_fields,
            f"{resource}/views/{view.name}",
        )
        if view.filter_equals:
            view_entities = {
                identifier: entity
                for identifier, entity in view_entities.items()
                if all(_nested(entity, field) == expected for field, expected in view.filter_equals)
            }
        view_summaries = {
            identifier: _summary(entity, view.projection)
            for identifier, entity in view_entities.items()
        }
        view_index = _projected_collection(
            view_summaries,
            view_was_array,
            view_source_keys,
        )
        if view.replace_collection_in_index:
            index = _replace_nested(index, view.collection, view_index)
        view_index_path = f"api/v1/catalog/{resource}/views/{view.name}/index.json"
        write_json(resource_root / "views" / view.name / "index.json", view_index)
        view_descriptor = {
            "count": len(view_entities),
            "entities": _write_partitions(
                target,
                f"{resource}/views/{view.name}/entities/",
                view_entities,
            ),
            "index": view_index_path,
            "path": list(view.collection),
            "shape": "array" if view_was_array else "object",
        }
        views[view.name] = view_descriptor
    if views:
        descriptor["views"] = views
    write_json(resource_root / "index.json", index)
    relations: dict[str, Any] = {}
    for relation in spec.relations:
        records: dict[str, Any] = {}
        for identifier, entity in entities.items():
            for relation_value in _relation_values(entity, relation):
                if relation.value_mode == "ids":
                    records.setdefault(relation_value, []).append(identifier)
                else:
                    records.setdefault(relation_value, {})[identifier] = summaries[identifier]
        if relation.value_mode == "ids":
            records = {
                relation_value: sorted(set(identifiers))
                for relation_value, identifiers in records.items()
            }
        relation_descriptor = _write_partitions(
            target,
            f"{resource}/relations/{relation.name}/",
            records,
        )
        relation_descriptor.update(
            {
                "entityCount": sum(len(value) for value in records.values()),
                "valueMode": relation.value_mode,
            }
        )
        relations[relation.name] = relation_descriptor
    if relations:
        descriptor["relations"] = relations
    return descriptor, count


def compile_catalog_storage(
    source: Path,
    target: Path,
    server: str,
    source_id: str,
) -> dict[str, Any]:
    """Atomically replace one release-local catalog read model."""

    provenance = read_json(source / "provenance.json")
    if (
        not isinstance(provenance, dict)
        or provenance.get("schema") != CATALOG_PROVENANCE_SCHEMA
        or provenance.get("server") != server
        or provenance.get("sourceId") != source_id
    ):
        raise ValueError("catalog provenance identity does not match its release")
    staging = target.with_name(f".{target.name}.staging")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    resources: dict[str, Any] = {}
    counts: dict[str, int] = {}
    try:
        for resource in CATALOG_RESOURCES:
            file = source / f"{resource}.json"
            document = _release_value(read_json(file))
            if not isinstance(document, dict):
                raise ValueError(f"canonical catalog resource must be an object: {file}")
            descriptor, count = _compile_resource(resource, document, staging)
            resources[resource] = descriptor
            counts[resource] = count
        feature_status = read_json(source / "feature-status.json")
        summary = {
            "schema": CATALOG_SUMMARY_SCHEMA,
            "server": server,
            "sourceId": source_id,
            "resources": {
                name: {"count": counts[name], "kind": resources[name]["kind"]}
                for name in CATALOG_RESOURCES
            },
            "features": (
                feature_status.get("features", {})
                if isinstance(feature_status, dict)
                else {}
            ),
        }
        write_json(staging / "summary.json", summary)
        manifest = {
            "schema": CATALOG_STORAGE_SCHEMA,
            "server": server,
            "sourceId": source_id,
            "summary": "api/v1/catalog/summary.json",
            "partition": {
                "algorithm": CATALOG_PARTITION_ALGORITHM,
                "shards": CATALOG_PARTITION_SHARDS,
            },
            "resources": resources,
        }
        write_json(staging / "manifest.json", manifest, pretty=True)
        if target.exists():
            shutil.rmtree(target)
        staging.replace(target)
        return manifest
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def compile_source_index_storage(
    source: Path,
    target: Path,
    server: str,
    source_id: str,
) -> dict[str, Any]:
    """Atomically split the source index into independently consumed views."""

    document = _release_value(read_json(source))
    if not isinstance(document, dict):
        raise ValueError(f"source index must be an object: {source}")
    if (
        document.get("schema") != UNITY_INDEX_SCHEMA
        or document.get("server") != server
        or document.get("sourceId") != source_id
    ):
        raise ValueError(f"source index identity does not match its release: {source}")
    tree = document.get("tree")
    sources = document.get("sources")
    serialized_files = document.get("serializedFiles")
    if (
        not isinstance(tree, dict)
        or not isinstance(sources, dict)
        or not isinstance(serialized_files, dict)
    ):
        raise ValueError("source index tree, sources, and serializedFiles must be objects")
    if document.get("sourceCount") != len(sources):
        raise ValueError("source index sourceCount does not match its sources")

    staging = target.with_name(f".{target.name}.staging")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        write_json(staging / "tree.json", tree)
        source_partitions = _write_source_index_partitions(staging, "sources/", sources)
        serialized_partitions = _write_source_index_partitions(
            staging,
            "serialized-files/",
            serialized_files,
        )
        manifest = {
            key: value
            for key, value in document.items()
            if key not in {"tree", "sources", "serializedFiles"}
        }
        manifest.update(
            {
                "schema": SOURCE_INDEX_STORAGE_SCHEMA,
                "server": server,
                "sourceId": source_id,
                "tree": "metadata/source-index/tree.json",
                "sources": source_partitions,
                "serializedFiles": serialized_partitions,
            }
        )
        write_json(staging / "manifest.json", manifest, pretty=True)
        if target.exists():
            shutil.rmtree(target)
        staging.replace(target)
        return manifest
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def _write_source_index_partitions(
    root: Path,
    prefix: str,
    records: dict[str, Any],
) -> dict[str, Any]:
    partitions: dict[str, dict[str, Any]] = {}
    for key, value in records.items():
        shard = fnv1a32_shard(key, CATALOG_PARTITION_SHARDS)
        partitions.setdefault(shard, {})[key] = value
    for shard, values in sorted(partitions.items()):
        write_json(root / f"{prefix}{shard}.json", values)
    return {
        "algorithm": CATALOG_PARTITION_ALGORITHM,
        "count": len(records),
        "prefix": f"metadata/source-index/{prefix}",
        "shards": sorted(partitions),
    }
