from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol


NAMESPACE_PREFIX = "garupa-master"
DEFAULT_SERVER = "jp"
SNAPSHOT_SCHEMA = "haneoka-garupa-master-snapshot-v1"
POINTER_SCHEMA = "haneoka-garupa-master-pointer-v1"
UPLOAD_CHECKPOINT_SCHEMA = "haneoka-garupa-master-upload-checkpoint-v1"
CAS_STORAGE_SCHEMA = "haneoka-r2-cas-v1"
CAS_PREFIX = "cas/v1/sha256"
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
POINTER_CACHE = "public, max-age=30, must-revalidate"
UPLOAD_CHECKPOINT_CACHE = "private, no-store"

ROOT_NAMES = ("archive", "schema", "projections")
WEB_PATHS = {
    "manifest": "projections/manifest.json",
    "bands": "projections/bands.json",
    "songs": "projections/songs.json",
    "stageChallenges": "projections/stage-challenges.json",
    "playlists": "projections/playlists.json",
}

SERVER_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SNAPSHOT_ID_PATTERN = re.compile(r"^m-[a-f0-9]{20}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
SHARD_PATTERN = re.compile(r"^[a-f0-9]{2}$")
MAX_SNAPSHOT_FILES = 20_000


class GarupaR2Error(ValueError):
    """Raised when a Garupa snapshot or its R2 representation is invalid."""


class R2StoreLike(Protocol):
    """The subset of :class:`publish.r2.R2Store` used by this module."""

    def head(self, key: str) -> dict[str, Any] | None: ...

    def upload_cas(self, file: Path, digest: str, content_type: str) -> None: ...

    def put_json(self, key: str, value: Any, cache_control: str) -> None: ...

    def get_bytes(self, key: str) -> bytes | None: ...

    def get_json(self, key: str) -> Any | None: ...

    def iter_keys(self, prefix: str) -> Iterable[dict[str, Any]]: ...

    def delete_prefix(self, prefix: str) -> int: ...

    def delete_keys(self, keys: Iterable[str]) -> int: ...


def _stable_json(value: Any) -> str:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    )


def _shared_cas_key(digest: object) -> str:
    """Resolve the repository CAS helper lazily.

    Garupa decoder tests intentionally run without boto3.  Importing
    ``publish.r2`` at module import time would pull boto3 into those jobs, so
    callers pass an actual ``publish.r2.R2Store`` by duck typing while this
    small helper lazily reuses the canonical key implementation.
    """

    try:
        from core.storage import cas_key
    except ModuleNotFoundError:
        scripts_root = str(Path(__file__).resolve().parents[1])
        if scripts_root not in sys.path:
            sys.path.insert(0, scripts_root)
        from core.storage import cas_key

    return cas_key(digest)


def _server(value: object) -> str:
    if not isinstance(value, str) or not SERVER_PATTERN.fullmatch(value):
        raise GarupaR2Error(f"invalid Garupa server id: {value}")
    return value


def _snapshot_id(value: object) -> str:
    if not isinstance(value, str) or not SNAPSHOT_ID_PATTERN.fullmatch(value):
        raise GarupaR2Error(f"invalid Garupa snapshot id: {value}")
    return value


def _sha256(value: object) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise GarupaR2Error(f"invalid SHA-256 digest: {value}")
    # Calling the shared helper also enforces the repository-wide CAS format.
    _shared_cas_key(value)
    return value


def _relative_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise GarupaR2Error(f"invalid snapshot path: {value}")
    if value.startswith("/") or value.endswith("/") or "//" in value:
        raise GarupaR2Error(f"invalid snapshot path: {value}")
    parts = value.split("/")
    if any(part in {"", ".", ".."} or "\0" in part for part in parts):
        raise GarupaR2Error(f"invalid snapshot path: {value}")
    return value


def namespace_prefix(server: str = DEFAULT_SERVER) -> str:
    return f"{NAMESPACE_PREFIX}/{_server(server)}"


def snapshot_prefix(server: str, snapshot_id: str) -> str:
    return f"{namespace_prefix(server)}/snapshots/{_snapshot_id(snapshot_id)}"


