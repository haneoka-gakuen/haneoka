"""Assemble an immutable release from one complete build."""

from __future__ import annotations

import shutil
from pathlib import Path
from uuid import uuid4

from build.catalog_storage import compile_catalog_storage, compile_source_index_storage
from build.game_client import assemble_game_client
from core.manifests import read_json, write_json
from core.paths import build_layout, server_layout
from core.process import hardlink_or_copy, walk_files
from extract.master import ENCRYPTED_DIRECTORY
from verify.release import promote_directory


def _copy_tree(source: Path, target: Path) -> None:
    for file in walk_files(source):
        hardlink_or_copy(file, target / file.relative_to(source))


def _strip_build_identity(value: object) -> bool:
    changed = False
    if isinstance(value, dict):
        changed = value.pop("buildId", None) is not None
        for child in value.values():
            changed = _strip_build_identity(child) or changed
    elif isinstance(value, list):
        for child in value:
            changed = _strip_build_identity(child) or changed
    return changed


def _remove_build_identity(file: Path) -> None:
    if not file.is_file():
        return
    document = read_json(file)
    if not isinstance(document, dict):
        raise ValueError(f"release document must be a JSON object: {file}")
    if _strip_build_identity(document):
        write_json(file, document)


def _copy_release_metadata(
    source: Path,
    target: Path,
    server: str,
    source_id: str,
) -> None:
    """Copy public metadata while removing build-local identity fields."""

    for file in walk_files(source):
        if file == source / "source-index.json":
            continue
        hardlink_or_copy(file, target / file.relative_to(source))
    for name in ("cri.json", "live2d.json"):
        _remove_build_identity(target / name)
    compile_source_index_storage(
        source / "source-index.json",
        target / "source-index",
        server,
        source_id,
    )


def _copy_release_api(
    source: Path,
    target: Path,
    server: str,
    source_id: str,
) -> None:
    compile_catalog_storage(source, target, server, source_id)


def _copy_decoded_master(source: Path, target: Path) -> None:
    """Keep the raw client blobs out of the browser-facing decoded Master tree."""

    for file in walk_files(source):
        relative = file.relative_to(source)
        if relative.parts and relative.parts[0] == ENCRYPTED_DIRECTORY:
            continue
        hardlink_or_copy(file, target / relative)


def assemble_release(server: str, source_id: str, build_id: str) -> dict:
    build = build_layout(server, build_id)
    staging_parent = server_layout(server).releases / ".staging"
    staging: Path | None = staging_parent / f"{build_id}-{uuid4().hex}"
    staging.mkdir(parents=True)
    try:
        _copy_tree(build.assets, staging / "assets")
        _copy_tree(build.runtime, staging / "runtime")
        _copy_tree(build.objects, staging / "objects")
        _copy_decoded_master(build.master, staging / "objects" / "master")
        # Raw encrypted Master tables and a sharded Addressables index form the
        # original-client contract. Large bundles stay deduplicated in source CAS.
        assemble_game_client(server, source_id, build.master, staging / "game-client")
        _copy_release_api(
            build.api,
            staging / "api" / "v1" / "catalog",
            server,
            source_id,
        )
        _copy_release_metadata(
            build.metadata,
            staging / "metadata",
            server,
            source_id,
        )
        hardlink_or_copy(build.database, staging / "metadata" / "unity.sqlite")
        manifest = promote_directory(staging, server, source_id)
        if staging.exists():
            shutil.rmtree(staging)
        staging = None
        return manifest
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging)
