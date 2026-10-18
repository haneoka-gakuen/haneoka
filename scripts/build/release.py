# L3 — GEB
# Input: 完整构建、server 配置、生产者指纹与可选增量基线。
# Output: 不可变 release、清单及本地选择结果。
# Pos: [Map](L2-2.md)；资源构建到 release 组装的边界。
# Effects/Dependencies: 创建／复制文件、编译存储并写清单和本地指针；R2 发布另行执行。
"""Assemble an immutable release from one complete build."""

from __future__ import annotations

import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import unquote
from uuid import uuid4

from build.catalog_storage import compile_catalog_storage, compile_source_index_storage
from build.game_client import assemble_game_client
from build.http_encoding import moc_gzip_path, precompress_runtime
from core.manifests import read_json, write_json
from core.config import PROJECT_ROOT, load_server_config
from core.fingerprints import pipeline_producer
from core.paths import build_layout, server_layout
from core.paths import validate_release_path
from core.process import hardlink_or_copy, walk_files
from extract.master import ENCRYPTED_DIRECTORY
from verify.release import (
    promote_directory,
    promote_prepared_directory,
    release_entries,
)


def _link_files(source: Path, target: Path, files: list[Path]) -> None:
    """Materialize ``files`` under ``target`` with hard links, off the main thread's IO queue."""

    if not files:
        return

    def link(file: Path) -> None:
        hardlink_or_copy(file, target / file.relative_to(source))

    with ThreadPoolExecutor(max_workers=max(1, min(16, len(files)))) as executor:
        list(executor.map(link, files))


def _copy_tree(source: Path, target: Path) -> None:
    _link_files(source, target, list(walk_files(source)))


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

    _link_files(
        source,
        target,
        [file for file in walk_files(source) if file != source / "source-index.json"],
    )
    for name in ("cri.json", "live2d.json", "runtime-textures.json"):
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

    _link_files(
        source,
        target,
        [
            file
            for file in walk_files(source)
            if not (relative := file.relative_to(source)).parts
            or relative.parts[0] != ENCRYPTED_DIRECTORY
        ],
    )


def _runtime_texture_records(build, server: str, source_id: str | None = None) -> dict[str, dict]:
    file = build.metadata / "runtime-textures.json"
    if not file.is_file():
        return {}
    document = read_json(file)
    if (document.get("schema") != "haneoka-runtime-textures-v1" or document.get("server") != server
            or not isinstance(document.get("sourceId"), str)
            or (source_id is not None and document.get("sourceId") != source_id)):
        raise ValueError("runtime texture manifest identity does not match this release")
    records = {}
    for variant in document.get("variants", []):
        url = variant.get("source")
        prefix = f"/runtime/{server}/"
        if not isinstance(url, str) or not url.startswith(prefix):
            raise ValueError("runtime texture variant has a cross-server or invalid output URL")
        path = validate_release_path("runtime/" + unquote(url.removeprefix(prefix)))
        if not path.endswith(".ktx2") or path in records:
            raise ValueError(f"runtime texture output path is invalid/repeated: {path}")
        if (not isinstance(variant.get("byteLength"), int) or variant["byteLength"] <= 0
                or not isinstance(variant.get("sha256"), str) or len(variant["sha256"]) != 64):
            raise ValueError(f"runtime texture output has incomplete byte identity: {path}")
        records[path] = variant
    return records


def _expected_delta_paths(build, server: str, source_id: str | None = None) -> tuple[set[str], set[str]]:
    """Derive the release paths this build must contain, from its local documents.

    Returns ``(expected, assets_pngs)``.  Everything the stages declared —
    bundle reports, archives, media, projections, CRI outputs, model previews,
    Home Spot scenes — is reachable from the local build documents, so the
    composer can distinguish "produced locally" from "must come from the base
    release" without trusting either side blindly.

    Media expectations follow the CANONICAL corpus exactly: descriptor outputs
    plus the merge's delta-declared document (declared media including locale
    variants, and adopted projections).  Bundle reports also carry the outputs
    of NON-canonical providers — a full build never publishes those, so
    counting them here would demand files neither side has.
    """

    expected: set[str] = set()

    reports_dir = build.metadata / "bundles"
    for file in sorted(reports_dir.glob("*.json")):
        digest = file.stem
        expected.add(f"metadata/bundles/{digest}.json")
        report = read_json(file)
        archive = (report.get("objectArchive") or {}) if isinstance(report, dict) else {}
        archive_path = str(archive.get("path") or "")
        if archive_path:
            expected.add(archive_path)

    sources_dir = build.metadata / "sources"
    for file in sorted(sources_dir.rglob("*.json")):
        relative = f"metadata/{file.relative_to(build.metadata).as_posix()}"
        expected.add(relative)
        descriptor = read_json(file)
        if not isinstance(descriptor, dict):
            continue
        for projection in descriptor.get("runtimeObjects") or []:
            projection_path = str(projection.get("path") or "")
            if projection_path:
                expected.add(projection_path)
        for output in descriptor.get("outputs") or []:
            output_path = str(output.get("path") or "")
            if output_path:
                expected.add(output_path)

    declared_file = build.reports / "delta-declared.json"
    if declared_file.is_file():
        declared = read_json(declared_file)
        if isinstance(declared, dict):
            for item in declared.get("media") or []:
                media_path = str((item or {}).get("path") or "")
                if media_path:
                    expected.add(media_path)
            for projection_path in declared.get("projectionPaths") or []:
                if projection_path:
                    expected.add(str(projection_path))

    cri_file = build.metadata / "cri.json"
    if cri_file.is_file():
        expected.add("metadata/cri.json")
        cri = read_json(cri_file)
        for entry in (cri.get("entries") or []) if isinstance(cri, dict) else []:
            for output in (entry.get("outputs") or []):
                output_path = str(output.get("path") or "")
                if output_path:
                    expected.add(output_path)

    assets_pngs: set[str] = set()
    for document_name in ("live2d.json", "spine.json", "home-spots.json"):
        document_file = build.metadata / document_name
        if not document_file.is_file():
            continue
        expected.add(f"metadata/{document_name}")
        _collect_document_paths(
            read_json(document_file),
            server,
            expected,
            assets_pngs,
        )
    texture_file = build.metadata / "runtime-textures.json"
    if texture_file.is_file():
        expected.add("metadata/runtime-textures.json")
        records = _runtime_texture_records(build, server, source_id)
        expected.update(records)
        _collect_document_paths(read_json(texture_file), server, expected, assets_pngs)
    return expected, assets_pngs


