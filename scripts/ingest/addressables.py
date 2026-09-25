"""Addressables download planning built from the binary catalog."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ingest.catalog import downloadable_locations as _catalog_locations


def downloadable_locations(catalog: Path, remote_root: str = "", asset_dir: str = "") -> list[dict[str, Any]]:
    """Return unique remote locations in deterministic catalog order."""

    return sorted(
        _catalog_locations(catalog, remote_root, asset_dir),
        key=lambda item: (str(item.get("remoteUrl", "")), str(item.get("primaryKey", ""))),
    )
