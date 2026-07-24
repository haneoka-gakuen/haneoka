from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Protocol

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import ClientError

from core.config import ServerConfig, validate_server_id
from core.contracts import (
    PACKAGE_MAX_BYTES,
    POINTER_SCHEMA,
    RELEASE_SCHEMA,
    RELEASE_TREES,
)
from core.hashes import sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import (
    release_layout,
    safe_id,
    source_layout,
    validate_release_path,
)
from core.storage import (
    CAS_PREFIX,
    RELEASE_INDEX_ALGORITHM,
    RELEASE_INDEX_SHARDS,
    cas_key,
    parse_cas_key,
    release_index_key,
    release_index_prefix,
    release_index_shard,
)
from verify.source import validate_source_manifest


IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
POINTER_CACHE = "public, max-age=30, must-revalidate"
UPLOAD_CHECKPOINT_CACHE = "private, no-store"
RELEASE_ID = re.compile(r"^r-[a-f0-9]{20}$")
PACKAGE_LEASE_PREFIX = "private/v1/package-leases"
PACKAGE_LEASE_SCHEMA = "haneoka-r2-package-lease-v1"
UPLOAD_CHECKPOINT_SCHEMA_V1 = "haneoka-r2-upload-checkpoint-v1"
UPLOAD_CHECKPOINT_SCHEMA_V2 = "haneoka-r2-upload-checkpoint-v2"
UPLOAD_CHECKPOINT_SCHEMA = "haneoka-r2-upload-checkpoint-v3"
STREAM_CHUNK_BYTES = 1024 * 1024


class R2BucketConfig(Protocol):
    """Minimum configuration needed to connect an :class:`R2Store`."""

    r2_bucket: str


class R2Store:
    def __init__(self, config: R2BucketConfig, concurrency: int = 64):
        account_id = os.environ.get("R2_ACCOUNT_ID") or os.environ.get(
            "CLOUDFLARE_ACCOUNT_ID"
        )
        endpoint = os.environ.get("R2_ENDPOINT") or (
            f"https://{account_id}.r2.cloudflarestorage.com" if account_id else ""
        )
        if not endpoint:
            raise ValueError("set R2_ENDPOINT or CLOUDFLARE_ACCOUNT_ID")
        profile = os.environ.get("R2_AWS_PROFILE") or os.environ.get("AWS_PROFILE")
        session = boto3.Session(profile_name=profile) if profile else boto3.Session()
        self.bucket = str(os.environ.get("R2_BUCKET") or config.r2_bucket).strip()
        if not self.bucket:
            raise ValueError("set R2_BUCKET or configure r2_bucket")
        self.concurrency = max(1, concurrency)
        self.client = session.client(
            "s3",
            endpoint_url=endpoint,
            region_name="auto",
            config=Config(
                retries={"max_attempts": 8, "mode": "standard"},
                signature_version="s3v4",
                max_pool_connections=max(16, self.concurrency * 2),
                connect_timeout=10,
                read_timeout=120,
                tcp_keepalive=True,
            ),
        )
        self.transfer = TransferConfig(
            multipart_threshold=64 * 1024 * 1024,
            multipart_chunksize=64 * 1024 * 1024,
            max_concurrency=min(self.concurrency, 8),
            use_threads=True,
        )

    def head(self, key: str) -> dict[str, Any] | None:
        try:
            return self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
                return None
            raise

    def upload_cas(
        self,
        file: Path,
        digest: str,
        content_type: str,
    ) -> None:
        """Write one immutable CAS object without a latency-heavy HEAD first."""

        key = cas_key(digest)
        size = file.stat().st_size
        extra = {
            "ContentType": content_type,
            "CacheControl": IMMUTABLE_CACHE,
            "Metadata": {"sha256": digest},
        }
        if size < self.transfer.multipart_threshold:
            with file.open("rb") as body:
                self.client.put_object(
                    Bucket=self.bucket,
                    Key=key,
                    Body=body,
                    ContentLength=size,
                    **extra,
                )
            return
        self.client.upload_file(
            str(file),
            self.bucket,
            key,
            ExtraArgs=extra,
            Config=self.transfer,
        )

    def put_json(self, key: str, value: Any, cache_control: str) -> None:
        body = stable_json(value).encode()
        digest = hashlib.sha256(body).hexdigest()
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=body,
            ContentLength=len(body),
            ContentType="application/json; charset=utf-8",
            CacheControl=cache_control,
            Metadata={"sha256": digest},
        )

    def get_bytes(self, key: str) -> bytes | None:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
                return None
            raise
        body = response["Body"]
        try:
            return body.read()
        finally:
            body.close()

    def get_json(self, key: str) -> Any | None:
        body = self.get_bytes(key)
        if body is None:
            return None
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"R2 object is not valid JSON: {key}") from error

    def download_file(
        self,
        key: str,
        file: Path,
        *,
        expected_bytes: int | None = None,
        expected_sha256: str | None = None,
    ) -> int:
        if expected_bytes is not None and expected_bytes < 0:
            raise ValueError("expected_bytes must be non-negative")
        file.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        body: Any | None = None
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
            declared_size = response.get("ContentLength")
            body = response["Body"]
            if isinstance(declared_size, int):
                if expected_bytes is not None and declared_size != expected_bytes:
                    raise ValueError(
                        f"R2 object size differs from its manifest: {key}: "
                        f"{declared_size} != {expected_bytes}"
                    )
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{file.name}.",
                suffix=".part",
                dir=file.parent,
                delete=False,
            ) as output:
                temporary = Path(output.name)
                copied = 0
                for chunk in iter(lambda: body.read(STREAM_CHUNK_BYTES), b""):
                    copied += len(chunk)
                    if expected_bytes is not None and copied > expected_bytes:
                        raise ValueError(
                            f"R2 object size differs from its manifest: {key}: "
                            f"received more than {expected_bytes} bytes"
                        )
                    output.write(chunk)
            if expected_bytes is not None and copied != expected_bytes:
                raise ValueError(
                    f"R2 object size differs from its manifest: {key}: "
                    f"{copied} != {expected_bytes}"
                )
            if (
                expected_sha256 is not None
                and sha256_file(temporary) != expected_sha256
            ):
                raise ValueError(f"R2 object hash differs from its manifest: {key}")
            os.replace(temporary, file)
            temporary = None
            return copied
        finally:
            try:
                if body is not None:
                    body.close()
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)

    def iter_keys(self, prefix: str) -> Iterable[dict[str, Any]]:
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            yield from page.get("Contents", [])

    def iter_prefixes(self, prefix: str) -> Iterable[str]:
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(
            Bucket=self.bucket, Prefix=prefix, Delimiter="/"
        ):
            for value in page.get("CommonPrefixes", []):
                candidate = value.get("Prefix")
                if isinstance(candidate, str):
                    yield candidate

    def delete_prefix(self, prefix: str) -> int:
        count = 0
        batch: list[dict[str, str]] = []
        for item in self.iter_keys(prefix):
            batch.append({"Key": item["Key"]})
            if len(batch) == 1000:
                self.client.delete_objects(
                    Bucket=self.bucket, Delete={"Objects": batch, "Quiet": True}
                )
                count += len(batch)
                batch = []
        if batch:
            self.client.delete_objects(
                Bucket=self.bucket, Delete={"Objects": batch, "Quiet": True}
            )
            count += len(batch)
        return count

    def delete_keys(self, keys: Iterable[str]) -> int:
        count = 0
        batch: list[dict[str, str]] = []
        for key in keys:
            batch.append({"Key": key})
            if len(batch) == 1000:
                self.client.delete_objects(
                    Bucket=self.bucket, Delete={"Objects": batch, "Quiet": True}
                )
                count += len(batch)
                batch = []
        if batch:
            self.client.delete_objects(
                Bucket=self.bucket, Delete={"Objects": batch, "Quiet": True}
            )
            count += len(batch)
        return count


