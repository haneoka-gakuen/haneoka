"""Reproject selected current gacha rates from three verified original Master tables."""
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
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build.game_systems import _number, _prize_rate_rows
from core.config import load_server_config
from core.manifests import stable_json, write_json
from core.storage import cas_key, fnv1a32_shard
from extract.master import _decode_master_table
from publish.band_descriptions import document, entry_json, publish
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from py3rijndael import Pkcs7Padding, RijndaelCbc
from verify.release import release_entries, write_release_identity_files

TABLES = {"MasterGacha", "MasterGachaLot", "MasterGachaPrize"}


def raw_table(store, entry, name, crypto):
    if not 0 < entry["bytes"] <= 2 * 1024 * 1024:
        raise ValueError("selected Master table exceeds byte budget")
    body = store.get_bytes(cas_key(entry["sha256"]))
    if body is None or len(body) != entry["bytes"] or hashlib.sha256(body).hexdigest() != entry["sha256"]:
        raise ValueError("selected Master CAS identity differs")
    salt, iv = bytes.fromhex(crypto["salt"]), bytes.fromhex(crypto["iv"])
    cipher = RijndaelCbc(bytes.fromhex(crypto["key"]), iv, Pkcs7Padding(32), block_size=32)
    return _decode_master_table(body, name, salt, iv, cipher)["_allData"]


def derive(original, pool, tables):
    lots = sorted([row for row in tables["MasterGachaLot"] if _number(row, "_lotGroupId") == _number(pool, "_lotGroupId")], key=lambda row: -_number(row, "_weight"))
    total = sum(_number(row, "_weight") for row in lots)
    if total <= 0 or len(lots) != len(original["rates"]):
        raise ValueError("current gacha groups differ from original Master lots")
    updated = copy.deepcopy(original)
    expected_original_rewards, expected_original_featured, featured = [], [], []
    changes = []
    for lot, group, prior in zip(lots, updated["rates"], original["rates"], strict=True):
        weight = _number(lot, "_weight")
        prizes = [row for row in tables["MasterGachaPrize"] if _number(row, "_groupId") == _number(lot, "_prizeGroupId")]
        shares = _prize_rate_rows(prizes, weight)
        if (weight < 0 or group["weight"] != weight or group["rarity"] != _number(lot, "_rarityConstraint")
                or group["rate"] != weight / total or len(group["prizes"]) != len(shares)):
            raise ValueError("current gacha group contract differs from original Master")
        if any(_number(row, "_pickUpAddedRate") != 0 for row in prizes):
            raise ValueError("nonzero added-rate semantics require separate original evidence")
        if sum(item["weight"] for item in shares) != weight:
            raise ValueError("projected prize weights do not conserve original group weight")
        legacy_regular = [row for row in prizes if _number(row, "_pickUpType") != 2]
        fixed = sum(_number(row, "_pickUpFixedRate") for row in prizes if _number(row, "_pickUpType") == 2)
        legacy_share = max(0, weight - fixed) // len(legacy_regular) if legacy_regular else 0
        for reward, old, item in zip(group["prizes"], prior["prizes"], shares, strict=True):
            prize = item["prize"]
            if (reward["resourceId"] != _number(prize, "_resourceId")
                    or reward["resourceType"] != _number(prize, "_resourceType")
                    or reward["count"] != (_number(prize, "_amount") or 1)
                    or reward["pickup"] != item["pickup"]):
                raise ValueError("current prize identity or pickup marker differs from original Master")
            rate = item["weight"] / total
            legacy = (_number(prize, "_pickUpFixedRate") or legacy_share) / total
            if old["rate"] not in (legacy, rate):
                raise ValueError("current prize rate is neither original projection nor corrected projection")
            reward["rate"] = rate
            expected_original_rewards.append(old)
            if item["pickup"]:
                expected_original_featured.append(old)
                featured.append(copy.deepcopy(reward))
            if old["rate"] != rate:
                changes.append({"prizeId": _number(prize, "_id"), "resourceId": reward["resourceId"], "before": old["rate"], "after": rate})
    if original["rewards"] != expected_original_rewards or original["featured"] != expected_original_featured:
        raise ValueError("current duplicated prize views differ from current rate groups")
    updated["rewards"] = [copy.deepcopy(prize) for group in updated["rates"] for prize in group["prizes"]]
    updated["featured"] = featured
    if {k: v for k, v in original.items() if k not in {"rates", "rewards", "featured"}} != {k: v for k, v in updated.items() if k not in {"rates", "rewards", "featured"}}:
        raise ValueError("gacha projection modified unrelated fields")
    return updated, changes


