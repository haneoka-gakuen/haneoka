"""Deterministic, sharded Unity resource processing based on ``m_Container`` paths.

The processor never derives a source path from a download filename. Original
bundle names remain provenance; public paths come only from Unity's container.
"""

from __future__ import annotations

import gzip
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

import UnityPy
from UnityPy.classes.PPtr import PPtr

from core.hashes import sha256_bytes, sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import build_layout, source_layout, validate_unity_path


ARCHIVE_FORMAT = "haneoka-unity-objects-jsonl-v1"
MEDIA_TYPES = {"Texture2D", "Sprite", "TextAsset", "AudioClip"}


def _pointer_id(pointer: Any) -> int:
    return int(getattr(pointer, "path_id", None) or getattr(pointer, "m_PathID", 0) or 0)


def _safe_name(value: Any, fallback: str) -> str:
    name = re.sub(r"[\\/:\x00]+", "_", str(value or "").strip())
    return name or fallback


def _object_name(obj: Any) -> str:
    try:
        data = obj.read()
        return _safe_name(getattr(data, "m_Name", None) or getattr(data, "name", None), f"{obj.type.name}_{obj.path_id}")
    except Exception:
        return f"{obj.type.name}_{obj.path_id}"


def _raw_bytes(value: Any) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("utf-8", "surrogateescape")
    return str(value).encode("utf-8", "replace")


def _text_payload(obj: Any) -> bytes:
    data = obj.read()
    value: Any = None
    for attribute in ("text", "script", "m_Script"):
        candidate = getattr(data, attribute, None)
        if candidate not in (None, b"", ""):
            value = candidate
            break
    if value is None:
        value = obj.read_typetree().get("m_Script", "")
    raw = _raw_bytes(value)
    if raw.startswith(b"\x1f\x8b"):
        try:
            return gzip.decompress(raw)
        except Exception as error:
            raise ValueError("Unity TextAsset has an invalid gzip payload") from error
    return raw


def _write_bytes(file: Path, payload: bytes) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.exists():
        if file.stat().st_size == len(payload) and sha256_file(file) == sha256_bytes(payload):
            return
        raise FileExistsError(f"Unity output collision: {file}")
    temporary = file.with_name(f".{file.name}.{os.getpid()}.tmp")
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, file)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _required_file_size(file: Path, label: str) -> int:
    if not file.is_file():
        raise FileNotFoundError(f"{label} is not a file: {file}")
    size = file.stat().st_size
    if size == 0:
        raise ValueError(f"{label} is empty: {file}")
    return size


def _save_png(file: Path, obj: Any) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(f".{file.name}.{os.getpid()}.tmp")
    try:
        image = obj.read().image
        image.save(temporary, format="PNG")
        if file.exists():
            if sha256_file(file) != sha256_file(temporary):
                raise FileExistsError(f"Unity output collision: {file}")
            temporary.unlink()
            return
        os.replace(temporary, file)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


@dataclass
class SourceGroup:
    source_path: str
    serialized_file: str
    roots: set[int] = field(default_factory=set)
    preloads: set[int] = field(default_factory=set)
    root_references: set[tuple[str, int]] = field(default_factory=set)
    preload_references: set[tuple[str, int]] = field(default_factory=set)
    root_types: set[str] = field(default_factory=set)
    outputs: list[dict[str, Any]] = field(default_factory=list)


def _pointer_identity(pointer: Any) -> tuple[str, int] | None:
    path_id = _pointer_id(pointer)
    if not path_id:
        return None
    try:
        reader = pointer.deref()
    except (FileNotFoundError, KeyError, ValueError):
        return None
    return str(reader.assets_file.name), int(reader.path_id)


