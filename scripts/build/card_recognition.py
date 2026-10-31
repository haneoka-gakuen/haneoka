"""Stage complete recognition references, reporting missing controlled-source thumbnails."""
from __future__ import annotations
import re
from pathlib import Path
from core.manifests import read_json, write_json
from core.paths import validate_release_path
from core.server_policy import is_validation_source
from recognize.build_index import source_index

SOURCE_PATH = "runtime/card-recognition/source.json"
LOCAL_PATH = "runtime/card-recognition/local.json"
# Tile sizes keep each sheet small enough to fetch on demand in the browser and app.
# Each tile is the part of the thumbnail the in-game card list draws: members
# show the top-centred 85% of the width, Snapshots the full width cut to the cell.
TILES = {"members": (48, 59), "snapshots": (64, 34)}
SHOWN_WIDTH = {"members": 0.85, "snapshots": 1.0}
SHEET_COLUMNS = 16


def write_local_reference(root: Path, server: str, source: dict, data) -> dict:
    """Downsampled thumbnail sheets plus level glyphs for on-device recognition."""
    from PIL import Image
    kinds = {}
    for kind, (width, height) in TILES.items():
        refs = sorted((r for r in source["references"] if r["kind"] == kind), key=lambda r: r["cardId"])
        rows = -(-len(refs) // SHEET_COLUMNS)
        sheet = Image.new("RGB", (width * SHEET_COLUMNS, height * max(1, rows)))
        for index, ref in enumerate(refs):
            file = data.asset_file(ref["sourcePath"].removeprefix("assets/"))
            if file is None:
                raise ValueError("recognition thumbnail is missing from the build")
            with Image.open(file) as image:
                shown = image.width * SHOWN_WIDTH[kind]
                left = (image.width - shown) / 2
                tall = min(image.height, shown * height / width)
                top = 0 if kind == "members" else (image.height - tall) / 2
                tile = image.convert("RGB").resize((width, height), Image.Resampling.BOX,
                                                   box=(left, top, left + shown, top + tall))
            sheet.paste(tile, ((index % SHEET_COLUMNS) * width, (index // SHEET_COLUMNS) * height))
        path = f"runtime/card-recognition/{kind}.png"
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(target, optimize=True)
        kinds[kind] = {"tile": [width, height], "columns": SHEET_COLUMNS, "sheet": f"{kind}.png",
                       "cardIds": [r["cardId"] for r in refs]}
    reader = source.get("levelReader")
    document = {"schema": "haneoka-card-recognition-local-v1", "server": server, "sourceId": source["sourceId"],
                "kinds": kinds, "levelReader": None if reader is None else
                {"glyphs": reader["glyphs"], "allowedLevels": reader["allowedLevels"]}}
    write_json(root / LOCAL_PATH, document)
    return {"path": LOCAL_PATH, "levelReader": reader is not None}


def build_card_recognition_source(root: Path, server: str, source_id: str, *, data=None):
    selected = read_json(root / "metadata/source-index.json")
    if selected.get("server") != server or selected.get("sourceId") != source_id:
        raise ValueError("recognition input index belongs to a different source")
    catalogs = [(kind, read_json(root / "api/v1/catalog" / (resource + ".json")))
                for kind, resource in (("members", "cards"), ("snapshots", "support-cards"))]
    expected = {(kind, int(card)) for kind, catalog in catalogs for card in catalog}
    missing = 0
    for _, catalog in catalogs:
        for card in catalog.values():
            image = card.get("images", {}).get("thumbnail")
            if image is None or image == "":
                missing += 1
            elif not isinstance(image, str) or not image.startswith(f"/assets/{server}/"):
                raise ValueError("thumbnail source belongs to another server")
    if missing and is_validation_source(server):
        (root / SOURCE_PATH).unlink(missing_ok=True)
        return {"status": "unavailable", "reason": "catalog-thumbnails-incomplete",
                "missingThumbnailCount": missing, "catalogCardCount": len(expected), "sourceId": source_id}
    source = source_index(root, server, data=data)
    if source.get("schema") != "haneoka-card-recognition-source-v1" or source.get("sourceId") != source_id or "releaseId" in source:
        raise ValueError("recognition source identity is invalid or self-referential")
    refs = source["references"]
    if not 0 < len(refs) <= 2048 or {(r["kind"], r["cardId"]) for r in refs} != expected or len(refs) != len(expected):
        raise ValueError("recognition references do not exactly cover selected card catalogs")
    for ref in refs:
        digest = ref["sha256"]
        path = validate_release_path(ref["sourcePath"])
        if (not re.fullmatch(r"[a-f0-9]{64}", digest) or not path.startswith("assets/") or not path.endswith(".png")
                or ref["path"] != f"images/{digest}.png" or ref["variant"] != "thumbnail"):
            raise ValueError("recognition thumbnail identity is invalid")
    write_json(root / SOURCE_PATH, source)
    local = write_local_reference(root, server, source, data) if data is not None else None
    return {"path": SOURCE_PATH, "local": local, "references": len(refs), "levelReaderAvailable": source.get("levelReader") is not None,
            "levelReaderStatus": source.get("levelReaderStatus"), "sourceId": source_id}
