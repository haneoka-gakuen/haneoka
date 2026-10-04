"""Project reviewed native JP shop payment metadata onto an exact current release."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build.jp_shop import bind_jp_shop_metadata
from core.config import load_server_config
from core.manifests import stable_json, write_json
from publish.band_descriptions import document, entry_json, publish
from publish.gacha_rates import raw_table
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from verify.release import release_entries, write_release_identity_files

TABLES = {"MasterShop", "MasterShopProduct"}
ALLOWED = {"payment", "sourceTable", "shopId", "identityNamespace"}
RECIPE = "native-jp-shop-current-v1"
HELPER_SHA256 = "088a0a0cb7f62bb514808372aabe5705f86c64cec8bb17c5542fee536eb47ffe"


def project(document, shop_rows, product_rows, *, require_grants=True):
    before = document.get("entries")
    if not isinstance(before, dict) or len(before) != 75:
        raise ValueError("native JP current shop coverage differs from reviewed 75-row input")
    grants = defaultdict(list)
    for row in product_rows:
        grants[str(row["_shopId"])].append((row["_resourceType"], row["_resourceId"], row["_resourceCount"], bool(row["_isBonus"])))
    if set(grants) != set(before):
        raise ValueError("native ShopProduct grant domains differ from current JP lineup")
    if require_grants:
        for key, row in before.items():
            actual = [(r["resourceType"], r["resourceId"], r["count"], bool(r["bonus"])) for r in row["rewards"]]
            if actual != grants[key]:
                raise ValueError("current JP grants differ from verified original ShopProduct")
    updated = bind_jp_shop_metadata(document, shop_rows)
    cash = sum(r["payment"]["storePurchase"] is True for r in updated["entries"].values())
    if cash != 16 or len(updated["entries"]) - cash != 59:
        raise ValueError("native JP cash/currency split differs from reviewed 16/59")
    for key, row in updated["entries"].items():
        if {k: v for k, v in row.items() if k not in ALLOWED} != {k: v for k, v in before[key].items() if k not in ALLOWED}:
            raise ValueError("JP shop projection changed grants, windows, assets or unrelated fields")
    if {k: v for k, v in updated.items() if k != "entries"} != {k: v for k, v in document.items() if k != "entries"}:
        raise ValueError("JP shop root metadata changed")
    return updated


def prepare(store, config, projection, staging):
    identity = projection["identity"]
    if (config.id != "jp" or identity.get("server") != "jp"
            or set(projection.get("originalMasterSHA256", {})) != TABLES):
        raise ValueError("native shop requires exact JP identity and two original Master digests")
    pointer_key = "servers/jp/current.json"
    head, pointer = store.head(pointer_key), document(store, pointer_key, 4096)
    if not head or any(pointer.get(k) != identity[k] for k in ("releaseId", "sourceId")):
        raise ValueError("JP current changed before shop projection; refresh exact input")
    manifest_key = f"servers/jp/releases/{identity['releaseId']}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError("JP current manifest key differs")
    base = document(store, manifest_key)
    records = _validate_release_manifest_for_gc(base, manifest_key, "jp", identity["releaseId"])
    if base["sourceId"] != identity["sourceId"]:
        raise ValueError("JP shop parent source differs")
    entries = {row["path"]: row for row in records}
    tables, master_entries = {}, {}
    for name in TABLES:
        entry = entries[f"game-client/master/{name}.bin"]
        if entry["sha256"] != projection["originalMasterSHA256"][name]:
            raise ValueError("JP shop Master input differs from current immutable original CAS")
        tables[name] = raw_table(store, entry, name, config.master_crypto)
        master_entries[name] = entry
    if len(tables["MasterShop"]) != 75 or len(tables["MasterShopProduct"]) != 190:
        raise ValueError("original JP shop row counts differ")
    catalog = entry_json(store, entries["api/v1/catalog/manifest.json"], 256 * 1024)
    if catalog.get("sourceId") != identity["sourceId"] or catalog.get("server") != "jp":
        raise ValueError("JP catalog identity differs")
    descriptor = catalog["resources"]["shop"]
    partition = descriptor["entities"]
    if (descriptor["index"] != "api/v1/catalog/shop/index.json"
            or partition.get("algorithm") != "fnv1a32-mod-256"
            or partition["prefix"] != "api/v1/catalog/shop/entities/"
            or descriptor.get("relations")):
        raise ValueError("unsupported current JP shop storage contract")
    index = entry_json(store, entries[descriptor["index"]], 2 * 1024 * 1024)
    updated_index = project(index, tables["MasterShop"], tables["MasterShopProduct"], require_grants=False)
    selected, details, preservation = {}, {}, {}

    def stage(path, before, after):
        if before != after:
            write_json(staging / path, after)
            selected[path] = True

    stage(descriptor["index"], index, updated_index)
    seen, metadata_bytes, originals, shard_documents = set(), entries[descriptor["index"]]["bytes"], {}, {}
    for shard in partition["shards"]:
        path = partition["prefix"] + shard + ".json"
        metadata_bytes += entries[path]["bytes"]
        if metadata_bytes > 16 * 1024 * 1024:
            raise ValueError("JP shop metadata exceeds bounded budget")
        original = entry_json(store, entries[path], 2 * 1024 * 1024)
        shard_documents[path] = original
        for key, row in original.items():
            if key not in index["entries"] or key in seen or any(row.get(k) != v for k, v in index["entries"][key].items()):
                raise ValueError("current JP full/index entity mismatch")
            seen.add(key)
            originals[key] = row
            preservation[key] = hashlib.sha256(stable_json({k: v for k, v in row.items() if k not in ALLOWED}).encode()).hexdigest()
    if seen != set(index["entries"]):
        raise ValueError("current JP full/index coverage differs")
    details = project({"entries": originals}, tables["MasterShop"], tables["MasterShopProduct"])["entries"]
    for key, row in details.items():
        if any(row.get(field) != updated_index["entries"][key].get(field) for field in ALLOWED):
            raise ValueError("projected JP native payment metadata differs between full/index")
    for path, original in shard_documents.items():
        stage(path, original, {key: copy.deepcopy(details[key]) for key in original})
    if "api/shop.json" in entries:
        original = entry_json(store, entries["api/shop.json"], 2 * 1024 * 1024)
        updated = project(original, tables["MasterShop"], tables["MasterShopProduct"])
        if updated["entries"] != details:
            raise ValueError("legacy JP shop differs from current full/index projection")
        stage("api/shop.json", original, updated)
    changed = release_entries(staging)
    if {row["path"] for row in changed} != set(selected):
        raise ValueError("JP shop staging escaped selected JSON entries")
    reused = [row for row in records if row["path"] not in selected]
    result = {"pointer": pointer, "pointerETag": head["ETag"], "sourceId": identity["sourceId"],
              "noOp": not changed, "changedEntries": changed, "reusedEntryCount": len(reused),
              "index": updated_index, "details": details, "preservation": preservation,
              "MasterEntries": master_entries, "metadataBytes": metadata_bytes}
    if changed:
        manifest = write_release_identity_files(staging, "jp", identity["sourceId"], sorted(reused + changed, key=lambda r: r["path"]))
        checked = _validate_release_manifest_for_gc(manifest, f"servers/jp/releases/{manifest['releaseId']}/release.json", "jp", manifest["releaseId"])
        if {r["path"]: r for r in checked if r["path"] not in selected} != {r["path"]: r for r in reused}:
            raise ValueError("non-shop metadata or asset CAS identity changed")
        result["manifest"] = manifest
    return result


def verify_public(receipt, prepared, output):
    proofs = []
    # Authoritative current shop index plus one cash and one currency full entity.
    currency = next(k for k, v in prepared["details"].items() if not v["payment"]["storePurchase"])
    for key in ["shop", "shop/2", "shop/" + currency]:
        url = f"https://haneoka.org/api/v1/servers/jp/{key}?release={receipt['releaseId']}"
        with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as response:
            if response.status != 200 or response.headers.get("X-Haneoka-Release-Id") != receipt["releaseId"] or response.headers.get("X-Haneoka-Source-Id") != receipt["sourceId"]:
                raise ValueError("JP shop public response pin differs")
            body = response.read(2 * 1024 * 1024 + 1)
            if len(body) > 2 * 1024 * 1024:
                raise ValueError("JP shop public readback exceeds cap")
            expected = prepared["index"] if key == "shop" else prepared["details"][key.split("/")[1]]
            if json.loads(body) != expected:
                raise ValueError("JP shop public full/index differs from exact prepared projection")
            proofs.append({"path": key, "HTTP": 200, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
    write_json(output / "public-readback.json", proofs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pin = os.environ["PRODUCER_PIN"]
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != pin:
        raise ValueError("JP shop publication producer commit mismatch")
    helper = Path(__file__).resolve().parents[1] / "build/jp_shop.py"
    if hashlib.sha256(helper.read_bytes()).hexdigest() != HELPER_SHA256:
        raise ValueError("JP shop helper differs from reviewed native producer")
    packed = os.environ["JP_SHOP_INPUT_JSON"]
    if len(packed.encode()) > 4096:
        raise ValueError("JP shop projection input exceeds cap")
    projection = json.loads(packed)
    config = load_server_config("jp")
    store = R2Store(config, concurrency=4)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="native-jp-shop-metadata-") as directory:
        staging = Path(directory)
        prepared = prepare(store, config, projection, staging)
        receipt = {"schema": "haneoka-current-native-jp-shop-receipt-v1", "recipe": RECIPE, "producerPin": pin,
                   "server": "jp", "sourceId": prepared["sourceId"], "baseReleaseId": projection["identity"]["releaseId"],
                   "releaseId": prepared.get("manifest", prepared["pointer"])["releaseId"], "noOp": prepared["noOp"],
                   "published": False, "promoted": False, "rowCount": 75, "cashRows": 16, "currencyRows": 59,
                   "originalMasterEntries": prepared["MasterEntries"], "metadataBytes": prepared["metadataBytes"],
                   "changedEntries": prepared["changedEntries"], "reusedEntries": prepared["reusedEntryCount"],
                   "capturedCurrentETag": prepared["pointerETag"], "grantsWindowsAssetsAndOtherFieldsPreserved": True,
                   "nativeIndexAndFullSame75": True, "platformPricesQueried": False, "IntlBiliPayUsed": False,
                   "rawBuildOrBaselineCopy": False, "pipelineFingerprintPreserved": True}
        write_json(args.output / "publication-receipt.json", receipt)
        if not prepared["noOp"] and os.environ.get("PUBLISH") == "true":
            receipt["pointer"] = publish(store, config, prepared, staging)
            receipt.update(published=True, promoted=True)
            write_json(args.output / "publication-receipt.json", receipt)
        if receipt["published"] or receipt["noOp"]:
            if store.get_json("servers/jp/current.json")["releaseId"] != receipt["releaseId"]:
                raise ValueError("JP shop current changed after conditional promotion")
            verify_public(receipt, prepared, args.output)
        if receipt["published"] and os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
                stream.write("release_promoted=true\n")
        print(stable_json(receipt))


if __name__ == "__main__":
    main()