def snapshot_manifest_key(server: str, snapshot_id: str) -> str:
    return f"{snapshot_prefix(server, snapshot_id)}/manifest.json"


def pointer_key(server: str = DEFAULT_SERVER) -> str:
    return f"{namespace_prefix(server)}/current.json"


def upload_checkpoint_prefix(server: str, snapshot_id: str) -> str:
    return f"{namespace_prefix(server)}/uploads/{_snapshot_id(snapshot_id)}/"


def upload_checkpoint_key(server: str, snapshot_id: str, shard: str) -> str:
    if not isinstance(shard, str) or not SHARD_PATTERN.fullmatch(shard):
        raise GarupaR2Error(f"invalid Garupa upload shard: {shard}")
    return f"{upload_checkpoint_prefix(server, snapshot_id)}{shard}.json"


def _snapshot_identity(manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": manifest.get("schema"),
        "server": manifest.get("server"),
        "storage": manifest.get("storage"),
        "roots": manifest.get("roots"),
        "web": manifest.get("web"),
        "files": manifest.get("files"),
    }


def _expected_snapshot_id(manifest: dict[str, Any]) -> str:
    digest = hashlib.sha256(_stable_json(_snapshot_identity(manifest)).encode()).hexdigest()
    return f"m-{digest[:20]}"