def fetch_package_artifact(store: R2Store, key: str, output: Path) -> dict[str, Any]:
    try:
        expected = parse_cas_key(key)
    except ValueError as error:
        raise ValueError(f"invalid package CAS key: {key}") from error
    metadata = store.head(key)
    declared_bytes = metadata.get("ContentLength") if metadata else None
    if (
        not isinstance(declared_bytes, int)
        or isinstance(declared_bytes, bool)
        or declared_bytes < 1
    ):
        raise FileNotFoundError(f"package CAS object is missing or empty: {key}")
    if declared_bytes > PACKAGE_MAX_BYTES:
        raise ValueError(
            f"package CAS object exceeds the {PACKAGE_MAX_BYTES}-byte package limit: "
            f"{declared_bytes}"
        )
    size = store.download_file(
        key,
        output,
        expected_bytes=declared_bytes,
    )
    return {
        "schema": "haneoka-package-fetch-v1",
        "key": key,
        "bytes": size,
        "sha256": expected,
    }


def _current_pointer(store: R2Store, config: ServerConfig) -> dict[str, Any] | None:
    pointer = store.get_json(f"servers/{config.id}/current.json")
    if pointer is None:
        return None
    release_id = pointer.get("releaseId") if isinstance(pointer, dict) else None
    source_id = pointer.get("sourceId") if isinstance(pointer, dict) else None
    release_id = release_id if isinstance(release_id, str) else ""
    source_id = source_id if isinstance(source_id, str) else ""
    try:
        source_id_is_valid = safe_id(source_id, "source id") == source_id
    except ValueError:
        source_id_is_valid = False
    expected_manifest = f"servers/{config.id}/releases/{release_id}/release.json"
    expected_index = {
        "algorithm": RELEASE_INDEX_ALGORITHM,
        "shards": RELEASE_INDEX_SHARDS,
        "prefix": release_index_prefix(config.id, release_id),
    }
    if (
        not isinstance(pointer, dict)
        or pointer.get("schema") != POINTER_SCHEMA
        or pointer.get("server") != config.id
        or not RELEASE_ID.fullmatch(release_id)
        or not source_id_is_valid
        or pointer.get("releaseManifest") != expected_manifest
        or pointer.get("releaseIndex") != expected_index
    ):
        raise ValueError(f"invalid current R2 pointer for {config.id}")
    return pointer


