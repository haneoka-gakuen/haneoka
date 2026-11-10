# L3 — GEB
# Input: Complete immutable resource releases in the configured R2 bucket.
# Output: Release-bound content ownership records for request authorization.
# Pos: [Map](L2-2.md); offline production of resource visibility metadata.
# Effects/Dependencies: Reads verified CAS objects and writes only content-index/v3; preserves releases and current pointers.
"""Publish compact resource ownership metadata without changing a release."""
from __future__ import annotations

import argparse
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from build.catalog_storage import _content_access_index
from core.storage import cas_key, fnv1a32_shard
from publish.r2 import R2Store, IMMUTABLE_CACHE, _validate_release_manifest_for_gc

KINDS = {
    "cards", "support-cards", "songs", "characters", "bands", "stories", "events", "arena", "gacha", "comics",
    "stamps", "stickers", "backgrounds", "chat-customizations", "band-items", "items", "missions", "shop", "exchange",
    "login-campaigns", "passes", "challenge", "circle", "real-lives", "live2d", "spine", "help", "help-tips", "tgw-card", "skills", "anon-tokyo", "voices",
}


def publish_index(server: str, store) -> dict:
    pointer = store.get_json(f"servers/{server}/current.json")
    release_id = pointer["releaseId"]
    target = f"content-index/v3/{server}/{release_id}.json"
    if store.head(target):
        return {"server": server, "releaseId": release_id, "reused": True}
    manifest_key = f"servers/{server}/releases/{release_id}/release.json"
    manifest = store.get_json(manifest_key)
    entries = {entry["path"]: entry for entry in _validate_release_manifest_for_gc(manifest, manifest_key, server, release_id)}

    def read(path: str) -> dict:
        entry = entries[path]
        if entry["bytes"] > 16 * 1024 * 1024:
            raise ValueError(f"catalog metadata exceeds byte budget: {path}")
        body = store.get_bytes(cas_key(entry["sha256"]))
        if body is None or len(body) != entry["bytes"] or hashlib.sha256(body).hexdigest() != entry["sha256"]:
            raise ValueError(f"catalog metadata identity differs: {path}")
        return json.loads(body)

    catalog = read("api/v1/catalog/manifest.json")
    result = {"schema": "haneoka-content-index-v1", "server": server, "releaseId": release_id,
              "sourceId": manifest["sourceId"], "records": {}, "assets": {}, "previewAssets": [], "publications": {}}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for name, resource in catalog["resources"].items():
            if name not in KINDS:
                continue
            category = "characters" if name == "voices" else name
            access_path = resource.get("access")
            if access_path and access_path in entries:
                access = read(access_path)
            else:
                index = read(resource["index"])
                descriptor = resource.get("entities")
                entities = {}
                if descriptor:
                    paths = [descriptor["prefix"] + shard + ".json" for shard in descriptor["shards"]]
                    for shard in pool.map(read, paths):
                        entities.update(shard)
                access = _content_access_index(category, index, entities)
            for key, reference in access["records"].items():
                if reference["kind"] == "voices":
                    reference = {**reference, "kind": "characters"}
                result["records"][name + ":" + key] = reference
                if reference["kind"] == category:
                    result["publications"].setdefault(category + ":" + reference["id"], reference["publication"])
            result["publications"].update({
                ("characters:" + key[len("voices:"):] if key.startswith("voices:") else key): value
                for key, value in access.get("publications", {}).items()
            })
            for path, owners in access["assets"].items():
                result["assets"].setdefault(path, []).extend([[name + ":" + owner for owner in chain] for chain in owners])
            result["previewAssets"].extend(access["previewAssets"])
    result["previewAssets"] = sorted(set(result["previewAssets"]))
    # Event-owned stories use the event opening, including before archive release.
    stories = catalog["resources"].get("stories")
    if stories:
        events = read(stories["index"]).get("storyEvents", [])
        if isinstance(events, dict):
            events = events.values()
        starts = {str(row["chapterId"]): (row["startAt"][0] if isinstance(row.get("startAt"), list) else row.get("startAt"))
                  for row in events if row.get("chapterId") and row.get("startAt")}
        for ref in result["records"].values():
            start = starts.get(str(ref["publication"].get("chapterId")))
            if ref["kind"] == "stories" and start:
                ref["publication"]["eventPublishedAt"] = start
        for key, publication in result["publications"].items():
            start = starts.get(str(publication.get("chapterId")))
            if key.startswith("stories:") and start:
                publication["eventPublishedAt"] = start
    # Small ownership partitions keep resource reads independent of catalog size.
    count = len(result["assets"])
    previews = set(result["previewAssets"])
    shards: dict[str, dict] = {}
    prefix = f"content-index/v3/{server}/{release_id}/assets/"
    for path, owners in result.pop("assets").items():
        shard = shards.setdefault(fnv1a32_shard(path, 64), {"assets": {}, "previewAssets": []})
        shard["assets"][path] = owners
        if path in previews:
            shard["previewAssets"].append(path)
    result["assets"] = {}
    result["previewAssets"] = []
    result["assetShards"] = {"prefix": prefix, "count": 64}

    def immutable(key: str, value: dict) -> None:
        try:
            store.put_json(key, value, IMMUTABLE_CACHE, if_absent=True)
        except Exception:
            if store.get_json(key) != value:
                raise

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda item: immutable(prefix + item[0] + ".json", item[1]), shards.items()))
    immutable(target, result)
    return {"server": server, "releaseId": release_id, "records": len(result["records"]), "assets": count, "assetShards": len(shards), "reused": False}



def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=["jp", "intl"], action="append")
    parser.add_argument("--bucket", default="hotdori-assets")
    args = parser.parse_args()
    store = R2Store(SimpleNamespace(r2_bucket=args.bucket), concurrency=6)
    for server in args.server or ["jp", "intl"]:
        print(json.dumps(publish_index(server, store)))


if __name__ == "__main__":
    main()