def validate_snapshot_manifest(
    value: object,
    server: str,
    snapshot_id: str,
) -> list[dict[str, Any]]:
    """Validate one immutable snapshot manifest and return its file records.

    This is deliberately public so the shared R2 garbage collector can use
    exactly the same root contract as publication and verification.
    """

    expected_server = _server(server)
    expected_snapshot_id = _snapshot_id(snapshot_id)
    if not isinstance(value, dict):
        raise GarupaR2Error("Garupa snapshot manifest must be an object")
    expected_fields = {
        "schema",
        "server",
        "snapshotId",
        "storage",
        "roots",
        "web",
        "files",
        "entryCount",
        "totalBytes",
    }
    if set(value) != expected_fields:
        raise GarupaR2Error("Garupa snapshot manifest has unexpected fields")
    if (
        value.get("schema") != SNAPSHOT_SCHEMA
        or value.get("server") != expected_server
        or value.get("snapshotId") != expected_snapshot_id
        or value.get("storage")
        != {"schema": CAS_STORAGE_SCHEMA, "prefix": CAS_PREFIX}
    ):
        raise GarupaR2Error("Garupa snapshot manifest identity is invalid")

    raw_entries = value.get("files")
    if (
        not isinstance(raw_entries, list)
        or not raw_entries
        or len(raw_entries) > MAX_SNAPSHOT_FILES
    ):
        raise GarupaR2Error("Garupa snapshot files must be an array")
    entries: list[dict[str, Any]] = []
    paths: set[str] = set()
    digest_sizes: dict[str, int] = {}
    root_counts = {root: 0 for root in ROOT_NAMES}
    root_bytes = {root: 0 for root in ROOT_NAMES}
    total_bytes = 0
    for index, raw_entry in enumerate(raw_entries):
        if not isinstance(raw_entry, dict) or set(raw_entry) != {
            "root",
            "path",
            "bytes",
            "sha256",
            "mediaType",
        }:
            raise GarupaR2Error(f"Garupa snapshot entry {index} is invalid")
        root = raw_entry.get("root")
        if root not in ROOT_NAMES:
            raise GarupaR2Error(f"Garupa snapshot entry {index} has an invalid root")
        path = _relative_path(raw_entry.get("path"))
        if not path.startswith(f"{root}/") or path == f"{root}/":
            raise GarupaR2Error(f"Garupa snapshot entry root/path mismatch: {path}")
        if path in paths:
            raise GarupaR2Error(f"duplicate Garupa snapshot path: {path}")
        paths.add(path)
        byte_count = raw_entry.get("bytes")
        if (
            not isinstance(byte_count, int)
            or isinstance(byte_count, bool)
            or byte_count < 0
        ):
            raise GarupaR2Error(f"invalid Garupa snapshot byte count: {path}")
        digest = _sha256(raw_entry.get("sha256"))
        previous_size = digest_sizes.setdefault(digest, byte_count)
        if previous_size != byte_count:
            raise GarupaR2Error(
                f"Garupa snapshot digest has conflicting sizes: {digest}"
            )
        media_type = raw_entry.get("mediaType")
        if (
            not isinstance(media_type, str)
            or not media_type
            or len(media_type) > 128
            or any(ord(character) < 0x20 or ord(character) > 0x7E for character in media_type)
        ):
            raise GarupaR2Error(f"invalid Garupa snapshot media type: {path}")
        entry = {
            "root": root,
            "path": path,
            "bytes": byte_count,
            "sha256": digest,
            "mediaType": media_type,
        }
        entries.append(entry)
        root_counts[root] += 1
        root_bytes[root] += byte_count
        total_bytes += byte_count
    if entries != sorted(entries, key=lambda item: item["path"]):
        raise GarupaR2Error("Garupa snapshot entries are not canonically sorted")

    roots = value.get("roots")
    if not isinstance(roots, dict) or set(roots) != set(ROOT_NAMES):
        raise GarupaR2Error("Garupa snapshot roots are invalid")
    for root in ROOT_NAMES:
        descriptor = roots.get(root)
        if (
            not isinstance(descriptor, dict)
            or set(descriptor) != {"prefix", "entryCount", "totalBytes"}
            or descriptor.get("prefix") != f"{root}/"
            or not isinstance(descriptor.get("entryCount"), int)
            or isinstance(descriptor.get("entryCount"), bool)
            or not isinstance(descriptor.get("totalBytes"), int)
            or isinstance(descriptor.get("totalBytes"), bool)
            or descriptor.get("entryCount") != root_counts[root]
            or descriptor.get("totalBytes") != root_bytes[root]
            or root_counts[root] < 1
        ):
            raise GarupaR2Error(f"Garupa snapshot root descriptor is invalid: {root}")

    web = value.get("web")
    if web != WEB_PATHS:
        raise GarupaR2Error("Garupa snapshot web paths are invalid")
    missing_web = sorted(set(WEB_PATHS.values()) - paths)
    if missing_web:
        raise GarupaR2Error(
            f"Garupa snapshot is missing web projection paths: {missing_web}"
        )
    if (
        not isinstance(value.get("entryCount"), int)
        or isinstance(value.get("entryCount"), bool)
        or not isinstance(value.get("totalBytes"), int)
        or isinstance(value.get("totalBytes"), bool)
        or value.get("entryCount") != len(entries)
        or value.get("totalBytes") != total_bytes
    ):
        raise GarupaR2Error("Garupa snapshot aggregate counts are invalid")
    if _expected_snapshot_id(value) != expected_snapshot_id:
        raise GarupaR2Error("Garupa snapshot content identity is invalid")
    return entries


def validate_pointer(value: object, server: str = DEFAULT_SERVER) -> dict[str, Any]:
    expected_server = _server(server)
    if not isinstance(value, dict) or set(value) != {
        "schema",
        "server",
        "snapshotId",
        "manifest",
    }:
        raise GarupaR2Error("Garupa current pointer is invalid")
    snapshot_id = _snapshot_id(value.get("snapshotId"))
    if (
        value.get("schema") != POINTER_SCHEMA
        or value.get("server") != expected_server
        or value.get("manifest")
        != snapshot_manifest_key(expected_server, snapshot_id)
    ):
        raise GarupaR2Error("Garupa current pointer identity is invalid")
    return dict(value)


def validate_upload_checkpoint_key(key: object) -> tuple[str, str, str]:
    if not isinstance(key, str):
        raise GarupaR2Error(f"invalid Garupa upload checkpoint key: {key}")
    parts = key.split("/")
    if (
        len(parts) != 5
        or parts[0] != NAMESPACE_PREFIX
        or parts[2] != "uploads"
        or not parts[4].endswith(".json")
    ):
        raise GarupaR2Error(f"invalid Garupa upload checkpoint key: {key}")
    server = _server(parts[1])
    snapshot_id = _snapshot_id(parts[3])
    shard = parts[4].removesuffix(".json")
    if not SHARD_PATTERN.fullmatch(shard):
        raise GarupaR2Error(f"invalid Garupa upload checkpoint key: {key}")
    if key != upload_checkpoint_key(server, snapshot_id, shard):
        raise GarupaR2Error(f"non-canonical Garupa upload checkpoint key: {key}")
    return server, snapshot_id, shard


