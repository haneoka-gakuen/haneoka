"""Index Unity archive identities and exact cross-bundle dependencies."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import UnityPy


def _bundle_metadata(file: Path) -> dict[str, list[str]]:
    if not file.is_file():
        raise FileNotFoundError(f"Unity bundle is not a file: {file}")
    if file.stat().st_size == 0:
        raise ValueError(f"Unity bundle is empty: {file}")
    environment = UnityPy.load(str(file))
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
    metadata: dict[str, dict[str, list[str]]] = {}
    owners: dict[str, dict[str, Any]] = {}
    for record in bundles:
        relative = str(record["path"])
        file = source_root / relative
        value = _bundle_metadata(file)
        actual_bytes = file.stat().st_size
        if actual_bytes != record["bytes"]:
            raise ValueError(
                f"Unity bundle size mismatch: expected {record['bytes']}, "
                f"got {actual_bytes}: {relative}"
            )
        metadata[relative] = value
        for cab in value["cabFiles"]:
            existing = owners.get(cab)
            if existing and existing["sha256"] != record["sha256"]:
                raise ValueError(
                    f"Unity CAB identity belongs to different bundles: {cab} "
                    f"({existing['path']}, {relative})"
                )
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