def prepare(store, config, projection, staging):
    if projection.get("schema") != "haneoka-current-gacha-rate-input-v1" or set(projection.get("originalMasterSHA256", {})) != TABLES:
        raise ValueError("gacha input requires exactly three original Master byte identities")
    identity = projection["identity"]
    ids = projection["poolIds"]
    if (identity["server"] != config.id or config.id != "intl" or not isinstance(ids, list)
            or not 1 <= len(ids) <= 8 or len(set(ids)) != len(ids)
            or any(not isinstance(i, str) or not re.fullmatch(r"[1-9][0-9]*", i) for i in ids)):
        raise ValueError("gacha projection requires bounded unique Intl pool IDs")
    pointer_key = f"servers/{config.id}/current.json"
    head = store.head(pointer_key)
    pointer = document(store, pointer_key, 4096)
    if any(pointer.get(field) != identity[field] for field in ("releaseId", "sourceId")):
        raise ValueError("current changed since selected gacha input; refresh exact pin")
    manifest_key = f"servers/{config.id}/releases/{identity['releaseId']}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError("invalid parent manifest key")
    base = document(store, manifest_key)
    records = _validate_release_manifest_for_gc(base, manifest_key, config.id, identity["releaseId"])
    if base["sourceId"] != identity["sourceId"]:
        raise ValueError("parent source mismatch")
    entries = {row["path"]: row for row in records}
    tables = {}
    for name, digest in projection["originalMasterSHA256"].items():
        entry = entries[f"game-client/master/{name}.bin"]
        if entry["sha256"] != digest:
            raise ValueError("selected Master input differs from current original bytes")
        tables[name] = raw_table(store, entry, name, config.master_crypto)
    pools = {str(_number(row, "_id")): row for row in tables["MasterGacha"]}
    if not set(ids) <= set(pools):
        raise ValueError("selected pool absent in original current Master")
    catalog = entry_json(store, entries["api/v1/catalog/manifest.json"])
    descriptor = catalog["resources"]["gacha"]
    entities = descriptor["entities"]
    if (descriptor["index"] != "api/v1/catalog/gacha/index.json" or entities.get("algorithm") != "fnv1a32-mod-256"
            or entities.get("prefix") != "api/v1/catalog/gacha/entities/"):
        raise ValueError("unsupported gacha catalog storage contract")
    selected = {}
    def select(path):
        if path not in selected:
            original = entry_json(store, entries[path], 8 * 1024 * 1024)
            selected[path] = (original, copy.deepcopy(original))
        return selected[path][1]
    index = select(descriptor["index"])
    archive = select("api/gacha.json") if "api/gacha.json" in entries else None
    details, changes = {}, {}
    for pool_id in ids:
        shard = fnv1a32_shard(pool_id)
        if shard not in entities["shards"]:
            raise ValueError("selected gacha partition absent")
        path = entities["prefix"] + shard + ".json"
        partition = select(path)
        original = partition[pool_id]
        if str(original["id"]) != pool_id or index["entries"][pool_id]["featured"] != original["featured"]:
            raise ValueError("current gacha summary differs from full entity")
        updated, delta = derive(original, pools[pool_id], tables)
        partition[pool_id] = updated
        index["entries"][pool_id]["featured"] = copy.deepcopy(updated["featured"])
        if archive is not None:
            archive_updated, archive_delta = derive(archive["entries"][pool_id], pools[pool_id], tables)
            if archive_delta != delta:
                raise ValueError("legacy current gacha rates differ from current catalog")
            archive["entries"][pool_id] = archive_updated
        details[pool_id], changes[pool_id] = updated, delta
    allowed = {path for path, (original, value) in selected.items() if value != original}
    for path in allowed:
        write_json(staging / path, selected[path][1])
    changed = release_entries(staging)
    if {row["path"] for row in changed} != allowed:
        raise ValueError("gacha projection escaped selected entries")
    reused = [row for row in records if row["path"] not in allowed]
    result = {"pointer": pointer, "pointerETag": head["ETag"], "sourceId": identity["sourceId"], "noOp": not changed,
              "changedEntries": changed, "reusedEntryCount": len(reused), "details": details, "index": index, "changes": changes}
    if changed:
        manifest = write_release_identity_files(staging, config.id, identity["sourceId"], sorted(reused + changed, key=lambda row: row["path"]))
        checked = _validate_release_manifest_for_gc(manifest, f"servers/{config.id}/releases/{manifest['releaseId']}/release.json", config.id, manifest["releaseId"])
        if {row["path"]: row for row in checked if row["path"] not in allowed} != {row["path"]: row for row in reused}:
            raise ValueError("unrelated CAS identity changed")
        result["manifest"] = manifest
    return result


