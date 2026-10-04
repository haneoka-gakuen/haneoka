"""Add exact native MasterAdv identities to current story metadata only."""
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
from core.config import load_server_config
from core.manifests import stable_json, write_json
from publish.band_descriptions import document, entry_json, publish
from publish.gacha_rates import raw_table
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from verify.release import release_entries, write_release_identity_files

FIELDS = {"advId", "sourceTable"}
RECIPE = "native-story-masteradv-current-v1"


def derive(index, rows):
    episodes = index.get("episodes")
    if not isinstance(episodes, dict) or not episodes:
        raise ValueError("current story index has no episodes")
    by_asset, native_ids = {}, set()
    for row in rows:
        identity, asset = row.get("_id"), row.get("_advEpisodeAsset")
        if type(identity) is not int or identity <= 0 or identity in native_ids:
            raise ValueError("MasterAdv original identity is invalid or duplicated")
        native_ids.add(identity)
        if not asset:
            continue
        if not isinstance(asset, str):
            raise ValueError("MasterAdv asset locator is invalid")
        key = asset.removeprefix("adv_script_")
        if key in by_asset and key in episodes:
            raise ValueError("current story has ambiguous MasterAdv asset provenance")
        by_asset[key] = (identity, asset)
    updated = copy.deepcopy(index)
    mapping = {}
    for key, original in episodes.items():
        if key not in by_asset:
            raise ValueError("current story has no exact original MasterAdv row")
        identity, asset = by_asset[key]
        expected_asset = f"Assets/AddressableResources/Adv/Episode/{asset}/{asset}-Episode.txt"
        if (original.get("storyId") != key or original.get("storyKey") != key
                or original.get("scriptAsset") != expected_asset):
            raise ValueError("current story locator differs from original MasterAdv asset")
        row = updated["episodes"][key]
        row.update(advId=identity, sourceTable="MasterAdv")
        mapping[key] = {field: row[field] for field in FIELDS}
        if {k: v for k, v in original.items() if k not in FIELDS} != {k: v for k, v in row.items() if k not in FIELDS}:
            raise ValueError("story summary changed outside native identity fields")
    if len({row["advId"] for row in mapping.values()}) != len(mapping):
        raise ValueError("native ADV identity has multiple current story locators")
    if {k: v for k, v in index.items() if k != "episodes"} != {k: v for k, v in updated.items() if k != "episodes"}:
        raise ValueError("non-episode story metadata changed")
    return updated, mapping


def patch_episode(original, summary, expected):
    if {k: v for k, v in original.items() if k not in FIELDS | {"commands", "assets"}} != {k: v for k, v in summary.items() if k not in FIELDS}:
        raise ValueError("current full story differs from authoritative index summary")
    updated = copy.deepcopy(original)
    updated.update(expected)
    if {k: v for k, v in updated.items() if k not in FIELDS} != {k: v for k, v in original.items() if k not in FIELDS}:
        raise ValueError("story commands, assets, text or unrelated metadata changed")
    return updated


