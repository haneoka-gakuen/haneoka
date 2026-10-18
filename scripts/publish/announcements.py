"""Refresh the operational in-game announcement snapshot independently of releases."""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

# Allow direct execution from the repository root as well as the workflow's
# PYTHONPATH=scripts invocation.
_SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from build.announcements import (
    ANNOUNCEMENT_SCHEMA,
    PUBLIC_BASE_URL,
    AnnouncementCollection,
    announcement_timestamp,
    collect_announcements,
    merge_announcement_archive,
    package_client_version,
    public_announcement_document,
    saved_announcement_archive,
)
from core.config import ServerConfig, load_server_config
from core.manifests import read_json, stable_json
from core.paths import safe_id, server_layout, source_layout
from ingest.version_api import DiscoveryUnavailable
from publish.r2 import IMMUTABLE_CACHE, R2Store


OPERATION_PREFIX = "operation"
SNAPSHOT_CACHE = "public, max-age=60, must-revalidate"


def _validate_published_snapshot(value: dict[str, Any], server: str) -> None:
    if value.get("schema") != ANNOUNCEMENT_SCHEMA or value.get("server") != server:
        raise ValueError("invalid published announcement snapshot identity")
    if value.get("available") is not True:
        raise ValueError("published announcement snapshot is unavailable")
    if not isinstance(value.get("fetchedAt"), str) or not value["fetchedAt"]:
        raise ValueError("invalid published announcement snapshot timestamp")
    records = value.get("announcements")
    if not isinstance(records, list):
        raise ValueError("invalid published announcement snapshot records")
    for record in records:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get("title"), str)
            or not record["title"]
        ):
            raise ValueError("invalid published announcement record title")
        for key in ("id", "category", "startAt", "endAt", "updatedAt"):
            number = record.get(key)
            if (
                type(number) is not int
                or number < (1 if key == "id" else 0)
                or number > (1 << 53) - 1
            ):
                raise ValueError(f"invalid published announcement record {key}")
        if "sourceRegion" in record or "sourceId" in record:
            region, identifier = record.get("sourceRegion"), record.get("sourceId")
            if (
                not isinstance(region, str) or not region or len(region) > 32
                or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in region)
            ):
                raise ValueError("invalid published announcement source region")
            if type(identifier) is not int or not 0 < identifier <= (1 << 53) - 1:
                raise ValueError("invalid published announcement source id")


def _repair_published_snapshot(value: dict[str, Any], server: str) -> tuple[dict[str, Any], int]:
    records = value.get("announcements")
    if not isinstance(records, list):
        raise ValueError("invalid published announcement snapshot records")
    repaired = {**value, "announcements": []}
    changed = 0
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("invalid published announcement record")
        current = dict(record)
        for field in ("startAt", "endAt", "updatedAt"):
            if type(current.get(field)) is int:
                timestamp = announcement_timestamp(current[field])
                changed += timestamp != current[field]
                current[field] = timestamp
        repaired["announcements"].append(current)
    _validate_published_snapshot(repaired, server)
    return repaired, changed


def repair_published_announcements(store: R2Store, config: ServerConfig) -> dict[str, Any]:
    snapshot_key = f"servers/{config.id}/{OPERATION_PREFIX}/announcements.json"
    version = store.get_json_with_version(snapshot_key)
    if version is None or not isinstance(version[0], dict):
        raise ValueError("published announcement snapshot is missing")
    repaired, changed = _repair_published_snapshot(version[0], config.id)
    if changed:
        store.put_json(snapshot_key, repaired, SNAPSHOT_CACHE, expected_etag=version[1])
    return {
        "schema": "haneoka-announcements-publication-v1",
        "server": config.id,
        "available": True,
        "announcements": len(repaired["announcements"]),
        "timestampsRepaired": changed,
        "snapshotKey": snapshot_key,
    }


def restore_saved_announcements(store: R2Store, config: ServerConfig) -> dict[str, Any]:
    saved = saved_announcement_archive(config.id)
    if saved is None:
        raise ValueError(f"no saved announcement archive for {config.id}")
    _validate_published_snapshot(saved, config.id)
    snapshot_key = f"servers/{config.id}/{OPERATION_PREFIX}/announcements.json"
    previous = store.get_json_with_version(snapshot_key)
    current = previous[0] if previous else saved
    document = merge_announcement_archive(current, saved)
    _validate_published_snapshot(document, config.id)
    store.put_json(
        snapshot_key, document, SNAPSHOT_CACHE,
        expected_etag=previous[1] if previous else None,
        if_absent=previous is None,
    )
    return {
        "schema": "haneoka-announcements-publication-v1",
        "server": config.id,
        "available": True,
        "announcements": len(document["announcements"]),
        "recovered": len(document["announcements"]) - len(previous[0]["announcements"]) if previous else len(document["announcements"]),
        "snapshotKey": snapshot_key,
    }


def _media_key(server: str, filename: str) -> str:
    return f"servers/{server}/{OPERATION_PREFIX}/announcements/media/{filename}"


def _media_matches(metadata: dict[str, Any] | None, asset: Any) -> bool:
    if not metadata:
        return False
    object_metadata = metadata.get("Metadata")
    digest = (
        object_metadata.get("sha256") if isinstance(object_metadata, dict) else None
    )
    return (
        metadata.get("ContentLength") == asset.file.stat().st_size
        and digest == asset.digest
    )


def _upload_media(
    store: R2Store, server: str, collection: AnnouncementCollection
) -> tuple[int, int]:
    uploaded = 0
    reused = 0
    for asset in sorted(collection.media, key=lambda value: value.filename):
        key = _media_key(server, asset.filename)
        if _media_matches(store.head(key), asset):
            reused += 1
            continue
        store.upload_path(
            asset.file,
            key,
            asset.content_type,
            cache_control=IMMUTABLE_CACHE,
            metadata={"sha256": asset.digest},
        )
        uploaded += 1
    return uploaded, reused