def validate_upload_checkpoint(
    value: object,
    key: str,
) -> tuple[str, list[str], datetime]:
    server, snapshot_id, shard = validate_upload_checkpoint_key(key)
    if not isinstance(value, dict) or set(value) != {
        "schema",
        "server",
        "snapshotId",
        "state",
        "updatedAt",
        "shard",
        "objects",
    }:
        raise GarupaR2Error(f"invalid Garupa upload checkpoint: {key}")
    state = value.get("state")
    if (
        value.get("schema") != UPLOAD_CHECKPOINT_SCHEMA
        or value.get("server") != server
        or value.get("snapshotId") != snapshot_id
        or value.get("shard") != shard
        or state not in {"uploading", "completed"}
    ):
        raise GarupaR2Error(f"invalid Garupa upload checkpoint identity: {key}")
    raw_updated_at = value.get("updatedAt")
    try:
        updated_at = datetime.fromisoformat(str(raw_updated_at))
    except ValueError as error:
        raise GarupaR2Error(
            f"invalid Garupa upload checkpoint timestamp: {key}"
        ) from error
    if updated_at.tzinfo is None or updated_at.utcoffset() != timedelta(0):
        raise GarupaR2Error(
            f"Garupa upload checkpoint timestamp must be UTC: {key}"
        )
    objects = value.get("objects")
    if (
        not isinstance(objects, list)
        or not objects
        or any(not isinstance(digest, str) for digest in objects)
        or objects != sorted(set(objects))
    ):
        raise GarupaR2Error(f"invalid Garupa upload checkpoint objects: {key}")
    validated: list[str] = []
    for digest in objects:
        digest = _sha256(digest)
        if digest[:2] != shard:
            raise GarupaR2Error(
                f"Garupa upload checkpoint object is in the wrong shard: {key}"
            )
        validated.append(digest)
    return str(state), validated, updated_at


def _snapshot_manifest_identity_from_key(key: str) -> tuple[str, str]:
    parts = key.split("/")
    if (
        len(parts) != 5
        or parts[0] != NAMESPACE_PREFIX
        or parts[2] != "snapshots"
        or parts[4] != "manifest.json"
    ):
        raise GarupaR2Error(f"invalid Garupa snapshot manifest key: {key}")
    server = _server(parts[1])
    snapshot_id = _snapshot_id(parts[3])
    if key != snapshot_manifest_key(server, snapshot_id):
        raise GarupaR2Error(f"non-canonical Garupa snapshot manifest key: {key}")
    return server, snapshot_id