def _source_groups(
    bundle: Any, objects_by_identity: dict[tuple[str, int], Any]
) -> list[SourceGroup]:
    groups: dict[str, SourceGroup] = {}
    bundle_serialized_file = str(bundle.object_reader.assets_file.name)
    serialized_files = {identity[0] for identity in objects_by_identity}
    preload_table = list(getattr(bundle, "m_PreloadTable", []) or [])
    for raw_path, info in list(getattr(bundle, "m_Container", []) or []):
        source_path = validate_unity_path(raw_path)
        root_pointer = getattr(info, "asset", None)
        root_reference = _pointer_identity(root_pointer)
        if _pointer_id(root_pointer) and root_reference is None:
            raise ValueError(f"Unity source root pointer is unresolved: {source_path}")
        if root_reference is not None:
            serialized_file = root_reference[0]
        else:
            scene_files = serialized_files - {bundle_serialized_file}
            if len(scene_files) == 1:
                serialized_file = next(iter(scene_files))
            elif serialized_files == {bundle_serialized_file}:
                serialized_file = bundle_serialized_file
            else:
                raise ValueError(
                    f"Unity zero-root container cannot identify its scene file: "
                    f"{source_path} ({', '.join(sorted(serialized_files))})"
                )
        group = groups.setdefault(
            source_path, SourceGroup(source_path, serialized_file)
        )
        if group.serialized_file != serialized_file:
            raise ValueError(
                f"Unity source spans multiple root serialized files: {source_path}"
            )
        if root_reference is not None:
            group.root_references.add(root_reference)
            group.roots.add(root_reference[1])
            root_object = objects_by_identity.get(root_reference)
            if root_object is not None:
                group.root_types.add(root_object.type.name)
        start = max(0, int(getattr(info, "preloadIndex", 0) or 0))
        size = max(0, int(getattr(info, "preloadSize", 0) or 0))
        for pointer in preload_table[start : start + size]:
            reference = _pointer_identity(pointer)
            if reference is None:
                continue
            group.preload_references.add(reference)
            if reference[0] == group.serialized_file:
                group.preloads.add(reference[1])
    return [groups[key] for key in sorted(groups)]


def _owner(
    groups: list[SourceGroup], identity: tuple[str, int]
) -> tuple[SourceGroup | None, bool]:
    direct = [group for group in groups if identity in group.root_references]
    if direct:
        return direct[0], True
    preload = [group for group in groups if identity in group.preload_references]
    if preload:
        return preload[0], False
    return (groups[0], False) if len(groups) == 1 else (None, False)


def _preferred_png_object(
    group: SourceGroup, objects_by_identity: dict[tuple[str, int], Any]
) -> tuple[str, int] | None:
    """Choose the one Unity object that provides a PNG source image.

    Unity commonly repeats one PNG container entry for its backing Texture2D
    and every Sprite cut from that texture.  The Texture2D is the original
    image; Sprites are runtime views and must not compete for the source path.
    """

    if not group.source_path.lower().endswith(".png"):
        return None
    candidates = [
        objects_by_identity[identity]
        for identity in sorted(
            group.root_references | group.preload_references
        )
        if identity in objects_by_identity
    ]
    for object_type in ("Texture2D", "Sprite"):
        matching = [
            (str(obj.assets_file.name), int(obj.path_id))
            for obj in candidates
            if obj.type.name == object_type
        ]
        if matching:
            return min(matching)
    return None


def _media_output(shard_root: Path, group: SourceGroup, obj: Any, direct: bool) -> tuple[Path, str] | None:
    source = PurePosixPath(group.source_path)
    object_id = str(obj.path_id)
    object_type = obj.type.name
    name = _object_name(obj)
    source_suffix = source.suffix.lower()

    if object_type in {"Texture2D", "Sprite"}:
        if direct and source_suffix == ".png":
            return shard_root / "assets" / Path(*source.parts), "source"
        filename = f"{name}--{object_type}-{object_id}.png"
        return shard_root / "runtime" / "unity" / Path(*source.parts) / filename, "derivative"
    if object_type == "TextAsset":
        if direct:
            return shard_root / "assets" / Path(*source.parts), "source"
        suffix = Path(name).suffix or ".bytes"
        return shard_root / "runtime" / "unity" / Path(*source.parts) / f"{name}{'' if Path(name).suffix else suffix}", "derivative"
    if object_type == "AudioClip":
        samples = getattr(obj.read(), "samples", {}) or {}
        if direct and source_suffix == ".wav" and len(samples) == 1:
            return shard_root / "assets" / Path(*source.parts), "source"
        if len(samples) == 1:
            sample_name = _safe_name(next(iter(samples)), name)
            return shard_root / "runtime" / "unity" / Path(*source.parts) / f"{sample_name}.wav", "derivative"
    return None


