"""Catalog projections for collectible objects with Master-authored names."""

from __future__ import annotations

from typing import Any, Callable


def build_stickers(data: Any, stamp: Callable[[Any], list[int | None]]) -> dict[str, Any]:
    entries = {}
    for row in data.rows("MasterDegree"):
        identity = int(row.get("_id") or 0)
        image_path = str(row.get("_imagePath") or "").strip("/")
        if not identity or not image_path:
            continue
        image = data.asset(f"Assets/AddressableResources/{image_path}.png")
        if not image:
            raise ValueError(f"MasterDegree image is absent: {identity}: {image_path}")
        entries[str(identity)] = {
            "stickerId": identity,
            "name": data.text(row.get("_nameTextId")),
            "description": data.text(row.get("_descriptionTextId")),
            "image": image,
            "characterIds": [int(value) for value in row.get("_characterIds", []) if int(value)],
            "releasedAt": stamp(row.get("_startAt")),
            "closedAt": stamp(row.get("_endAt")),
            "degreeType": int(row.get("_degreeType") or 0),
            "sourceTable": "MasterDegree",
        }
    return {"entries": entries}


def build_backgrounds(data: Any) -> dict[str, Any]:
    entries = {}
    for row in data.rows("MasterBackground"):
        identity = int(row.get("_id") or 0)
        source = str(row.get("_assetPath") or "").strip("/")
        thumbnail_source = str(row.get("_thumbnailAssetPath") or "").strip("/")
        if not identity or not source:
            continue
        image = data.asset(f"Assets/AddressableResources/{source}.png")
        thumbnail = data.asset(f"Assets/AddressableResources/{thumbnail_source}.png") if thumbnail_source else None
        if not image:
            raise ValueError(f"MasterBackground image is absent: {identity}: {source}")
        entries[str(identity)] = {
            "backgroundId": identity,
            "name": data.text(row.get("_nameTextId")),
            "description": data.text(row.get("_descriptionTextId")),
            "image": image,
            "thumbnail": thumbnail or image,
            "sourceTable": "MasterBackground",
        }
    return {"entries": entries}