def garupa_gc_roots(
    store: R2StoreLike,
    *,
    server: str | None = None,
) -> tuple[set[str], set[str], dict[str, str]]:
    """Return strict live CAS roots, manifests, and upload checkpoint states.

    Unknown metadata within the reserved namespace fails closed.  A namespace
    that has no published snapshot is valid, including an interrupted
    first-time upload protected only by checkpoints.
    """

    selected_server = _server(server) if server is not None else None
    prefix = (
        f"{namespace_prefix(selected_server)}/"
        if selected_server is not None
        else f"{NAMESPACE_PREFIX}/"
    )
    keys = sorted(
        str(item.get("Key") or "")
        for item in store.iter_keys(prefix)
    )
    live: set[str] = set()
    manifests: set[str] = set()
    checkpoint_states: dict[str, str] = {}
    pointers: dict[str, dict[str, Any]] = {}
    server_manifests: dict[str, set[str]] = defaultdict(set)
    namespace_servers: set[str] = set()

    for key in keys:
        parts = key.split("/")
        if len(parts) < 3 or parts[0] != NAMESPACE_PREFIX:
            raise GarupaR2Error(f"invalid key in Garupa namespace: {key}")
        key_server = _server(parts[1])
        namespace_servers.add(key_server)
        if selected_server is not None and key_server != selected_server:
            raise GarupaR2Error(f"cross-server key in Garupa namespace scan: {key}")
        if key == pointer_key(key_server):
            pointer = validate_pointer(store.get_json(key), key_server)
            if key_server in pointers:
                raise GarupaR2Error(f"duplicate Garupa pointer for {key_server}")
            pointers[key_server] = pointer
            continue
        if "/snapshots/" in key:
            manifest_server, snapshot_id = _snapshot_manifest_identity_from_key(key)
            manifest = store.get_json(key)
            entries = validate_snapshot_manifest(
                manifest,
                manifest_server,
                snapshot_id,
            )
            manifests.add(key)
            server_manifests[manifest_server].add(key)
            live.update(_shared_cas_key(entry["sha256"]) for entry in entries)
            continue
        if "/uploads/" in key:
            checkpoint_server, _, _ = validate_upload_checkpoint_key(key)
            if checkpoint_server != key_server:
                raise GarupaR2Error(f"Garupa upload checkpoint server mismatch: {key}")
            state, objects, _ = validate_upload_checkpoint(store.get_json(key), key)
            checkpoint_states[key] = state
            live.update(_shared_cas_key(digest) for digest in objects)
            continue
        raise GarupaR2Error(f"unknown key in Garupa namespace: {key}")

    for key_server in namespace_servers:
        published = server_manifests.get(key_server, set())
        pointer = pointers.get(key_server)
        if published and pointer is None:
            raise GarupaR2Error(
                f"Garupa snapshots exist without a current pointer: {key_server}"
            )
        if pointer is not None and pointer["manifest"] not in published:
            raise GarupaR2Error(
                f"Garupa current pointer selects a missing snapshot: {key_server}"
            )
    return live, manifests, checkpoint_states


def _media_type(path: str) -> str:
    suffix = Path(path).suffix.lower()
    explicit = {
        ".bz2": "application/x-bzip2",
        ".cs": "text/plain; charset=utf-8",
        ".encrypted": "application/octet-stream",
        ".json": "application/json; charset=utf-8",
        ".pb": "application/x-protobuf",
        ".sha256": "text/plain; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
    }
    return explicit.get(suffix) or mimetypes.guess_type(path)[0] or "application/octet-stream"