def _export_media(shard_root: Path, group: SourceGroup, obj: Any, direct: bool) -> dict[str, Any] | None:
    target = _media_output(shard_root, group, obj, direct)
    if not target:
        return None
    file, role = target
    if obj.type.name == "Texture2D":
        texture = obj.read()
        stream = getattr(texture, "m_StreamData", None)
        has_payload = bool(getattr(texture, "image_data", None)) or bool(
            stream and getattr(stream, "path", "") and int(getattr(stream, "size", 0) or 0) > 0
        )
        if not has_payload:
            if role == "source":
                raise ValueError(f"source Texture2D has no image payload: {group.source_path}")
            return None
        _save_png(file, obj)
    elif obj.type.name == "Sprite":
        _save_png(file, obj)
    elif obj.type.name == "TextAsset":
        _write_bytes(file, _text_payload(obj))
    elif obj.type.name == "AudioClip":
        samples = getattr(obj.read(), "samples", {}) or {}
        _write_bytes(file, next(iter(samples.values())).data)
    else:
        return None
    return {
        "path": file.relative_to(shard_root).as_posix(),
        "role": role,
        "type": obj.type.name,
        "serializedFile": str(obj.assets_file.name),
        "objectId": str(obj.path_id),
        "bytes": file.stat().st_size,
        "sha256": sha256_file(file),
    }


def _external_path(assets_file: Any, file_id: int) -> str | None:
    index = file_id - 1
    externals = list(getattr(assets_file, "externals", []) or [])
    if index < 0 or index >= len(externals):
        return None
    return str(getattr(externals[index], "path", "") or "") or None


def _resolved_object_name(reader: Any) -> str | None:
    try:
        value = reader.read()
    except Exception:
        return None
    parsed = getattr(value, "m_ParsedForm", None)
    name = (
        getattr(parsed, "m_Name", None)
        or getattr(value, "m_Name", None)
        or getattr(value, "name", None)
    )
    return str(name) if name else None


class _ReferenceResolver:
    """Resolve external PPtrs while UnityPy still owns dependency context."""

    def __init__(self) -> None:
        self._resolved: dict[tuple[str, int], dict[str, Any]] = {}

    def resolve(self, assets_file: Any, file_id: int, path_id: int) -> dict[str, Any]:
        external_path = _external_path(assets_file, file_id)
        try:
            reader = PPtr(
                m_FileID=file_id,
                m_PathID=path_id,
                assetsfile=assets_file,
            ).deref()
        except Exception as error:
            return {
                "status": "unresolved",
                "externalPath": external_path,
                "error": type(error).__name__,
            }
        key = (str(reader.assets_file.name), int(reader.path_id))
        cached = self._resolved.get(key)
        if cached is None:
            cached = {
                "status": "resolved",
                "serializedFile": key[0],
                "pathId": str(key[1]),
                "type": reader.type.name,
                "name": _resolved_object_name(reader),
            }
            self._resolved[key] = cached
        return {**cached, "externalPath": external_path}

    def decorate(
        self,
        value: Any,
        assets_file: Any,
    ) -> Any:
        if isinstance(value, dict):
            output = {
                key: self.decorate(child, assets_file)
                for key, child in value.items()
            }
            if "m_FileID" in value and "m_PathID" in value:
                try:
                    file_id = int(value.get("m_FileID") or 0)
                    path_id = int(value.get("m_PathID") or 0)
                except (TypeError, ValueError):
                    file_id = 0
                    path_id = 0
                if file_id and path_id:
                    output["reference"] = self.resolve(assets_file, file_id, path_id)
            return output
        if isinstance(value, list):
            return [self.decorate(child, assets_file) for child in value]
        return value