def verify_public(receipt, prepared, output):
    proofs = []
    for key in ["gacha"] + [f"gacha/{pool}" for pool in prepared["details"]]:
        url = f"https://haneoka.org/api/v1/servers/intl/{key}?release={receipt['releaseId']}"
        with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}), timeout=30) as response:
            if (response.status != 200 or response.headers.get("X-Haneoka-Release-Id") != receipt["releaseId"]
                    or response.headers.get("X-Haneoka-Source-Id") != receipt["sourceId"]):
                raise ValueError("gacha public readback pin differs")
            body = response.read(2 * 1024 * 1024 + 1)
            if len(body) > 2 * 1024 * 1024:
                raise ValueError("selected public gacha exceeds readback budget")
            expected = prepared["index"] if key == "gacha" else prepared["details"][key.split("/")[1]]
            if json.loads(body) != expected:
                raise ValueError("selected public gacha differs from exact reprojected CAS JSON")
            proofs.append({"path": key, "HTTP": response.status, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
    write_json(output / "public-readback.json", proofs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pin = os.environ["PRODUCER_PIN"]
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != pin:
        raise ValueError("gacha producer pin mismatch")
    if _prize_rate_rows([{"_pickUpType": 2, "_pickUpFixedRate": 0}], 300)[0]["weight"] != 300:
        raise ValueError("producer pin lacks the reviewed zero-fixed-rate pickup fix")
    packed = os.environ["GACHA_RATE_INPUT_JSON"]
    if len(packed.encode()) > 8192:
        raise ValueError("gacha input size cap")
    projection = json.loads(packed)
    config = load_server_config(projection["identity"]["server"])
    store = R2Store(config, concurrency=4)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="current-gacha-rates-") as directory:
        staging = Path(directory)
        prepared = prepare(store, config, projection, staging)
        receipt = {"schema": "haneoka-current-gacha-rate-receipt-v1", "producerPin": pin, "server": config.id,
                   "sourceId": prepared["sourceId"], "baseReleaseId": prepared["pointer"]["releaseId"], "noOp": prepared["noOp"],
                   "published": False, "promoted": False, "rawBuildRun": False, "pipelineFingerprintPreserved": True,
                   "originalMasterSHA256": projection["originalMasterSHA256"], "changes": prepared["changes"]}
        if not prepared["noOp"]:
            receipt.update({"releaseId": prepared["manifest"]["releaseId"], "changedPaths": [row["path"] for row in prepared["changedEntries"]],
                            "changedBytes": sum(row["bytes"] for row in prepared["changedEntries"]), "reusedEntries": prepared["reusedEntryCount"]})
            if os.environ.get("PUBLISH") == "true":
                receipt["pointer"] = publish(store, config, prepared, staging)
                receipt.update({"published": True, "promoted": True})
        else:
            receipt["releaseId"] = prepared["pointer"]["releaseId"]
        write_json(args.output / "publication-receipt.json", receipt)
        if receipt["published"] or receipt["noOp"]:
            if store.get_json(f"servers/{config.id}/current.json")["releaseId"] != receipt["releaseId"]:
                raise ValueError("promoted current pointer differs from prepared release")
            verify_public(receipt, prepared, args.output)
        if receipt["published"] and os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write("release_promoted=true\n")
    print(stable_json(receipt))


if __name__ == "__main__":
    main()
