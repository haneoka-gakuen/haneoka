# L3 — GEB
# Input: 已验证 source／release、存储配置和保留选项。
# Output: 远端对象／索引／current、恢复结果及清理报告。
# Pos: [Map](L2-2.md)；R2 发布、恢复与存储维护。
# Effects/Dependencies: S3 API 网络、文件读写和远端指针更新；prune／GC 可删除对象，需对应授权。
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Protocol

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import ClientError, ConnectionClosedError, IncompleteReadError, ReadTimeoutError, ResponseStreamingError

from core.config import ServerConfig, validate_server_id
from core.contracts import (
    PACKAGE_MAX_BYTES,
    POINTER_SCHEMA,
    RELEASE_SCHEMA,
    RELEASE_IDENTITY_FILENAME,
    release_identity_descriptor,
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
from verify.source import validate_master_source, validate_source_manifest
from verify.release import verify_release


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

    def upload_path(
        self,
        file: Path,
        key: str,
        content_type: str,
        *,
        cache_control: str = IMMUTABLE_CACHE,
        metadata: dict[str, str] | None = None,
    ) -> None:
        """Upload one file to an explicit key without a latency-heavy HEAD first.

        ``upload_cas`` addresses objects by digest; this addresses them by a stable
        path-shaped key (used by the shared global Sonolus payload, which is
        overwritten in place on every rebuild).
        """
        size = file.stat().st_size
        extra: dict[str, Any] = {"ContentType": content_type, "CacheControl": cache_control}
        if metadata:
            extra["Metadata"] = metadata
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

    def upload_cas(
        self,
        file: Path,
        digest: str,
        content_type: str,
    ) -> None:
        """Upload content only under the digest of its actual bytes."""
        if sha256_file(file) != digest:
            raise ValueError(f"CAS file hash differs from its key: {file}")
        self.upload_path(file, cas_key(digest), content_type, metadata={"sha256": digest})

    def put_json(
        self, key: str, value: Any, cache_control: str,
        *, expected_etag: str | None = None, if_absent: bool = False,
    ) -> None:
        if expected_etag is not None and if_absent:
            raise ValueError("conflicting object write preconditions")
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
            **({"IfMatch": expected_etag} if expected_etag is not None else {}),
            **({"IfNoneMatch": "*"} if if_absent else {}),
        )

    def get_bytes(self, key: str) -> bytes | None:
        try:
            return self._read_object(key, lambda response: response["Body"].read())
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
                return None
            raise

    def _read_object(self, key: str, read: Callable[[dict[str, Any]], Any]) -> Any:
        """Retry interrupted response bodies after closing their connections."""
        for attempt in range(5):
            body = None
            try:
                response = self.client.get_object(Bucket=self.bucket, Key=key)
                body = response["Body"]
                return read(response)
            except (ResponseStreamingError, IncompleteReadError, ReadTimeoutError, ConnectionClosedError):
                if attempt == 4:
                    raise
                sys.stderr.write(f"warning: R2 response interrupted; retrying {key} ({attempt + 2}/5)\n")
            finally:
                if body is not None:
                    body.close()
            time.sleep(min(2 ** attempt, 8))

    def get_json(self, key: str) -> Any | None:
        body = self.get_bytes(key)
        if body is None:
            return None
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"R2 object is not valid JSON: {key}") from error

    def get_json_with_version(self, key: str) -> tuple[Any, str, int] | None:
        """Read JSON and its version from the same response."""

        def read(response: dict[str, Any]) -> tuple[Any, str, int]:
            body = response["Body"].read()
            try:
                value = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(f"R2 object is not valid JSON: {key}") from error
            return value, str(response.get("ETag") or ""), len(body)

        try:
            return self._read_object(key, read)
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
                return None
            raise

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
        if expected_sha256 is not None and file.is_file():
            size = file.stat().st_size
            if (expected_bytes is None or size == expected_bytes) and sha256_file(file) == expected_sha256:
                return size
        file.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        def copy(response: dict[str, Any]) -> int:
            nonlocal temporary
            declared_size = response.get("ContentLength")
            body = response["Body"]
            if isinstance(declared_size, int):
                if expected_bytes is not None and declared_size != expected_bytes:
                    raise ValueError(
                        f"R2 object size differs from its manifest: {key}: "
                        f"{declared_size} != {expected_bytes}"
                    )
            if temporary is not None:
                temporary.unlink(missing_ok=True)
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

        try:
            return self._read_object(key, copy)
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
        return self.delete_keys(str(item["Key"]) for item in self.iter_keys(prefix))

    def delete_keys(self, keys: Iterable[str]) -> int:
        count = 0
        batch: list[dict[str, str]] = []
        for key in keys:
            batch.append({"Key": key})
            if len(batch) == 1000:
                count += self._delete_batch(batch)
                batch = []
        if batch:
            count += self._delete_batch(batch)
        return count

    def _delete_batch(self, batch: list[dict[str, str]]) -> int:
        pending = batch
        transient = {"InternalError", "ServiceUnavailable", "SlowDown", "RequestTimeout", "Throttling"}
        for attempt in range(5):
            response = self.client.delete_objects(
                Bucket=self.bucket, Delete={"Objects": pending, "Quiet": True}
            )
            errors = response.get("Errors", [])
            if not isinstance(errors, list):
                raise OSError("R2 deletion returned an invalid error list")
            if not errors:
                return len(batch)
            keys = {item["Key"] for item in pending}
            if any(not isinstance(error, dict) or error.get("Key") not in keys for error in errors):
                raise OSError("R2 deletion returned an unknown object error")
            failed = {str(error["Key"]) for error in errors}
            if attempt == 4 or any(error.get("Code") not in transient for error in errors):
                detail = ", ".join(f"{error['Key']}: {error.get('Code', 'unknown')}" for error in errors)
                raise OSError(f"R2 deletion failed after {len(batch) - len(failed)} confirmed removals: {detail}")
            pending = [{"Key": key} for key in sorted(failed)]
            time.sleep(min(2 ** attempt, 8))
        raise AssertionError("unreachable deletion retry state")


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
        expected_sha256=expected,
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
        len(body) != declared_bytes
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


