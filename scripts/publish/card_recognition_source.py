"""Add one source-only card recognition artifact to an exact observed current release."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build.card_recognition import SOURCE_PATH, build_card_recognition_source
from core.config import load_server_config
from core.contracts import SOURCE_INDEX_STORAGE_SCHEMA
from core.manifests import stable_json, write_json
from core.storage import cas_key, fnv1a32_shard
from publish.band_descriptions import document, entry_json, publish
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from verify.release import release_entries, write_release_identity_files


def prepare(store, config, identity, staging, inputs):
    if identity.get("server") != config.id or config.id not in {"intl", "jp"}:
        raise ValueError("recognition current server mismatch")
    pointer_key = f"servers/{config.id}/current.json"
    head = store.head(pointer_key)
    pointer = document(store, pointer_key, 4096)
    if any(pointer.get(k) != identity[k] for k in ("releaseId", "sourceId")):
        raise ValueError("current changed before recognition projection; refresh exact input")
    manifest_key = f"servers/{config.id}/releases/{identity['releaseId']}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError("invalid selected current manifest key")
    base = document(store, manifest_key)
    records = _validate_release_manifest_for_gc(base, manifest_key, config.id, identity["releaseId"])
    if base["sourceId"] != identity["sourceId"]:
        raise ValueError("recognition parent source mismatch")
    entries = {row["path"]: row for row in records}
    cache, input_bytes = {}, 0
    def read(path):
        nonlocal input_bytes
        if path not in cache:
            row = entries[path]
            input_bytes += row["bytes"]
            if input_bytes > 32 * 1024 * 1024:
                raise ValueError("selected recognition metadata closure exceeds budget")
            cache[path] = entry_json(store, row, 8 * 1024 * 1024)
        return cache[path]
    catalog = read("api/v1/catalog/manifest.json")
    if catalog.get("server") != config.id or catalog.get("sourceId") != identity["sourceId"]:
        raise ValueError("selected card catalog identity differs")
    source_manifest = read("metadata/source-index/manifest.json")
    if (source_manifest.get("schema") != SOURCE_INDEX_STORAGE_SCHEMA or source_manifest.get("server") != config.id
            or source_manifest.get("sourceId") != identity["sourceId"]):
        raise ValueError("selected source-index identity differs")
    source_parts = source_manifest["sources"]
    if source_parts.get("algorithm") != "fnv1a32-mod-256" or source_parts.get("prefix") != "metadata/source-index/sources/":
        raise ValueError("unsupported selected source-index partition contract")
    selected_sources = {}
    count = 0
    for resource in ("cards", "support-cards"):
        descriptor = catalog["resources"][resource]
        if descriptor["index"] != f"api/v1/catalog/{resource}/index.json":
            raise ValueError("unexpected current card index path")
        cards = read(descriptor["index"])
        if len(cards) != descriptor["count"]:
            raise ValueError("selected card catalog coverage differs")
        count += len(cards)
        if count > 2048:
            raise ValueError("recognition reference count exceeds limit")
        for card_id, card in cards.items():
            if not re.fullmatch(r"[1-9][0-9]*", card_id):
                raise ValueError("invalid selected card ID")
            uri = card.get("images", {}).get("thumbnail")
            prefix = f"/assets/{config.id}/"
            if not isinstance(uri, str) or not uri.startswith(prefix):
                raise ValueError("recognition thumbnail belongs to another server")
            source_path = uri.removeprefix(prefix)
            shard = fnv1a32_shard(source_path)
            if shard not in source_parts["shards"]:
                raise ValueError("current thumbnail source-index shard absent")
            sources = read(source_parts["prefix"] + shard + ".json")
            selected_sources[source_path] = sources[source_path]
        write_json(inputs / "api/v1/catalog" / (resource + ".json"), cards)
    # A selected-record projection of verified source-index partitions, never a research build.
    write_json(inputs / "metadata/source-index.json", {
        "server": config.id, "sourceId": identity["sourceId"], "sources": selected_sources})
    result = build_card_recognition_source(inputs, config.id, identity["sourceId"], card_only=True)
    source = json.loads((inputs / SOURCE_PATH).read_text())
    if source.get("levelReader") is not None:
        raise ValueError("card-only current projection must leave visible levels unknown")
    unique_images = {}
    for ref in source["references"]:
        entry = entries[ref["sourcePath"]]
        if (entry["sha256"] != ref["sha256"] or entry["mediaType"] != "image/png"
                or not 0 < entry["bytes"] <= 2 * 1024 * 1024):
            raise ValueError("recognition thumbnail output differs from actual release entry")
        if ref["sha256"] in unique_images and unique_images[ref["sha256"]]["bytes"] != entry["bytes"]:
            raise ValueError("same thumbnail CAS digest has inconsistent size")
        unique_images[ref["sha256"]] = entry
    source_bytes = (inputs / SOURCE_PATH).stat().st_size
    # Conservative upper bound for the provider's stored ZIP, including index/header overhead.
    bundle_bound = sum(row["bytes"] for row in unique_images.values()) + source_bytes + 4096 + 256 * len(unique_images)
    if source_bytes > 4 * 1024 * 1024 or bundle_bound > 64 * 1024 * 1024:
        raise ValueError("current recognition reference ZIP exceeds provider budget")
    def present(row):
        image_head = store.head(cas_key(row["sha256"]))
        if image_head is None or image_head.get("ContentLength") != row["bytes"]:
            raise ValueError("actual thumbnail CAS object absent or size differs")
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(present, unique_images.values()))
    target = staging / SOURCE_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(inputs / SOURCE_PATH, target)
    changed = release_entries(staging)
    if len(changed) != 1 or changed[0]["path"] != SOURCE_PATH:
        raise ValueError("recognition projection escaped its single artifact path")
    existing = entries.get(SOURCE_PATH)
    no_op = existing is not None and existing["sha256"] == changed[0]["sha256"] and existing["bytes"] == changed[0]["bytes"]
    reused = [row for row in records if row["path"] != SOURCE_PATH]
    prepared = {"pointer": pointer, "pointerETag": head["ETag"], "sourceId": identity["sourceId"],
                "changedEntries": [] if no_op else changed, "reusedEntryCount": len(reused), "noOp": no_op,
                "source": source, "sourceSHA256": changed[0]["sha256"], "inputMetadataPaths": sorted(cache),
                "inputMetadataBytes": input_bytes, "thumbnailCASHeadCount": len(unique_images),
                "thumbnailBodyDownloads": 0, "bundleSizeUpperBound": bundle_bound, "references": result["references"]}
    if not no_op:
        manifest = write_release_identity_files(staging, config.id, identity["sourceId"], sorted(reused + changed, key=lambda row: row["path"]))
        checked = _validate_release_manifest_for_gc(manifest, f"servers/{config.id}/releases/{manifest['releaseId']}/release.json", config.id, manifest["releaseId"])
        if {r["path"]: r for r in checked if r["path"] != SOURCE_PATH} != {r["path"]: r for r in reused}:
            raise ValueError("unrelated release entry changed during recognition projection")
        prepared["manifest"] = manifest
    return prepared


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pin = os.environ["PRODUCER_PIN"]
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != pin:
        raise ValueError("recognition producer pin mismatch")
    packed = os.environ["RECOGNITION_CURRENT_IDENTITY_JSON"]
    if len(packed.encode()) > 4096:
        raise ValueError("recognition input size cap")
    identity = json.loads(packed)
    if identity["server"] != os.environ["RESOURCE_SERVER"]:
        raise ValueError("recognition input server differs from workflow environment")
    config = load_server_config(identity["server"])
    store = R2Store(config, concurrency=4)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="current-recognition-projection-") as temporary:
        root = Path(temporary)
        prepared = prepare(store, config, identity, root / "release", root / "selected-inputs")
        receipt = {"schema": "haneoka-current-card-recognition-publication-v1", "producerPin": pin, "server": config.id,
                   "sourceId": identity["sourceId"], "baseReleaseId": identity["releaseId"], "published": False, "promoted": False,
                   "noOp": prepared["noOp"], "references": prepared["references"], "sourceSHA256": prepared["sourceSHA256"],
                   "levelReader": None, "levelReaderStatus": prepared["source"]["levelReaderStatus"],
                   "inputMetadataPaths": prepared["inputMetadataPaths"], "inputMetadataBytes": prepared["inputMetadataBytes"],
                   "thumbnailCASHeadCount": prepared["thumbnailCASHeadCount"], "thumbnailBodyDownloads": 0,
                   "bundleSizeUpperBound": prepared["bundleSizeUpperBound"], "rawBuildRun": False,
                   "pipelineFingerprintPreserved": True, "reusedEntries": prepared["reusedEntryCount"]}
        if not prepared["noOp"]:
            receipt.update({"releaseId": prepared["manifest"]["releaseId"], "changedPaths": [SOURCE_PATH],
                            "changedBytes": prepared["changedEntries"][0]["bytes"]})
            if os.environ.get("PUBLISH") == "true":
                receipt["pointer"] = publish(store, config, prepared, root / "release")
                receipt.update({"published": True, "promoted": True})
        else:
            receipt["releaseId"] = identity["releaseId"]
        write_json(args.output / "publication-receipt.json", receipt)
        if receipt["published"] or receipt["noOp"]:
            if store.get_json(f"servers/{config.id}/current.json")["releaseId"] != receipt["releaseId"]:
                raise ValueError("recognition current differs after conditional promotion")
            with urlopen(Request(f"https://haneoka.org/runtime/{config.id}/card-recognition/source.json?release={receipt['releaseId']}",
                                 headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}), timeout=30) as response:
                if (response.status != 200 or response.headers.get("X-Haneoka-Release-Id") != receipt["releaseId"]
                        or response.headers.get("X-Haneoka-Source-Id") != identity["sourceId"]):
                    raise ValueError("public recognition source readback identity differs")
                body = response.read(4 * 1024 * 1024 + 1)
                if (len(body) > 4 * 1024 * 1024 or json.loads(body) != prepared["source"]
                        or hashlib.sha256(body).hexdigest() != prepared["sourceSHA256"]):
                    raise ValueError("public recognition source differs from prepared artifact")
                write_json(args.output / "public-readback.json", {"HTTP": response.status, "bytes": len(body),
                           "sha256": hashlib.sha256(body).hexdigest(), "releaseId": receipt["releaseId"], "sourceId": identity["sourceId"]})
        if receipt["published"] and os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write("release_promoted=true\n")
    print(stable_json(receipt))


if __name__ == "__main__":
    main()
