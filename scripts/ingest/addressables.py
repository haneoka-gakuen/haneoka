"""Addressables download planning built from the binary catalog."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ingest.catalog import downloadable_locations as _catalog_locations


def downloadable_locations(catalog: Path) -> list[dict[str, Any]]:
    """Return unique remote locations in deterministic catalog order."""

    return sorted(
        _catalog_locations(catalog),
        key=lambda item: (str(item.get("remoteUrl", "")), str(item.get("primaryKey", ""))),
    )