def download_current_release_paths(
    store: R2Store,
    config: ServerConfig,
    prefixes: tuple[str, ...],
    exact_paths: tuple[str, ...],
    target_root: Path,
) -> dict[str, Any]:
    """Materialize selected files from the current release under ``target_root``.

    Each manifest entry whose ``path`` starts with one of ``prefixes`` or equals
    one of ``exact_paths`` is downloaded from content-addressed storage into
    ``target_root/<path>``, mirroring the release layout. This is the bridge that
    lets an independent build (the Sonolus engine payload) read a release's
    presentation assets without re-running the resource pipeline.
    """

    pointer, manifest = _current_release_manifest(store, config)
    if not isinstance(pointer, dict) or not isinstance(manifest, dict):
        raise ValueError(f"no current release is selected for server {config.id!r}")
    source_id = str(pointer.get("sourceId") or "")
    if (
        manifest.get("server") != config.id
        or manifest.get("releaseId") != pointer.get("releaseId")
        or manifest.get("sourceId") != source_id
    ):
        raise ValueError("current release manifest identity does not match its pointer")

    source_manifest = store.get_json(
        f"servers/{config.id}/sources/{source_id}/source.json"
    )
    source_records = validate_source_manifest(
        source_manifest,
        config.id,
        source_id,
        require_storage=True,
    )
    package_info = source_manifest.get("package") if isinstance(source_manifest, dict) else None
    package_file = package_info.get("file") if isinstance(package_info, dict) else None
    package_record = next(
        (
            record
            for record in source_records
            if record.get("role") == "package" and record.get("path") == package_file
        ),
        None,
    )
    if not isinstance(package_info, dict) or not isinstance(package_file, str) or not isinstance(package_record, dict):
        raise ValueError("current source manifest does not declare its package identity")
    apk_identity = {
        "path": package_file,
        "bytes": int(package_record["bytes"]),
        "sha256": str(package_record["sha256"]),
        **{
            key: package_info[key]
            for key in ("packageName", "versionName", "versionCode")
            if isinstance(package_info.get(key), str)
        },
    }
    exact = set(exact_paths)
    wanted: list[dict[str, Any]] = []
    for entry in manifest.get("entries", []):
        if not isinstance(entry, dict):
            raise ValueError("current release manifest contains a non-object entry")
        path = str(entry.get("path") or "")
        if path and (path in exact or any(path.startswith(prefix) for prefix in prefixes)):
            wanted.append(entry)
    if not wanted:
        scanned = len(manifest.get("entries", []))
        raise ValueError(
            "the current release declares none of the requested paths "
            f"(scanned {scanned} entries)"
        )
    missing_prefixes = [
        prefix
        for prefix in prefixes
        if not any(str(entry.get("path") or "").startswith(prefix) for entry in wanted)
    ]
    if missing_prefixes:
        raise ValueError(
            "the current release declares none of the requested paths for prefixes: "
            + ", ".join(missing_prefixes)
        )
    wanted.sort(key=lambda item: str(item.get("path") or ""))
    target_root = target_root.resolve()
    target_root.mkdir(parents=True, exist_ok=True)

    def download(entry: dict[str, Any]) -> None:
        path = str(entry["path"])
        file = target_root.joinpath(*PurePosixPath(path).parts)
        if not file.resolve().is_relative_to(target_root):
            raise ValueError(f"release path escapes the target root: {path}")
        store.download_file(
            cas_key(str(entry["sha256"])),
            file,
            expected_bytes=int(entry["bytes"]),
            expected_sha256=str(entry["sha256"]),
        )

    with ThreadPoolExecutor(max_workers=store.concurrency) as executor:
        list(executor.map(download, wanted))

    write_json(
        target_root / "sonolus-input-provenance.json",
        {
            "schema": "haneoka-sonolus-input-provenance-v1",
            "server": config.id,
            "releaseId": pointer["releaseId"],
            "sourceId": source_id,
            "prefixes": list(prefixes),
            "exactPaths": list(exact_paths),
            "files": [
                {
                    "path": str(entry["path"]),
                    "bytes": int(entry["bytes"]),
                    "sha256": str(entry["sha256"]),
                }
                for entry in wanted
            ],
            "apk": apk_identity,
        },
        pretty=True,
    )

    return {
        "schema": "haneoka-release-fetch-v1",
        "server": config.id,
        "releaseId": pointer["releaseId"],
        "sourceId": source_id,
        "fileCount": len(wanted),
        "fileBytes": sum(int(entry["bytes"]) for entry in wanted),
        "provenanceFile": "sonolus-input-provenance.json",
        "apk": apk_identity,
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
    size = int(record.get("bytes", -1))
    if (
        not isinstance(entry, dict)
        or entry.get("sha256") != digest
        or int(entry.get("bytes", -1)) != size
    ):
        raise ValueError(
            f"current release does not declare the reusable object exactly: {path}"
        )
    store.download_file(
        cas_key(digest),
        target,
        expected_bytes=size,
        expected_sha256=digest,
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
    validate_source_manifest(local_manifest, config.id, source_id)
    validate_master_source(local_manifest, layout.root)
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
    if existing_manifest is not None:
        raise ValueError(
            f"refusing to overwrite immutable source manifest {manifest_key}; "
            "bump the source normalization revision when its interpretation changes"
        )

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
    exclude_sha256: set[str] | None = None,
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
        if exclude_sha256 and str(record.get("sha256")) in exclude_sha256:
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
            expected_sha256=str(record["sha256"]),
        )

    with ThreadPoolExecutor(max_workers=store.concurrency) as executor:
        list(executor.map(download, selected))
    selected_roles = {record["role"] for record in selected}
    if "master-manifest" in selected_roles and "master-data" in selected_roles:
        validate_master_source(manifest, layout.root)
    return {
        "schema": "haneoka-source-fetch-v1",
        "server": config.id,
        "sourceId": source_id,
        "fileCount": len(selected),
        "fileBytes": selected_bytes,
    }


def _publish_release_identity(
    store: R2Store,
    key: str,
    identity: dict[str, str],
) -> bool:
    """Publish an immutable release identity, returning whether it was new."""

    if store.head(key) is not None:
        if store.get_json(key) != identity:
            raise ValueError(f"immutable release identity mismatch: {key}")
        return False
    store.put_json(key, identity, IMMUTABLE_CACHE)
    return True


def publish_release(
    store: R2Store,
    config: ServerConfig,
    release_id: str,
    check_hashes: bool = True,
) -> dict[str, Any]:
    layout = release_layout(config.id, release_id)
    prefix = f"servers/{config.id}/releases/{release_id}/"
    pointer_key = f"servers/{config.id}/current.json"
    pointer_head = store.head(pointer_key)
    pointer_etag = pointer_head.get("ETag") if pointer_head is not None else None
    if pointer_head is not None and (not isinstance(pointer_etag, str) or not pointer_etag):
        raise ValueError("current release pointer has no object version")
    current, previous_manifest = _current_release_manifest(store, config)
    # A delta release keeps composed entries whose bytes stay in the previous
    # release; verification cross-checks those entries against that manifest.
    manifest = verify_release(
        config.id,
        release_id,
        check_hashes=check_hashes,
        base_manifest=previous_manifest,
    )
    manifest_key = prefix + "release.json"
    identity_key = prefix + RELEASE_IDENTITY_FILENAME
    identity = release_identity_descriptor(config.id, release_id, manifest)
    producer = {}
    producer_path = "metadata/pipeline-recipes/pipeline.json"
    producer_entry = next((entry for entry in manifest["entries"] if entry["path"] == producer_path), None)
    producer_file = layout.root / producer_path
    if producer_entry is not None and producer_file.is_file():
        body = producer_file.read_bytes()
        if len(body) != producer_entry["bytes"] or hashlib.sha256(body).hexdigest() != producer_entry["sha256"]:
            raise ValueError("release producer receipt does not match the verified manifest")
        producer = json.loads(body)
        if producer.get("schema") != "haneoka-pipeline-producer-v1" or producer.get("server") != config.id:
            raise ValueError("release producer receipt has an invalid identity")
    if isinstance(current, dict) and current.get("releaseId") == release_id:
        remote_manifest = store.get_json(manifest_key)
        if remote_manifest != manifest:
            raise ValueError(f"remote release manifest mismatch: {manifest_key}")
        identity_published = _publish_release_identity(store, identity_key, identity)
        fingerprint = producer.get("pipelineFingerprint", current.get("pipelineFingerprint", ""))
        identity_refreshed = current.get("pipelineFingerprint") != fingerprint
        if identity_refreshed:
            if store.get_json(pointer_key) != current:
                raise ValueError("current release changed during publication; refusing stale identity refresh")
            current = {**current, "pipelineFingerprint": fingerprint}
            store.put_json(pointer_key, current, POINTER_CACHE, expected_etag=pointer_etag)
        return {
            **current,
            "releasePromoted": False,
            "releaseIdentity": identity_key,
            "identityPublished": identity_published,
            "identityRefreshed": identity_refreshed,
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
    identity_published = _publish_release_identity(store, identity_key, identity)

    pointer = {
        "schema": POINTER_SCHEMA,
        "server": config.id,
        "sourceId": manifest["sourceId"],
        "pipelineFingerprint": producer.get("pipelineFingerprint", ""),
        "releaseId": release_id,
        "releaseManifest": manifest_key,
        "releaseIndex": {
            "algorithm": RELEASE_INDEX_ALGORITHM,
            "shards": RELEASE_INDEX_SHARDS,
            "prefix": release_index_prefix(config.id, release_id),
        },
    }
    if producer.get("producerGitSha"):
        pointer["producerGitSha"] = producer["producerGitSha"]
    if store.get_json(pointer_key) != current:
        raise ValueError("current release changed during publication; refusing stale promotion")
    store.put_json(
        pointer_key, pointer, POINTER_CACHE,
        expected_etag=pointer_etag, if_absent=pointer_head is None,
    )
    return {
        **pointer,
        "releasePromoted": True,
        "releaseIdentity": identity_key,
        "identityPublished": identity_published,
        "transfer": {
            **transfer,
            "reusedObjects": len(objects) - len(pending),
            "indexObjects": RELEASE_INDEX_SHARDS,
        },
    }


def prune_releases(store: R2Store, config: ServerConfig, dry_run: bool = False) -> dict[str, Any]:
    """Retain recent releases plus active offline and resumable pipeline roots."""

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
    offline = store.get_json(f"servers/{config.id}/offline/current.json")
    if isinstance(offline, dict) and offline.get("schema") == "haneoka-story-offline-v1" and offline.get("server") == config.id:
        offline_release = offline.get("releaseId")
        if isinstance(offline_release, str) and any(
            candidate[0] == offline_release and candidate[3] == offline.get("sourceId") for candidate in candidates
        ):
            keep.add(offline_release)
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
    from publish.stages import recent_pipeline_stage_references
    _, stage_releases, stage_plans = recent_pipeline_stage_references(store, config.id)
    if stage_releases - {candidate[0] for candidate in candidates}:
        raise ValueError("a resumable pipeline stage references a missing base release")
    keep.update(stage_releases)

    planned: dict[str, int] = {}
    retained_incomplete: list[str] = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    deleted: dict[str, int] = {}
    for release_id, prefix, _, _ in candidates:
        if release_id not in keep:
            if _current_pointer(store, config) != pointer:
                raise ValueError("current release changed during maintenance")
            if dry_run:
                planned[release_id] = sum(1 for _ in store.iter_keys(prefix))
            else:
                deleted[release_id] = store.delete_prefix(prefix)
    for release_id, prefix in incomplete:
        if release_id == current:
            raise ValueError(
                f"refusing release cleanup: selected release is incomplete: {current}"
            )
        items = list(store.iter_keys(prefix))
        if any(not isinstance(item.get("LastModified"), datetime) or item["LastModified"] > cutoff for item in items):
            retained_incomplete.append(release_id)
            continue
        if _current_pointer(store, config) != pointer:
            raise ValueError("current release changed during maintenance")
        if dry_run:
            planned[release_id] = len(items)
        else:
            deleted[release_id] = store.delete_prefix(prefix)
    return {
        "schema": "haneoka-r2-release-prune-v1",
        "server": config.id,
        "dryRun": dry_run,
        "currentReleaseId": current,
        "retainedReleaseIds": sorted(keep),
        "retainedStageReleaseIds": sorted(stage_releases),
        "retainedStagePlans": stage_plans,
        "retainedRecentIncompleteReleases": sorted(retained_incomplete),
        "plannedReleases": planned,
        "deletedReleases": deleted,
        "deletedObjects": sum(deleted.values()),
    }


def prune_sources(store: R2Store, config: ServerConfig, dry_run: bool = False, ignored_releases: set[str] | None = None) -> dict[str, Any]:
    """Retain only source manifests referenced by retained releases."""

    release_root = f"servers/{config.id}/releases/"
    ignored_releases = ignored_releases or set()
    if ignored_releases and (not dry_run or any(not RELEASE_ID.fullmatch(value) for value in ignored_releases)):
        raise ValueError("hypothetical release exclusions require a dry run and valid release ids")
    keep: set[str] = set()
    retained_releases: dict[str, str] = {}
    incomplete: list[str] = []
    for prefix in store.iter_prefixes(release_root):
        release_id = prefix.removeprefix(release_root).strip("/")
        if not RELEASE_ID.fullmatch(release_id):
            continue
        if release_id in ignored_releases:
            continue
        manifest_key = prefix + "release.json"
        if store.head(manifest_key) is None:
            incomplete.append(prefix)
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
    from publish.stages import recent_pipeline_stage_references
    stage_sources, _, stage_plans = recent_pipeline_stage_references(store, config.id)
    keep.update(stage_sources)

    source_root = f"servers/{config.id}/sources/"
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    planned: dict[str, int] = {}
    retained_recent: list[str] = []
    deleted: dict[str, int] = {}
    for prefix in store.iter_prefixes(source_root):
        source_id = prefix.removeprefix(source_root).strip("/")
        if source_id and source_id not in keep:
            items = list(store.iter_keys(prefix))
            if any(not isinstance(item.get("LastModified"), datetime) or item["LastModified"] > cutoff for item in items):
                retained_recent.append(source_id)
                continue
            if _current_pointer(store, config) != pointer:
                raise ValueError("current release changed during maintenance")
            if dry_run:
                planned[source_id] = len(items)
            else:
                deleted[source_id] = store.delete_prefix(prefix)
    return {
        "schema": "haneoka-r2-source-prune-v1",
        "server": config.id,
        "dryRun": dry_run,
        "hypotheticallyPrunedReleases": sorted(ignored_releases),
        "retainedSourceIds": sorted(keep),
        "retainedStageSourceIds": sorted(stage_sources),
        "retainedStagePlans": stage_plans,
        "retainedRecentSourceIds": sorted(retained_recent),
        "incompleteReleasePrefixes": incomplete,
        "plannedSources": planned,
        "deletedSources": deleted,
        "deletedObjects": sum(deleted.values()),
    }


def prune_upload_checkpoints(
    store: R2Store,
    config: ServerConfig,
    stale_uploading_age_hours: int = 168,
    dry_run: bool = False,
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
        effective_updated_at = updated_at
        if effective_updated_at is None:
            modified = item.get("LastModified")
            if isinstance(modified, datetime) and modified.tzinfo is not None:
                effective_updated_at = modified
        if state == "completed":
            completed.append(key)
        elif effective_updated_at is not None and effective_updated_at <= cutoff:
            stale_uploading.append(key)
        else:
            uploading.append(key)
            if updated_at is None:
                legacy_uploading.append(key)
    deleted = 0 if dry_run else store.delete_keys(completed + stale_uploading)
    return {
        "schema": "haneoka-r2-upload-prune-v1",
        "server": config.id,
        "dryRun": dry_run,
        "completedCheckpointCount": len(completed),
        "uploadingCheckpointCount": len(uploading),
        "staleUploadingCheckpointCount": len(stale_uploading),
        "staleUploadingAgeHours": stale_uploading_age_hours,
        "retainedUploadingCheckpoints": sorted(uploading),
        "retainedLegacyUploadingCheckpoints": sorted(legacy_uploading),
        "plannedObjects": len(completed) + len(stale_uploading),
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


def _same_modified_time(actual: object, expected: datetime) -> bool:
    # S3 HEAD uses an HTTP date (whole seconds); LIST retains fractional seconds.
    return isinstance(actual, datetime) and actual.replace(microsecond=0) == expected.replace(microsecond=0)


def prune_package_leases(
    store: R2Store,
    config: ServerConfig,
    *,
    dry_run: bool = True,
    stale_age_hours: int = 168,
) -> dict[str, Any]:
    if stale_age_hours < 168:
        raise ValueError("package leases must remain available for at least seven days")
    if not dry_run:
        raise ValueError("legacy package leases have no authoritative expiry; produce a read-only plan before migrating their upload-state contract")
    prefix = f"{PACKAGE_LEASE_PREFIX}/{config.id}/"
    cutoff = datetime.now(timezone.utc) - timedelta(hours=stale_age_hours)
    planned, retained, changed = [], [], []
    for item in store.iter_keys(prefix):
        key = str(item.get("Key") or "")
        digest = key.removeprefix(prefix).removesuffix(".json")
        cas_key(digest)
        lease = store.get_json(key)
        if not isinstance(lease, dict) or lease.get("schema") != PACKAGE_LEASE_SCHEMA or lease.get("server") != config.id or lease.get("sha256") != digest or key != f"{prefix}{digest}.json":
            raise ValueError(f"invalid package lease: {key}")
        modified = item.get("LastModified")
        if not isinstance(modified, datetime) or modified.tzinfo is None:
            raise ValueError(f"missing package lease modification time: {key}")
        if modified > cutoff:
            retained.append(key)
            continue
        current = store.head(key)
        if current is None or not _same_modified_time(current.get("LastModified"), modified) or current.get("ETag") != item.get("ETag") or current.get("ContentLength") != item.get("Size"):
            changed.append(key)
            continue
        planned.append(key)
    return {"schema": "haneoka-r2-package-lease-prune-v1", "server": config.id, "dryRun": True, "staleAgeHours": stale_age_hours, "agedLeasesRequiringUploadState": planned, "retainedRecentLeases": retained, "retainedChangedLeases": changed, "deletedObjects": 0}


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
    manifest_cache: dict[str, tuple[str, int, tuple[str, ...]]],
) -> tuple[set[str], set[str], dict[str, str], set[str], dict[str, int]]:
    """Strictly resolve every manifest, checkpoint, and lease CAS root."""

    garupa_live, garupa_manifests, garupa_checkpoint_states = (
        _garupa_master_cas_live_roots(store)
    )
    live = set(garupa_live)
    server_keys = list(store.iter_keys("servers/"))
    manifests: dict[str, tuple[str, str, str]] = {}
    versions: dict[str, tuple[object, object]] = {}
    for item in server_keys:
        key = str(item.get("Key") or "")
        identity = _manifest_identity(key)
        if identity is not None:
            kind, server, manifest_id = identity
            manifests[key] = (kind, server, manifest_id)
            versions[key] = (item.get("ETag"), item.get("Size"))

    def read_manifest(
        item: tuple[str, tuple[str, str, str]],
    ) -> tuple[str, tuple[str, int, tuple[str, ...]], bool]:
        key, (kind, server, manifest_id) = item
        cached = manifest_cache.get(key)
        if cached and cached[0] and versions[key] == cached[:2]:
            return key, cached, True
        result = store.get_json_with_version(key)
        if result is None:
            raise ValueError(f"refusing CAS garbage collection: missing manifest: {key}")
        manifest, etag, byte_count = result
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
        roots = tuple(sys.intern(cas_key(record["sha256"])) for record in records)
        return key, (etag, byte_count, roots), False

    reused = 0
    # Bound simultaneous JSON bodies while overlapping independent R2 reads.
    with ThreadPoolExecutor(max_workers=min(store.concurrency, 4)) as executor:
        for key, cached, was_reused in executor.map(read_manifest, manifests.items()):
            manifest_cache[key] = cached
            live.update(cached[2])
            reused += was_reused

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
        {"reads": len(manifests) - reused, "reused": reused},
    )


def garbage_collect_cas(
    store: R2Store,
    dry_run: bool = False,
    minimum_age_hours: int = 24,
    shard: str | None = None,
) -> dict[str, Any]:
    """Collect CAS blobs only after roots and object identity are revalidated."""

    if minimum_age_hours < 1:
        raise ValueError("minimum CAS garbage age must be at least one hour")
    if shard is not None and not re.fullmatch(r"[a-f0-9]{2}", shard):
        raise ValueError("CAS sweep shard must be two lowercase hexadecimal characters")
    manifest_cache: dict[str, tuple[str, int, tuple[str, ...]]] = {}
    live, manifests, checkpoint_states, lease_keys, initial_reads = _collect_cas_live_roots(
        store, manifest_cache,
    )

    candidates: dict[str, tuple[datetime, int, str]] = {}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=minimum_age_hours)
    scanned = 0
    for item in store.iter_keys(CAS_PREFIX + "/" + (f"{shard}/" if shard else "")):
        scanned += 1
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
    refreshed_live, refreshed_manifests, refreshed_checkpoints, refreshed_leases, refreshed_reads = (
        _collect_cas_live_roots(store, manifest_cache)
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
    ) -> tuple[str, str, list[str], bool]:
        key, (expected_modified, expected_size, expected_etag) = item
        metadata = store.head(key)
        if metadata is None:
            return key, "missing", [], False
        digest = parse_cas_key(key)
        object_metadata = metadata.get("Metadata")
        reasons = []
        modified = metadata.get("LastModified")
        same_modified = _same_modified_time(modified, expected_modified)
        precision_adjusted = same_modified and modified != expected_modified
        if not same_modified:
            reasons.append("lastModified")
        if metadata.get("ContentLength") != expected_size:
            reasons.append("size")
        if metadata.get("ETag") != expected_etag:
            reasons.append("etag")
        recorded_digest = object_metadata.get("sha256") if isinstance(object_metadata, dict) else None
        if recorded_digest != digest:
            reasons.append("sha256Missing" if recorded_digest is None else "sha256Mismatch")
        return key, "changed" if reasons else "unchanged", reasons, precision_adjusted

    garbage: list[str] = []
    changed: list[str] = []
    changed_reasons: dict[str, int] = defaultdict(int)
    timestamp_precision_adjusted = 0
    missing: list[str] = []
    deleted = 0
    candidate_items = sorted(candidates.items())
    with ThreadPoolExecutor(max_workers=store.concurrency) as executor:
        for offset in range(0, len(candidate_items), 1000):
            batch = candidate_items[offset : offset + 1000]
            verified: list[str] = []
            for key, state, reasons, precision_adjusted in executor.map(unchanged_candidate, batch):
                timestamp_precision_adjusted += precision_adjusted
                if state == "unchanged":
                    verified.append(key)
                elif state == "changed":
                    changed.append(key)
                    for reason in reasons:
                        changed_reasons[reason] += 1
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
        "shard": shard,
        "scannedObjects": scanned,
        "manifestCount": len(manifests),
        "manifestReads": initial_reads["reads"] + refreshed_reads["reads"],
        "reusedManifests": refreshed_reads["reused"],
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
        "changedObjectReasons": dict(sorted(changed_reasons.items())),
        "timestampPrecisionAdjustedObjects": timestamp_precision_adjusted,
        "missingObjects": len(missing),
        "garbageObjects": len(garbage),
        "garbageBytes": garbage_bytes,
        "garbageKeys": garbage if dry_run else [],
        "deletedObjects": deleted,
    }
