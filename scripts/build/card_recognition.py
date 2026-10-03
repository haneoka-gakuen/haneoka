"""Stage the selected source's recognition reference artifact after API projection."""
from __future__ import annotations
import re
from pathlib import Path
from core.manifests import read_json, write_json
from core.paths import validate_release_path
from recognize.build_index import source_index

SOURCE_PATH = "runtime/card-recognition/source.json"


def build_card_recognition_source(root: Path, server: str, source_id: str, *, card_only=False):
    selected = read_json(root / "metadata/source-index.json")
    if selected.get("server") != server or selected.get("sourceId") != source_id:
        raise ValueError("recognition input index belongs to a different source")
    source = source_index(root, server, include_levels=not card_only)
    if source.get("schema") != "haneoka-card-recognition-source-v1" or source.get("sourceId") != source_id or "releaseId" in source:
        raise ValueError("recognition source identity is invalid or self-referential")
    refs = source["references"]
    expected = {(kind, int(card)) for kind, resource in (("members", "cards"), ("snapshots", "support-cards"))
                for card in read_json(root / "api/v1/catalog" / (resource + ".json"))}
    if not 0 < len(refs) <= 2048 or {(r["kind"], r["cardId"]) for r in refs} != expected or len(refs) != len(expected):
        raise ValueError("recognition references do not exactly cover selected card catalogs")
    for ref in refs:
        digest = ref["sha256"]
        path = validate_release_path(ref["sourcePath"])
        if (not re.fullmatch(r"[a-f0-9]{64}", digest) or not path.startswith("assets/") or not path.endswith(".png")
                or ref["path"] != f"images/{digest}.png" or ref["variant"] != "thumbnail"):
            raise ValueError("recognition thumbnail identity is invalid")
    write_json(root / SOURCE_PATH, source)
    return {"path": SOURCE_PATH, "references": len(refs), "levelReaderAvailable": source.get("levelReader") is not None,
            "levelReaderStatus": source.get("levelReaderStatus"), "sourceId": source_id}