def _walk_root(root: Path, name: str) -> list[Path]:
    if root.is_symlink() or not root.is_dir():
        raise GarupaR2Error(f"Garupa {name} root is not a directory: {root}")
    files: list[Path] = []
    for directory, directory_names, file_names in os.walk(root, followlinks=False):
        current = Path(directory)
        for directory_name in directory_names:
            candidate = current / directory_name
            if candidate.is_symlink():
                raise GarupaR2Error(
                    f"Garupa {name} root contains a symlink: {candidate}"
                )
        for file_name in file_names:
            candidate = current / file_name
            if candidate.is_symlink() or not candidate.is_file():
                raise GarupaR2Error(
                    f"Garupa {name} root contains a non-regular file: {candidate}"
                )
            relative = candidate.relative_to(root).as_posix()
            _relative_path(f"{name}/{relative}")
            files.append(candidate)
    files.sort(key=lambda file: file.relative_to(root).as_posix())
    if not files:
        raise GarupaR2Error(f"Garupa {name} root is empty: {root}")
    return files


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_snapshot_manifest(
    archive_root: Path,
    schema_root: Path,
    projections_root: Path,
    *,
    server: str = DEFAULT_SERVER,
) -> tuple[dict[str, Any], dict[str, Path]]:
    """Describe the three exact input trees without changing their bytes."""

    server = _server(server)
    roots_by_name = {
        "archive": archive_root,
        "schema": schema_root,
        "projections": projections_root,
    }
    required = {
        "archive": {
            "manifest.json",
            "application/response.encrypted",
            "application/response.pb",
            "application/response.json",
            "suite/response.encrypted",
            "suite/response.bz2",
            "suite/response.pb",
            "suite/tables.json",
            "suite/schema-coverage.json",
        },
        "schema": {
            "schema.json",
        },
        "projections": {
            "manifest.json",
            "bands.json",
            "songs.json",
            "stage-challenges.json",
            "playlists.json",
        },
    }
    entries: list[dict[str, Any]] = []
    sources: dict[str, Path] = {}
    root_descriptors: dict[str, dict[str, Any]] = {}
    for root_name in ROOT_NAMES:
        root = roots_by_name[root_name]
        files = _walk_root(root, root_name)
        relative_files = {
            file.relative_to(root).as_posix()
            for file in files
        }
        missing = sorted(required[root_name] - relative_files)
        if missing:
            raise GarupaR2Error(
                f"Garupa {root_name} root is missing required files: {missing}"
            )
        if root_name == "archive":
            if not any(
                path.startswith("suite/tables/") and path.endswith(".pb")
                for path in relative_files
            ):
                raise GarupaR2Error(
                    "Garupa archive root has no per-table protobuf files"
                )
            if not any(
                path.startswith("suite/decoded/") and path.endswith(".json")
                for path in relative_files
            ):
                raise GarupaR2Error(
                    "Garupa archive root has no decoded table files"
                )
        if root_name == "projections" and relative_files != required[root_name]:
            unexpected = sorted(relative_files - required[root_name])
            raise GarupaR2Error(
                f"Garupa projections root has unexpected files: {unexpected}"
            )
        root_total = 0
        for file in files:
            relative = file.relative_to(root).as_posix()
            logical_path = f"{root_name}/{relative}"
            byte_count = file.stat().st_size
            entry = {
                "root": root_name,
                "path": logical_path,
                "bytes": byte_count,
                "sha256": _file_sha256(file),
                "mediaType": _media_type(logical_path),
            }
            entries.append(entry)
            sources[logical_path] = file
            root_total += byte_count
        root_descriptors[root_name] = {
            "prefix": f"{root_name}/",
            "entryCount": len(files),
            "totalBytes": root_total,
        }
    entries.sort(key=lambda item: item["path"])
    manifest: dict[str, Any] = {
        "schema": SNAPSHOT_SCHEMA,
        "server": server,
        "snapshotId": "",
        "storage": {"schema": CAS_STORAGE_SCHEMA, "prefix": CAS_PREFIX},
        "roots": root_descriptors,
        "web": dict(WEB_PATHS),
        "files": entries,
        "entryCount": len(entries),
        "totalBytes": sum(entry["bytes"] for entry in entries),
    }
    manifest["snapshotId"] = _expected_snapshot_id(manifest)
    validate_snapshot_manifest(manifest, server, manifest["snapshotId"])
    return manifest, sources


def _verify_remote_object(
    store: R2StoreLike,
    digest: str,
    expected_bytes: int,
) -> None:
    key = _shared_cas_key(digest)
    metadata = store.head(key)
    if (
        metadata is None
        or metadata.get("ContentLength") != expected_bytes
        or not isinstance(metadata.get("Metadata"), dict)
        or metadata["Metadata"].get("sha256") != digest
    ):
        raise GarupaR2Error(f"Garupa CAS metadata is invalid: {key}")
    body = store.get_bytes(key)
    if (
        body is None
        or len(body) != expected_bytes
        or hashlib.sha256(body).hexdigest() != digest
    ):
        raise GarupaR2Error(f"Garupa CAS content is invalid: {key}")


