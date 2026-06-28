"""Validation for immutable package and Addressables source snapshots."""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any

from core.contracts import PACKAGE_MAX_BYTES, SOURCE_SCHEMA
from core.hashes import sha256_file
from core.manifests import read_json
from core.paths import source_layout, validate_release_path


SHA256 = re.compile(r"^[a-f0-9]{64}$")
SOURCE_ROLE_PREFIXES = {
    "package": "package/",
    "catalog": "android/catalogs/",
    "catalog-hash": "android/catalogs/",
    "embedded-catalog": "android/catalogs/",
    "unity-bundle": "android/bundles/",
    "cri-payload": "android/cri/",
}
REQUIRED_SOURCE_ROLES = {"package", "catalog", "catalog-hash", "embedded-catalog"}
REMOTE_STORAGE = {"schema": "haneoka-r2-cas-v1", "prefix": "cas/v1/sha256"}


def validate_source_manifest(
    manifest: object,
    server: str,
    source_id: str,
    *,
    require_storage: bool = False,
) -> list[dict[str, Any]]:
    errors: list[str] = []
    if not isinstance(manifest, dict):
        raise ValueError("source manifest must be an object")
    if manifest.get("schema") != SOURCE_SCHEMA:
        errors.append(f"unexpected schema: {manifest.get('schema')}")
    if manifest.get("server") != server or manifest.get("sourceId") != source_id:
        errors.append("source identity mismatch")
    if require_storage and manifest.get("storage") != REMOTE_STORAGE:
        errors.append("remote source storage contract is invalid")
    elif "storage" in manifest and manifest.get("storage") != REMOTE_STORAGE:
        errors.append("source storage contract is invalid")

    raw_files = manifest.get("files")
    if not isinstance(raw_files, list):
        errors.append("files must be an array")
        raw_files = []
    records: list[dict[str, Any]] = []
    paths: set[str] = set()
    roles: set[str] = set()
    by_path: dict[str, dict[str, Any]] = {}
    total_bytes = 0
    for index, raw_record in enumerate(raw_files):
        if not isinstance(raw_record, dict):
            errors.append(f"source record {index} must be an object")
            continue
        try:
            relative = validate_release_path(raw_record.get("path"))
        except ValueError as error:
            errors.append(str(error))
            continue
        role = raw_record.get("role")
        prefix = SOURCE_ROLE_PREFIXES.get(role) if isinstance(role, str) else None
        tail = (
            relative.removeprefix(prefix)
            if prefix and relative.startswith(prefix)
            else ""
        )
        if not prefix or not tail or "/" in tail:
            errors.append(f"source role/path mismatch: {relative}")
            continue
        if relative in paths:
            errors.append(f"duplicate source path: {relative}")
            continue
        paths.add(relative)
        roles.add(role)
        original_filename = raw_record.get("originalFilename")
        if (
            not isinstance(original_filename, str)
            or original_filename != PurePosixPath(relative).name
        ):
            errors.append(f"original filename mismatch: {relative}")
        byte_count = raw_record.get("bytes")
        if (
            not isinstance(byte_count, int)
            or isinstance(byte_count, bool)
            or byte_count < 0
        ):
            errors.append(f"invalid byte count: {relative}")
        else:
            total_bytes += byte_count
            if role == "package" and byte_count > PACKAGE_MAX_BYTES:
                errors.append(
                    f"source package exceeds the {PACKAGE_MAX_BYTES}-byte limit: "
                    f"{relative}"
                )
        digest = raw_record.get("sha256")
        if not isinstance(digest, str) or not SHA256.fullmatch(digest):
            errors.append(f"invalid sha256: {relative}")
        if role == "package" and PurePosixPath(relative).suffix.lower() not in {
            ".apk",
            ".apks",
        }:
            errors.append(f"invalid package path: {relative}")
        if role == "unity-bundle" and not relative.endswith(".bundle"):
            errors.append(f"invalid Unity bundle path: {relative}")
        records.append(raw_record)
        by_path[relative] = raw_record

    if not REQUIRED_SOURCE_ROLES.issubset(roles):
        errors.append("required source roles are missing")
    package_file = (
        (manifest.get("package") or {}).get("file")
        if isinstance(manifest.get("package"), dict)
        else None
    )
    catalog_file = (
        (manifest.get("catalog") or {}).get("file")
        if isinstance(manifest.get("catalog"), dict)
        else None
    )
    if (
        not isinstance(package_file, str)
        or by_path.get(package_file, {}).get("role") != "package"
    ):
        errors.append("package file reference is invalid")
    if (
        not isinstance(catalog_file, str)
        or by_path.get(catalog_file, {}).get("role") != "catalog"
    ):
        errors.append("catalog file reference is invalid")
    if manifest.get("fileCount") != len(paths):
        errors.append("fileCount mismatch")
    if manifest.get("fileBytes") != total_bytes:
        errors.append("fileBytes mismatch")
    for relative, record in by_path.items():
        if record.get("role") != "unity-bundle":
            continue
        unity = record.get("unity")
        if (
            not isinstance(unity, dict)
            or not isinstance(unity.get("cabFiles"), list)
            or not unity.get("cabFiles")
        ):
            errors.append(f"Unity CAB index is missing: {relative}")
            continue
        dependencies = unity.get("dependencies", [])
        if not isinstance(dependencies, list):
            errors.append(f"Unity dependency list is invalid: {relative}")
            continue
        for dependency in dependencies:
            if (
                not isinstance(dependency, str)
                or by_path.get(dependency, {}).get("role") != "unity-bundle"
            ):
                errors.append(f"invalid Unity dependency: {relative} -> {dependency}")

    if errors:
        raise ValueError(
            f"source manifest validation failed ({len(errors)}):\n"
            + "\n".join(errors[:100])
        )
    return records


def verify_source(
    server: str, source_id: str, check_hashes: bool = True
) -> dict[str, Any]:
    layout = source_layout(server, source_id)
    manifest = read_json(layout.manifest)
    records = validate_source_manifest(manifest, server, source_id)
    errors: list[str] = []
    paths: set[str] = set()
    roles: set[str] = set()
    artifacts_by_path = {
        str(artifact.get("path", "")): artifact for artifact in records
    }
    for artifact in records:
        relative = str(artifact.get("path", ""))
        if relative in paths:
            errors.append(f"duplicate source path: {relative}")
        paths.add(relative)
        roles.add(str(artifact.get("role") or ""))
        file = layout.root / relative
        if not file.is_file():
            errors.append(f"missing source file: {relative}")
            continue
        if file.name != artifact.get("originalFilename"):
            errors.append(f"original filename mismatch: {relative}")
        if file.stat().st_size != artifact.get("bytes"):
            errors.append(f"size mismatch: {relative}")
        if check_hashes and sha256_file(file) != artifact.get("sha256"):
            errors.append(f"hash mismatch: {relative}")
        if artifact.get("role") == "unity-bundle":
            unity = artifact.get("unity")
            if not isinstance(unity, dict) or not unity.get("cabFiles"):
                errors.append(f"Unity CAB index is missing: {relative}")
                continue
            for dependency in unity.get("dependencies", []):
                target = artifacts_by_path.get(str(dependency))
                if not target or target.get("role") != "unity-bundle":
                    errors.append(
                        f"invalid Unity dependency: {relative} -> {dependency}"
                    )
    if errors:
        raise ValueError(
            f"source verification failed ({len(errors)}):\n" + "\n".join(errors[:100])
        )
    return manifest
