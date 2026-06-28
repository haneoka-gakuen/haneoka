"""Merge Unity processing shards into one collision-checked build index."""

from __future__ import annotations

import json
import os
import sqlite3
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from core.contracts import UNITY_INDEX_SCHEMA
from core.hashes import sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import build_layout, validate_unity_path
from core.process import hardlink_or_copy, walk_files
from core.unity_objects import iter_unity_object_archive


MERGE_TREES = ("objects", "metadata/bundles")
RUNTIME_PROJECTION_PREFIXES = ("Assets/AddressableResources/Live/",)
RUNTIME_PROJECTION_TYPES = {"AnimationClip", "ParticleSystem", "Sprite", "SpriteAtlas", "SpriteRenderer"}
HUD_FONT_RUNTIME_SOURCE = (
    "Assets/AddressableResources/Font/VibeMOPro-Medium/"
    "VibeMOPro-Medium SDF.asset"
)


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
        raise ValueError(
            f"current Unity source path resolves to different object data: "
            f"{eligible[0]['source']['sourcePath']} "
            f"({', '.join(item['bundleFilename'] for item in eligible)})"
        )
    output_by_path: dict[str, dict[str, Any]] = {}
    for candidate in eligible:
        for output in candidate["source"].get("outputs", []):
            existing = output_by_path.get(output["path"])
            if existing and existing["sha256"] != output["sha256"]:
                raise ValueError(f"Unity source output collision: {output['path']}")
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


def _materialize_outputs(layout, sources: list[dict[str, Any]], shard_count: int) -> int:
    materialized: dict[str, str] = {}
    for source in sources:
        for output in source["outputs"]:
            relative = str(output["path"])
            if not relative.startswith(("assets/", "runtime/")):
                raise ValueError(f"invalid Unity media output path: {relative}")
            digest = str(output["bundleSha256"])
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
    return len(materialized)


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


def _runtime_projections(layout, sources: list[dict[str, Any]]) -> int:
    """Materialize the small Unity JSON surface consumed by the web runtime.

    Full object fidelity remains in the bundle JSONL archives.  These files are
    deterministic projections, named by real Unity source path and type ordinal;
    they do not recreate a processor-specific directory tree.
    """

    by_bundle: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for source in sources:
        source_path = source["sourcePath"]
        if (
            source_path.startswith(RUNTIME_PROJECTION_PREFIXES)
            or source_path == HUD_FONT_RUNTIME_SOURCE
        ):
            by_bundle[source["selectedBundle"]].append(source)
    output_count = 0
    for digest, bundle_sources in sorted(by_bundle.items()):
        records_by_file = _archive_records(
            layout.objects / "unity" / f"{digest}.jsonl.gz"
        )
        for source in bundle_sources:
            records = records_by_file.get(source["serializedFile"], {})
            object_ids = sorted(
                set(source["rootObjects"]) | set(source.get("preloadObjects", [])),
                key=int,
            )
            counters: dict[str, int] = defaultdict(int)
            projected = []
            for object_id in object_ids:
                record = records.get(object_id)
                if not record:
                    continue
                object_type = str(record.get("type") or "")
                allowed = object_type in RUNTIME_PROJECTION_TYPES
                # The live HUD consumes this one TMP_FontAsset descriptor.
                # Do not make MonoBehaviour a global projection type: Live
                # bundles contain many unrelated script objects.
                if source["sourcePath"] == HUD_FONT_RUNTIME_SOURCE:
                    allowed = object_type == "MonoBehaviour"
                if not allowed:
                    continue
                ordinal = counters[object_type]
                counters[object_type] += 1
                filename = f"{object_type}{f'_{ordinal}' if ordinal else ''}.json"
                relative = PurePosixPath("unity-json", source["sourcePath"], filename)
                output = layout.runtime / Path(*relative.parts)
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(stable_json(record), "utf-8")
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
    return output_count


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


def merge_unity_shards(server: str, source_id: str, build_id: str, shard_count: int) -> dict[str, Any]:
    layout = build_layout(server, build_id)
    reports_by_sha: dict[str, dict[str, Any]] = {}
    candidates: dict[str, list[dict[str, Any]]] = defaultdict(list)
    shard_manifests = []
    for index in range(shard_count):
        shard = layout.shards / f"{index:03d}"
        descriptor_file = shard / "shard.json"
        if not descriptor_file.is_file():
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

    sources = [_canonical_source(candidates[path], reports_by_sha) for path in sorted(candidates)]
    media_output_count = _materialize_outputs(layout, sources, shard_count)
    runtime_object_count = _runtime_projections(layout, sources)
    for source in sources:
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
                raise ValueError(
                    f"Unity serialized file resolves to multiple archives: {serialized_file}"
                )
            serialized_files[serialized_file] = value
    source_index = {
        "schema": UNITY_INDEX_SCHEMA,
        "server": server,
        "sourceId": source_id,
        "bundleCount": len(reports_by_sha),
        "sourceCount": len(sources),
        "objectCount": sum(report["objectArchive"]["objectCount"] for report in reports_by_sha.values()),
        "runtimeObjectCount": runtime_object_count,
        "mediaOutputCount": media_output_count,
        "serializedFiles": serialized_files,
        "tree": _tree(source["sourcePath"] for source in sources),
        "sources": {
            source["sourcePath"]: {
                "descriptor": source["descriptor"].removeprefix("metadata/"),
                "contentSha256": source["contentSha256"],
                "serializedFile": source["serializedFile"],
                "rootTypes": source["rootTypes"],
                "outputs": source["outputs"],
            }
            for source in sources
        },
    }
    write_json(layout.metadata / "source-index.json", source_index)
    _write_database(layout.database, list(reports_by_sha.values()), sources)
    summary = {
        "schema": "haneoka-unity-merge-v1",
        "server": server,
        "sourceId": source_id,
        "buildId": build_id,
        "shardCount": shard_count,
        "bundleCount": len(reports_by_sha),
        "sourceCount": len(sources),
        "objectCount": source_index["objectCount"],
        "runtimeObjectCount": runtime_object_count,
        "mediaOutputCount": media_output_count,
    }
    write_json(layout.reports / "unity.json", summary, pretty=True)
    return summary