def _write_object_archive(
    objects: list[Any], original_filename: str, digest: str, output: Path
) -> tuple[dict[str, Any], dict[tuple[str, int], str]]:
    objects = sorted(objects, key=lambda value: (str(value.assets_file.name), int(value.path_id)))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    failed = 0
    fingerprints: dict[tuple[str, int], str] = {}
    serialized_files = sorted({str(obj.assets_file.name) for obj in objects})
    serialized_file_object_counts = {
        serialized_file: sum(
            str(obj.assets_file.name) == serialized_file for obj in objects
        )
        for serialized_file in serialized_files
    }
    resolver = _ReferenceResolver()
    try:
        with temporary.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=6, mtime=0) as compressed:
                header = stable_json(
                    {
                        "record": "header",
                        "format": ARCHIVE_FORMAT,
                        "bundle": original_filename,
                        "bundleSha256": digest,
                        "serializedFiles": serialized_files,
                    }
                ).encode()
                compressed.write(header)
                for obj in objects:
                    record: dict[str, Any] = {
                        "record": "object",
                        "serializedFile": str(obj.assets_file.name),
                        "pathId": str(obj.path_id),
                        "type": obj.type.name,
                    }
                    try:
                        record["data"] = resolver.decorate(obj.read_typetree(), obj.assets_file)
                    except Exception as error:
                        record["error"] = f"{type(error).__name__}: {error}"
                        failed += 1
                    # Unity strings may contain surrogate-escaped raw bytes. JSON
                    # escaping preserves their exact value while keeping the JSONL
                    # archive valid UTF-8 on every runner.
                    line = json.dumps(record, ensure_ascii=True, separators=(",", ":"), sort_keys=True, default=str)
                    encoded = line.encode("utf-8")
                    fingerprints[(str(obj.assets_file.name), int(obj.path_id))] = sha256_bytes(encoded)
                    compressed.write(encoded + b"\n")
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return ({
        "path": output.as_posix(),
        "format": ARCHIVE_FORMAT,
        "serializedFiles": serialized_files,
        "serializedFileObjectCounts": serialized_file_object_counts,
        "objectCount": len(objects),
        "failedObjectCount": failed,
        "bytes": output.stat().st_size,
        "sha256": sha256_file(output),
    }, fingerprints)


def extract_bundle(
    bundle: Path,
    artifact: dict[str, Any],
    shard_root: Path,
    dependencies: list[Path] | None = None,
) -> dict[str, Any]:
    digest = artifact["sha256"]
    bundle_bytes = _required_file_size(bundle, "Unity bundle")
    declared_value = artifact.get("bytes")
    if (
        not isinstance(declared_value, int)
        or isinstance(declared_value, bool)
        or declared_value < 0
    ):
        raise ValueError(f"Unity bundle has an invalid declared size: {bundle}")
    declared_bytes = declared_value
    if declared_bytes != bundle_bytes:
        raise ValueError(
            f"Unity bundle size mismatch: expected {declared_bytes}, got {bundle_bytes}: {bundle}"
        )
    dependencies = list(dependencies or [])
    for dependency in dependencies:
        _required_file_size(dependency, "Unity dependency bundle")
    environment = UnityPy.load(str(bundle))
    for dependency in dependencies:
        environment.load_file(str(dependency), is_dependency=True)
    objects = list(environment.objects)
    objects_by_identity = {
        (str(obj.assets_file.name), int(obj.path_id)): obj for obj in objects
    }
    if len(objects_by_identity) != len(objects):
        raise ValueError(
            f"Unity bundle repeats a serialized-file/pathId identity: "
            f"{artifact['originalFilename']}"
        )
    bundle_object = next((obj for obj in objects if obj.type.name == "AssetBundle"), None)
    groups = (
        _source_groups(bundle_object.read(), objects_by_identity)
        if bundle_object
        else []
    )
    warnings = [] if bundle_object else ["AssetBundle object is missing"]
    candidate_root = shard_root / "candidates" / digest
    preferred_png_objects = {
        group.source_path: identity
        for group in groups
        if (identity := _preferred_png_object(group, objects_by_identity))
        is not None
    }
    for obj in sorted(
        objects, key=lambda value: (str(value.assets_file.name), int(value.path_id))
    ):
        if obj.type.name not in MEDIA_TYPES:
            continue
        identity = (str(obj.assets_file.name), int(obj.path_id))
        group, direct = _owner(groups, identity)
        if not group:
            continue
        if group.source_path in preferred_png_objects:
            direct = identity == preferred_png_objects[group.source_path]
        try:
            output = _export_media(candidate_root, group, obj, direct)
            if output:
                group.outputs.append(output)
        except Exception as error:
            raise RuntimeError(f"failed to export {artifact['originalFilename']}:{obj.path_id}: {error}") from error

    archive_file = shard_root / "objects" / "unity" / f"{digest}.jsonl.gz"
    archive, fingerprints = _write_object_archive(objects, artifact["originalFilename"], digest, archive_file)
    archive["path"] = archive_file.relative_to(shard_root).as_posix()
    report = {
        "schema": "haneoka-unity-bundle-v1",
        "bundle": {
            "originalFilename": artifact["originalFilename"],
            "bytes": artifact["bytes"],
            "sha256": digest,
            "serializedFiles": archive["serializedFiles"],
            "origin": "remote-catalog" if artifact.get("addressables") else "embedded-package",
            "dependencies": list((artifact.get("unity") or {}).get("dependencies", [])),
        },
        "objectArchive": archive,
        "sources": [
            {
                "sourcePath": group.source_path,
                "serializedFile": group.serialized_file,
                "rootObjects": [str(value) for value in sorted(group.roots)],
                "preloadObjects": [str(value) for value in sorted(group.preloads)],
                "rootObjectReferences": [
                    {"serializedFile": serialized_file, "pathId": str(path_id)}
                    for serialized_file, path_id in sorted(group.root_references)
                ],
                "preloadObjectReferences": [
                    {"serializedFile": serialized_file, "pathId": str(path_id)}
                    for serialized_file, path_id in sorted(
                        group.preload_references
                    )
                ],
                "preloadObjectCount": len(group.preload_references),
                "rootTypes": sorted(group.root_types),
                "contentSha256": sha256_bytes(
                    "\n".join(
                        f"{serialized_file}:{object_id}:"
                        f"{fingerprints.get((serialized_file, object_id), '')}"
                        for serialized_file, object_id in sorted(
                            group.root_references | group.preload_references
                        )
                    )
                ),
                "outputs": sorted(group.outputs, key=lambda item: (item["path"], item["objectId"])),
            }
            for group in groups
        ],
        "warnings": warnings,
    }
    write_json(shard_root / "metadata" / "bundles" / f"{digest}.json", report)
    return report


