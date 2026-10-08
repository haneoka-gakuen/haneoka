#!/usr/bin/env python3
"""The single command-line entry point for the resource pipeline."""

from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path
from typing import Any

from build.api import build_api
from build.assets import merge_unity_shards
from build.home_spots import build_home_spots, home_spot_source_bundle_paths
from build.announcements import build_announcements
from build.ktx2 import build_ktx2
from build.live2d import build_live2d
from build.release import assemble_release
from build.spine import build_spine
from core.config import ServerConfig, load_server_config
from core.contracts import SOURCE_SCHEMA
from core.fingerprints import build_fingerprint
from core.manifests import read_json, stable_json, write_json
from core.private_config import redact_private_text
from core.paths import build_layout, source_layout
from core.storage import cas_key
from extract.master import extract_master, validate_master_manifest
from core.hashes import sha256_bytes, sha256_file
from extract.unity_reuse import (
    extractor_identity,
    load_reuse_manifest,
    make_restore,
    prepare_unity_delta_plan,
)
from extract.cri import extract_cri
from extract.unity import extract_shard
from ingest.apks import ingest_package, probe_source_identity
from ingest.version_api import (
    cdn_authorization,
    discover_asset_version,
    proxy_from_env,
    resolve_version_endpoint,
)
from ingest.reuse import build_reuse_index
from ingest.unity import index_unity_dependencies
from publish.r2 import (
    R2Store,
    current_release_document,
    download_current_release_paths,
    fetch_package_artifact,
    fetch_source,
    garbage_collect_cas,
    prune_garupa_master_snapshots,
    prune_releases,
    prune_sources,
    prune_upload_checkpoints,
    publish_release,
    publish_source,
    restore_release_object,
)
from publish.song_reference import publish_meta_reference
from verify.release import verify_release
from verify.remote import verify_remote
from verify.source import verify_source


def _pipeline_hash(config: ServerConfig) -> str:
    return build_fingerprint(Path(__file__).resolve().parent.parent, config)


def build_id(config: ServerConfig, source_id: str) -> str:
    return f"b-{source_id}-{_pipeline_hash(config)[:16]}"


def _print(value: object) -> None:
    sys.stdout.write(redact_private_text(stable_json(value, pretty=True)))


def _source_summary(manifest: dict) -> dict:
    roles: dict[str, dict[str, int]] = {}
    for artifact in manifest.get("files", []):
        role = str(artifact.get("role") or "unknown")
        summary = roles.setdefault(role, {"files": 0, "bytes": 0})
        summary["files"] += 1
        summary["bytes"] += int(artifact.get("bytes") or 0)
    return {
        "schema": manifest.get("schema"),
        "server": manifest.get("server"),
        "sourceId": manifest.get("sourceId"),
        "fileCount": manifest.get("fileCount"),
        "fileBytes": manifest.get("fileBytes"),
        "roles": roles,
        "package": manifest.get("package"),
        "catalog": manifest.get("catalog"),
    }


def _release_summary(manifest: dict) -> dict:
    roles: dict[str, dict[str, int]] = {}
    for entry in manifest.get("entries", []):
        role = str(entry.get("role") or "unknown")
        summary = roles.setdefault(role, {"files": 0, "bytes": 0})
        summary["files"] += 1
        summary["bytes"] += int(entry.get("bytes") or 0)
    return {
        key: manifest.get(key)
        for key in (
            "schema",
            "server",
            "sourceId",
            "releaseId",
            "entryCount",
            "totalBytes",
        )
    } | {"roles": roles}


def _fields(value: dict, *names: str) -> dict:
    """Keep CLI output bounded while detailed stage manifests stay on disk."""
    return {name: value.get(name) for name in names if name in value}


def _source_package(server: str, source_id: str) -> Path:
    layout = source_layout(server, source_id)
    value = json.loads(layout.manifest.read_text("utf-8"))
    return layout.root / value["package"]["file"]


def _source_master_root(server: str, source_id: str) -> Path | None:
    layout = source_layout(server, source_id)
    master = read_json(layout.manifest).get("master")
    if master is None:
        return None
    file = layout.root / "master" / "MasterManifest.json"
    if (
        not isinstance(master, dict)
        or master.get("manifest") != "master/MasterManifest.json"
        or not file.is_file()
        or sha256_file(file) != master.get("manifestSha256")
    ):
        raise ValueError("source Master manifest integrity mismatch")
    validate_master_manifest(read_json(file), expected_version=master.get("version"))
    return layout.root


def _require_local_offline_source(config: ServerConfig, source_id: str) -> dict:
    """Return a complete local source snapshot without consulting any remote.

    ``run --offline`` deliberately never calls ingest: all source artifacts must
    already be present under ``data/servers/<server>/sources/<source-id>``.  A
    source can be restored from R2 beforehand with ``fetch-source``; that
    restore is a separate, explicit network operation.
    """

    layout = source_layout(config.id, source_id)
    restore_hint = (
        "Restore it from R2 first with:\n"
        f"  python scripts/pipeline.py --server {config.id} fetch-source "
        f"--source {source_id}"
    )
    if not layout.manifest.is_file():
        raise FileNotFoundError(
            "offline build requires a complete local source; "
            f"source manifest is missing: {layout.manifest}\n{restore_hint}"
        )
    try:
        # A source restored from R2 must be byte-for-byte identical to the
        # manifest before the build starts.  This also turns same-size local
        # corruption into an early failure rather than a subtly wrong release.
        return verify_source(config.id, source_id, check_hashes=True)
    except (FileNotFoundError, ValueError) as error:
        raise ValueError(
            f"offline build requires a complete local source: {source_id}\n"
            f"{restore_hint}\n"
            f"Local verification failed: {error}"
        ) from error


