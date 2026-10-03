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


def source_index(build: Path, server: str, *, include_levels: bool = True) -> dict:
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
    if include_levels:
        try:
            reader = level_reader(build, index)
            level_status = {"status": "available" if reader is not None else "unavailable",
                            "reason": None if reader is not None else "font_binding_unsupported_or_absent"}
        except (OSError, KeyError, StopIteration, ValueError) as error:
            # Level resources are optional. Do not delay card identity projection.
            # The reason contains no server path or untrusted exception text.
            level_status = {"status": "unavailable", "reason": "missing_or_invalid_level_resources"}
    return {"schema": "haneoka-card-recognition-source-v1", "server": server, "sourceId": index["sourceId"],
            "references": references, "levelReader": reader, "levelReaderStatus": level_status}


def level_reader(build: Path, index: dict) -> dict | None:
    reader = None
    # The bound Lv face has this source name in the current original prefab.
    # Glyphs come from the selected build, never a research filesystem or screenshot.
    font_path = next((name for name in index["sources"] if name.endswith("VibeMOPro-Medium SDF.asset")), None)
    binding_names = set()
    for widget in ("UIMemberCardListWidget", "UISupportCardListWidget"):
        ui_path = f"Assets/AddressableResources/UI/Prefab/{widget}.prefab"
        entry = index["sources"].get(ui_path)
        if entry is None:
            continue
        ui_metadata = json.loads((build / "metadata" / entry["descriptor"]).read_text())
        ui_archive = build / ui_metadata["objectArchive"]["path"]
        if sha(ui_archive) != ui_metadata["objectArchive"]["sha256"]:
            raise ValueError("level binding prefab identity mismatch")
        with gzip.open(ui_archive, "rt") as stream:
            ui_objects = [json.loads(line) for line in stream]
        names = {str(o.get("pathId")): o["data"].get("m_Name") for o in ui_objects if o.get("type") == "GameObject"}
        for o in ui_objects:
            data = o.get("data", {})
            if names.get(str(data.get("m_GameObject", {}).get("m_PathID"))) == "LvValueText" and "m_fontAsset" in data:
                binding_names.add(data["m_fontAsset"].get("reference", {}).get("name"))
    if font_path is not None and binding_names == {"VibeMOPro-Medium SDF"}:
        descriptor = build / "metadata" / index["sources"][font_path]["descriptor"]
        metadata = json.loads(descriptor.read_text())
        archive = build / metadata["objectArchive"]["path"]
        if sha(archive) != metadata["objectArchive"]["sha256"]:
            raise ValueError("font archive identity mismatch")
        with gzip.open(archive, "rt") as stream:
            objects = [json.loads(line) for line in stream]
        font = next(o["data"] for o in objects if o.get("data", {}).get("m_Name") == "VibeMOPro-Medium SDF")
        texture = next(o for o in metadata["outputs"] if o["type"] == "Texture2D")
        atlas_file = build / texture["path"]
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
        allowed = {}
        for kind, table in (("members", "MasterMemberCardLevel"), ("snapshots", "MasterSupportCardLevel")):
            rows = json.loads((build / "master" / f"{table}.json").read_text())["_allData"]
            allowed[kind] = sorted({int(row["_level"]) for row in rows})
        reader = {"fontName": font["m_FaceInfo"]["m_FamilyName"] + " " + font["m_FaceInfo"]["m_StyleName"], "atlasSha256": texture["sha256"],
                  "fontArchiveSha256": metadata["objectArchive"]["sha256"],
                  "glyphs": glyphs, "allowedLevels": allowed}
    return reader


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
    source = source_index(args.build_root, args.server, include_levels=not args.without_levels)
    result = materialize_index(source, args.release_id) if args.release_id else source
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False) + "\n")
    print(json.dumps({"references": len(source["references"]), "levelReader": source["levelReader"] is not None}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
