from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from build.catalog_storage import RESOURCE_SPECS, ViewSpec, valid_catalog_route_key
from build.game_client import verify_game_client_release
from build.media import ACTIVE_CONTENT_SUFFIXES, media_type
from core.contracts import (
    CATALOG_PARTITION_ALGORITHM,
    CATALOG_PARTITION_SHARDS,
    CATALOG_PROVENANCE_SCHEMA,
    CATALOG_REQUIRED_RESOURCES,
    CATALOG_RESOURCES,
    CATALOG_STORAGE_SCHEMA,
    CATALOG_SUMMARY_SCHEMA,
    POINTER_SCHEMA,
    RELEASE_SCHEMA,
    RELEASE_TREES,
    SOURCE_INDEX_STORAGE_SCHEMA,
    STORY_ASSETS_SCHEMA,
)
from core.hashes import sha256_bytes, sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import (
    release_layout,
    server_layout,
    validate_release_path,
    validate_unity_path,
)
from core.process import walk_files
from core.storage import (
    RELEASE_INDEX_ALGORITHM,
    RELEASE_INDEX_SHARDS,
    fnv1a32_shard,
    release_index_prefix,
)


FORBIDDEN_SEGMENTS = {"legacy", "_unity"}
SHA256 = re.compile(r"^[a-f0-9]{64}$")