def command_ingest(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    reuse_index = None
    store = None
    if args.reuse:
        try:
            store = R2Store(config, args.concurrency)
            reuse_index = build_reuse_index(store, config)
            sys.stderr.write(
                f"catalog: reuse index covers {len(reuse_index)} artifacts from prior sources\n"
            )
        except Exception as error:  # noqa: BLE001 - reuse is best effort
            sys.stderr.write(f"warning: artifact reuse unavailable: {error}\n")
    base_source_manifest = None
    if args.base_source:
        try:
            store = store or R2Store(config, args.concurrency)
            base_source_manifest = store.get_json(
                f"servers/{config.id}/sources/{args.base_source}/source.json"
            )
            if not isinstance(base_source_manifest, dict):
                raise ValueError("base source manifest is missing or invalid")
        except Exception as error:  # noqa: BLE001 - adoption is best effort
            sys.stderr.write(f"warning: delta record adoption unavailable: {error}\n")
            base_source_manifest = None
    manifest = ingest_package(
        Path(args.input),
        config,
        Path(args.cache) if args.cache else None,
        args.concurrency,
        reuse_index=reuse_index,
        reuse_store=store,
        base_source_manifest=base_source_manifest,
    )
    _print(_source_summary(manifest))


def command_probe_source(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(ingest_package(Path(args.input), config, probe_only=True))


def _current_package_document(config, concurrency: int) -> dict:
    store = R2Store(config, concurrency)
    pointer = store.get_json(f"servers/{config.id}/current.json")
    source_id = str((pointer or {}).get("sourceId") or "")
    manifest = (
        store.get_json(f"servers/{config.id}/sources/{source_id}/source.json")
        if source_id
        else None
    )
    package = (manifest or {}).get("package") or {}
    digest = next(
        (
            str(item["sha256"])
            for item in (manifest or {}).get("files", [])
            if isinstance(item, dict) and item.get("role") == "package"
        ),
        "",
    )
    publisher = package.get("publisher")
    publisher = publisher if isinstance(publisher, dict) else {}
    return {
        "available": bool(
            digest and (package.get("versionCode") or package.get("versionName"))
        ),
        "sourceId": source_id,
        "versionCode": str(package.get("versionCode") or ""),
        "versionName": str(package.get("versionName") or ""),
        "sha256": digest,
        "casKey": cas_key(digest) if digest else "",
        "publisher": {
            str(k): str(v)
            for k, v in publisher.items()
            if isinstance(k, str) and isinstance(v, str)
        },
    }


def command_current_package(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    try:
        document = _current_package_document(config, args.concurrency)
    except Exception as error:  # noqa: BLE001 - callers treat unavailability as "no reuse"
        sys.stderr.write(f"warning: current package lookup failed: {error}\n")
        _print({"server": config.id, "available": False})
        return
    _print({"server": config.id, **document})


def command_probe_identity(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    if args.package_sha and args.version_code:
        document = {
            "available": True,
            "sha256": args.package_sha,
            "versionCode": args.version_code,
        }
    else:
        document = _current_package_document(config, args.concurrency)
    if not document.get("available"):
        raise ValueError(f"no published package identity available for {config.id}")
    _print(
        probe_source_identity(
            config,
            str(document["versionCode"]),
            str(document["sha256"]),
        )
    )


def command_cdn_credential(args: argparse.Namespace) -> None:
    """Report the effective CDN Authorization value and its source."""
    config = load_server_config(args.server)
    value = ""
    origin = "environment"
    discovered: dict[str, str] = {}
    if config.version_endpoint or config.version_catalog_path:
        try:
            info = discover_asset_version(
                resolve_version_endpoint(config.version_endpoint),
                config.platform,
                skip_resolution_check=config.skip_public_resolution_check,
                proxy=proxy_from_env(config.version_proxy_env),
            )
        except Exception as error:  # noqa: BLE001 - reported, then fall back
            sys.stderr.write(f"warning: server version discovery failed: {error}\n")
        else:
            discovered = {"version": info.version, "platformHash": info.platform_hash}
            if info.cdn_password:
                value = cdn_authorization(config.version_basic_user, info.cdn_password)
                origin = "server"
    if not value:
        raw = os.environ.get(config.authorization_env, "").strip()
        if raw:
            value = f"Basic {raw}" if " " not in raw else raw
    _print(
        {"server": config.id, "origin": origin, "authorization": value, **discovered}
    )


def command_fetch_release_document(args: argparse.Namespace) -> None:
    """Fetch and verify one JSON document from a published release."""

    config = load_server_config(args.server)
    store = R2Store(config, args.concurrency)
    release_id = args.release
    if not release_id:
        pointer = store.get_json(f"servers/{config.id}/current.json") or {}
        release_id = str(pointer.get("releaseId") or "")
    if not release_id:
        raise ValueError(f"no release selected for {config.id}")
    manifest = store.get_json(f"servers/{config.id}/releases/{release_id}/release.json")
    if not isinstance(manifest, dict) or manifest.get("releaseId") != release_id:
        raise ValueError(f"release manifest is missing or invalid: {release_id}")
    entry = next(
        (
            item
            for item in manifest.get("entries", [])
            if isinstance(item, dict) and item.get("path") == args.path
        ),
        None,
    )
    if entry is None:
        raise ValueError(f"release does not declare the document: {args.path}")
    digest = str(entry["sha256"])
    body = store.get_bytes(cas_key(digest))
    if body is None or len(body) != int(entry["bytes"]) or sha256_bytes(body) != digest:
        raise ValueError(f"release document CAS object is invalid: {args.path}")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(body)
    _print(
        {
            "server": config.id,
            "releaseId": release_id,
            "path": args.path,
            "bytes": len(body),
        }
    )


def command_verify_source(args: argparse.Namespace) -> None:
    _print(_source_summary(verify_source(args.server, args.source, not args.fast)))


def command_index_source(args: argparse.Namespace) -> None:
    layout = source_layout(args.server, args.source)
    manifest = read_json(layout.manifest)
    manifest["schema"] = SOURCE_SCHEMA
    manifest["unityIndex"] = index_unity_dependencies(
        layout.root, manifest.get("files", [])
    )
    write_json(layout.manifest, manifest, pretty=True)
    _print(_source_summary(verify_source(args.server, args.source, not args.fast)))


def _delta_context(config: ServerConfig, plan_path: str) -> Any:
    """Build a pinned DeltaContext from a plan file (delta builds only)."""

    from core.delta import DeltaContext, load_plan

    plan = load_plan(Path(plan_path))
    if plan["extractor"] != extractor_identity():
        raise ValueError(
            "delta plan was prepared by a different Unity extractor; "
            "reusable outputs must not be composed across extractor changes"
        )
    store = R2Store(config, 32)
    return DeltaContext(store, config.id, plan)


def command_prepare_unity_reuse(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    layout = source_layout(config.id, args.source)
    store = R2Store(config, args.concurrency)
    pointer = store.get_json(f"servers/{config.id}/current.json")
    if not isinstance(pointer, dict) or pointer.get("pipelineFingerprint") != _pipeline_hash(config)[:16]:
        raise ValueError("pipeline outputs changed; rebuild stages before adopting base derivatives")
    plan, stats = prepare_unity_delta_plan(
        store,
        config.id,
        read_json(layout.manifest),
        args.source,
        args.shard_count,
        args.concurrency,
    )
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    write_json(
        output / "unity-delta-plan.json",
        plan,
        pretty=True,
    )
    # Per-shard restore manifests stay available for the non-delta path.
    shards: list[dict[str, dict[str, Any]]] = [{} for _ in range(args.shard_count)]
    for digest, entry in plan["bundles"].items():
        shards[entry["shardIndex"]][digest] = entry
    for index, bundles in enumerate(shards):
        write_json(
            output / f"unity-reuse-{index:03d}.json",
            {
                "schema": "haneoka-unity-reuse-v1",
                "server": config.id,
                "sourceId": args.source,
                "shardIndex": index,
                "shardCount": args.shard_count,
                "extractor": extractor_identity(),
                "bundles": bundles,
            },
        )
    pending_by_shard: dict[str, int] = {}
    for digest, shard in plan["pending"].items():
        pending_by_shard[str(shard)] = pending_by_shard.get(str(shard), 0) + 1
    _print(
        {
            "server": config.id,
            "sourceId": args.source,
            "baseReleaseId": plan["baseReleaseId"],
            **stats,
            "pending": len(plan["pending"]),
            "pendingByShard": pending_by_shard,
        }
    )


def command_extract_master(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    layout = build_layout(config.id, identity)
    manifest = extract_master(
        _source_package(config.id, args.source),
        layout.master,
        config,
        snapshot_root=_source_master_root(config.id, args.source),
    )
    _print(
        {
            "buildId": identity,
            **_fields(manifest, "schema", "systemVersion", "tableCount", "rowCount"),
        }
    )


def command_extract_unity(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    count = args.shard_count or config.extraction_shards
    reuse_restore = None
    delta = None
    if args.delta_plan:
        context = _delta_context(config, args.delta_plan)
        reusable = set(context.shard_reusable(args.shard_index))
        bundles = {digest: context.plan_entry(digest) for digest in reusable}
        delta = (reusable, bundles)
        sys.stderr.write(
            f"unity: delta shard {args.shard_index} skips {len(reusable)} reusable bundles\n"
        )
    elif args.reuse_manifest:
        try:
            entries = load_reuse_manifest(Path(args.reuse_manifest))
            reuse_restore = make_restore(R2Store(config, 8), entries)
            sys.stderr.write(f"unity: reuse manifest covers {len(entries)} bundles\n")
        except Exception as error:  # noqa: BLE001 - extraction must proceed without reuse
            sys.stderr.write(f"warning: Unity reuse unavailable: {error}\n")
    fetch_store: list[R2Store] = []

    def fetch_original(digest: str, target: Path) -> None:
        # Self-heal a delta-adopted record that still needs a fresh
        # extraction: restore its original bundle from the source CAS.
        # The store is created lazily so offline local runs never touch R2.
        if not fetch_store:
            fetch_store.append(R2Store(config, 8))
        fetch_store[0].download_file(cas_key(digest), target, expected_sha256=digest)

    result = extract_shard(
        config.id,
        args.source,
        identity,
        args.shard_index,
        count,
        reuse_restore,
        delta,
        fetch_original,
    )
    _print(
        _fields(
            result,
            "schema",
            "server",
            "sourceId",
            "buildId",
            "shardIndex",
            "shardCount",
            "bundleCount",
            "sourceCount",
            "objectCount",
            "deltaReusableBundleCount",
        )
    )


def command_merge_unity(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    count = args.shard_count or config.extraction_shards
    delta = _delta_context(config, args.delta_plan) if args.delta_plan else None
    _print(merge_unity_shards(config.id, args.source, identity, count, delta))


def command_extract_cri(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    snapshot = None
    store = None
    delta = None
    if args.delta_plan:
        delta = _delta_context(config, args.delta_plan)
        try:
            document = delta.base_document("metadata/cri.json")
            snapshot = {
                "releaseId": delta.base_release_id,
                "document": document,
                "entries": delta.entries(),
            }
        except Exception as error:  # noqa: BLE001 - declare falls back to decode
            sys.stderr.write(f"warning: base CRI document unavailable: {error}\n")
            snapshot = None
    elif args.reuse_current:
        try:
            store = R2Store(config, args.reuse_concurrency)
            snapshot = current_release_document(store, config, "metadata/cri.json")
        except Exception as error:
            sys.stderr.write(
                f"CRI current-release reuse is unavailable; decoding all sources: {error}\n"
            )
    restore_output = None
    if delta is not None:
        # Pinned restore used only by the music-video re-mux fallback.
        restore_output = lambda output, target: delta.fetch_release_path(
            str(output["path"]), target
        )
    elif store is not None and isinstance(snapshot, dict):
        restore_output = lambda output, target: restore_release_object(
            store, snapshot, output, target
        )
    result = extract_cri(
        config,
        args.source,
        identity,
        args.concurrency,
        reuse_manifest=snapshot.get("document") if isinstance(snapshot, dict) else None,
        restore_output=restore_output,
        reuse_concurrency=args.reuse_concurrency,
        delta=delta,
    )
    _print(
        _fields(
            result,
            "schema",
            "server",
            "sourceId",
            "buildId",
            "sourceCount",
            "outputCount",
            "reuse",
        )
    )


def _preview_reuse_inputs(
    config: ServerConfig,
    document_path: str,
    reuse_concurrency: int,
    delta: Any = None,
) -> tuple[dict | None, object | None]:
    """Load the pinned base release's stage document for preview reuse."""

    if delta is not None:
        try:
            snapshot = {
                "releaseId": delta.base_release_id,
                "document": delta.base_document(document_path),
                "entries": delta.entries(),
            }
        except Exception as error:
            sys.stderr.write(
                f"{document_path} base-release reuse is unavailable; rendering all previews: {error}\n"
            )
            return None, None
        return snapshot.get("document"), _preview_restore(delta, snapshot)

    try:
        store = R2Store(config, reuse_concurrency)
        snapshot = current_release_document(store, config, document_path)
    except Exception as error:
        sys.stderr.write(
            f"{document_path} current-release reuse is unavailable; rendering all previews: {error}\n"
        )
        return None, None
    if not isinstance(snapshot, dict):
        return None, None
    return snapshot.get("document"), _preview_restore(store, snapshot)


def _preview_restore(store: Any, snapshot: dict) -> object:
    """Build the preview-restore callable shared by the Live2D and Spine stages."""

    entries = snapshot.get("entries")

    def restore(path: str, sha256: str, target: Path) -> None:
        if not isinstance(entries, dict):
            raise ValueError("current release snapshot has no path entries")
        entry = entries.get(path)
        if not isinstance(entry, dict) or str(entry.get("sha256") or "") != sha256:
            raise ValueError(
                f"current release does not declare the reusable preview: {path}"
            )
        if isinstance(store, R2Store):
            restore_release_object(
                store,
                snapshot,
                {
                    "path": path,
                    "sha256": sha256,
                    "bytes": int(entry.get("bytes") or -1),
                },
                target,
            )
        else:
            # DeltaContext: restore from the pinned base release entries.
            store.fetch_release_path(path, target)

    return restore


def command_build_live2d(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    reuse_manifest, restore_output = (None, None)
    delta = None
    base_document = None
    if args.delta_plan:
        delta = _delta_context(config, args.delta_plan)
        reuse_manifest, restore_output = _preview_reuse_inputs(
            config, "metadata/live2d.json", args.reuse_concurrency, delta=delta
        )
        try:
            base_document = delta.base_document("metadata/live2d.json")
        except Exception as error:  # noqa: BLE001 - adoption is best effort
            sys.stderr.write(f"warning: base Live2D document unavailable: {error}\n")
    elif args.reuse_current:
        reuse_manifest, restore_output = _preview_reuse_inputs(
            config, "metadata/live2d.json", args.reuse_concurrency
        )
    result = build_live2d(
        config,
        args.source,
        identity,
        include_bc7=getattr(args, "live2d_bc7", False),
        reuse_manifest=reuse_manifest,
        restore_output=restore_output,
        reuse_concurrency=args.reuse_concurrency,
        delta=delta,
        base_document=base_document,
    )
    _print(
        _fields(
            result,
            "schema",
            "server",
            "sourceId",
            "buildId",
            "modelCount",
            "skippedModelCount",
            "previewReusedCount",
            "previewReuseRestoreFailureCount",
        )
    )


def command_build_spine(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    reuse_manifest, restore_output = (None, None)
    delta = None
    base_document = None
    if args.delta_plan:
        delta = _delta_context(config, args.delta_plan)
        reuse_manifest, restore_output = _preview_reuse_inputs(
            config, "metadata/spine.json", args.reuse_concurrency, delta=delta
        )
        try:
            base_document = delta.base_document("metadata/spine.json")
        except Exception as error:  # noqa: BLE001 - adoption is best effort
            sys.stderr.write(f"warning: base Spine document unavailable: {error}\n")
    elif args.reuse_current:
        reuse_manifest, restore_output = _preview_reuse_inputs(
            config, "metadata/spine.json", args.reuse_concurrency
        )
    result = build_spine(
        config,
        args.source,
        identity,
        reuse_manifest=reuse_manifest,
        restore_output=restore_output,
        reuse_concurrency=args.reuse_concurrency,
        delta=delta,
        base_document=base_document,
    )
    _print(
        _fields(
            result,
            "schema",
            "server",
            "sourceId",
            "modelCount",
            "playableModelCount",
            "unavailableModelCount",
            "previewRenderedCount",
            "previewReusedCount",
            "previewReuseRestoreFailureCount",
            "renderRecipePreviewRenderedCount",
            "renderRecipeCount",
            "unavailableRenderRecipeCount",
        )
    )


def command_build_home_spots(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    delta = None
    base_document = None
    if args.delta_plan:
        delta = _delta_context(config, args.delta_plan)
        try:
            base_document = delta.base_document("metadata/home-spots.json")
        except Exception as error:  # noqa: BLE001 - adoption is best effort
            sys.stderr.write(f"warning: base Home Spot document unavailable: {error}\n")
    result = build_home_spots(
        config,
        args.source,
        identity,
        delta=delta,
        base_document=base_document,
    )
    _print(
        {
            "buildId": identity,
            **_fields(
                result,
                "schema",
                "server",
                "sourceId",
                "sceneCount",
                "adoptedSceneCount",
            ),
        }
    )


def command_build_api(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    base_release_entries = None
    restore_archive = None
    restore_output = None
    if args.delta_plan:
        delta = _delta_context(config, args.delta_plan)
        base_release_entries = delta.entries()
        restore_archive = lambda digest, target: delta.fetch_archive(digest, target)  # noqa: E731
        restore_output = lambda path, target: delta.fetch_release_path(path, target)  # noqa: E731
    _print(
        build_api(
            config,
            args.source,
            identity,
            base_release_entries,
            restore_archive,
            restore_output,
        )
    )


def command_build_ktx2(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    texture_metadata = read_json(build_layout(config.id, identity).metadata / "spine.json")
    if texture_metadata.get("server") != config.id or texture_metadata.get("sourceId") != args.source:
        raise ValueError("runtime texture selection metadata belongs to a different server/source")
    delta = _delta_context(config, args.delta_plan) if args.delta_plan else None
    if delta is not None and delta.source_id != args.source:
        raise ValueError("texture delta source does not match the requested source")
    stores = []

    def fetch_original(digest: str, target: Path) -> None:
        if delta is not None:
            delta.fetch_original_bundle(digest, target)
            return
        if not stores:
            stores.append(R2Store(config, 2))
        stores[0].download_file(cas_key(digest), target, expected_sha256=digest)

    _print(build_ktx2(config.id, identity, source_id=args.source,
                      fetch_original=fetch_original, allow_basis_reencode=args.basis_reencode))


def command_build_textless_stamps(args: argparse.Namespace) -> None:
    from build.stamp_pipeline import build_textless_stamps, MANIFEST

    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    delta = _delta_context(config, args.delta_plan) if args.delta_plan else None
    reuse_manifest = None
    restore_output = None
    if config.id in ("intl", "intl-cbt") and delta is None and args.reuse_current:
        try:
            store = R2Store(config, 2)
            snapshot = current_release_document(store, config, MANIFEST)
            if isinstance(snapshot, dict):
                reuse_manifest = snapshot["document"]
                restore_output = _preview_restore(store, snapshot)
                # _preview_restore also pins the expected object SHA.
                pinned = restore_output
                restore_output = lambda path, target: pinned(path, snapshot["entries"][path]["sha256"], target)
        except Exception as error:
            sys.stderr.write(f"stamp current-release cache unavailable; rebuilding: {error}\n")
    _print(build_textless_stamps(config.id, args.source, identity,
                                 model=Path(args.model) if args.model else None,
                                 delta=delta,
                                 reuse_manifest=reuse_manifest, restore_output=restore_output,
                                 seed_manifest=Path(args.seed_manifest) if args.seed_manifest else None,
                                 seed_provenance=Path(args.seed_provenance) if args.seed_provenance else None,
                                 repair_cache_manifest=Path(args.repair_cache_manifest) if args.repair_cache_manifest else None))


def command_build_announcements(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    _print(build_announcements(config.id, identity, args.source))


def command_build_release(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    base_manifest = None
    if args.delta_plan:
        base_manifest = _delta_context(config, args.delta_plan).base_manifest()
    _print(
        _release_summary(
            assemble_release(config.id, args.source, identity, base_manifest)
        )
    )


def _run_build(
    config: ServerConfig,
    source_id: str,
    identity: str,
    include_ktx2: bool,
    include_live2d_bc7: bool = False,
    include_basis_reencode: bool = False,
    offline: bool = False,
) -> dict:
    extract_master(
        _source_package(config.id, source_id),
        build_layout(config.id, identity).master,
        config,
        snapshot_root=_source_master_root(config.id, source_id),
    )
    # UnityPy decoding is CPU-heavy Python work. Use separate processes locally;
    # GitHub Actions already distributes these shards across independent jobs.
    workers = min(config.extraction_shards, os.cpu_count() or 1, 4)
    with ProcessPoolExecutor(max_workers=workers) as executor:
        futures = [
            executor.submit(
                extract_shard,
                config.id,
                source_id,
                identity,
                index,
                config.extraction_shards,
            )
            for index in range(config.extraction_shards)
        ]
        for future in futures:
            future.result()
    merge_unity_shards(config.id, source_id, identity, config.extraction_shards)
    stages = [
        lambda: extract_cri(config, source_id, identity),
        lambda: build_live2d(
            config,
            source_id,
            identity,
            include_bc7=include_live2d_bc7,
        ),
        lambda: build_spine(config, source_id, identity),
        lambda: build_home_spots(config, source_id, identity),
    ]
    with ThreadPoolExecutor(max_workers=len(stages)) as executor:
        for future in [executor.submit(stage) for stage in stages]:
            future.result()
    # Runtime metadata is a prerequisite for exact atlas selection.
    if include_ktx2 or include_basis_reencode:
        texture_metadata = read_json(build_layout(config.id, identity).metadata / "spine.json")
        if texture_metadata.get("server") != config.id or texture_metadata.get("sourceId") != source_id:
            raise ValueError("runtime texture selection metadata belongs to a different server/source")
        build_ktx2(config.id, identity, source_id=source_id,
                   allow_basis_reencode=include_basis_reencode)
    build_api(config, source_id, identity)
    from build.stamp_pipeline import build_textless_stamps
    build_textless_stamps(config.id, source_id, identity, allow_model_download=not offline)
    # NOTE: the Sonolus payload is intentionally NOT built here. It is decoupled
    # from the resource pipeline (it is slow and changes independently): the engine
    # is a shared global asset built via `pnpm sonolus:build`, and chart data is
    # read from this release at serve time.
    return assemble_release(config.id, source_id, identity)


def command_run(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    if args.offline:
        if args.input:
            raise ValueError(
                "--offline cannot be combined with --input; use --source instead"
            )
        if not args.source:
            raise ValueError("--offline requires --source")
        if args.cache:
            raise ValueError("--cache is only valid when ingesting --input")
        if args.publish:
            raise ValueError(
                "--offline does not publish; publish a verified release separately"
            )
        source = _require_local_offline_source(config, args.source)
    else:
        if args.source:
            raise ValueError("--source requires --offline")
        if not args.input:
            raise ValueError("run requires --input, or --offline --source")
        source = ingest_package(
            Path(args.input),
            config,
            Path(args.cache) if args.cache else None,
            args.concurrency,
        )

    store = R2Store(config, args.concurrency) if args.publish else None
    if store:
        publish_source(store, config, source["sourceId"])
    identity = build_id(config, source["sourceId"])
    release = _run_build(
        config,
        source["sourceId"],
        identity,
        args.ktx2,
        getattr(args, "live2d_bc7", False),
        getattr(args, "basis_reencode", False),
        offline=args.offline,
    )
    pointer = publish_release(store, config, release["releaseId"]) if store else None
    _print(
        {
            "source": _source_summary(source),
            "release": _release_summary(release),
            **({"pointer": pointer} if pointer else {}),
        }
    )


def command_build_id(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    fingerprint = _pipeline_hash(config)
    _print(
        {
            "server": config.id,
            "sourceId": args.source,
            "buildId": build_id(config, args.source),
            "buildFingerprint": fingerprint,
        }
    )


def command_verify_release(args: argparse.Namespace) -> None:
    _print(_release_summary(verify_release(args.server, args.release, not args.fast)))


def command_verify_remote(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(
        verify_remote(
            R2Store(config, args.concurrency),
            config,
            not args.fast,
            expected_release_id=args.release,
        )
    )


def command_publish_source(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(publish_source(R2Store(config, args.concurrency), config, args.source))


def command_fetch_source(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    exclude_sha256 = None
    if args.exclude_sha256_file:
        values = json.loads(Path(args.exclude_sha256_file).read_text("utf-8"))
        if not isinstance(values, list):
            raise ValueError("exclude-sha256 file must contain a JSON array")
        exclude_sha256 = {str(value) for value in values}
    _print(
        fetch_source(
            R2Store(config, args.concurrency),
            config,
            args.source,
            roles=set(args.role or []),
            shard_index=args.shard_index,
            shard_count=args.shard_count,
            exclude_sha256=exclude_sha256,
        )
    )


def command_fetch_home_spots(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    paths = set(home_spot_source_bundle_paths(config, args.source, identity))
    _print(
        fetch_source(
            R2Store(config, args.concurrency),
            config,
            args.source,
            paths=paths,
        )
    )


def command_fetch_package(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(
        fetch_package_artifact(
            R2Store(config, args.concurrency),
            args.key,
            Path(args.output),
        )
    )


# Runtime slices the Sonolus engine payload build reads from a release
# (see packages/sonolus/scripts/build-{native-effect-assets,original-assets}.ts).
# Everything else in the payload is built from vendored sources or projected
# dynamically per release, so these paths are the complete release-side input.
SONOLUS_INPUT_PREFIXES = (
    "runtime/note-se/",
    "runtime/unity-json/Assets/AddressableResources/Effect/Live/NoteEffect/effect001/",
    "runtime/unity-json/Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/",
    "runtime/unity-json/Assets/AddressableResources/Effect/Live/NoteEffect/effect001Simple/",
    "runtime/unity-json/Assets/AddressableResources/Effect/Live/NoteEffect/common/",
    "runtime/unity-json/Assets/AddressableResources/Effect/Live/LaneEffect/effect001/",
    "assets/Assets/AddressableResources/Effect/Live/NoteEffect/common/",
    "assets/Assets/AddressableResources/Live/Images/lane_effect_white.png",
    "runtime/unity/Assets/AddressableResources/Effect/Live/NoteEffect/common/",
    "runtime/unity-json/Assets/AddressableResources/Live/Images/lane_effect_white.png/",
    "runtime/unity/Assets/AddressableResources/Live/Images/lane_effect_white.png/",
)
SONOLUS_INPUT_EXACT_PATHS = ("metadata/cri.json",)


def command_fetch_sonolus_inputs(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(
        download_current_release_paths(
            R2Store(config, args.concurrency),
            config,
            SONOLUS_INPUT_PREFIXES,
            SONOLUS_INPUT_EXACT_PATHS,
            Path(args.output),
        )
    )


def command_publish_release(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(
        publish_release(
            R2Store(config, args.concurrency),
            config,
            args.release,
            check_hashes=not args.fast,
        )
    )


def command_prune_sources(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(prune_sources(R2Store(config, args.concurrency), config))


def command_publish_meta_reference(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(publish_meta_reference(
        R2Store(config, args.concurrency), config.id, args.release, args.source,
        Path(args.recipe), Path(args.request), dry_run=args.dry_run,
        output=Path(args.output) if args.output else None,
    ))


def command_prune_releases(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(prune_releases(R2Store(config, args.concurrency), config))


def command_prune_uploads(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(
        prune_upload_checkpoints(
            R2Store(config, args.concurrency),
            config,
            args.stale_uploading_age_hours,
        )
    )


def command_prune_garupa_master(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(
        prune_garupa_master_snapshots(
            R2Store(config, args.concurrency),
            server=args.garupa_server,
            retain=args.retain,
        )
    )


def command_gc_r2(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    _print(
        garbage_collect_cas(
            R2Store(config, args.concurrency),
            args.dry_run,
            args.minimum_age_hours,
        )
    )


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--server", default="jp-cbt", help="server configuration id")
    commands = root.add_subparsers(dest="command", required=True)

    ingest = commands.add_parser(
        "ingest", help="normalize an APK, APKS/XAPK, or split APK directory"
    )
    ingest.add_argument("--input", required=True)
    ingest.add_argument(
        "--cache", help="flat cache of exact original download filenames"
    )
    ingest.add_argument("--concurrency", type=int, default=12)
    ingest.add_argument(
        "--reuse",
        action="store_true",
        help="restore unchanged bundle names from prior sources in R2 instead of downloading",
    )
    ingest.add_argument(
        "--base-source",
        help="adopt unchanged bundle records from this published source without transferring bytes",
    )
    ingest.set_defaults(run=command_ingest)

    probe_identity = commands.add_parser(
        "probe-identity",
        help="compute the live source identity from stored package identity and fresh catalogs",
    )
    probe_identity.add_argument("--package-sha")
    probe_identity.add_argument("--version-code")
    probe_identity.add_argument("--concurrency", type=int, default=8)
    probe_identity.set_defaults(run=command_probe_identity)
    current_package = commands.add_parser(
        "current-package",
        help="report the published source's package fingerprint and CAS key",
    )
    current_package.add_argument("--concurrency", type=int, default=8)
    current_package.set_defaults(run=command_current_package)
    credential = commands.add_parser(
        "cdn-credential",
        help="report the effective CDN authorization and its source (server or secret)",
    )
    credential.set_defaults(run=command_cdn_credential)
    probe = commands.add_parser(
        "probe-source",
        help="identify package and live catalog without downloading bundles",
    )
    probe.add_argument("--input", required=True)
    probe.set_defaults(run=command_probe_source)

    identity = commands.add_parser("build-id", help="derive the build id for a source")
    identity.add_argument("--source", required=True)
    identity.set_defaults(run=command_build_id)

    document_fetch = commands.add_parser(
        "fetch-release-document",
        help="fetch one verified JSON document from a published release",
    )
    document_fetch.add_argument(
        "--release", help="release id; defaults to the current pointer"
    )
    document_fetch.add_argument("--path", required=True)
    document_fetch.add_argument("--output", required=True)
    document_fetch.add_argument("--concurrency", type=int, default=8)
    document_fetch.set_defaults(run=command_fetch_release_document)

    source_verify = commands.add_parser(
        "verify-source", help="verify a local immutable source"
    )
    source_verify.add_argument("--source", required=True)
    source_verify.add_argument(
        "--fast", action="store_true", help="skip content rehashing"
    )
    source_verify.set_defaults(run=command_verify_source)

    source_index = commands.add_parser(
        "index-source",
        help="index exact Unity CAB dependencies in an existing local source",
    )
    source_index.add_argument("--source", required=True)
    source_index.add_argument(
        "--fast", action="store_true", help="skip content rehashing"
    )
    source_index.set_defaults(run=command_index_source)

    master = commands.add_parser(
        "extract-master", help="decrypt all Master tables from the normalized package"
    )
    master.add_argument("--source", required=True)
    master.add_argument("--build")
    master.set_defaults(run=command_extract_master)

    unity = commands.add_parser(
        "extract-unity", help="process one deterministic Unity shard"
    )
    unity.add_argument("--source", required=True)
    unity.add_argument("--build")
    unity.add_argument("--shard-index", type=int, required=True)
    unity.add_argument("--shard-count", type=int)
    unity.add_argument(
        "--reuse-manifest",
        help="reuse manifest from prepare-unity-reuse; restores unchanged bundles from the current release",
    )
    unity.add_argument(
        "--delta-plan",
        help="delta plan from prepare-unity-reuse; extract only pending bundles, compose the rest from the base release",
    )
    unity.set_defaults(run=command_extract_unity)

    reuse_parser = commands.add_parser(
        "prepare-unity-reuse",
        help="list per-shard Unity bundles reusable from the current release",
    )
    reuse_parser.add_argument("--source", required=True)
    reuse_parser.add_argument("--shard-count", type=int, required=True)
    reuse_parser.add_argument("--output-dir", required=True)
    reuse_parser.add_argument("--concurrency", type=int, default=32)
    reuse_parser.set_defaults(run=command_prepare_unity_reuse)

    merge = commands.add_parser("merge-unity", help="merge and index all Unity shards")
    merge.add_argument("--source", required=True)
    merge.add_argument("--build")
    merge.add_argument("--shard-count", type=int)
    merge.add_argument(
        "--delta-plan",
        help="delta plan from prepare-unity-reuse; compose reusable outputs from the base release",
    )
    merge.set_defaults(run=command_merge_unity)

    cri = commands.add_parser(
        "extract-cri", help="decode original and embedded CRI payloads"
    )
    cri.add_argument("--source", required=True)
    cri.add_argument("--build")
    cri.add_argument("--concurrency", type=int, default=2)
    cri.add_argument(
        "--reuse-current",
        action="store_true",
        help="reuse matching CRI outputs from the selected R2 release CAS",
    )
    cri.add_argument(
        "--delta-plan",
        help="delta plan from prepare-unity-reuse; declare reusable sources from the pinned base release",
    )
    cri.add_argument("--reuse-concurrency", type=int, default=32)
    cri.set_defaults(run=command_extract_cri)

    live2d = commands.add_parser(
        "build-live2d", help="build Live2D catalog/runtime derivatives"
    )
    live2d.add_argument("--source", required=True)
    live2d.add_argument("--build")
    live2d.add_argument(
        "--reuse-current",
        action="store_true",
        help="restore unchanged models' previews from the selected R2 release CAS",
    )
    live2d.add_argument(
        "--delta-plan",
        help="delta plan from prepare-unity-reuse; adopt unchanged models from the pinned base release",
    )
    live2d.add_argument(
        "--live2d-bc7",
        action="store_true",
        help="also produce lossy desktop BC7 KTX2 variants (native ASTC remains enabled by default)",
    )
    live2d.add_argument("--reuse-concurrency", type=int, default=32)
    live2d.set_defaults(run=command_build_live2d)

    spine = commands.add_parser(
        "build-spine",
        help="build generic Spine metadata and static setup-pose previews",
    )
    spine.add_argument("--source", required=True)
    spine.add_argument("--build")
    spine.add_argument(
        "--reuse-current",
        action="store_true",
        help="restore unchanged models' previews from the selected R2 release CAS",
    )
    spine.add_argument(
        "--delta-plan",
        help="delta plan from prepare-unity-reuse; adopt unchanged models from the pinned base release",
    )
    spine.add_argument("--reuse-concurrency", type=int, default=32)
    spine.set_defaults(run=command_build_spine)

    home_spots = commands.add_parser(
        "build-home-spots", help="build strict Home Spot background GLB derivatives"
    )
    home_spots.add_argument("--source", required=True)
    home_spots.add_argument("--build")
    home_spots.add_argument(
        "--delta-plan",
        help="delta plan from prepare-unity-reuse; adopt unchanged scenes from the pinned base release",
    )
    home_spots.set_defaults(run=command_build_home_spots)

    api = commands.add_parser("build-api", help="build canonical catalog documents")
    api.add_argument("--source", required=True)
    api.add_argument("--build")
    api.add_argument(
        "--delta-plan",
        help="compose reusable outputs against the plan's pinned base release",
    )
    api.set_defaults(run=command_build_api)

    ktx2 = commands.add_parser(
        "build-ktx2", help="package selected original runtime texture blocks"
    )
    ktx2.add_argument("--source", required=True)
    ktx2.add_argument("--build")
    ktx2.add_argument("--delta-plan", help="pinned source/CAS restore plan for selected texture bundles and dependencies")
    ktx2.add_argument("--basis-reencode", action="store_true", help="opt in to lossy runtime-only Basis derivatives; canonical PNGs stay unchanged")
    ktx2.set_defaults(run=command_build_ktx2)

    announcements = commands.add_parser(
        "build-announcements",
        help="collect live in-game announcements into the release",
    )
    announcements.add_argument("--source", required=True)
    announcements.add_argument("--build")
    announcements.set_defaults(run=command_build_announcements)

    release = commands.add_parser("build-release", help="assemble an immutable release")
    release.add_argument("--source", required=True)
    release.add_argument("--build")
    release.add_argument(
        "--delta-plan",
        help="delta plan from prepare-unity-reuse; compose the release against the pinned base release",
    )
    release.set_defaults(run=command_build_release)

    stamp_build = commands.add_parser("build-textless-stamps", help="build all international stamps for normal release publication")
    stamp_build.add_argument("--source", required=True)
    stamp_build.add_argument("--build")
    stamp_build.add_argument("--delta-plan")
    stamp_build.add_argument("--reuse-current", action="store_true", help="reuse matching images from one pinned current release")
    stamp_build.add_argument("--model", help="verified detector; defaults to the pinned download/cache")
    stamp_build.add_argument("--seed-manifest", help="content-verified reviewed local images for initial cache population")
    stamp_build.add_argument("--seed-provenance", help="portable reviewed repair metadata bound into the production recipe")
    stamp_build.add_argument("--repair-cache-manifest", help="verified repair objects accompanying the reviewed seed")
    stamp_build.set_defaults(run=command_build_textless_stamps)

    run = commands.add_parser(
        "run",
        help="run the complete local pipeline from an input package or a verified local source",
    )
    run_input = run.add_mutually_exclusive_group()
    run_input.add_argument(
        "--input", help="APK, APKS/XAPK, or split-APK directory to ingest"
    )
    run_input.add_argument(
        "--source", help="existing local immutable source id (requires --offline)"
    )
    run.add_argument(
        "--offline",
        action="store_true",
        help="build only --source already stored locally; never contacts the game CDN or R2",
    )
    run.add_argument("--cache", help="flat cache of exact original download filenames")
    run.add_argument("--ktx2", action="store_true", help="package original runtime blocks after runtime stages")
    run.add_argument("--basis-reencode", action="store_true", help="opt in to lossy runtime-only Basis derivatives")
    run.add_argument(
        "--live2d-bc7",
        action="store_true",
        help="also produce lossy desktop BC7 KTX2 Live2D variants (native ASTC remains enabled by default)",
    )
    run.add_argument(
        "--publish",
        action="store_true",
        help="publish the source and verified release to R2",
    )
    run.add_argument("--concurrency", type=int, default=12)
    run.set_defaults(run=command_run)

    release_verify = commands.add_parser(
        "verify-release", help="verify a complete immutable release"
    )
    release_verify.add_argument("--release", required=True)
    release_verify.add_argument(
        "--fast", action="store_true", help="skip content rehashing"
    )
    release_verify.set_defaults(run=command_verify_release)

    remote_verify = commands.add_parser(
        "verify-remote", help="verify the selected release and objects in R2"
    )
    remote_verify.add_argument(
        "--release", help="require current.json to select this release id"
    )
    remote_verify.add_argument(
        "--fast",
        action="store_true",
        help="verify only the pointer and release manifest",
    )
    remote_verify.add_argument("--concurrency", type=int, default=12)
    remote_verify.set_defaults(run=command_verify_remote)

    source_publish = commands.add_parser(
        "publish-source", help="publish source artifacts to R2 CAS"
    )
    source_publish.add_argument("--source", required=True)
    source_publish.add_argument("--concurrency", type=int, default=64)
    source_publish.set_defaults(run=command_publish_source)

    package_fetch = commands.add_parser(
        "fetch-package", help="fetch one APK/APKS package from the R2 artifact store"
    )
    package_fetch.add_argument("--key", required=True)
    package_fetch.add_argument("--output", required=True)
    package_fetch.add_argument("--concurrency", type=int, default=12)
    package_fetch.set_defaults(run=command_fetch_package)

    source_fetch = commands.add_parser(
        "fetch-source", help="fetch selected immutable source files from R2"
    )
    source_fetch.add_argument("--source", required=True)
    source_fetch.add_argument(
        "--role", action="append", help="source file role to fetch; may be repeated"
    )
    source_fetch.add_argument("--shard-index", type=int)
    source_fetch.add_argument("--shard-count", type=int)
    source_fetch.add_argument(
        "--exclude-sha256-file",
        help="JSON array of content digests to skip (delta fetches only what changed)",
    )
    source_fetch.add_argument("--concurrency", type=int, default=12)
    source_fetch.set_defaults(run=command_fetch_source)

    home_spot_fetch = commands.add_parser(
        "fetch-home-spots",
        help="fetch only the original Unity bundles required by the Home Spot build",
    )
    home_spot_fetch.add_argument("--source", required=True)
    home_spot_fetch.add_argument("--build")
    home_spot_fetch.add_argument("--concurrency", type=int, default=12)
    home_spot_fetch.set_defaults(run=command_fetch_home_spots)

    sonolus_inputs = commands.add_parser(
        "fetch-sonolus-inputs",
        help="fetch the release runtime slices the Sonolus engine payload build needs",
    )
    sonolus_inputs.add_argument("--output", required=True)
    sonolus_inputs.add_argument("--concurrency", type=int, default=12)
    sonolus_inputs.set_defaults(run=command_fetch_sonolus_inputs)

    release_publish = commands.add_parser(
        "publish-release", help="publish and atomically promote an R2 release"
    )
    release_publish.add_argument("--release", required=True)
    release_publish.add_argument(
        "--fast",
        action="store_true",
        help="trust hashes from the immediately preceding release build",
    )
    release_publish.add_argument("--concurrency", type=int, default=64)
    release_publish.set_defaults(run=command_publish_release)

    reference_publish = commands.add_parser(
        "publish-meta-reference", help="publish an explicit same-pin reference sidecar"
    )
    reference_publish.add_argument("--release", required=True)
    reference_publish.add_argument("--source", required=True)
    reference_publish.add_argument("--recipe", required=True)
    reference_publish.add_argument("--request", required=True)
    reference_publish.add_argument("--output", help="save the evaluated reference locally")
    reference_publish.add_argument("--dry-run", action="store_true")
    reference_publish.add_argument("--concurrency", type=int, default=4)
    reference_publish.set_defaults(run=command_publish_meta_reference)

    source_prune = commands.add_parser(
        "prune-sources",
        help="delete source manifests not referenced by a retained release",
    )
    source_prune.add_argument("--concurrency", type=int, default=64)
    source_prune.set_defaults(run=command_prune_sources)

    release_prune = commands.add_parser(
        "prune-releases",
        help="delete non-current R2 releases beyond the configured retention",
    )
    release_prune.add_argument("--concurrency", type=int, default=64)
    release_prune.set_defaults(run=command_prune_releases)

    upload_prune = commands.add_parser(
        "prune-uploads", help="delete resumable R2 upload checkpoints after publication"
    )
    upload_prune.add_argument("--concurrency", type=int, default=64)
    upload_prune.add_argument("--stale-uploading-age-hours", type=int, default=168)
    upload_prune.set_defaults(run=command_prune_uploads)

    garupa_prune = commands.add_parser(
        "prune-garupa-master",
        help="retain the selected Garupa Master snapshot and its two newest predecessors",
    )
    garupa_prune.add_argument("--garupa-server", default="jp")
    garupa_prune.add_argument("--retain", type=int, default=3)
    garupa_prune.add_argument("--concurrency", type=int, default=64)
    garupa_prune.set_defaults(run=command_prune_garupa_master)

    r2_gc = commands.add_parser(
        "gc-r2",
        help="delete unreferenced objects from the shared R2 content-addressed store",
    )
    r2_gc.add_argument("--dry-run", action="store_true")
    r2_gc.add_argument("--minimum-age-hours", type=int, default=24)
    r2_gc.add_argument("--concurrency", type=int, default=64)
    r2_gc.set_defaults(run=command_gc_r2)
    return root


def main() -> int:
    args = parser().parse_args()
    args.run(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
