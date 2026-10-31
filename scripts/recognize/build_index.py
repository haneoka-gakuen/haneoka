#!/usr/bin/env python3
"""Project a recognition source artifact from one existing build; no re-extraction.

The public source artifact carries sourceId, not a self-referential releaseId.
The serving adapter wraps it with the actual selected release identity.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def sha(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def catalog(root: Path, name: str) -> dict:
    flat = root / "api/v1/catalog" / f"{name}.json"
    if not flat.is_file():
        raise ValueError("reference projection requires the selected build's canonical catalog")
    return json.loads(flat.read_text())


def source_index(build: Path, server: str, *, data=None) -> dict:
    index = json.loads((build / "metadata/source-index.json").read_text())
    if index.get("server") != server or not index.get("sourceId"):
        raise ValueError("selected source does not match server")
    references = []
    for kind, resource in (("members", "cards"), ("snapshots", "support-cards")):
        for card_id, card in catalog(build, resource).items():
            image = card.get("images", {}).get("thumbnail")
            prefix = f"/assets/{server}/"
            if not isinstance(image, str) or not image.startswith(prefix):
                raise ValueError("thumbnail source belongs to another server")
            file = build / "assets" / image.removeprefix(prefix)
            relative = "assets/" + image.removeprefix(prefix)
            output = next((o for o in index["sources"].get(image.removeprefix(prefix), {}).get("outputs", [])
                           if o.get("path") == relative and o.get("type") == "Texture2D"), None)
            if output is None:
                raise ValueError("thumbnail geometry/hash missing from selected source index")
            digest = output["sha256"]
            if file.is_file() and sha(file) != digest:
                raise ValueError("thumbnail bytes changed")
            references.append({"kind": kind, "cardId": int(card_id), "variant": "thumbnail",
                               "path": f"images/{digest}.png", "sha256": digest,
                               "sourcePath": "assets/" + image.removeprefix(prefix)})
    reader = None
    level_status = {"status": "disabled", "reason": "explicitly_disabled"}
    if data is not None:
        try:
            reader = level_reader(data)
            level_status = {"status": "available" if reader is not None else "unavailable",
                            "reason": None if reader is not None else "font_binding_unsupported_or_absent"}
        except (OSError, KeyError, StopIteration, ValueError) as error:
            # Level resources are optional. Do not delay card identity projection.
            # The published reason contains no server path or exception text.
            print(f"card recognition level reader: {type(error).__name__}: {error}", file=sys.stderr)
            level_status = {"status": "unavailable", "reason": "missing_or_invalid_level_resources"}
    return {"schema": "haneoka-card-recognition-source-v1", "server": server, "sourceId": index["sourceId"],
            "references": references, "levelReader": reader, "levelReaderStatus": level_status}


FONT_NAME = "VibeMOPro-Medium SDF"
FONT_SOURCE = f"Packages/com.fromtokyo.sirius-asset/AddressableResources/Font/VibeMOPro-Medium/{FONT_NAME}.asset"


def level_reader(data) -> dict | None:
    # Reads through the build's accessors so delta builds restore reusable
    # object archives and the atlas from the base release.
    binding_names = set()
    for widget in ("UIMemberCardListWidget", "UISupportCardListWidget"):
        ui_path = f"Assets/AddressableResources/UI/Prefab/{widget}.prefab"
        if ui_path not in data.source_index:
            continue
        _, ui_objects = data.source_objects(ui_path)
        names = {key: o["data"].get("m_Name") for key, o in ui_objects.items() if o.get("type") == "GameObject"}
        for o in ui_objects.values():
            fields = o.get("data", {})
            if names.get(str(fields.get("m_GameObject", {}).get("m_PathID"))) == "LvValueText" and "m_fontAsset" in fields:
                binding_names.add(fields["m_fontAsset"].get("reference", {}).get("name"))
    if FONT_SOURCE not in data.source_index or binding_names != {FONT_NAME}:
        return None
    descriptor, objects = data.source_objects(FONT_SOURCE)
    font = next(o["data"] for o in objects.values() if o.get("data", {}).get("m_Name") == FONT_NAME)
    texture = next(o for o in descriptor["outputs"] if o["type"] == "Texture2D")
    atlas_file = data.root / texture["path"]
    if not atlas_file.is_file() and texture["path"] in data.base_release_entries and data.restore_output is not None:
        data.restore_output(texture["path"], atlas_file)
    if sha(atlas_file) != texture["sha256"]:
        raise ValueError("font atlas identity mismatch")
    with Image.open(atlas_file) as image:
        atlas = np.array(image.convert("RGBA"))
    glyph_table = {g["m_Index"]: g for g in font["m_GlyphTable"]}
    chars = {c["m_Unicode"]: c for c in font["m_CharacterTable"]}
    glyphs = {}
    pad = font["m_AtlasPadding"]
    for character in "0123456789Lv.":
        glyph = glyph_table[chars[ord(character)]["m_GlyphIndex"]]
        rect = glyph["m_GlyphRect"]
        x, y = rect["m_X"] - pad, rect["m_Y"] - pad
        w, h = rect["m_Width"] + 2 * pad, rect["m_Height"] + 2 * pad
        top = atlas.shape[0] - y - h
        mask = atlas[top:top + h, x:x + w, 3] > 127
        ys, xs = np.where(mask)
        mask = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        glyphs[character] = ["".join("1" if v else "0" for v in row) for row in mask]
    allowed = {kind: sorted({int(row["_level"]) for row in data.tables[table]})
               for kind, table in (("members", "MasterMemberCardLevel"), ("snapshots", "MasterSupportCardLevel"))}
    return {"fontName": font["m_FaceInfo"]["m_FamilyName"] + " " + font["m_FaceInfo"]["m_StyleName"],
            "atlasSha256": texture["sha256"], "fontArchiveSha256": descriptor["objectArchive"]["sha256"],
            "glyphs": glyphs, "allowedLevels": allowed}


def materialize_index(source: dict, release_id: str) -> dict:
    return {"schema": "haneoka-card-recognition-index-v1",
            "identity": {"server": source["server"], "releaseId": release_id, "sourceId": source["sourceId"]},
            "references": source["references"], "levelReader": source.get("levelReader")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-root", type=Path, required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--release-id", help="materialize a private index after the actual release is known")
    parser.add_argument("--without-levels", action="store_true", help="publish card references without any optional font/archive inputs")
    args = parser.parse_args()
    data = None
    if not args.without_levels:
        from build.api import BuildData
        data = BuildData(args.server, args.build_root)
    source = source_index(args.build_root, args.server, data=data)
    result = materialize_index(source, args.release_id) if args.release_id else source
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False) + "\n")
    print(json.dumps({"references": len(source["references"]), "levelReader": source["levelReader"] is not None}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