def prepare(store, config, identity, staging):
    if config.id not in {"intl", "jp"} or identity.get("server") != config.id:
        raise ValueError("story ADV current server mismatch")
    pointer_key = f"servers/{config.id}/current.json"
    head, pointer = store.head(pointer_key), document(store, pointer_key, 4096)
    if not head or any(pointer.get(k) != identity[k] for k in ("releaseId", "sourceId")):
        raise ValueError("current changed before native story identity projection")
    manifest_key = f"servers/{config.id}/releases/{identity['releaseId']}/release.json"
    if pointer.get("releaseManifest") != manifest_key:
        raise ValueError("current release manifest key differs")
    # Read parent descriptors once for standard immutable release composition.
    # No APK extraction, baseline copy or asset-body download is performed.
    base = document(store, manifest_key)
    records = _validate_release_manifest_for_gc(base, manifest_key, config.id, identity["releaseId"])
    if base["sourceId"] != identity["sourceId"]:
        raise ValueError("native story parent source differs")
    entries = {row["path"]: row for row in records}
    master_entry = entries["game-client/master/MasterAdv.bin"]
    catalog = entry_json(store, entries["api/v1/catalog/manifest.json"], 256 * 1024)
    if catalog.get("server") != config.id or catalog.get("sourceId") != identity["sourceId"]:
        raise ValueError("native story catalog identity differs")
    descriptor = catalog["resources"]["stories"]
    if descriptor["index"] != "api/v1/catalog/stories/index.json":
        raise ValueError("native story index path differs")
    index = entry_json(store, entries[descriptor["index"]], 8 * 1024 * 1024)
    updated, mapping = derive(index, raw_table(store, master_entry, "MasterAdv", config.master_crypto))
    selected, metadata_bytes, preserved = {}, 0, {}

    def read(path, cap=16 * 1024 * 1024):
        nonlocal metadata_bytes
        metadata_bytes += entries[path]["bytes"]
        if metadata_bytes > 512 * 1024 * 1024:
            raise ValueError("selected story metadata byte budget exceeded")
        return entry_json(store, entries[path], cap)

    def stage(path, original, value):
        if value != original:
            if not path.startswith("api/v1/catalog/stories/") and path != "api/stories.json":
                raise ValueError("native identity escaped current story JSON scope")
            write_json(staging / path, value)
            selected[path] = True

    stage(descriptor["index"], index, updated)
    partition = descriptor["entities"]
    if partition.get("algorithm") != "fnv1a32-mod-256" or partition["prefix"] != "api/v1/catalog/stories/entities/":
        raise ValueError("unsupported current story entity partition")
    seen = set()
    for shard in partition["shards"]:
        path = partition["prefix"] + shard + ".json"
        original = read(path)
        value = copy.deepcopy(original)
        for key, row in original.items():
            if key not in mapping or key in seen:
                raise ValueError("current full story membership differs")
            seen.add(key)
            value[key] = patch_episode(row, index["episodes"][key], mapping[key])
            preserved[key] = hashlib.sha256(stable_json({k: v for k, v in row.items() if k not in FIELDS}).encode()).hexdigest()
        stage(path, original, value)
    if seen != set(mapping):
        raise ValueError("current story entities do not cover all native identities")
    for relation in descriptor.get("relations", {}).values():
        if relation.get("valueMode", "records") != "records":
            continue
        if relation.get("algorithm") != "fnv1a32-mod-256" or not relation["prefix"].startswith("api/v1/catalog/stories/relations/"):
            raise ValueError("unsupported story relation partition")
        for shard in relation["shards"]:
            path = relation["prefix"] + shard + ".json"
            original = read(path)
            value = copy.deepcopy(original)
            for group in value.values():
                for key, row in group.items():
                    if key not in mapping or {k: v for k, v in row.items() if k not in FIELDS} != {k: v for k, v in index["episodes"][key].items() if k not in FIELDS}:
                        raise ValueError("current story relation summary differs")
                    row.update(mapping[key])
            stage(path, original, value)
    if "api/stories.json" in entries:
        original = read("api/stories.json", 256 * 1024 * 1024)
        value = copy.deepcopy(original)
        if set(value["episodes"]) != set(mapping):
            raise ValueError("legacy story archive membership differs")
        for key, row in original["episodes"].items():
            value["episodes"][key] = patch_episode(row, index["episodes"][key], mapping[key])
        stage("api/stories.json", original, value)
    changed = release_entries(staging)
    if {row["path"] for row in changed} != set(selected):
        raise ValueError("native story identity staging differs from selected paths")
    reused = [row for row in records if row["path"] not in selected]
    result = {"pointer": pointer, "pointerETag": head["ETag"], "sourceId": identity["sourceId"],
              "noOp": not changed, "mapping": mapping, "storyCount": len(mapping),
              "MasterAdvEntry": master_entry, "metadataBytes": metadata_bytes,
              "changedEntries": changed, "reusedEntryCount": len(reused), "preservedStoryFieldsSHA256": preserved}
    if changed:
        manifest = write_release_identity_files(staging, config.id, identity["sourceId"], sorted(reused + changed, key=lambda r: r["path"]))
        checked = _validate_release_manifest_for_gc(manifest, f"servers/{config.id}/releases/{manifest['releaseId']}/release.json", config.id, manifest["releaseId"])
        if {r["path"]: r for r in checked if r["path"] not in selected} != {r["path"]: r for r in reused}:
            raise ValueError("non-story metadata or CAS asset identity changed")
        result["manifest"] = manifest
    return result


