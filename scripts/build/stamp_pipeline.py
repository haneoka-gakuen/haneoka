"""Automatic international stamp derivatives, staged for normal release/CAS publication."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
from pathlib import Path

from core.hashes import sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import PROJECT_ROOT, build_layout, validate_release_path

MANIFEST = "runtime/stamp-maker/manifest.json"
OBJECT_PREFIX = "assets/Assets/Haneoka/StampMaker/shared/sha256"
SERVERS = ("intl", "intl-test")


def input_fingerprint(sources: list[dict]) -> str:
    # IDs, filenames and source category never decide whether pixels are reused.
    fields = ("language", "sha256", "spriteSha256", "textureSize", "effectiveOriginalSize",
              "spriteRect", "atlasSpriteRect", "downscaleMultiplier")
    evidence = sorted(({k: source[k] for k in fields} for source in sources), key=lambda s: s["language"])
    return hashlib.sha256(stable_json(evidence).encode()).hexdigest()


def seed_cache_inputs(seed_manifest: Path | None, seed_provenance: Path | None = None,
                      repair_cache_manifest: Path | None = None) -> tuple[dict, dict | None]:
    """Bind actual portable metadata and repair objects before using a reviewed seed."""
    inputs = {}
    if seed_manifest is not None:
        inputs["seedManifestSha256"] = sha256_file(seed_manifest)
    provenance = None
    if seed_provenance is not None:
        if seed_manifest is None or repair_cache_manifest is None:
            raise ValueError("seed provenance requires its seed and repair cache manifests")
        provenance = read_json(seed_provenance)
        inputs["seedProvenanceSha256"] = sha256_file(seed_provenance)
        inputs["repairCacheManifestSha256"] = sha256_file(repair_cache_manifest)
        if (provenance.get("schema") != "haneoka-stamp-seed-provenance-v1"
                or provenance.get("seedManifestSha256") != inputs["seedManifestSha256"]
                or provenance.get("repairCacheManifestSha256") != inputs["repairCacheManifestSha256"]):
            raise ValueError("seed provenance metadata identity mismatch")
        cache = read_json(repair_cache_manifest)
        if cache.get("schema") != "haneoka-stamp-local-repair-cache-v1":
            raise ValueError("invalid reviewed repair cache")
        entries = {}
        for entry in cache["records"]:
            for field in ("patchImage", "patchMask"):
                file = repair_cache_manifest.parent / entry[field]
                if sha256_file(file) != entry[field + "Sha256"]:
                    raise ValueError("seed repair cache object hash mismatch")
            repaired_hash = hashlib.sha256((entry["sourceHash"] + entry["patchImageSha256"]
                                           + entry["patchMaskSha256"]).encode()).hexdigest()
            entries[repaired_hash] = entry
        for record in provenance["records"]:
            entry = entries.get(record["sourceHash"])
            local = record.get("localRepair", {})
            if (entry is None or record.get("localGeneratedRepair") is not True
                    or record.get("localRepairCacheApplied") is not True
                    or record.get("repairInputSourceHash") != entry["sourceHash"]
                    or record.get("repairSourceIdentity") != provenance.get("sourceIdentity")
                    or local.get("outsideMaskRgbaIdentity") is not True
                    or entry.get("outsidePatchByteIdentity") is not True
                    or any(local.get(k) != entry[k] for k in
                           ("inputPixelSha256", "patchImageSha256", "patchMaskSha256", "bbox"))):
                raise ValueError("seed local repair provenance differs from its actual cache")
    elif repair_cache_manifest is not None:
        raise ValueError("seed repair cache requires its portable provenance manifest")
    return inputs, provenance


def reviewed_seed_record(record: dict, seed: dict, inputs: dict, provenance: dict | None) -> dict:
    identity = seed.get("sourceIdentity")
    result = {**record, "seedOrigin": {**inputs, "sourceIdentity": identity}}
    if provenance is not None:
        if provenance.get("sourceIdentity") != identity:
            raise ValueError("seed review source identity mismatch")
        evidence = next((r for r in provenance["records"]
                         if r["sourceHash"] == record["sourceHash"]
                         and r["inputFingerprint"] == input_fingerprint(record["sources"])), None)
        if evidence is not None:
            result.update({k: evidence[k] for k in ("localGeneratedRepair", "localRepairCacheApplied",
                                                   "localRepair", "repairSourceIdentity", "repairInputSourceHash")})
    if ("-reviewed-local-v1" in record["algorithmVersion"]
            and (result.get("localGeneratedRepair") is not True or not result.get("localRepair"))):
        raise ValueError("reviewed seed image is missing portable local repair provenance")
    return result


def recipe_identity(base: dict, cache_inputs: dict, previous: dict | None = None) -> tuple[dict, str]:
    if not cache_inputs and previous is not None and previous.get("base") == base:
        cache_inputs = previous.get("cacheInputs", {})
    document = {"schema": "haneoka-stamp-production-recipe-v2", "base": base,
                "cacheInputs": cache_inputs}
    return document, hashlib.sha256(stable_json(document).encode()).hexdigest()


def detector_model(path: Path | None = None, *, allow_download: bool = True) -> Path:
    info = read_json(PROJECT_ROOT / "scripts/build/textless-stamps-models.json")["textDetection"]
    target = path or Path(os.environ.get("TEXTLESS_DETECTOR_MODEL", PROJECT_ROOT / ".cache/stamp-cv/text-detector.onnx"))
    if not target.is_file() and path is None and allow_download:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".download")
        try:
            with urllib.request.urlopen(info["url"], timeout=60) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            if temporary.stat().st_size != info["bytes"] or sha256_file(temporary) != info["sha256"]:
                raise ValueError("stamp detector download differs from the pinned model")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    if target.stat().st_size != info["bytes"] or sha256_file(target) != info["sha256"]:
        raise ValueError("stamp detector differs from the pinned model")
    return target


def restore_stamp_inputs(root: Path, index: dict, delta) -> None:
    if delta is None:
        return
    digests = {output["bundleSha256"] for name, entry in index["sources"].items()
               if name.startswith("Assets/AddressableResources/Stamp/")
               for output in entry.get("outputs", [])}
    for digest in sorted(digests):
        entry = delta.plan_entry(digest)
        if entry is None:
            continue
        paths = [entry["report"], entry["archive"], *entry["media"]]
        for item in paths:
            relative = validate_release_path(item.get("rel") or item["path"])
            target = root / relative
            if not target.is_file() or sha256_file(target) != item["sha256"]:
                delta.fetch_release_path(relative, target)


def stage_records(root: Path, server: str, source_id: str, rows: list[dict], records: list[dict], recipe: str,
                  production_recipe: dict | None = None) -> dict:
    import numpy as np
    from PIL import Image

    expected = {str(row["stampId"]): row for row in rows}
    if len(expected) != len(rows) or {str(r["stampId"]) for r in records} != expected.keys() or len(records) != len(rows):
        raise ValueError("stamp derivative coverage differs from the complete catalog")
    objects = {}; public = []
    for record in records:
        row = expected[str(record["stampId"])]
        frozen = record.get("reusedByStampId") is True
        if not frozen and input_fingerprint(record["sources"]) != input_fingerprint(row["variants"]):
            raise ValueError("stamp derivative input evidence changed")
        asset = record["artifacts"]["sourceImage"]
        file = Path(asset["path"])
        if sha256_file(file) != asset["sha256"]:
            raise ValueError("stamp derivative output hash mismatch")
        with Image.open(file) as image:
            if image.format != "PNG":
                raise ValueError("stamp derivative is not a PNG")
            pixels = np.array(image.convert("RGBA"))
        width, height = pixels.shape[1], pixels.shape[0]
        if ([width, height] != record["effectiveSourceSize"]
                or width > record["effectiveOriginalSize"][0] or height > record["effectiveOriginalSize"][1]
                or record.get("processingToSourceScale", 1) != 1):
            raise ValueError("stamp derivative resamples or exceeds its native frame")
        if not record["hasArtwork"] and pixels[..., 3].any():
            raise ValueError("text-only derivative must have an empty alpha channel")
        if not frozen and (set(record["languageWeights"]) != {s["language"] for s in row["variants"]} or any(v != 1 for v in record["languageWeights"].values())):
            raise ValueError("stamp language evidence must have equal weights")
        pixels[pixels[..., 3] == 0, :3] = 0
        pixel_hash = hashlib.sha256(width.to_bytes(4, "big") + height.to_bytes(4, "big") + pixels.tobytes()).hexdigest()
        if pixel_hash not in objects:
            # Preserve source PNG bytes; different encodings of identical RGBA share one object.
            digest = sha256_file(file)
            relative = f"{OBJECT_PREFIX}/{digest}.png"
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and sha256_file(target) != digest:
                raise ValueError("stamp content object changed")
            if not target.exists():
                shutil.copyfile(file, target)
            objects[pixel_hash] = {"path": f"/assets/{server}/" + relative.removeprefix("assets/"), "sha256": digest}
        obj = objects[pixel_hash]
        public_record = {"id": row["id"], "stampId": str(row["stampId"]), "sourceServer": server,
                       "publishable": True, "hasArtwork": record["hasArtwork"], "quality": record["quality"],
                       "effectiveSourceSize": [width, height], "effectiveOriginalSize": record["effectiveOriginalSize"],
                       "inputFingerprint": record.get("inputFingerprint") if frozen else input_fingerprint(row["variants"]),
                       "recipeFingerprint": record.get("recipeFingerprint", recipe),
                       "pixelSha256": pixel_hash, "algorithmVersion": record["algorithmVersion"],
                       "sourceHash": record["sourceHash"], "languageWeights": record["languageWeights"],
                       "exportPolicy": record["exportPolicy"],
                       "artifacts": {"sourceImage": obj, "exportCandidate": obj}}
        for field in ("seedOrigin", "localGeneratedRepair", "localRepairCacheApplied", "localRepair",
                      "repairSourceIdentity", "repairInputSourceHash", "originSourceIdentity"):
            if field in record:
                public_record[field] = record[field]
        public_record.setdefault("originSourceIdentity", {"server": server, "sourceId": source_id})
        public.append(public_record)
    document = {"schema": "haneoka-textless-stamps-v1", "server": server,
                "sourceIdentity": {"server": server, "sourceId": source_id}, "records": public}
    if production_recipe is not None:
        document["productionRecipe"] = production_recipe
    write_json(root / MANIFEST, document)
    return {"server": server, "sourceId": source_id, "records": len(public), "objects": len(objects), "manifest": MANIFEST}


def build_textless_stamps(server: str, source_id: str, build_id: str, *, model: Path | None = None,
                          delta=None, seed_manifest: Path | None = None, allow_model_download: bool = True,
                          reuse_manifest: dict | None = None, restore_output=None,
                          seed_provenance: Path | None = None, repair_cache_manifest: Path | None = None,
                          id_cache=None, previous_manifests: list[dict] | None = None) -> dict:
    if server not in SERVERS:
        return {"server": server, "skipped": True, "reason": "international variants only"}
    from build import textless_stamps as producer

    layout = build_layout(server, build_id)
    index = read_json(layout.metadata / "source-index.json")
    if index.get("server") != server or index.get("sourceId") != source_id:
        raise ValueError("stamp build source identity mismatch")
    if delta is not None and delta.source_id != source_id:
        raise ValueError("stamp delta source identity mismatch")
    entities = read_json(layout.api / "stamps.json")
    pool = dict(id_cache.records) if id_cache is not None else {}
    documents = list(previous_manifests or [])
    own = delta.base_document(MANIFEST) if delta is not None and delta.entry(MANIFEST) else reuse_manifest
    if own is None:
        own = next((document for document in documents if document.get("server") == server), None)
    if own is None and (layout.root / MANIFEST).is_file():
        own = read_json(layout.root / MANIFEST)
    if own is not None:
        documents.append(own)
    for document in documents:
        if document.get("schema") != "haneoka-textless-stamps-v1" or document.get("server") not in SERVERS:
            raise ValueError("stamp cache belongs to an unsupported server")
        for old in document.get("records", []):
            if old.get("publishable") is True and str(old.get("stampId", "")).isdecimal():
                record = {**old, "originSourceIdentity": old.get("originSourceIdentity", document.get("sourceIdentity"))}
                pool.setdefault(str(old["stampId"]), record)
                if id_cache is not None:
                    id_cache.remember(record)
    seeds = {}
    cache_inputs, provenance = seed_cache_inputs(seed_manifest, seed_provenance, repair_cache_manifest)
    if seed_manifest:
        seed = read_json(seed_manifest)
        if seed.get("schema") != "haneoka-textless-stamps-v1" or seed.get("server") not in SERVERS:
            raise ValueError("stamp seed belongs to an unsupported server")
        for record in seed["records"]:
            stamp_id = str(record.get("stampId", ""))
            if record.get("publishable") is True and stamp_id.isdecimal() and stamp_id not in pool:
                asset = record["artifacts"]["sourceImage"]
                file = Path(asset["path"])
                if not file.is_absolute():
                    file = seed_manifest.parent / file
                seeds[stamp_id] = {**reviewed_seed_record(record, seed, cache_inputs, provenance),
                                    "originSourceIdentity": seed.get("sourceIdentity"),
                                    "artifacts": {"sourceImage": {**asset, "path": str(file)}}}
    pending = set(entities) - set(pool) - set(seeds)
    unavailable = sorted(stamp_id for stamp_id in pending if not entities[stamp_id].get("image"))
    pending.difference_update(unavailable)
    base_recipe = {"producer": sha256_file(Path(producer.__file__)), "pipeline": sha256_file(Path(__file__))}
    if pending:
        restore_stamp_inputs(layout.root, index, delta)
        model_path = detector_model(model, allow_download=allow_model_download)
        producer._DETECTOR_MODEL = str(model_path.resolve())
        producer._DETECTOR_NET = None
        producer._TOOLCHAIN = None
        base_recipe["toolchain"] = producer.toolchain_fingerprint()
        inventory = producer.catalog_inventory(layout.api / "stamps.json", layout.root, layout.assets, server, stamp_ids=pending)
        fresh = {str(row["stampId"]): row for row in inventory["records"]}
    else:
        fresh = {}
    if not pending and own is not None and isinstance(own.get("productionRecipe"), dict):
        production_recipe = own["productionRecipe"]
        recipe = hashlib.sha256(stable_json(production_recipe).encode()).hexdigest()
    else:
        production_recipe, recipe = recipe_identity(base_recipe, cache_inputs)
    reused = 0; generated = 0
    with tempfile.TemporaryDirectory(prefix="haneoka-stamps-") as temporary:
        working = Path(temporary); records = []; rows = []
        all_ids = set(pool) | set(seeds) | set(fresh)
        for stamp_id in sorted(all_ids, key=int):
            if id_cache is not None:
                id_cache.renew()
            record = pool.get(stamp_id)
            if record is not None:
                asset = record["artifacts"]["sourceImage"]
                target = working / (asset["sha256"] + ".png")
                if id_cache is not None:
                    id_cache.restore(record, target)
                elif own is not None and own.get("server") == server:
                    prefix = f"/assets/{server}/"
                    relative = validate_release_path("assets/" + asset["path"].removeprefix(prefix))
                    if delta is not None:
                        delta.fetch_release_path(relative, target)
                    elif restore_output is not None:
                        restore_output(relative, target)
                    else:
                        raise ValueError("stamp ID cache requires an object restorer")
                else:
                    raise ValueError("shared stamp cache requires its CAS store")
                record = {**record, "reusedByStampId": True, "artifacts": {"sourceImage": {**asset, "path": str(target)}}}
                row = {"stampId": stamp_id, "id": record["id"], "variants": []}
                reused += 1
            elif stamp_id in seeds:
                record = seeds[stamp_id]
                record = {**record, "reusedByStampId": True, "inputFingerprint": input_fingerprint(record["sources"])}
                row = {"stampId": stamp_id, "id": record["id"], "variants": []}
                reused += 1
            else:
                row = fresh[stamp_id]
                record = producer.build_catalog_record(row, working)
                count = record.get("unresolvedNativeDetailPixels", 0)
                area = record["effectiveSourceSize"][0] * record["effectiveSourceSize"][1]
                if count > max(24, area * .005):
                    raise ValueError(f"stamp {stamp_id} has {count} unresolved detail pixels; reconstruction failed")
                record["quality"] = "validated-native-fusion"
                generated += 1
            rows.append(row); records.append(record)
        result = stage_records(layout.root, server, source_id, rows, records, recipe, production_recipe)
        if id_cache is not None:
            public = read_json(layout.root / MANIFEST)
            for record in public["records"]:
                asset = record["artifacts"]["sourceImage"]
                relative = "assets/" + asset["path"].removeprefix(f"/assets/{server}/")
                id_cache.preserve_image(record, layout.root / validate_release_path(relative))
            id_cache.save()
    result.update(reused=reused, generated=generated, unavailableStampIds=unavailable)
    result["recipeFingerprint"] = recipe
    write_json(layout.reports / "textless-stamps.json", result)
    return result