def shard_artifacts(manifest: dict[str, Any], shard_index: int, shard_count: int) -> list[dict[str, Any]]:
    if shard_count < 1 or not 0 <= shard_index < shard_count:
        raise ValueError(f"invalid shard {shard_index}/{shard_count}")
    artifacts = sorted(
        (item for item in manifest.get("files", []) if item.get("role") == "unity-bundle"),
        key=lambda item: (item["sha256"], item["originalFilename"]),
    )
    return [item for item in artifacts if int(item["sha256"][:16], 16) % shard_count == shard_index]


def _dependency_paths(artifact: dict[str, Any], artifacts_by_path: dict[str, dict[str, Any]]) -> list[str]:
    root_path = str(artifact["path"])
    found: set[str] = {root_path}
    pending = list((artifact.get("unity") or {}).get("dependencies", []))
    while pending:
        relative = str(pending.pop())
        if relative in found:
            continue
        dependency = artifacts_by_path.get(relative)
        if not dependency or dependency.get("role") != "unity-bundle":
            raise ValueError(f"invalid Unity dependency: {artifact['path']} -> {relative}")
        found.add(relative)
        pending.extend((dependency.get("unity") or {}).get("dependencies", []))
    return sorted(found - {root_path})


def extract_shard(server: str, source_id: str, build_id: str, shard_index: int, shard_count: int) -> dict[str, Any]:
    source = source_layout(server, source_id)
    build = build_layout(server, build_id)
    manifest = read_json(source.manifest)
    records = list(manifest.get("files", []))
    shard_root = build.shards / f"{shard_index:03d}"
    if shard_root.exists():
        raise FileExistsError(f"shard output already exists: {shard_root}")
    shard_root.mkdir(parents=True)
    selected = shard_artifacts(manifest, shard_index, shard_count)
    artifacts_by_path = {str(item["path"]): item for item in records}
    reports = []
    for artifact in selected:
        dependencies = [
            source.root / relative
            for relative in _dependency_paths(artifact, artifacts_by_path)
        ]
        report = extract_bundle(source.root / artifact["path"], artifact, shard_root, dependencies)
        reports.append(report)
    result = {
        "schema": "haneoka-unity-shard-v1",
        "server": server,
        "sourceId": source_id,
        "buildId": build_id,
        "shardIndex": shard_index,
        "shardCount": shard_count,
        "bundleCount": len(reports),
        "sourceCount": sum(len(report["sources"]) for report in reports),
        "objectCount": sum(report["objectArchive"]["objectCount"] for report in reports),
        "bundles": [report["bundle"]["sha256"] for report in reports],
    }
    write_json(shard_root / "shard.json", result, pretty=True)
    return result
