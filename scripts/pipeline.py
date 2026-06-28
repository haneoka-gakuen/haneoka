#!/usr/bin/env python3
"""The single command-line entry point for the resource pipeline."""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from build.api import build_api
from build.assets import merge_unity_shards
from build.home_spots import build_home_spots, home_spot_source_bundle_paths
from build.ktx2 import build_ktx2
from build.live2d import build_live2d
from build.release import assemble_release
from build.sonolus import build_sonolus
from core.config import ServerConfig, load_server_config
from core.contracts import SOURCE_SCHEMA
from core.fingerprints import build_fingerprint
from core.manifests import read_json, stable_json, write_json
from core.paths import build_layout, source_layout
from extract.master import extract_master
from extract.cri import extract_cri
from extract.unity import extract_shard
from ingest.apks import ingest_package
from ingest.unity import index_unity_dependencies
from publish.r2 import (
    R2Store,
    current_release_document,
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
from verify.release import verify_release
from verify.remote import verify_remote
from verify.source import verify_source


def _pipeline_hash(config: ServerConfig) -> str:
    return build_fingerprint(Path(__file__).resolve().parent.parent, config)


def build_id(config: ServerConfig, source_id: str) -> str:
    return f"b-{source_id}-{_pipeline_hash(config)[:16]}"


def _print(value: object) -> None:
    sys.stdout.write(stable_json(value, pretty=True))


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
        for key in ("schema", "server", "sourceId", "releaseId", "entryCount", "totalBytes")
    } | {"roles": roles}


def _fields(value: dict, *names: str) -> dict:
    """Keep CLI output bounded while detailed stage manifests stay on disk."""
    return {name: value.get(name) for name in names if name in value}


def _source_package(server: str, source_id: str) -> Path:
    layout = source_layout(server, source_id)
    value = json.loads(layout.manifest.read_text("utf-8"))
    return layout.root / value["package"]["file"]


def command_ingest(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    manifest = ingest_package(
        Path(args.input), config, Path(args.cache) if args.cache else None, args.concurrency
    )
    _print(_source_summary(manifest))


def command_verify_source(args: argparse.Namespace) -> None:
    _print(_source_summary(verify_source(args.server, args.source, not args.fast)))


def command_index_source(args: argparse.Namespace) -> None:
    layout = source_layout(args.server, args.source)
    manifest = read_json(layout.manifest)
    manifest["schema"] = SOURCE_SCHEMA
    manifest["unityIndex"] = index_unity_dependencies(layout.root, manifest.get("files", []))
    write_json(layout.manifest, manifest, pretty=True)
    _print(_source_summary(verify_source(args.server, args.source, not args.fast)))


def command_extract_master(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    layout = build_layout(config.id, identity)
    manifest = extract_master(_source_package(config.id, args.source), layout.master, config)
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
    result = extract_shard(config.id, args.source, identity, args.shard_index, count)
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
        )
    )