def _publish_cas(
    store: R2StoreLike,
    manifest: dict[str, Any],
    sources: dict[str, Path],
) -> dict[str, int]:
    unique: dict[str, tuple[dict[str, Any], Path]] = {}
    for entry in manifest["files"]:
        digest = str(entry["sha256"])
        existing = unique.get(digest)
        if existing is not None and existing[0]["bytes"] != entry["bytes"]:
            raise GarupaR2Error(f"Garupa digest has conflicting sizes: {digest}")
        unique.setdefault(digest, (entry, sources[entry["path"]]))

    def publish_one(digest: str) -> tuple[int, int, int]:
        entry, source = unique[digest]
        if store.head(_shared_cas_key(digest)) is None:
            store.upload_cas(source, digest, str(entry["mediaType"]))
            return 1, int(entry["bytes"]), 0
        return 0, 0, 1

    workers = min(
        max(1, int(getattr(store, "concurrency", 1))),
        max(1, len(unique)),
    )
    with ThreadPoolExecutor(max_workers=workers) as executor:
        results = list(executor.map(publish_one, sorted(unique)))
    return {
        "uploadedObjects": sum(result[0] for result in results),
        "uploadedBytes": sum(result[1] for result in results),
        "reusedObjects": sum(result[2] for result in results),
    }


def publish_snapshot(
    store: R2StoreLike,
    archive_root: Path,
    schema_root: Path,
    projections_root: Path,
    *,
    server: str = DEFAULT_SERVER,
) -> dict[str, Any]:
    """Publish one exact snapshot, changing visibility only in the last write."""

    manifest, sources = build_snapshot_manifest(
        archive_root,
        schema_root,
        projections_root,
        server=server,
    )
    server = str(manifest["server"])
    snapshot_id = str(manifest["snapshotId"])
    current_key = pointer_key(server)

    transfer = _publish_cas(store, manifest, sources)

    manifest_key = snapshot_manifest_key(server, snapshot_id)
    existing_manifest = store.get_json(manifest_key)
    if existing_manifest is None:
        store.put_json(manifest_key, manifest, IMMUTABLE_CACHE)
    else:
        validate_snapshot_manifest(existing_manifest, server, snapshot_id)
        if existing_manifest != manifest:
            raise GarupaR2Error(
                f"immutable Garupa snapshot manifest differs: {manifest_key}"
            )
    current_value = store.get_json(current_key)
    current = (
        None
        if current_value is None
        else validate_pointer(current_value, server)
    )
    pointer = {
        "schema": POINTER_SCHEMA,
        "server": server,
        "snapshotId": snapshot_id,
        "manifest": manifest_key,
    }
    changed = current != pointer
    if changed:
        # This remains the final write, so any earlier failure leaves the
        # currently visible snapshot untouched.
        store.put_json(current_key, pointer, POINTER_CACHE)
    return {
        **pointer,
        "changed": changed,
        "entryCount": manifest["entryCount"],
        "totalBytes": manifest["totalBytes"],
        "transfer": transfer,
    }


def verify_snapshot(
    store: R2StoreLike,
    *,
    server: str = DEFAULT_SERVER,
    snapshot_id: str | None = None,
    check_objects: bool = True,
) -> dict[str, Any]:
    server = _server(server)
    pointer = validate_pointer(store.get_json(pointer_key(server)), server)
    selected_snapshot_id = str(pointer["snapshotId"])
    if snapshot_id is not None and _snapshot_id(snapshot_id) != selected_snapshot_id:
        raise GarupaR2Error(
            "Garupa current pointer does not select the expected snapshot"
        )
    snapshot_id = selected_snapshot_id
    key = str(pointer["manifest"])
    manifest = store.get_json(key)
    entries = validate_snapshot_manifest(manifest, server, snapshot_id)
    unique: dict[str, int] = {}
    for entry in entries:
        digest = str(entry["sha256"])
        expected_bytes = int(entry["bytes"])
        if digest in unique and unique[digest] != expected_bytes:
            raise GarupaR2Error(f"Garupa digest has conflicting sizes: {digest}")
        unique[digest] = expected_bytes
    if check_objects:
        for digest, expected_bytes in sorted(unique.items()):
            _verify_remote_object(store, digest, expected_bytes)
    return {
        "schema": "haneoka-garupa-master-verification-v1",
        "server": server,
        "snapshotId": snapshot_id,
        "entryCount": len(entries),
        "uniqueObjectCount": len(unique),
        "objectsChecked": len(unique) if check_objects else 0,
    }