def release_entries(root: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for tree in RELEASE_TREES:
        tree_root = root / tree
        for file in walk_files(tree_root):
            relative = f"{tree}/{file.relative_to(tree_root).as_posix()}"
            if (
                tree in {"assets", "runtime", "objects"}
                and file.suffix.lower() in ACTIVE_CONTENT_SUFFIXES
            ):
                raise ValueError(
                    f"active content is forbidden in public release media: {relative}"
                )
            digest = sha256_file(file)
            entries.append(
                {
                    "path": relative,
                    "role": tree,
                    "bytes": file.stat().st_size,
                    "sha256": digest,
                    "mediaType": media_type(file),
                }
            )
    return sorted(entries, key=lambda item: item["path"])


def describe_release(root: Path, server: str, source_id: str) -> dict[str, Any]:
    entries = release_entries(root)
    identity = {
        "schema": RELEASE_SCHEMA,
        "server": server,
        "sourceId": source_id,
        "entries": entries,
    }
    release_id = f"r-{sha256_bytes(stable_json(identity))[:20]}"
    return {
        **identity,
        "releaseId": release_id,
        "entryCount": len(entries),
        "totalBytes": sum(item["bytes"] for item in entries),
    }


def write_release_manifest(root: Path, server: str, source_id: str) -> dict[str, Any]:
    manifest = describe_release(root, server, source_id)
    write_json(root / "release.json", manifest, pretty=True)
    return manifest


def _forbidden_path(value: str) -> bool:
    parts = value.split("/")
    return any(
        part.lower() in FORBIDDEN_SEGMENTS or part.lower().endswith("_rip")
        for part in parts
    )


def _expected_release_id(manifest: dict[str, Any]) -> str:
    identity = {
        "schema": manifest.get("schema"),
        "server": manifest.get("server"),
        "sourceId": manifest.get("sourceId"),
        "entries": manifest.get("entries"),
    }
    return f"r-{sha256_bytes(stable_json(identity))[:20]}"


def _catalog_resource_errors(root: Path, server: str, declared: set[str]) -> list[str]:
    """Reject legacy URLs and verify every release-local API resource exactly."""
    errors: list[str] = []
    api_root = root / "api" / "v1" / "catalog"
    asset_prefix = f"/assets/{server}/"
    runtime_prefix = f"/runtime/{server}/"

    def verify_value(value: Any, source: str) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                verify_value(item, f"{source}.{key}")
            return
        if isinstance(value, list):
            for index, item in enumerate(value):
                verify_value(item, f"{source}[{index}]")
            return
        if not isinstance(value, str):
            return

        raw_path = urlsplit(value).path
        relative: str | None = None
        tree: str | None = None
        public_url = False
        if raw_path.startswith("/asset/") or raw_path.startswith("/api/assets/"):
            errors.append(f"legacy resource URL in {source}: {value}")
            return
        if raw_path.startswith("/assets/"):
            if not raw_path.startswith(asset_prefix):
                errors.append(f"cross-server or legacy asset URL in {source}: {value}")
                return
            relative = unquote(raw_path.removeprefix(asset_prefix))
            if not relative.startswith(("Assets/", "Packages/")):
                errors.append(f"non-canonical Unity asset URL in {source}: {value}")
                return
            tree = "assets"
            public_url = True
        elif raw_path.startswith("/runtime/"):
            if not raw_path.startswith(runtime_prefix):
                errors.append(f"cross-server runtime URL in {source}: {value}")
                return
            relative = unquote(raw_path.removeprefix(runtime_prefix))
            tree = "runtime"
            public_url = True
        elif value.startswith(("Assets/", "Packages/")):
            relative = value
            tree = "assets"
        elif value.startswith("runtime/"):
            relative = value.removeprefix("runtime/")
            tree = "runtime"

        if relative is None or tree is None:
            return
        if _forbidden_path(relative):
            errors.append(f"legacy resource path in {source}: {value}")
            return
        try:
            release_path = validate_release_path(f"{tree}/{relative}")
        except ValueError as error:
            errors.append(f"{source}: {error}")
            return
        # The manifest comparison is deliberately case-sensitive. Path.is_file()
        # alone is insufficient on the default macOS filesystem and could let an
        # all-lowercase legacy URL resolve to the canonical Unity path.
        if public_url and release_path not in declared:
            errors.append(
                f"catalog resource does not resolve exactly in {source}: {value}"
            )

    for file in sorted(api_root.rglob("*.json")):
        try:
            document = read_json(file)
        except Exception as error:
            errors.append(f"invalid catalog JSON {file.name}: {error}")
            continue
        verify_value(document, file.relative_to(root).as_posix())
    return errors


def _partition_errors(
    root: Path,
    declared: set[str],
    descriptor: Any,
    prefix: str,
    label: str,
    *,
    catalog_route_keys: bool = False,
    relation_value_mode: str | None = None,
    entity_keys: set[str] | None = None,
) -> tuple[list[str], int, int, set[str], set[str]]:
    errors: list[str] = []
    if not isinstance(descriptor, dict):
        return [f"{label} partition descriptor must be an object"], 0, 0, set(), set()
    if descriptor.get("algorithm") != CATALOG_PARTITION_ALGORITHM:
        errors.append(f"{label} has an unexpected partition algorithm")
    if descriptor.get("prefix") != prefix:
        errors.append(f"{label} has a non-canonical partition prefix")
    count = descriptor.get("count")
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        errors.append(f"{label} has an invalid record count")
        count = 0
    shards = descriptor.get("shards")
    if (
        not isinstance(shards, list)
        or any(
            not isinstance(shard, str)
            or not re.fullmatch(r"[a-f0-9]{2}", shard)
            for shard in shards
        )
        or shards != sorted(set(shards))
    ):
        errors.append(f"{label} has an invalid shard list")
        return errors, int(count), 0, set(), set()
    if (count == 0) != (len(shards) == 0):
        errors.append(f"{label} has an invalid empty partition")
    found: set[str] = set()
    paths: set[str] = set()
    nested_count = 0
    for shard in shards:
        relative = f"{prefix}{shard}.json"
        paths.add(relative)
        if relative not in declared:
            errors.append(f"{label} shard is absent from release manifest: {relative}")
            continue
        file = root.joinpath(*relative.split("/"))
        try:
            document = read_json(file)
        except Exception as error:
            errors.append(f"invalid {label} shard {relative}: {error}")
            continue
        if not isinstance(document, dict):
            errors.append(f"{label} shard must be an object: {relative}")
            continue
        for key, value in document.items():
            if not isinstance(key, str) or not key:
                errors.append(f"{label} shard contains an invalid key: {relative}")
                continue
            if catalog_route_keys and not valid_catalog_route_key(key):
                errors.append(f"{label} shard contains a non-routable key: {key}")
            if fnv1a32_shard(key, CATALOG_PARTITION_SHARDS) != shard:
                errors.append(f"{label} record is in the wrong shard: {key}")
            if key in found:
                errors.append(f"{label} contains a duplicate key: {key}")
            found.add(key)
            related_ids: list[str] | None = None
            if relation_value_mode == "records":
                if not isinstance(value, dict):
                    errors.append(f"{label} relation value must be an object: {key}")
                elif any(not valid_catalog_route_key(identifier) for identifier in value):
                    errors.append(f"{label} relation contains an invalid entity id: {key}")
                else:
                    related_ids = list(value)
            elif relation_value_mode == "ids":
                if (
                    not isinstance(value, list)
                    or any(not valid_catalog_route_key(identifier) for identifier in value)
                    or value != sorted(set(value))
                ):
                    errors.append(f"{label} relation id list is invalid: {key}")
                else:
                    related_ids = value
            if related_ids is not None:
                nested_count += len(related_ids)
                if entity_keys is not None:
                    missing = sorted(set(related_ids) - entity_keys)
                    if missing:
                        errors.append(
                            f"{label} references unknown entities: {missing[:10]}"
                        )
    if len(found) != count:
        errors.append(f"{label} record count mismatch: {len(found)} != {count}")
    return errors, int(count), nested_count, paths, found


def _catalog_nested(value: Any, path: tuple[str, ...]) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _view_index_errors(
    value: Any,
    view: ViewSpec,
    expected_shape: str,
    entity_keys: set[str],
    label: str,
) -> list[str]:
    errors: list[str] = []
    if expected_shape == "array":
        if not isinstance(value, list):
            return [f"{label} index must be an array"]
        rows = value
    elif expected_shape == "object":
        if not isinstance(value, dict):
            return [f"{label} index must be an object"]
        rows = list(value.values())
    else:
        return [f"{label} has an invalid index shape"]
    found: set[str] = set()
    allowed = set(view.projection.include or ())
    for row in rows:
        if not isinstance(row, dict):
            errors.append(f"{label} index contains a non-object row")
            continue
        if view.projection.include is not None and not set(row).issubset(allowed):
            errors.append(f"{label} index contains fields outside its projection")
        if any(field in row for field in view.projection.exclude):
            errors.append(f"{label} index contains an excluded field")
        identifier = ""
        for path in view.id_fields:
            candidate = _catalog_nested(row, path)
            if isinstance(candidate, (str, int)) and not isinstance(candidate, bool):
                identifier = str(candidate)
                break
        if not valid_catalog_route_key(identifier):
            errors.append(f"{label} index row has no routable stable id")
            continue
        if identifier in found:
            errors.append(f"{label} index contains a duplicate entity id: {identifier}")
        found.add(identifier)
    if found != entity_keys:
        missing = sorted(entity_keys - found)
        extra = sorted(found - entity_keys)
        errors.append(
            f"{label} index/entity id mismatch: missing={missing[:10]}, extra={extra[:10]}"
        )
    return errors


def _story_assets_index_errors(
    document: Any,
    server: str,
    source_id: str,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(document, dict):
        return ["story-assets index must be an object"]
    if (
        document.get("schema") != STORY_ASSETS_SCHEMA
        or document.get("server") != server
        or document.get("sourceId") != source_id
    ):
        errors.append("story-assets identity does not match the release")
    expected = {
        "backgrounds": ("background", None, None),
        "stills": ("still", None, None),
        "frames": ("frame", None, None),
        "effects": ("effect", None, None),
        "postEffects": ("post-effect", None, None),
        "videos": ("video", None, None),
        "bgms": ("bgm", 0, "Bgm"),
        "soundEffects": ("sound-effect", 1, "Se"),
        "voices": ("voice", 2, "Voice"),
    }
    counts = document.get("counts")
    if not isinstance(counts, dict) or set(counts) != set(expected):
        errors.append("story-assets counts do not match the collection contract")
        counts = {}
    all_ids: set[str] = set()
    for collection, (kind, category, category_name) in expected.items():
        entities = document.get(collection)
        if not isinstance(entities, dict):
            errors.append(f"story-assets collection is invalid: {collection}")
            continue
        if counts.get(collection) != len(entities):
            errors.append(f"story-assets collection count mismatch: {collection}")
        for asset_id, entity in entities.items():
            if (
                not valid_catalog_route_key(asset_id)
                or not isinstance(entity, dict)
                or entity.get("assetId") != asset_id
                or entity.get("kind") != kind
            ):
                errors.append(
                    f"story-assets entity identity is invalid: {collection}/{asset_id}"
                )
                continue
            if asset_id in all_ids:
                errors.append(f"story-assets entity id is repeated: {asset_id}")
            all_ids.add(asset_id)
            if category is not None and (
                entity.get("category") != category
                or entity.get("categoryName") != category_name
                or entity.get("declaredCategoryCode") != category
                or entity.get("declaredCategory") != category_name
            ):
                errors.append(
                    f"story-assets audio category is invalid: {collection}/{asset_id}"
                )
    return errors


def _catalog_storage_errors(
    root: Path,
    server: str,
    source_id: str,
    declared: set[str],
) -> list[str]:
    errors: list[str] = []
    manifest_path = "api/v1/catalog/manifest.json"
    summary_path = "api/v1/catalog/summary.json"
    if manifest_path not in declared:
        return ["missing catalog storage manifest"]
    try:
        manifest = read_json(root / manifest_path)
    except Exception as error:
        return [f"invalid catalog storage manifest: {error}"]
    if not isinstance(manifest, dict):
        return ["catalog storage manifest must be an object"]
    if (
        manifest.get("schema") != CATALOG_STORAGE_SCHEMA
        or manifest.get("server") != server
        or manifest.get("sourceId") != source_id
        or manifest.get("summary") != summary_path
        or manifest.get("partition")
        != {
            "algorithm": CATALOG_PARTITION_ALGORITHM,
            "shards": CATALOG_PARTITION_SHARDS,
        }
    ):
        errors.append("catalog storage manifest identity or partition contract is invalid")
    resources = manifest.get("resources")
    compatible_resource_sets = {
        frozenset(CATALOG_REQUIRED_RESOURCES),
        frozenset(CATALOG_RESOURCES),
    }
    if (
        not isinstance(resources, dict)
        or frozenset(resources) not in compatible_resource_sets
    ):
        errors.append("catalog storage resources do not match the canonical registry")
        resources = {}
    resource_names = [name for name in CATALOG_RESOURCES if name in resources]
    counts: dict[str, int] = {}
    storage_paths = {manifest_path, summary_path}
    for resource in resource_names:
        descriptor = resources.get(resource)
        if not isinstance(descriptor, dict):
            errors.append(f"catalog resource descriptor is missing: {resource}")
            continue
        kind = descriptor.get("kind")
        count = descriptor.get("count")
        dependencies = descriptor.get("dependencies")
        index_path = f"api/v1/catalog/{resource}/index.json"
        storage_paths.add(index_path)
        expected_kind = "document" if RESOURCE_SPECS[resource].collection is None else "collection"
        if kind != expected_kind:
            errors.append(f"catalog resource has an invalid kind: {resource}")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            errors.append(f"catalog resource has an invalid count: {resource}")
        else:
            counts[resource] = count
        if (
            dependencies != list(RESOURCE_SPECS[resource].dependencies)
        ):
            errors.append(f"catalog resource has invalid dependencies: {resource}")
        if descriptor.get("index") != index_path or index_path not in declared:
            errors.append(f"catalog resource index is missing or non-canonical: {resource}")
        if resource == "story-assets" and index_path in declared:
            try:
                story_assets_index = read_json(root / index_path)
            except Exception as error:
                errors.append(f"invalid story-assets index: {error}")
            else:
                errors.extend(
                    _story_assets_index_errors(story_assets_index, server, source_id)
                )
        if resource == "provenance" and index_path in declared:
            try:
                provenance = read_json(root / index_path)
            except Exception as error:
                errors.append(f"invalid catalog provenance: {error}")
            else:
                if (
                    not isinstance(provenance, dict)
                    or provenance.get("schema") != CATALOG_PROVENANCE_SCHEMA
                    or provenance.get("server") != server
                    or provenance.get("sourceId") != source_id
                ):
                    errors.append("catalog provenance identity does not match the release")
        entities = descriptor.get("entities")
        if kind == "collection" and count and entities is None:
            errors.append(f"catalog resource entities are missing: {resource}")
        if kind == "document" and entities is not None:
            errors.append(f"catalog document must not declare entities: {resource}")
        if entities is not None:
            partition_errors, partition_count, _, partition_paths, entity_keys = _partition_errors(
                root,
                declared,
                entities,
                f"api/v1/catalog/{resource}/entities/",
                f"catalog {resource} entities",
                catalog_route_keys=True,
            )
            errors.extend(partition_errors)
            storage_paths.update(partition_paths)
            if isinstance(count, int) and partition_count != count:
                errors.append(f"catalog {resource} entity and resource counts differ")
        else:
            entity_keys = set()
        views = descriptor.get("views", {})
        if not isinstance(views, dict):
            errors.append(f"catalog resource views must be an object: {resource}")
            views = {}
        expected_views = {view.name: view for view in RESOURCE_SPECS[resource].views}
        if set(views) != set(expected_views):
            errors.append(f"catalog resource views do not match the registry: {resource}")
        for view_name, view_descriptor in views.items():
            view = expected_views.get(view_name)
            if view is None or not isinstance(view_descriptor, dict):
                errors.append(f"catalog {resource}/{view_name} view is invalid")
                continue
            view_index_path = (
                f"api/v1/catalog/{resource}/views/{view_name}/index.json"
            )
            storage_paths.add(view_index_path)
            if (
                view_descriptor.get("index") != view_index_path
                or view_descriptor.get("path") != list(view.collection)
                or view_descriptor.get("shape") not in {"array", "object"}
                or view_index_path not in declared
            ):
                errors.append(
                    f"catalog {resource}/{view_name} view contract is non-canonical"
                )
            view_partition_errors, view_count, _, view_partition_paths, view_entity_keys = (
                _partition_errors(
                    root,
                    declared,
                    view_descriptor.get("entities"),
                    f"api/v1/catalog/{resource}/views/{view_name}/entities/",
                    f"catalog {resource}/{view_name} view entities",
                    catalog_route_keys=True,
                )
            )
            errors.extend(view_partition_errors)
            storage_paths.update(view_partition_paths)
            if view_descriptor.get("count") != view_count:
                errors.append(
                    f"catalog {resource}/{view_name} view count mismatch"
                )
            if view_index_path in declared:
                try:
                    view_index = read_json(root / view_index_path)
                except Exception as error:
                    errors.append(
                        f"invalid catalog {resource}/{view_name} view index: {error}"
                    )
                else:
                    errors.extend(
                        _view_index_errors(
                            view_index,
                            view,
                            str(view_descriptor.get("shape") or ""),
                            view_entity_keys,
                            f"catalog {resource}/{view_name} view",
                        )
                    )
        relations = descriptor.get("relations", {})
        if not isinstance(relations, dict):
            errors.append(f"catalog resource relations must be an object: {resource}")
            continue
        expected_relations = {relation.name for relation in RESOURCE_SPECS[resource].relations}
        if set(relations) != expected_relations:
            errors.append(f"catalog resource relations do not match the registry: {resource}")
        for relation, relation_descriptor in relations.items():
            if not isinstance(relation, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", relation):
                errors.append(f"catalog {resource} has an invalid relation name")
                continue
            expected_relation = next(
                (
                    value
                    for value in RESOURCE_SPECS[resource].relations
                    if value.name == relation
                ),
                None,
            )
            value_mode = (
                relation_descriptor.get("valueMode")
                if isinstance(relation_descriptor, dict)
                else None
            )
            if expected_relation is None or value_mode != expected_relation.value_mode:
                errors.append(f"catalog {resource}/{relation} relation value mode is invalid")
            partition_errors, _, nested_count, partition_paths, _ = _partition_errors(
                root,
                declared,
                relation_descriptor,
                f"api/v1/catalog/{resource}/relations/{relation}/",
                f"catalog {resource}/{relation} relation",
                catalog_route_keys=True,
                relation_value_mode=value_mode if value_mode in {"ids", "records"} else None,
                entity_keys=entity_keys,
            )
            errors.extend(partition_errors)
            storage_paths.update(partition_paths)
            if (
                isinstance(relation_descriptor, dict)
                and relation_descriptor.get("entityCount") != nested_count
            ):
                errors.append(f"catalog {resource}/{relation} relation entity count mismatch")
    if summary_path not in declared:
        errors.append("catalog summary is absent from release manifest")
    else:
        try:
            summary = read_json(root / summary_path)
        except Exception as error:
            errors.append(f"invalid catalog summary: {error}")
        else:
            expected_resources = {
                name: {
                    "count": counts.get(name),
                    "kind": (
                        resources.get(name, {}).get("kind")
                        if isinstance(resources.get(name), dict)
                        else None
                    ),
                }
                for name in resource_names
            }
            if (
                not isinstance(summary, dict)
                or summary.get("schema") != CATALOG_SUMMARY_SCHEMA
                or summary.get("server") != server
                or summary.get("sourceId") != source_id
                or summary.get("resources") != expected_resources
                or not isinstance(summary.get("features"), dict)
            ):
                errors.append("catalog summary does not match its storage manifest")
    actual_storage_paths = {
        relative for relative in declared if relative.startswith("api/v1/catalog/")
    }
    if actual_storage_paths != storage_paths:
        missing = sorted(storage_paths - actual_storage_paths)
        extra = sorted(actual_storage_paths - storage_paths)
        errors.append(
            f"catalog storage path set mismatch: missing={missing[:10]}, extra={extra[:10]}"
        )
    return errors


def _source_index_storage_errors(
    root: Path,
    server: str,
    source_id: str,
    declared: set[str],
) -> list[str]:
    errors: list[str] = []
    manifest_path = "metadata/source-index/manifest.json"
    tree_path = "metadata/source-index/tree.json"
    if manifest_path not in declared or tree_path not in declared:
        return ["split source-index manifest or tree is missing"]
    try:
        manifest = read_json(root / manifest_path)
        tree = read_json(root / tree_path)
    except Exception as error:
        return [f"invalid split source-index document: {error}"]
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != SOURCE_INDEX_STORAGE_SCHEMA
        or manifest.get("server") != server
        or manifest.get("sourceId") != source_id
    ):
        errors.append("split source-index manifest has an invalid schema")
        return errors
    if manifest.get("tree") != tree_path or not isinstance(tree, dict):
        errors.append("split source-index tree is invalid")
    storage_paths = {manifest_path, tree_path}
    for key, prefix in (
        ("sources", "metadata/source-index/sources/"),
        ("serializedFiles", "metadata/source-index/serialized-files/"),
    ):
        descriptor = manifest.get(key)
        partition_errors, _, _, partition_paths, _ = _partition_errors(
            root,
            declared,
            descriptor,
            prefix,
            f"source-index {key}",
        )
        errors.extend(partition_errors)
        storage_paths.update(partition_paths)
        if key == "sources" and manifest.get("sourceCount") != (
            descriptor.get("count") if isinstance(descriptor, dict) else None
        ):
            errors.append("split source-index sourceCount does not match its source records")
    if "metadata/source-index.json" in declared:
        errors.append("monolithic release source-index must not coexist with split storage")
    actual_storage_paths = {
        relative for relative in declared if relative.startswith("metadata/source-index/")
    }
    if actual_storage_paths != storage_paths:
        missing = sorted(storage_paths - actual_storage_paths)
        extra = sorted(actual_storage_paths - storage_paths)
        errors.append(
            f"source-index storage path set mismatch: missing={missing[:10]}, extra={extra[:10]}"
        )
    return errors


def verify_release(
    server: str, release_id: str, check_hashes: bool = True
) -> dict[str, Any]:
    layout = release_layout(server, release_id)
    if not layout.manifest.is_file():
        raise FileNotFoundError(f"release manifest not found: {layout.manifest}")
    manifest = read_json(layout.manifest)
    if not isinstance(manifest, dict):
        raise ValueError("release verification failed: manifest must be a JSON object")
    errors: list[str] = []
    if manifest.get("schema") != RELEASE_SCHEMA:
        errors.append(f"unexpected schema: {manifest.get('schema')}")
    if manifest.get("server") != server or manifest.get("releaseId") != release_id:
        errors.append("release identity mismatch")

    entries = manifest.get("entries")
    if not isinstance(entries, list):
        errors.append("entries must be a list")
        entries = []
    elif manifest.get("releaseId") != _expected_release_id(manifest):
        errors.append("releaseId does not match content-addressed manifest identity")

    declared: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("manifest entry must be an object")
            continue
        try:
            relative = validate_release_path(entry.get("path"))
        except ValueError as error:
            errors.append(str(error))
            continue
        if relative in declared:
            errors.append(f"duplicate manifest path: {relative}")
        declared.add(relative)
        if _forbidden_path(relative):
            errors.append(f"forbidden release path: {relative}")
        if (
            relative.split("/", 1)[0] in {"assets", "runtime", "objects"}
            and Path(relative).suffix.lower() in ACTIVE_CONTENT_SUFFIXES
        ):
            errors.append(
                f"active content is forbidden in public release media: {relative}"
            )
        role = entry.get("role")
        if role not in RELEASE_TREES or relative.split("/", 1)[0] != role:
            errors.append(f"role/path mismatch: {relative}")
        expected_bytes = entry.get("bytes")
        if (
            not isinstance(expected_bytes, int)
            or isinstance(expected_bytes, bool)
            or expected_bytes < 0
        ):
            errors.append(f"invalid byte count: {relative}")
            expected_bytes = None
        expected_hash = entry.get("sha256")
        if not isinstance(expected_hash, str) or not SHA256.fullmatch(expected_hash):
            errors.append(f"invalid sha256: {relative}")
            expected_hash = None
        expected_media_type = entry.get("mediaType")
        if not isinstance(expected_media_type, str) or not expected_media_type:
            errors.append(f"invalid mediaType: {relative}")
            expected_media_type = None
        if relative.startswith("assets/"):
            try:
                validate_unity_path(relative.removeprefix("assets/"))
            except ValueError as error:
                errors.append(str(error))
        file = layout.root.joinpath(*relative.split("/"))
        if not file.is_file():
            errors.append(f"missing release file: {relative}")
            continue
        if expected_bytes is not None and file.stat().st_size != expected_bytes:
            errors.append(f"size mismatch: {relative}")
        if (
            check_hashes
            and expected_hash is not None
            and sha256_file(file) != expected_hash
        ):
            errors.append(f"hash mismatch: {relative}")
        if expected_media_type is not None and media_type(file) != expected_media_type:
            errors.append(f"mediaType mismatch: {relative}")

    actual = {
        file.relative_to(layout.root).as_posix()
        for file in walk_files(layout.root)
        if file != layout.manifest
    }
    for relative in sorted(actual - declared):
        errors.append(f"undeclared release file: {relative}")
    for relative in sorted(declared - actual):
        errors.append(f"declared release file is absent: {relative}")
    errors.extend(
        _catalog_storage_errors(
            layout.root,
            server,
            str(manifest.get("sourceId") or ""),
            declared,
        )
    )
    errors.extend(
        _source_index_storage_errors(
            layout.root,
            server,
            str(manifest.get("sourceId") or ""),
            declared,
        )
    )
    errors.extend(_catalog_resource_errors(layout.root, server, declared))
    try:
        verify_game_client_release(
            layout.root / "game-client",
            server,
            str(manifest.get("sourceId") or ""),
            declared,
        )
    except (FileNotFoundError, UnicodeDecodeError, ValueError) as error:
        errors.append(f"game-client release verification failed: {error}")
    if not isinstance(manifest.get("entryCount"), int) or manifest.get(
        "entryCount"
    ) != len(declared):
        errors.append("entryCount mismatch")
    declared_bytes = sum(
        item.get("bytes", 0)
        for item in entries
        if isinstance(item, dict)
        and isinstance(item.get("bytes"), int)
        and not isinstance(item.get("bytes"), bool)
        and item.get("bytes", 0) >= 0
    )
    if (
        not isinstance(manifest.get("totalBytes"), int)
        or manifest.get("totalBytes") != declared_bytes
    ):
        errors.append("totalBytes mismatch")
    if errors:
        raise ValueError(
            f"release verification failed ({len(errors)}):\n" + "\n".join(errors[:100])
        )
    return manifest


def current_pointer(server: str) -> dict[str, Any]:
    file = server_layout(server).current
    if not file.is_file():
        raise FileNotFoundError(f"current release pointer not found: {file}")
    value = read_json(file)
    if value.get("schema") != POINTER_SCHEMA or value.get("server") != server:
        raise ValueError(f"invalid release pointer: {file}")
    return value


def write_current_pointer(server: str, manifest: dict[str, Any]) -> dict[str, Any]:
    release_id = manifest["releaseId"]
    pointer = {
        "schema": POINTER_SCHEMA,
        "server": server,
        "sourceId": manifest["sourceId"],
        "releaseId": release_id,
        "releaseManifest": f"servers/{server}/releases/{release_id}/release.json",
        "releaseIndex": {
            "algorithm": RELEASE_INDEX_ALGORITHM,
            "shards": RELEASE_INDEX_SHARDS,
            "prefix": release_index_prefix(server, release_id),
        },
    }
    write_json(server_layout(server).current, pointer, pretty=True)
    return pointer


def promote_directory(staging: Path, server: str, source_id: str) -> dict[str, Any]:
    manifest = write_release_manifest(staging, server, source_id)
    target = release_layout(server, manifest["releaseId"]).root
    if target.exists():
        existing = read_json(target / "release.json")
        if existing != manifest:
            raise FileExistsError(f"release id collision: {target}")
        write_current_pointer(server, manifest)
        return manifest
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staging, target)
    write_current_pointer(server, manifest)
    return manifest