def command_merge_unity(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    count = args.shard_count or config.extraction_shards
    _print(merge_unity_shards(config.id, args.source, identity, count))


def command_extract_cri(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    snapshot = None
    store = None
    if args.reuse_current:
        try:
            store = R2Store(config, args.reuse_concurrency)
            snapshot = current_release_document(store, config, "metadata/cri.json")
        except Exception as error:
            sys.stderr.write(f"CRI current-release reuse is unavailable; decoding all sources: {error}\n")
    restore_output = (
        (lambda output, target: restore_release_object(store, snapshot, output, target))
        if store is not None and isinstance(snapshot, dict)
        else None
    )
    result = extract_cri(
        config,
        args.source,
        identity,
        args.concurrency,
        reuse_manifest=snapshot.get("document") if isinstance(snapshot, dict) else None,
        restore_output=restore_output,
        reuse_concurrency=args.reuse_concurrency,
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


def command_build_live2d(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    result = build_live2d(config, args.source, identity)
    _print(
        _fields(
            result,
            "schema",
            "server",
            "sourceId",
            "buildId",
            "modelCount",
            "skippedModelCount",
        )
    )


def command_build_home_spots(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    result = build_home_spots(config, args.source, identity)
    _print(
        {
            "buildId": identity,
            **_fields(result, "schema", "server", "sourceId", "sceneCount"),
        }
    )


def command_build_api(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    _print(build_api(config, args.source, identity))


def command_build_ktx2(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    _print(build_ktx2(config.id, identity))


def command_build_sonolus(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    _print(build_sonolus(config.id, identity))


def command_build_release(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    identity = args.build or build_id(config, args.source)
    _print(_release_summary(assemble_release(config.id, args.source, identity)))


def _run_build(config: ServerConfig, source_id: str, identity: str, include_ktx2: bool) -> dict:
    extract_master(_source_package(config.id, source_id), build_layout(config.id, identity).master, config)
    for index in range(config.extraction_shards):
        extract_shard(config.id, source_id, identity, index, config.extraction_shards)
    merge_unity_shards(config.id, source_id, identity, config.extraction_shards)
    stages = [
        lambda: extract_cri(config, source_id, identity),
        lambda: build_live2d(config, source_id, identity),
        lambda: build_home_spots(config, source_id, identity),
    ]
    if include_ktx2:
        stages.append(lambda: build_ktx2(config.id, identity))
    with ThreadPoolExecutor(max_workers=len(stages)) as executor:
        for future in [executor.submit(stage) for stage in stages]:
            future.result()
    build_api(config, source_id, identity)
    build_sonolus(config.id, identity)
    return assemble_release(config.id, source_id, identity)


def command_run(args: argparse.Namespace) -> None:
    config = load_server_config(args.server)
    source = ingest_package(
        Path(args.input), config, Path(args.cache) if args.cache else None, args.concurrency
    )
    store = R2Store(config, args.concurrency) if args.publish else None
    if store:
        publish_source(store, config, source["sourceId"])
    identity = build_id(config, source["sourceId"])
    release = _run_build(config, source["sourceId"], identity, args.ktx2)
    pointer = publish_release(store, config, release["releaseId"], check_hashes=False) if store else None
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
    _print(
        fetch_source(
            R2Store(config, args.concurrency),
            config,
            args.source,
            roles=set(args.role or []),
            shard_index=args.shard_index,
            shard_count=args.shard_count,
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

    ingest = commands.add_parser("ingest", help="normalize an APK, APKS/XAPK, or split APK directory")
    ingest.add_argument("--input", required=True)
    ingest.add_argument("--cache", help="flat cache of exact original download filenames")
    ingest.add_argument("--concurrency", type=int, default=12)
    ingest.set_defaults(run=command_ingest)

    identity = commands.add_parser("build-id", help="derive the build id for a source")
    identity.add_argument("--source", required=True)
    identity.set_defaults(run=command_build_id)

    source_verify = commands.add_parser("verify-source", help="verify a local immutable source")
    source_verify.add_argument("--source", required=True)
    source_verify.add_argument("--fast", action="store_true", help="skip content rehashing")
    source_verify.set_defaults(run=command_verify_source)

    source_index = commands.add_parser(
        "index-source", help="index exact Unity CAB dependencies in an existing local source"
    )
    source_index.add_argument("--source", required=True)
    source_index.add_argument("--fast", action="store_true", help="skip content rehashing")
    source_index.set_defaults(run=command_index_source)

    master = commands.add_parser("extract-master", help="decrypt all Master tables from the normalized package")
    master.add_argument("--source", required=True)
    master.add_argument("--build")
    master.set_defaults(run=command_extract_master)

    unity = commands.add_parser("extract-unity", help="process one deterministic Unity shard")
    unity.add_argument("--source", required=True)
    unity.add_argument("--build")
    unity.add_argument("--shard-index", type=int, required=True)
    unity.add_argument("--shard-count", type=int)
    unity.set_defaults(run=command_extract_unity)

    merge = commands.add_parser("merge-unity", help="merge and index all Unity shards")
    merge.add_argument("--source", required=True)
    merge.add_argument("--build")
    merge.add_argument("--shard-count", type=int)
    merge.set_defaults(run=command_merge_unity)

    cri = commands.add_parser("extract-cri", help="decode original and embedded CRI payloads")
    cri.add_argument("--source", required=True)
    cri.add_argument("--build")
    cri.add_argument("--concurrency", type=int, default=2)
    cri.add_argument(
        "--reuse-current",
        action="store_true",
        help="reuse matching CRI outputs from the selected R2 release CAS",
    )
    cri.add_argument("--reuse-concurrency", type=int, default=32)
    cri.set_defaults(run=command_extract_cri)

    live2d = commands.add_parser("build-live2d", help="build Live2D catalog/runtime derivatives")
    live2d.add_argument("--source", required=True)
    live2d.add_argument("--build")
    live2d.set_defaults(run=command_build_live2d)

    home_spots = commands.add_parser(
        "build-home-spots", help="build strict Home Spot background GLB derivatives"
    )
    home_spots.add_argument("--source", required=True)
    home_spots.add_argument("--build")
    home_spots.set_defaults(run=command_build_home_spots)

    api = commands.add_parser("build-api", help="build canonical catalog documents")
    api.add_argument("--source", required=True)
    api.add_argument("--build")
    api.set_defaults(run=command_build_api)

    ktx2 = commands.add_parser("build-ktx2", help="build optional KTX2 runtime derivatives")
    ktx2.add_argument("--source", required=True)
    ktx2.add_argument("--build")
    ktx2.set_defaults(run=command_build_ktx2)

    sonolus = commands.add_parser("build-sonolus", help="build Sonolus repository objects into the runtime tree")
    sonolus.add_argument("--source", required=True)
    sonolus.add_argument("--build")
    sonolus.set_defaults(run=command_build_sonolus)

    release = commands.add_parser("build-release", help="assemble an immutable release")
    release.add_argument("--source", required=True)
    release.add_argument("--build")
    release.set_defaults(run=command_build_release)

    run = commands.add_parser("run", help="run the complete local pipeline from one APK/APKS input")
    run.add_argument("--input", required=True)
    run.add_argument("--cache", help="flat cache of exact original download filenames")
    run.add_argument("--ktx2", action="store_true")
    run.add_argument("--publish", action="store_true", help="publish the source and verified release to R2")
    run.add_argument("--concurrency", type=int, default=12)
    run.set_defaults(run=command_run)

    release_verify = commands.add_parser("verify-release", help="verify a complete immutable release")
    release_verify.add_argument("--release", required=True)
    release_verify.add_argument("--fast", action="store_true", help="skip content rehashing")
    release_verify.set_defaults(run=command_verify_release)

    remote_verify = commands.add_parser("verify-remote", help="verify the selected release and objects in R2")
    remote_verify.add_argument("--release", help="require current.json to select this release id")
    remote_verify.add_argument("--fast", action="store_true", help="verify only the pointer and release manifest")
    remote_verify.add_argument("--concurrency", type=int, default=12)
    remote_verify.set_defaults(run=command_verify_remote)

    source_publish = commands.add_parser("publish-source", help="publish source artifacts to R2 CAS")
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

    source_fetch = commands.add_parser("fetch-source", help="fetch selected immutable source files from R2")
    source_fetch.add_argument("--source", required=True)
    source_fetch.add_argument("--role", action="append", help="source file role to fetch; may be repeated")
    source_fetch.add_argument("--shard-index", type=int)
    source_fetch.add_argument("--shard-count", type=int)
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

    release_publish = commands.add_parser("publish-release", help="publish and atomically promote an R2 release")
    release_publish.add_argument("--release", required=True)
    release_publish.add_argument(
        "--fast", action="store_true", help="trust hashes from the immediately preceding release build"
    )
    release_publish.add_argument("--concurrency", type=int, default=64)
    release_publish.set_defaults(run=command_publish_release)

    source_prune = commands.add_parser(
        "prune-sources", help="delete source manifests not referenced by a retained release"
    )
    source_prune.add_argument("--concurrency", type=int, default=64)
    source_prune.set_defaults(run=command_prune_sources)

    release_prune = commands.add_parser(
        "prune-releases", help="delete non-current R2 releases beyond the configured retention"
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
        "gc-r2", help="delete unreferenced objects from the shared R2 content-addressed store"
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