def prune_snapshots(
    store: R2StoreLike,
    *,
    server: str = DEFAULT_SERVER,
    retain: int = 3,
    stale_uploading_age_hours: int = 168,
) -> dict[str, Any]:
    """Retain current plus recent snapshots and conservatively prune uploads."""

    server = _server(server)
    if not isinstance(retain, int) or isinstance(retain, bool) or retain < 1:
        raise GarupaR2Error("Garupa snapshot retention must be at least one")
    if (
        not isinstance(stale_uploading_age_hours, int)
        or isinstance(stale_uploading_age_hours, bool)
        or stale_uploading_age_hours < 24
    ):
        raise GarupaR2Error(
            "Garupa stale upload checkpoint age must be at least 24 hours"
        )

    _, manifest_keys, checkpoint_states = garupa_gc_roots(store, server=server)
    current_value = store.get_json(pointer_key(server))
    if not manifest_keys and current_value is None:
        # Safe before the first successful publication.  Incomplete upload
        # checkpoints remain GC roots and are handled by their stale cutoff.
        current_snapshot_id: str | None = None
    else:
        pointer = validate_pointer(current_value, server)
        current_snapshot_id = str(pointer["snapshotId"])

    candidates: list[tuple[str, str, float]] = []
    for key in sorted(manifest_keys):
        manifest_server, snapshot_id = _snapshot_manifest_identity_from_key(key)
        if manifest_server != server:
            raise GarupaR2Error(f"cross-server Garupa manifest during prune: {key}")
        metadata = store.head(key)
        modified = metadata.get("LastModified") if metadata else None
        if not isinstance(modified, datetime):
            raise GarupaR2Error(
                f"Garupa snapshot manifest has no modification time: {key}"
            )
        candidates.append((snapshot_id, key, modified.timestamp()))
    if current_snapshot_id is not None and all(
        snapshot_id != current_snapshot_id
        for snapshot_id, _, _ in candidates
    ):
        raise GarupaR2Error("Garupa current snapshot manifest is missing")

    keep: set[str] = (
        {current_snapshot_id}
        if current_snapshot_id is not None
        else set()
    )
    previous = sorted(
        (
            candidate
            for candidate in candidates
            if candidate[0] != current_snapshot_id
        ),
        key=lambda item: (item[2], item[0]),
        reverse=True,
    )
    keep.update(
        snapshot_id
        for snapshot_id, _, _ in previous[: max(0, retain - len(keep))]
    )
    deleted_snapshots: dict[str, int] = {}
    for snapshot_id, _, _ in candidates:
        if snapshot_id not in keep:
            deleted_snapshots[snapshot_id] = store.delete_prefix(
                f"{snapshot_prefix(server, snapshot_id)}/"
            )

    cutoff = datetime.now(timezone.utc) - timedelta(
        hours=stale_uploading_age_hours
    )
    checkpoint_deletions: list[str] = []
    retained_uploading: list[str] = []
    for key, state in sorted(checkpoint_states.items()):
        _, snapshot_id, _ = validate_upload_checkpoint_key(key)
        _, _, updated_at = validate_upload_checkpoint(store.get_json(key), key)
        manifest_existed = any(
            candidate_snapshot_id == snapshot_id
            for candidate_snapshot_id, _, _ in candidates
        )
        if state == "completed" and (
            manifest_existed or updated_at <= cutoff
        ):
            checkpoint_deletions.append(key)
        elif state == "uploading" and updated_at <= cutoff:
            checkpoint_deletions.append(key)
        else:
            retained_uploading.append(key)
    deleted_checkpoints = (
        store.delete_keys(checkpoint_deletions)
        if checkpoint_deletions
        else 0
    )
    return {
        "schema": "haneoka-garupa-master-prune-v1",
        "server": server,
        "currentSnapshotId": current_snapshot_id,
        "retainedSnapshotIds": sorted(keep),
        "deletedSnapshots": deleted_snapshots,
        "deletedSnapshotMetadataObjects": sum(deleted_snapshots.values()),
        "deletedUploadCheckpoints": deleted_checkpoints,
        "retainedUploadingCheckpoints": retained_uploading,
        "staleUploadingAgeHours": stale_uploading_age_hours,
    }
