"""Verify the selected immutable release directly in R2."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

from core.config import ServerConfig
from core.contracts import POINTER_SCHEMA, RELEASE_SCHEMA
from core.storage import (
    RELEASE_INDEX_ALGORITHM,
    RELEASE_INDEX_SHARDS,
    cas_key,
    release_index_key,
    release_index_prefix,
    release_index_shard,
)
from publish.r2 import R2Store
from verify.source import validate_source_manifest


GAME_CLIENT_SOURCE_ROLES = {
    "catalog",
    "catalog-hash",
    "embedded-catalog",
    "unity-bundle",
}


def verify_remote(
    store: R2Store,
    config: ServerConfig,
    check_objects: bool = True,
    expected_release_id: str | None = None,
) -> dict[str, Any]:
    pointer_key = f"servers/{config.id}/current.json"
    pointer = store.get_json(pointer_key)
    if (
        not isinstance(pointer, dict)
        or pointer.get("schema") != POINTER_SCHEMA
        or pointer.get("server") != config.id
    ):
        raise ValueError(f"invalid or missing remote pointer: {pointer_key}")
    release_id = str(pointer.get("releaseId") or "")
    if expected_release_id is not None and release_id != expected_release_id:
        raise ValueError(
            f"remote release mismatch: expected {expected_release_id}, found {release_id}"
        )
    manifest_key = f"servers/{config.id}/releases/{release_id}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError(
            "remote pointer does not identify its canonical release manifest"
        )
    expected_index = {
        "algorithm": RELEASE_INDEX_ALGORITHM,
        "shards": RELEASE_INDEX_SHARDS,
        "prefix": release_index_prefix(config.id, release_id),
    }
    if pointer.get("releaseIndex") != expected_index:
        raise ValueError("remote pointer does not identify its canonical release index")
    manifest = store.get_json(manifest_key)
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != RELEASE_SCHEMA
        or manifest.get("server") != config.id
        or manifest.get("releaseId") != release_id
    ):
        raise ValueError(f"invalid or missing remote release manifest: {manifest_key}")
    source_id = str(manifest.get("sourceId") or "")
    source_key = f"servers/{config.id}/sources/{source_id}/source.json"
    source = store.get_json(source_key)
    try:
        source_records = validate_source_manifest(
            source,
            config.id,
            source_id,
            require_storage=True,
        )
    except ValueError as error:
        raise ValueError(
            f"invalid or missing game-client source manifest: {source_key}: {error}"
        ) from error

    def load_index(index: int) -> tuple[str, dict[str, Any]]:
        shard = f"{index:02x}"
        key = release_index_key(config.id, release_id, shard)
        value = store.get_json(key)
        if (
            not isinstance(value, dict)
            or value.get("schema") != "haneoka-resource-index-v1"
            or value.get("server") != config.id
            or value.get("releaseId") != release_id
            or value.get("algorithm") != RELEASE_INDEX_ALGORITHM
            or value.get("shard") != shard
            or not isinstance(value.get("entries"), dict)
        ):
            raise ValueError(f"invalid or missing remote release index: {key}")
        return shard, value["entries"]

    with ThreadPoolExecutor(max_workers=store.concurrency) as executor:
        indexes = dict(executor.map(load_index, range(RELEASE_INDEX_SHARDS)))
    expected_entries = {
        entry["path"]: [entry["sha256"], entry["bytes"], entry["mediaType"]]
        for entry in manifest.get("entries", [])
    }
    indexed_entries: dict[str, Any] = {}
    for shard, entries in indexes.items():
        for path, value in entries.items():
            if release_index_shard(path) != shard:
                raise ValueError(f"release index entry is in the wrong shard: {path}")
            if path in indexed_entries:
                raise ValueError(f"duplicate remote release index entry: {path}")
            indexed_entries[path] = value
    if indexed_entries != expected_entries:
        missing = sorted(set(expected_entries) - set(indexed_entries))
        extra = sorted(set(indexed_entries) - set(expected_entries))
        raise ValueError(
            f"remote release index mismatch: missing={missing[:10]}, extra={extra[:10]}"
        )

    unique = {entry["sha256"]: entry for entry in manifest.get("entries", [])}
    game_client_objects = {
        record["sha256"]: record
        for record in source_records
        if record.get("role") in GAME_CLIENT_SOURCE_ROLES
    }
    failures: list[str] = []
    if check_objects:

        def verify(entry: dict[str, Any]) -> str | None:
            head = store.head(cas_key(entry["sha256"]))
            if (
                not head
                or head.get("ContentLength") != entry.get("bytes")
                or head.get("Metadata", {}).get("sha256") != entry.get("sha256")
            ):
                return entry["path"]
            return None

        with ThreadPoolExecutor(max_workers=store.concurrency) as executor:
            failures = [path for path in executor.map(verify, unique.values()) if path]

        def verify_game_client(record: dict[str, Any]) -> str | None:
            head = store.head(cas_key(record["sha256"]))
            if (
                not head
                or head.get("ContentLength") != record.get("bytes")
                or head.get("Metadata", {}).get("sha256") != record.get("sha256")
            ):
                return str(
                    record.get("path")
                    or record.get("originalFilename")
                    or record.get("sha256")
                )
            return None

        with ThreadPoolExecutor(max_workers=store.concurrency) as executor:
            failures.extend(
                path
                for path in executor.map(
                    verify_game_client, game_client_objects.values()
                )
                if path
            )
    if failures:
        raise ValueError(
            f"remote release verification failed ({len(failures)}): {failures[:20]}"
        )
    return {
        "schema": "haneoka-remote-verification-v1",
        "server": config.id,
        "sourceId": manifest["sourceId"],
        "releaseId": release_id,
        "entryCount": len(manifest.get("entries", [])),
        "indexObjectsChecked": RELEASE_INDEX_SHARDS,
        "casObjectsChecked": len(unique) if check_objects else 0,
        "gameClientCasObjectsChecked": len(game_client_objects) if check_objects else 0,
    }