def _current_release_manifest(
    store: R2Store, config: ServerConfig
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    pointer = _current_pointer(store, config)
    if pointer is None:
        return None, None
    key = pointer.get("releaseManifest")
    manifest = (
        store.get_json(key)
        if isinstance(key, str) and key
        else None
    )
    if not isinstance(manifest, dict) or manifest.get("releaseId") != pointer.get(
        "releaseId"
    ):
        return pointer, None
    return pointer, manifest


def current_release_document(
    store: R2Store,
    config: ServerConfig,
    path: str,
) -> dict[str, Any] | None:
    """Load one JSON document and the path index from the selected immutable release."""

    pointer, manifest = _current_release_manifest(store, config)
    if not isinstance(pointer, dict) or not isinstance(manifest, dict):
        return None
    entries: dict[str, dict[str, Any]] = {}
    for value in manifest.get("entries", []):
        if not isinstance(value, dict):
            raise ValueError("current release manifest contains a non-object entry")
        relative = str(value.get("path") or "")
        if not relative or relative in entries:
            raise ValueError(
                f"current release manifest contains an invalid or repeated path: {relative!r}"
            )
        entries[relative] = value
    entry = entries.get(path)
    if entry is None:
        return None
    digest = str(entry.get("sha256") or "")
    declared_bytes = entry.get("bytes")
    if (
        not isinstance(declared_bytes, int)
        or isinstance(declared_bytes, bool)
        or declared_bytes < 0
    ):
        raise ValueError(f"current release document has an invalid byte count: {path}")
    body = store.get_bytes(cas_key(digest))
    if body is None:
        raise FileNotFoundError(
            f"current release document CAS object is missing: {path}"
        )
    if (
        len(body) != int(entry.get("bytes") or -1)
        or hashlib.sha256(body).hexdigest() != digest
    ):
        raise ValueError(f"current release document CAS object is invalid: {path}")
    try:
        document = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(
            f"current release document is not valid JSON: {path}"
        ) from error
    if not isinstance(document, dict):
        raise ValueError(f"current release document must be a JSON object: {path}")
    return {
        "releaseId": pointer["releaseId"],
        "document": document,
        "entries": entries,
    }


def restore_release_object(
    store: R2Store,
    snapshot: dict[str, Any],
    record: dict[str, Any],
    target: Path,
) -> None:
    """Restore one record only when it is declared exactly by the selected release."""

    path = str(record.get("path") or "")
    entries = snapshot.get("entries")
    entry = entries.get(path) if isinstance(entries, dict) else None
    digest = str(record.get("sha256") or "")
    size = int(record.get("bytes") or -1)
    if (
        not isinstance(entry, dict)
        or entry.get("sha256") != digest
        or int(entry.get("bytes") or -1) != size
    ):
        raise ValueError(
            f"current release does not declare the reusable object exactly: {path}"
        )
    store.download_file(
        cas_key(digest),
        target,
        expected_bytes=size,
    )


def _upload_checkpoint_identity(key: str) -> tuple[str, str, str, str]:
    parts = key.split("/")
    if (
        len(parts) != 6
        or parts[0] != "servers"
        or parts[2] != "uploads"
        or parts[3] not in {"sources", "releases"}
        or not parts[5].endswith(".json")
    ):
        raise ValueError(f"invalid upload checkpoint key: {key}")
    try:
        server = validate_server_id(parts[1])
        identity = safe_id(parts[4], "upload identity")
    except ValueError as error:
        raise ValueError(f"invalid upload checkpoint key: {key}") from error
    if parts[3] == "releases" and not RELEASE_ID.fullmatch(identity):
        raise ValueError(f"invalid upload checkpoint key: {key}")
    shard = parts[5].removesuffix(".json")
    if not re.fullmatch(r"[a-f0-9]{2}", shard):
        raise ValueError(f"invalid upload checkpoint key: {key}")
    return server, parts[3], identity, shard


def _validate_upload_checkpoint(
    checkpoint: object,
    key: str,
) -> tuple[str, list[str], datetime | None]:
    _, _, _, key_shard = _upload_checkpoint_identity(key)
    if not isinstance(checkpoint, dict):
        raise ValueError(f"invalid upload checkpoint: {key}")
    schema = checkpoint.get("schema")
    if schema == UPLOAD_CHECKPOINT_SCHEMA_V1:
        expected_fields = {"schema", "shard", "objects"}
        state = "completed"
        updated_at = None
    elif schema == UPLOAD_CHECKPOINT_SCHEMA_V2:
        expected_fields = {"schema", "state", "shard", "objects"}
        state = checkpoint.get("state")
        if state not in {"uploading", "completed"}:
            raise ValueError(f"invalid upload checkpoint state: {key}")
        updated_at = None
    elif schema == UPLOAD_CHECKPOINT_SCHEMA:
        expected_fields = {"schema", "state", "updatedAt", "shard", "objects"}
        state = checkpoint.get("state")
        if state not in {"uploading", "completed"}:
            raise ValueError(f"invalid upload checkpoint state: {key}")
        raw_updated_at = checkpoint.get("updatedAt")
        try:
            updated_at = datetime.fromisoformat(raw_updated_at)
        except (TypeError, ValueError) as error:
            raise ValueError(f"invalid upload checkpoint timestamp: {key}") from error
        if updated_at.tzinfo is None or updated_at.utcoffset() != timedelta(0):
            raise ValueError(f"upload checkpoint timestamp must be UTC: {key}")
    else:
        raise ValueError(f"invalid upload checkpoint schema: {key}")
    if set(checkpoint) != expected_fields or checkpoint.get("shard") != key_shard:
        raise ValueError(f"invalid upload checkpoint structure: {key}")
    objects = checkpoint.get("objects")
    if (
        not isinstance(objects, list)
        or not objects
        or any(not isinstance(digest, str) for digest in objects)
        or objects != sorted(set(objects))
    ):
        raise ValueError(f"invalid upload checkpoint objects: {key}")
    for digest in objects:
        if digest[:2] != key_shard:
            raise ValueError(f"upload checkpoint object is in the wrong shard: {key}")
        try:
            cas_key(digest)
        except ValueError as error:
            raise ValueError(f"invalid digest referenced by {key}: {digest}") from error
    return state, objects, updated_at


def _upload_cas_delta(
    store: R2Store,
    items: Iterable[tuple[str, Path, str]],
) -> dict[str, int]:
    groups: dict[str, list[tuple[str, Path, str]]] = defaultdict(list)
    for digest, file, content_type in items:
        groups[digest[:2]].append((digest, file, content_type))

    def upload_group(
        item: tuple[str, list[tuple[str, Path, str]]],
    ) -> tuple[int, int, int]:
        _, values = item
        values.sort(key=lambda value: value[0])
        uploaded_bytes = 0
        for digest, file, content_type in values:
            store.upload_cas(file, digest, content_type)
            uploaded_bytes += file.stat().st_size
        return len(values), 0, uploaded_bytes

    with ThreadPoolExecutor(
        max_workers=min(store.concurrency, max(1, len(groups)))
    ) as executor:
        results = list(executor.map(upload_group, sorted(groups.items())))
    return {
        "uploadedObjects": sum(value[0] for value in results),
        "resumedObjects": sum(value[1] for value in results),
        "uploadedBytes": sum(value[2] for value in results),
    }


def publish_source(
    store: R2Store, config: ServerConfig, source_id: str
) -> dict[str, Any]:
    layout = source_layout(config.id, source_id)
    local_manifest = read_json(layout.manifest)
    manifest = {
        **local_manifest,
        "storage": {"schema": "haneoka-r2-cas-v1", "prefix": CAS_PREFIX},
    }
    manifest_key = f"servers/{config.id}/sources/{source_id}/source.json"
    existing_manifest = store.get_json(manifest_key)
    if existing_manifest == manifest:
        unique = {str(item["sha256"]) for item in manifest.get("files", [])}
        released_leases = _release_source_package_lease(store, config, manifest)
        return {
            "server": config.id,
            "sourceId": source_id,
            "uploadedObjects": 0,
            "resumedObjects": 0,
            "uploadedBytes": 0,
            "reusedObjects": len(unique),
            "releasedPackageLeases": released_leases,
        }

    pointer = _current_pointer(store, config)
    previous_source_id = str((pointer or {}).get("sourceId") or "")
    previous_source = (
        store.get_json(
            f"servers/{config.id}/sources/{previous_source_id}/source.json",
        )
        if previous_source_id and previous_source_id != source_id
        else None
    )
    reusable = (
        {
            str(item.get("sha256"))
            for item in (previous_source or {}).get("files", [])
            if isinstance(item, dict)
        }
        if (previous_source or {}).get("storage")
        == {"schema": "haneoka-r2-cas-v1", "prefix": CAS_PREFIX}
        else set()
    )
    artifacts: dict[str, dict[str, Any]] = {}
    for artifact in manifest.get("files", []):
        digest = str(artifact["sha256"])
        artifacts.setdefault(digest, artifact)
    pending = [
        (digest, layout.root / artifact["path"], "application/octet-stream")
        for digest, artifact in artifacts.items()
        if digest not in reusable
    ]
    transfer = _upload_cas_delta(
        store,
        pending,
    )
    store.put_json(manifest_key, manifest, IMMUTABLE_CACHE)
    released_leases = _release_source_package_lease(store, config, manifest)
    return {
        "server": config.id,
        "sourceId": source_id,
        **transfer,
        "reusedObjects": len(artifacts) - len(pending),
        "releasedPackageLeases": released_leases,
    }


def _release_source_package_lease(
    store: R2Store,
    config: ServerConfig,
    manifest: dict[str, Any],
) -> int:
    package = manifest.get("package")
    package_path = package.get("file") if isinstance(package, dict) else None
    package_record = next(
        (
            item
            for item in manifest.get("files", [])
            if isinstance(item, dict)
            and item.get("path") == package_path
            and item.get("role") == "package"
        ),
        None,
    )
    if not isinstance(package_record, dict):
        raise ValueError("source manifest package record is missing")
    digest = package_record.get("sha256")
    key = f"{PACKAGE_LEASE_PREFIX}/{config.id}/{digest}.json"
    return store.delete_keys([key]) if store.head(key) else 0


def _expand_unity_dependencies(
    records: list[dict[str, Any]], selected: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    by_path = {str(record["path"]): record for record in records}
    expanded = {str(record["path"]): record for record in selected}
    pending = list(expanded)
    while pending:
        path = pending.pop()
        record = expanded[path]
        for dependency in (record.get("unity") or {}).get("dependencies", []):
            dependency = str(dependency)
            target = by_path.get(dependency)
            if not target or target.get("role") != "unity-bundle":
                raise ValueError(
                    f"invalid Unity dependency in source manifest: {path} -> {dependency}"
                )
            if dependency not in expanded:
                expanded[dependency] = target
                pending.append(dependency)
    return [expanded[path] for path in sorted(expanded)]


def fetch_source(
    store: R2Store,
    config: ServerConfig,
    source_id: str,
    roles: set[str] | None = None,
    paths: set[str] | None = None,
    shard_index: int | None = None,
    shard_count: int | None = None,
) -> dict[str, Any]:
    key = f"servers/{config.id}/sources/{source_id}/source.json"
    manifest = store.get_json(key)
    try:
        records = validate_source_manifest(
            manifest, config.id, source_id, require_storage=True
        )
    except ValueError as error:
        raise ValueError(
            f"invalid or missing remote source manifest: {key}: {error}"
        ) from error
    layout = source_layout(config.id, source_id)
    layout.root.mkdir(parents=True, exist_ok=True)
    write_json(layout.manifest, manifest, pretty=True)
    selected = []
    for record in records:
        if roles and record.get("role") not in roles:
            continue
        if paths is not None and record.get("path") not in paths:
            continue
        if shard_index is not None:
            if (
                record.get("role") != "unity-bundle"
                or not shard_count
                or not 0 <= shard_index < shard_count
            ):
                continue
            if int(record["sha256"][:16], 16) % shard_count != shard_index:
                continue
        selected.append(record)
    if paths is not None:
        found = {str(record["path"]) for record in selected}
        missing = sorted(paths - found)
        if missing:
            raise ValueError(
                f"source paths are absent from the manifest: {missing[:10]}"
            )
    if shard_index is not None or paths is not None:
        selected = _expand_unity_dependencies(records, selected)
    selected_bytes = sum(int(record["bytes"]) for record in selected)

    def download(record: dict[str, Any]) -> None:
        artifact_key = cas_key(record["sha256"])
        file = layout.root.joinpath(*PurePosixPath(record["path"]).parts)
        if not file.resolve().is_relative_to(layout.root.resolve()):
            raise ValueError(f"source path escapes its layout: {record['path']}")
        declared_bytes = int(record["bytes"])
        store.download_file(
            artifact_key,
            file,
            expected_bytes=declared_bytes,
        )

    with ThreadPoolExecutor(max_workers=store.concurrency) as executor:
        list(executor.map(download, selected))
    return {
        "schema": "haneoka-source-fetch-v1",
        "server": config.id,
        "sourceId": source_id,
        "fileCount": len(selected),
        "fileBytes": selected_bytes,
    }


def publish_release(
    store: R2Store,
    config: ServerConfig,
    release_id: str,
    check_hashes: bool = True,
) -> dict[str, Any]:
    layout = release_layout(config.id, release_id)
    manifest = read_json(layout.manifest)
    prefix = f"servers/{config.id}/releases/{release_id}/"
    pointer_key = f"servers/{config.id}/current.json"
    manifest_key = prefix + "release.json"
    current, previous_manifest = _current_release_manifest(store, config)
    if isinstance(current, dict) and current.get("releaseId") == release_id:
        remote_manifest = store.get_json(manifest_key)
        if remote_manifest != manifest:
            raise ValueError(f"remote release manifest mismatch: {manifest_key}")
        return {
            **current,
            "transfer": {
                "uploadedObjects": 0,
                "resumedObjects": 0,
                "uploadedBytes": 0,
                "reusedObjects": len(
                    {entry["sha256"] for entry in manifest["entries"]}
                ),
                "indexObjects": RELEASE_INDEX_SHARDS,
            },
        }

    previous_digests = {
        str(entry.get("sha256"))
        for entry in (previous_manifest or {}).get("entries", [])
        if isinstance(entry, dict)
    }
    objects: dict[str, dict[str, Any]] = {}
    for entry in manifest["entries"]:
        digest = str(entry["sha256"])
        existing = objects.get(digest)
        if existing and existing["bytes"] != entry["bytes"]:
            raise ValueError(f"release digest has conflicting sizes: {digest}")
        objects.setdefault(digest, entry)
    pending = [
        entry for digest, entry in objects.items() if digest not in previous_digests
    ]
    transfer = _upload_cas_delta(
        store,
        (
            (
                entry["sha256"],
                layout.root.joinpath(*entry["path"].split("/")),
                entry["mediaType"],
            )
            for entry in pending
        ),
    )

    shards: dict[str, dict[str, list[Any]]] = defaultdict(dict)
    for entry in manifest["entries"]:
        shard = release_index_shard(entry["path"])
        shards[shard][entry["path"]] = [
            entry["sha256"],
            entry["bytes"],
            entry["mediaType"],
        ]

    def publish_index(index: int) -> None:
        shard = f"{index:02x}"
        store.put_json(
            release_index_key(config.id, release_id, shard),
            {
                "schema": "haneoka-resource-index-v1",
                "server": config.id,
                "releaseId": release_id,
                "algorithm": RELEASE_INDEX_ALGORITHM,
                "shard": shard,
                "entries": shards.get(shard, {}),
            },
            IMMUTABLE_CACHE,
        )

    with ThreadPoolExecutor(max_workers=store.concurrency) as executor:
        list(executor.map(publish_index, range(RELEASE_INDEX_SHARDS)))
    store.put_json(manifest_key, manifest, IMMUTABLE_CACHE)

    pointer = {
        "schema": POINTER_SCHEMA,
        "server": config.id,
        "sourceId": manifest["sourceId"],
        "releaseId": release_id,
        "releaseManifest": manifest_key,
        "releaseIndex": {
            "algorithm": RELEASE_INDEX_ALGORITHM,
            "shards": RELEASE_INDEX_SHARDS,
            "prefix": release_index_prefix(config.id, release_id),
        },
    }
    store.put_json(pointer_key, pointer, POINTER_CACHE)
    return {
        **pointer,
        "transfer": {
            **transfer,
            "reusedObjects": len(objects) - len(pending),
            "indexObjects": RELEASE_INDEX_SHARDS,
        },
    }


def prune_releases(store: R2Store, config: ServerConfig) -> dict[str, Any]:
    """Retain at most the configured number of releases, including the selected one."""

    pointer = _current_pointer(store, config)
    if pointer is None:
        raise ValueError(
            f"refusing release cleanup: missing current pointer for {config.id}"
        )
    current = str(pointer.get("releaseId") or "")

    root = f"servers/{config.id}/releases/"
    candidates: list[tuple[str, str, float, str]] = []
    incomplete: list[tuple[str, str]] = []
    for prefix in store.iter_prefixes(root):
        release_id = prefix.removeprefix(root).strip("/")
        if not RELEASE_ID.fullmatch(release_id):
            continue
        manifest_key = prefix + "release.json"
        metadata = store.head(manifest_key)
        if metadata is None:
            incomplete.append((release_id, prefix))
            continue
        manifest = store.get_json(manifest_key)
        try:
            _validate_release_manifest_for_gc(
                manifest,
                manifest_key,
                config.id,
                release_id,
            )
        except ValueError as error:
            raise ValueError(
                f"refusing release cleanup: invalid {manifest_key}: {error}"
            ) from error
        modified = metadata.get("LastModified")
        if not hasattr(modified, "timestamp"):
            raise ValueError(
                f"refusing release cleanup: missing modification time for {manifest_key}"
            )
        candidates.append(
            (release_id, prefix, modified.timestamp(), str(manifest["sourceId"]))
        )

    selected = next(
        (candidate for candidate in candidates if candidate[0] == current),
        None,
    )
    if selected is None:
        raise ValueError(
            f"refusing release cleanup: selected release is incomplete: {current}"
        )
    if selected[3] != pointer.get("sourceId"):
        raise ValueError(
            f"refusing release cleanup: selected release source does not match its pointer: {current}"
        )

    keep = {current}
    previous = sorted(
        (
            candidate
            for candidate in candidates
            if candidate[0] != current
        ),
        key=lambda candidate: (candidate[2], candidate[0]),
        reverse=True,
    )
    keep.update(
        release_id
        for release_id, _, _, _ in previous[: max(0, config.release_retention - 1)]
    )

    deleted: dict[str, int] = {}
    for release_id, prefix, _, _ in candidates:
        if release_id not in keep:
            deleted[release_id] = store.delete_prefix(prefix)
    for release_id, prefix in incomplete:
        if release_id == current:
            raise ValueError(
                f"refusing release cleanup: selected release is incomplete: {current}"
            )
        deleted[release_id] = store.delete_prefix(prefix)
    return {
        "schema": "haneoka-r2-release-prune-v1",
        "server": config.id,
        "currentReleaseId": current,
        "retainedReleaseIds": sorted(keep),
        "deletedReleases": deleted,
        "deletedObjects": sum(deleted.values()),
    }


def prune_sources(store: R2Store, config: ServerConfig) -> dict[str, Any]:
    """Retain only source manifests referenced by retained releases."""

    release_root = f"servers/{config.id}/releases/"
    keep: set[str] = set()
    retained_releases: dict[str, str] = {}
    for prefix in store.iter_prefixes(release_root):
        release_id = prefix.removeprefix(release_root).strip("/")
        if not RELEASE_ID.fullmatch(release_id):
            continue
        manifest_key = prefix + "release.json"
        if store.head(manifest_key) is None:
            raise ValueError(
                f"refusing source cleanup: incomplete release prefix: {prefix}"
            )
        manifest = store.get_json(manifest_key)
        try:
            _validate_release_manifest_for_gc(
                manifest,
                manifest_key,
                config.id,
                release_id,
            )
        except ValueError as error:
            raise ValueError(
                f"refusing source cleanup: invalid {manifest_key}: {error}"
            ) from error
        source_id = str(manifest["sourceId"])
        retained_releases[release_id] = source_id
        keep.add(source_id)
    pointer = _current_pointer(store, config)
    if pointer is None:
        raise ValueError(
            f"refusing source cleanup: missing current pointer for {config.id}"
        )
    current = str(pointer["releaseId"])
    if retained_releases.get(current) != pointer.get("sourceId"):
        raise ValueError(
            f"refusing source cleanup: selected release does not match its pointer: {current}"
        )

    for source_id in sorted(keep):
        source_key = f"servers/{config.id}/sources/{source_id}/source.json"
        manifest = store.get_json(source_key)
        try:
            validate_source_manifest(
                manifest,
                config.id,
                source_id,
                require_storage=True,
            )
        except ValueError as error:
            raise ValueError(
                f"refusing source cleanup: invalid {source_key}: {error}"
            ) from error

    source_root = f"servers/{config.id}/sources/"
    deleted: dict[str, int] = {}
    for prefix in store.iter_prefixes(source_root):
        source_id = prefix.removeprefix(source_root).strip("/")
        if source_id and source_id not in keep:
            deleted[source_id] = store.delete_prefix(prefix)
    return {
        "schema": "haneoka-r2-source-prune-v1",
        "server": config.id,
        "retainedSourceIds": sorted(keep),
        "deletedSources": deleted,
        "deletedObjects": sum(deleted.values()),
    }


def prune_upload_checkpoints(
    store: R2Store,
    config: ServerConfig,
    stale_uploading_age_hours: int = 168,
) -> dict[str, Any]:
    if stale_uploading_age_hours < 24:
        raise ValueError("stale uploading checkpoint age must be at least 24 hours")
    prefix = f"servers/{config.id}/uploads/"
    completed: list[str] = []
    uploading: list[str] = []
    stale_uploading: list[str] = []
    legacy_uploading: list[str] = []
    cutoff = datetime.now(timezone.utc) - timedelta(hours=stale_uploading_age_hours)
    for item in store.iter_keys(prefix):
        key = str(item.get("Key") or "")
        if not key.endswith(".json"):
            raise ValueError(f"refusing upload cleanup: invalid checkpoint key: {key}")
        checkpoint = store.get_json(key)
        try:
            state, _, updated_at = _validate_upload_checkpoint(checkpoint, key)
        except ValueError as error:
            raise ValueError(
                f"refusing upload cleanup: invalid checkpoint {key}: {error}"
            ) from error
        if state == "completed":
            completed.append(key)
        elif updated_at is None:
            uploading.append(key)
            legacy_uploading.append(key)
        elif updated_at <= cutoff:
            stale_uploading.append(key)
        else:
            uploading.append(key)
    deleted = store.delete_keys(completed + stale_uploading)
    return {
        "schema": "haneoka-r2-upload-prune-v1",
        "server": config.id,
        "completedCheckpointCount": len(completed),
        "uploadingCheckpointCount": len(uploading),
        "staleUploadingCheckpointCount": len(stale_uploading),
        "staleUploadingAgeHours": stale_uploading_age_hours,
        "retainedUploadingCheckpoints": sorted(uploading),
        "retainedLegacyUploadingCheckpoints": sorted(legacy_uploading),
        "deletedObjects": deleted,
    }


def prune_garupa_master_snapshots(
    store: R2Store,
    *,
    server: str = "jp",
    retain: int = 3,
) -> dict[str, Any]:
    """Prune Garupa snapshot metadata through its dedicated strict contract."""

    # Imported lazily because the Garupa publisher itself uses R2Store. Keeping
    # this edge out of module initialization avoids a publish.r2 <-> garupa
    # circular import while both pipelines share the same bucket client.
    from garupa_master.r2 import prune_snapshots

    return prune_snapshots(store, server=server, retain=retain)


def _manifest_identity(key: str) -> tuple[str, str, str] | None:
    if not key.endswith(("/source.json", "/release.json")):
        return None
    parts = key.split("/")
    if len(parts) != 5 or parts[0] != "servers":
        raise ValueError(f"invalid manifest key: {key}")
    try:
        server = validate_server_id(parts[1])
    except ValueError as error:
        raise ValueError(f"invalid manifest key: {key}") from error
    if parts[2] == "sources" and parts[4] == "source.json":
        try:
            identity = safe_id(parts[3], "source id")
        except ValueError as error:
            raise ValueError(f"invalid source manifest key: {key}") from error
        return "source", server, identity
    if parts[2] == "releases" and parts[4] == "release.json":
        identity = parts[3]
        if not RELEASE_ID.fullmatch(identity):
            raise ValueError(f"invalid release manifest key: {key}")
        return "release", server, identity
    raise ValueError(f"invalid manifest key: {key}")


def _validate_release_manifest_for_gc(
    manifest: object,
    key: str,
    server: str,
    release_id: str,
) -> list[dict[str, Any]]:
    if not isinstance(manifest, dict):
        raise ValueError(f"release manifest must be an object: {key}")
    if (
        manifest.get("schema") != RELEASE_SCHEMA
        or manifest.get("server") != server
        or manifest.get("releaseId") != release_id
    ):
        raise ValueError(f"release manifest identity mismatch: {key}")
    source_id = manifest.get("sourceId")
    try:
        if not isinstance(source_id, str) or safe_id(source_id, "source id") != source_id:
            raise ValueError("invalid source id")
    except ValueError as error:
        raise ValueError(f"release manifest has an invalid source id: {key}") from error
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise ValueError(f"release manifest entries must be an array: {key}")
    expected_release_id = "r-" + hashlib.sha256(
        stable_json(
            {
                "schema": manifest.get("schema"),
                "server": manifest.get("server"),
                "sourceId": source_id,
                "entries": entries,
            }
        ).encode("utf-8")
    ).hexdigest()[:20]
    if release_id != expected_release_id:
        raise ValueError(f"release manifest content identity mismatch: {key}")

    records: list[dict[str, Any]] = []
    paths: set[str] = set()
    total_bytes = 0
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f"release manifest entry {index} must be an object: {key}")
        try:
            path = validate_release_path(entry.get("path"))
        except ValueError as error:
            raise ValueError(f"invalid release manifest path in {key}") from error
        if path in paths:
            raise ValueError(f"duplicate release manifest path in {key}: {path}")
        paths.add(path)
        role = entry.get("role")
        if role not in RELEASE_TREES or path.split("/", 1)[0] != role:
            raise ValueError(f"release manifest role/path mismatch in {key}: {path}")
        byte_count = entry.get("bytes")
        if (
            not isinstance(byte_count, int)
            or isinstance(byte_count, bool)
            or byte_count < 0
        ):
            raise ValueError(f"invalid byte count in {key}: {path}")
        total_bytes += byte_count
        digest = entry.get("sha256")
        try:
            cas_key(digest)
        except ValueError as error:
            raise ValueError(f"invalid digest referenced by {key}: {digest}") from error
        media_type = entry.get("mediaType")
        if not isinstance(media_type, str) or not media_type:
            raise ValueError(f"invalid media type in {key}: {path}")
        records.append(entry)
    entry_count = manifest.get("entryCount")
    if (
        not isinstance(entry_count, int)
        or isinstance(entry_count, bool)
        or entry_count != len(paths)
    ):
        raise ValueError(f"release manifest entryCount mismatch: {key}")
    declared_total = manifest.get("totalBytes")
    if (
        not isinstance(declared_total, int)
        or isinstance(declared_total, bool)
        or declared_total != total_bytes
    ):
        raise ValueError(f"release manifest totalBytes mismatch: {key}")
    return records


def _garupa_master_cas_live_roots(
    store: R2Store,
) -> tuple[set[str], set[str], dict[str, str]]:
    """Resolve Garupa snapshot and in-flight upload roots through its contract."""

    # This stays a lazy import for the same reason as the pruning adapter above:
    # garupa_master.r2 publishes through R2Store from this module.
    from garupa_master.r2 import garupa_gc_roots

    result = garupa_gc_roots(store)
    if not isinstance(result, tuple) or len(result) != 3:
        raise ValueError(
            "refusing CAS garbage collection: invalid Garupa Master GC roots"
        )
    roots, manifests, checkpoint_states = result
    if (
        not isinstance(roots, set)
        or not isinstance(manifests, set)
        or not isinstance(checkpoint_states, dict)
        or any(not isinstance(key, str) for key in roots)
        or any(not isinstance(key, str) for key in manifests)
        or any(
            not isinstance(key, str) or state not in {"uploading", "completed"}
            for key, state in checkpoint_states.items()
        )
    ):
        raise ValueError(
            "refusing CAS garbage collection: invalid Garupa Master GC roots"
        )
    for key in roots:
        try:
            parse_cas_key(key)
        except ValueError as error:
            raise ValueError(
                "refusing CAS garbage collection: "
                f"invalid Garupa Master CAS root: {key}"
            ) from error
    return roots, manifests, checkpoint_states


def _collect_cas_live_roots(
    store: R2Store,
) -> tuple[set[str], set[str], dict[str, str], set[str]]:
    """Strictly resolve every manifest, checkpoint, and lease CAS root."""

    garupa_live, garupa_manifests, garupa_checkpoint_states = (
        _garupa_master_cas_live_roots(store)
    )
    live = set(garupa_live)
    server_keys = list(store.iter_keys("servers/"))
    manifests: dict[str, tuple[str, str, str]] = {}
    for item in server_keys:
        key = str(item.get("Key") or "")
        identity = _manifest_identity(key)
        if identity is not None:
            kind, server, manifest_id = identity
            manifests[key] = (kind, server, manifest_id)
    for key, (kind, server, manifest_id) in manifests.items():
        manifest = store.get_json(key)
        try:
            records = (
                _validate_release_manifest_for_gc(
                    manifest,
                    key,
                    server,
                    manifest_id,
                )
                if kind == "release"
                else validate_source_manifest(
                    manifest,
                    server,
                    manifest_id,
                    require_storage=True,
                )
            )
        except ValueError as error:
            raise ValueError(
                f"refusing CAS garbage collection: {key}: {error}"
            ) from error
        for record in records:
            live.add(cas_key(record["sha256"]))

    checkpoint_keys: list[str] = []
    for item in server_keys:
        key = str(item.get("Key") or "")
        if "/uploads/" not in key:
            continue
        try:
            _upload_checkpoint_identity(key)
        except ValueError as error:
            raise ValueError(f"refusing CAS garbage collection: {error}") from error
        checkpoint_keys.append(key)
    checkpoint_states = dict(garupa_checkpoint_states)
    for key in checkpoint_keys:
        checkpoint = store.get_json(key)
        try:
            state, objects, _ = _validate_upload_checkpoint(checkpoint, key)
        except ValueError as error:
            raise ValueError(f"refusing CAS garbage collection: {error}") from error
        checkpoint_states[key] = state
        for digest in objects:
            live.add(cas_key(digest))

    lease_keys: list[str] = []
    for item in store.iter_keys(PACKAGE_LEASE_PREFIX + "/"):
        key = str(item.get("Key") or "")
        if not key.endswith(".json"):
            raise ValueError(
                f"refusing CAS garbage collection: invalid package lease key: {key}"
            )
        lease_keys.append(key)
    for key in lease_keys:
        lease = store.get_json(key)
        server = lease.get("server") if isinstance(lease, dict) else None
        digest = lease.get("sha256") if isinstance(lease, dict) else None
        try:
            server_is_valid = (
                isinstance(server, str) and validate_server_id(server) == server
            )
            digest_key = cas_key(digest)
        except ValueError as error:
            raise ValueError(
                f"refusing CAS garbage collection: invalid package lease: {key}"
            ) from error
        if (
            not isinstance(lease, dict)
            or lease.get("schema") != PACKAGE_LEASE_SCHEMA
            or not server_is_valid
            or key != f"{PACKAGE_LEASE_PREFIX}/{server}/{digest}.json"
        ):
            raise ValueError(
                f"refusing CAS garbage collection: invalid package lease: {key}"
            )
        live.add(digest_key)

    return (
        live,
        set(manifests).union(garupa_manifests),
        checkpoint_states,
        set(lease_keys),
    )


def garbage_collect_cas(
    store: R2Store,
    dry_run: bool = False,
    minimum_age_hours: int = 24,
) -> dict[str, Any]:
    """Collect CAS blobs only after roots and object identity are revalidated."""

    if minimum_age_hours < 1:
        raise ValueError("minimum CAS garbage age must be at least one hour")
    live, manifests, checkpoint_states, lease_keys = _collect_cas_live_roots(store)

    candidates: dict[str, tuple[datetime, int, str]] = {}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=minimum_age_hours)
    for item in store.iter_keys(CAS_PREFIX + "/"):
        key = str(item["Key"])
        modified = item.get("LastModified")
        if key in live or not isinstance(modified, datetime) or modified > cutoff:
            continue
        parse_cas_key(key)
        size = item.get("Size")
        etag = item.get("ETag")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or not isinstance(etag, str)
            or not etag
        ):
            raise ValueError(
                f"refusing CAS garbage collection: invalid CAS object metadata: {key}"
            )
        candidates[key] = (modified, size, etag)

    # A different server can publish into the shared bucket while this sweep is
    # running. Preserve both snapshots: a root disappearing concurrently must
    # never make an object less live during the current collection pass.
    refreshed_live, refreshed_manifests, refreshed_checkpoints, refreshed_leases = (
        _collect_cas_live_roots(store)
    )
    live.update(refreshed_live)
    manifests.update(refreshed_manifests)
    checkpoint_states.update(refreshed_checkpoints)
    lease_keys.update(refreshed_leases)
    newly_referenced = set(candidates).intersection(live)
    for key in newly_referenced:
        candidates.pop(key)

    def unchanged_candidate(
        item: tuple[str, tuple[datetime, int, str]],
    ) -> tuple[str, str]:
        key, (expected_modified, expected_size, expected_etag) = item
        metadata = store.head(key)
        if metadata is None:
            return key, "missing"
        digest = parse_cas_key(key)
        object_metadata = metadata.get("Metadata")
        if (
            metadata.get("LastModified") != expected_modified
            or metadata.get("ContentLength") != expected_size
            or metadata.get("ETag") != expected_etag
            or not isinstance(object_metadata, dict)
            or object_metadata.get("sha256") != digest
        ):
            return key, "changed"
        return key, "unchanged"

    garbage: list[str] = []
    changed: list[str] = []
    missing: list[str] = []
    deleted = 0
    candidate_items = sorted(candidates.items())
    with ThreadPoolExecutor(max_workers=store.concurrency) as executor:
        for offset in range(0, len(candidate_items), 1000):
            batch = candidate_items[offset : offset + 1000]
            verified: list[str] = []
            for key, state in executor.map(unchanged_candidate, batch):
                if state == "unchanged":
                    verified.append(key)
                elif state == "changed":
                    changed.append(key)
                else:
                    missing.append(key)
            garbage.extend(verified)
            if not dry_run:
                deleted += store.delete_keys(verified)
    garbage_bytes = sum(candidates[key][1] for key in garbage)
    return {
        "schema": "haneoka-r2-cas-gc-v1",
        "dryRun": dry_run,
        "minimumAgeHours": minimum_age_hours,
        "manifestCount": len(manifests),
        "checkpointCount": len(checkpoint_states),
        "uploadingCheckpointCount": sum(
            state == "uploading" for state in checkpoint_states.values()
        ),
        "completedCheckpointCount": sum(
            state == "completed" for state in checkpoint_states.values()
        ),
        "packageLeaseCount": len(lease_keys),
        "retainedObjects": len(live),
        "initialGarbageObjects": len(candidates) + len(newly_referenced),
        "newlyReferencedObjects": len(newly_referenced),
        "changedObjects": len(changed),
        "missingObjects": len(missing),
        "garbageObjects": len(garbage),
        "garbageBytes": garbage_bytes,
        "deletedObjects": deleted,
    }