def _collect_document_paths(value: object, server: str, expected: set[str], assets_pngs: set[str]) -> None:
    """Recursively collect release paths referenced by a stage document."""

    if isinstance(value, dict):
        for child in value.values():
            _collect_document_paths(child, server, expected, assets_pngs)
    elif isinstance(value, list):
        for child in value:
            _collect_document_paths(child, server, expected, assets_pngs)
    elif isinstance(value, str):
        for prefix, tree in (
            (f"/runtime/{server}/", "runtime"),
            (f"/assets/{server}/", "assets"),
        ):
            if value.startswith(prefix):
                relative = f"{tree}/{unquote(value[len(prefix):])}"
                expected.add(relative)
                if relative.startswith("assets/") and relative.casefold().endswith(".png"):
                    assets_pngs.add(relative)
                return


def _base_fill_entries(
    staging: Path,
    build,
    server: str,
    base_manifest: dict,
    source_id: str | None = None,
) -> list[dict]:
    """Compose the manifest entries for a delta build.

    Local files win; base release entries fill every expected path that was
    not produced locally.  An expected path missing from both is a hard error,
    and so is a base entry whose role disagrees with its tree.
    """

    from verify.release import RELEASE_TREES  # noqa: PLC0415 - avoid an import cycle at module load

    local_entries = release_entries(staging)
    local_paths = {str(entry["path"]) for entry in local_entries}
    expected, _assets_pngs = _expected_delta_paths(build, server, source_id)
    base_entries = {
        str(entry.get("path")): entry
        for entry in base_manifest.get("entries", [])
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    # Native identities come from the current manifest, never PNG->legacy Basis naming.
    texture_records = _runtime_texture_records(build, server, source_id)
    local_by_path = {entry["path"]: entry for entry in local_entries}
    for path in list(expected):
        encoded_path = moc_gzip_path(path)
        if encoded_path is None or encoded_path not in base_entries:
            continue
        original = local_by_path.get(path) or base_entries.get(path)
        if original and base_entries.get(path, {}).get("sha256") == original["sha256"]:
            expected.add(encoded_path)
    for path, variant in texture_records.items():
        actual = local_by_path.get(path) or base_entries.get(path)
        if actual is None or actual.get("sha256") != variant["sha256"] or actual.get("bytes") != variant["byteLength"]:
            raise ValueError(f"runtime texture output differs from its explicit payload identity: {path}")
        texture = variant.get("texture")
        png = None
        for prefix, tree in ((f"/assets/{server}/", "assets/"), (f"/runtime/{server}/", "runtime/")):
            if isinstance(texture, str) and texture.startswith(prefix):
                png = validate_release_path(tree + unquote(texture.removeprefix(prefix)))
                break
        source_entry = local_by_path.get(png) or base_entries.get(png)
        if source_entry is None or source_entry.get("sha256") != variant.get("sourceTextureSha256"):
            raise ValueError(f"runtime texture canonical PNG identity changed: {texture}")

    entries = list(local_entries)
    missing = sorted(expected - local_paths)
    filled = 0

    def check(entry_path: str) -> dict:
        entry = base_entries.get(entry_path)
        if entry is None:
            raise ValueError(
                f"delta build is missing a locally produced file and the base release "
                f"does not declare it: {entry_path}"
            )
        role = str(entry.get("role") or "")
        if role not in RELEASE_TREES or entry_path.split("/", 1)[0] != role:
            raise ValueError(f"base entry has an invalid role: {entry_path}")
        return entry

    for entry_path in missing:
        entries.append(check(entry_path))
        filled += 1
    entries.sort(key=lambda item: item["path"])
    if filled:
        sys.stderr.write(f"release: composed {filled} entries from base release {base_manifest.get('releaseId')}\n")
    return entries


def assemble_release(server: str, source_id: str, build_id: str, base_manifest: dict | None = None) -> dict:
    build = build_layout(server, build_id)
    write_json(build.metadata / "pipeline-recipes" / "pipeline.json",
               pipeline_producer(PROJECT_ROOT, load_server_config(server)), pretty=True)
    staging_parent = server_layout(server).releases / ".staging"
    staging: Path | None = staging_parent / f"{build_id}-{uuid4().hex}"
    staging.mkdir(parents=True)
    try:
        _copy_tree(build.assets, staging / "assets")
        _copy_tree(build.runtime, staging / "runtime")
        precompress_runtime(staging, {
            entry["path"]: entry for entry in (base_manifest or {}).get("entries", [])
        })
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
        if base_manifest is None:
            manifest = promote_directory(staging, server, source_id)
        else:
            manifest = promote_prepared_directory(
                staging,
                server,
                source_id,
                _base_fill_entries(staging, build, server, base_manifest, source_id),
            )
        if staging.exists():
            shutil.rmtree(staging)
        staging = None
        return manifest
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging)