def verify_public(receipt, prepared, output):
    identity_url = f"https://haneoka.org/api/v1/servers/{receipt['server']}/release?projection=identity"
    with urlopen(Request(identity_url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as response:
        identity = json.loads(response.read(4097))
        if identity.get("releaseId") != receipt["releaseId"] or identity.get("sourceId") != receipt["sourceId"]:
            raise ValueError("native story public current identity differs after promotion")
    proofs = []
    paths = ["stories"] + ["stories/" + k for k in list(sorted(prepared["mapping"]))[:2]]
    for path in paths:
        url = f"https://haneoka.org/api/v1/servers/{receipt['server']}/{path}?release={receipt['releaseId']}"
        with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as response:
            if response.status != 200 or response.headers.get("X-Haneoka-Release-Id") != receipt["releaseId"] or response.headers.get("X-Haneoka-Source-Id") != receipt["sourceId"]:
                raise ValueError("native story public response pins differ")
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("story public readback exceeds bounded budget")
            value = json.loads(raw)
            rows = value["episodes"] if path == "stories" else {path.split("/")[1]: value}
            if path == "stories" and set(rows) != set(prepared["mapping"]):
                raise ValueError("public native story index coverage differs")
            for key, row in rows.items():
                if any(row.get(f) != v for f, v in prepared["mapping"][key].items()):
                    raise ValueError("public native story identity differs from original MasterAdv")
            proofs.append({"path": path, "HTTP": 200, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    write_json(output / "public-readback.json", proofs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pin = os.environ["PRODUCER_PIN"]
    if not re.fullmatch(r"[a-f0-9]{40}", pin) or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != pin:
        raise ValueError("native story producer commit pin differs")
    packed = os.environ["STORY_ADV_CURRENT_IDENTITY_JSON"]
    if len(packed.encode()) > 4096:
        raise ValueError("native story current identity input exceeds cap")
    identity = json.loads(packed)
    if identity["server"] != os.environ["RESOURCE_SERVER"]:
        raise ValueError("native story current server input differs")
    config = load_server_config(identity["server"])
    store = R2Store(config, concurrency=4)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="story-adv-current-metadata-") as directory:
        staging = Path(directory)
        prepared = prepare(store, config, identity, staging)
        receipt = {"schema": "haneoka-current-story-adv-identity-receipt-v1", "recipe": RECIPE,
                   "producerPin": pin, "server": config.id, "sourceId": identity["sourceId"],
                   "baseReleaseId": identity["releaseId"], "releaseId": prepared.get("manifest", prepared["pointer"])["releaseId"],
                   "storyCount": prepared["storyCount"], "nativeAdvIdUnique": True,
                   "MasterAdvEntry": prepared["MasterAdvEntry"], "metadataBytes": prepared["metadataBytes"],
                   "noOp": prepared["noOp"], "changedEntries": prepared["changedEntries"],
                   "reusedEntries": prepared["reusedEntryCount"], "capturedCurrentETag": prepared["pointerETag"],
                   "storyTextCommandsAssetsAndOtherFieldsPreserved": True, "CASAssetsUnchanged": True,
                   "rawBuildRun": False, "baselineCopiedOrChanged": False, "published": False, "promoted": False}
        write_json(args.output / "publication-receipt.json", receipt)
        if not prepared["noOp"] and os.environ.get("PUBLISH") == "true":
            receipt["pointer"] = publish(store, config, prepared, staging)
            receipt.update(published=True, promoted=True)
            write_json(args.output / "publication-receipt.json", receipt)
        if receipt["published"] or receipt["noOp"]:
            verify_public(receipt, prepared, args.output)
        if receipt["published"] and os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
                stream.write("release_promoted=true\n")
        print(stable_json(receipt))


if __name__ == "__main__":
    main()
