"""Index Unity archive identities and exact cross-bundle dependencies."""

from __future__ import annotations

import multiprocessing
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

from ingest.bundle_crypto import load_unity_bundle


def _bundle_metadata(file: Path) -> dict[str, list[str]]:
    if not file.is_file():
        raise FileNotFoundError(f"Unity bundle is not a file: {file}")
    if file.stat().st_size == 0:
        raise ValueError(f"Unity bundle is empty: {file}")
    environment = load_unity_bundle(file)
    # UnityPy accepts an unknown binary as a raw CAB with no objects. Production
    # Android packages now contain encrypted bundle headers, so accepting that
    # fallback silently published releases with no Live2D, Spine or story art.
    if not environment.objects:
        with file.open("rb") as stream:
            signature = stream.read(8)
        raise ValueError(
            f"Unity bundle has no readable objects (possible encrypted header, "
            f"signature={signature.hex()}): {file.name}"
        )
    cab_files = sorted({str(name).casefold() for name in environment.cabs})
    external_cabs = sorted(
        {
            str(external.name).casefold()
            for asset in environment.assets
            for external in (asset.externals or [])
            if getattr(external, "name", None)
        }
    )
    return {"cabFiles": cab_files, "externalCabs": external_cabs}


def _bundle_metadata_task(payload: tuple[str, str]) -> tuple[str, dict[str, list[str]]]:
    """Worker entry point: read one bundle and return its CAB identity."""

    relative, path = payload
    return relative, _bundle_metadata(Path(path))


def _gather_bundle_metadata(
    source_root: Path, bundles: list[dict[str, Any]]
) -> dict[str, dict[str, list[str]]]:
    """Parse every bundle's CAB structure, spreading CPU work across processes.

    Each bundle is parsed independently, and a full-corpus UnityPy pass is the
    dominant ingest cost after the CDN download. Forked workers inherit the
    already-imported modules, so this stays cheap to start.
    """

    tasks = [
        (str(record["path"]), str(source_root / str(record["path"])))
        for record in bundles
    ]
    workers = max(1, min(4, os.cpu_count() or 1, len(tasks) or 1))
    if workers == 1:
        return dict(_bundle_metadata_task(task) for task in tasks)
    try:
        context = multiprocessing.get_context("fork")
    except ValueError:  # pragma: no cover - non-POSIX fallback
        context = None
    with ProcessPoolExecutor(max_workers=workers, mp_context=context) as executor:
        return dict(executor.map(_bundle_metadata_task, tasks))


def index_unity_dependencies(source_root: Path, records: list[dict[str, Any]]) -> dict[str, int]:
    """Attach deterministic CAB ownership and dependency paths to bundle records."""

    bundles = sorted(
        (record for record in records if record.get("role") == "unity-bundle"),
        key=lambda record: record["path"],
    )
    for record in bundles:
        declared_bytes = record.get("bytes")
        if (
            not isinstance(declared_bytes, int)
            or isinstance(declared_bytes, bool)
            or declared_bytes < 1
        ):
            raise ValueError(
                f"Unity bundle declares an invalid size: {record.get('path', '')} ({declared_bytes})"
            )
    metadata = _gather_bundle_metadata(source_root, bundles)
    owners: dict[str, dict[str, Any]] = {}
    for record in bundles:
        relative = str(record["path"])
        file = source_root / relative
        actual_bytes = file.stat().st_size
        if actual_bytes != record["bytes"]:
            raise ValueError(
                f"Unity bundle size mismatch: expected {record['bytes']}, "
                f"got {actual_bytes}: {relative}"
            )
        value = metadata[relative]
        for cab in value["cabFiles"]:
            existing = owners.get(cab)
            if existing and existing["sha256"] != record["sha256"]:
                # Locale variants of the same Unity asset (e.g. band_logo(ja) vs
                # band_logo(en)) produce different bundles that share the same internal
                # CAB name. Keep the first owner rather than aborting the multi-locale merge.
                sys.stderr.write(
                    f"warning: Unity CAB identity {cab} appears in multiple bundles "
                    f"({existing['path']}, {relative}); keeping first owner\n"
                )
                continue
            if existing is None or relative < existing["path"]:
                owners[cab] = record

    dependency_edges = 0
    unresolved: set[str] = set()
    for record in bundles:
        value = metadata[str(record["path"])]
        dependencies = sorted(
            {
                str(owner["path"])
                for cab in value["externalCabs"]
                if (owner := owners.get(cab)) is not None and owner["path"] != record["path"]
            }
        )
        unresolved_cabs = sorted(cab for cab in value["externalCabs"] if cab not in owners)
        unresolved.update(unresolved_cabs)
        dependency_edges += len(dependencies)
        record["unity"] = {
            **value,
            "dependencies": dependencies,
            "unresolvedExternalCabs": unresolved_cabs,
        }
    return {
        "bundleCount": len(bundles),
        "cabCount": len(owners),
        "dependencyEdgeCount": dependency_edges,
        "unresolvedExternalCabCount": len(unresolved),
    }