def _source_client_version(
    store: R2Store | None, config: ServerConfig, source_id: str | None
) -> str:
    if source_id is None:
        pointer = (
            store.get_json(f"servers/{config.id}/current.json")
            if store is not None else read_json(server_layout(config.id).current)
        )
        source_id = str((pointer or {}).get("sourceId") or "")
    if not source_id:
        raise ValueError(f"no current package source is selected for {config.id}")
    source_id = safe_id(source_id, "source id")
    manifest = (
        store.get_json(f"servers/{config.id}/sources/{source_id}/source.json")
        if store is not None else read_json(source_layout(config.id, source_id).manifest)
    )
    return package_client_version(manifest, config.package_name)


def publish_announcements(
    store: R2Store | None,
    config: ServerConfig,
    *,
    source_id: str | None = None,
    base_url: str = PUBLIC_BASE_URL,
    work_dir: Path | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Refresh current announcements while retaining previously collected records."""

    snapshot_key = f"servers/{config.id}/{OPERATION_PREFIX}/announcements.json"
    if store is None and not dry_run:
        raise ValueError("announcement publication requires a storage client")
    previous_version = store.get_json_with_version(snapshot_key) if store is not None else None
    previous = previous_version[0] if previous_version is not None else None
    if work_dir is not None:
        work_dir.mkdir(parents=True, exist_ok=True)
    temporary_root = Path(
        tempfile.mkdtemp(prefix=f"haneoka-announcements-{config.id}-", dir=work_dir)
    )
    try:
        client_version = (
            _source_client_version(store, config, source_id)
            if config.announcements_regions
            else None
        )
        collection = collect_announcements(
            config,
            temporary_root / "media",
            client_version=client_version,
        )
        if previous is not None and previous.get("available") is True:
            _validate_published_snapshot(previous, config.id)
        document = merge_announcement_archive(
            public_announcement_document(collection, config.id, base_url),
            merge_announcement_archive(previous, saved_announcement_archive(config.id))
            if previous else saved_announcement_archive(config.id),
        )
        if document["available"]:
            _validate_published_snapshot(document, config.id)
        if dry_run:
            return {
                "schema": "haneoka-announcements-publication-v1",
                "server": config.id,
                "available": True,
                "dryRun": True,
                "announcements": len(document["announcements"]),
                "media": len(collection.media),
                "snapshotKey": snapshot_key,
            }
        uploaded, reused = _upload_media(store, config.id, collection)
        # The list document is the commit point. Every referenced media object is
        # already available before this overwrite starts.
        store.put_json(
            snapshot_key, document, SNAPSHOT_CACHE,
            expected_etag=previous_version[1] if previous_version else None,
            if_absent=previous_version is None,
        )
        return {
            "schema": "haneoka-announcements-publication-v1",
            "server": config.id,
            "available": True,
            "announcements": len(document["announcements"]),
            "mediaUploaded": uploaded,
            "mediaReused": reused,
            "snapshotKey": snapshot_key,
        }
    except Exception as exc:  # noqa: BLE001 - the operational feed preserves its previous commit
        result = {
            "schema": "haneoka-announcements-publication-v1",
            "server": config.id,
            "available": isinstance(previous, dict)
            and previous.get("available") is True,
            "announcements": len(previous.get("announcements", []))
            if isinstance(previous, dict)
            else 0,
            "preserved": isinstance(previous, dict),
            "snapshotKey": snapshot_key,
            "error": type(exc).__name__,
            "reason": str(exc),
        }
        if isinstance(exc, DiscoveryUnavailable) and result["available"]:
            repaired, changed = _repair_published_snapshot(previous, config.id)
            if changed:
                store.put_json(
                    snapshot_key, repaired, SNAPSHOT_CACHE,
                    expected_etag=previous_version[1],
                )
                result["timestampsRepaired"] = changed
            result["deferred"] = True
            result["temporaryReason"] = exc.reason
        return result
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Refresh the operational announcement snapshot without rebuilding a resource release."
    )
    parser.add_argument("--server", default="intl")
    parser.add_argument("--source")
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--base-url", default=PUBLIC_BASE_URL)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--restore-archive", action="store_true",
        help="merge saved historical announcements into R2 without requesting the game API",
    )
    mode.add_argument(
        "--repair-published", action="store_true",
        help="validate and repair only the published snapshot's exact unset-timestamp sentinel, using its ETag",
    )
    mode.add_argument(
        "--dry-run", action="store_true",
        help="collect and validate without R2 access; regional bootstrap uses the local --source/current package version",
    )
    args = parser.parse_args()
    config = load_server_config(args.server)
    if args.restore_archive:
        result = restore_saved_announcements(R2Store(config, args.concurrency), config)
    elif args.repair_published:
        result = repair_published_announcements(R2Store(config, args.concurrency), config)
    else:
        result = publish_announcements(
            None if args.dry_run else R2Store(config, args.concurrency),
            config,
            source_id=args.source,
            base_url=args.base_url,
            work_dir=args.work_dir,
            dry_run=args.dry_run,
        )
    print(stable_json(result, pretty=True), end="")
    if result.get("deferred"):
        print(
            f"::warning::Announcement refresh deferred for {config.id}; retained {result['announcements']} published announcements.",
            file=sys.stderr,
        )
    return 1 if "error" in result and not result.get("deferred") else 0


if __name__ == "__main__":
    raise SystemExit(main())
