# L3 — GEB
# Input: 一份完整的正式服 release、目录分片与原生剧情依赖。
# Output: 按章节组织的内容清单、对象允许索引和固定 release 的离线入口。
# Pos: [Map](L2-2.md)；App 剧情离线资源投影。
# Effects/Dependencies: 校验读取 R2 JSON、发布清单；媒体复用原有 CAS，不复制整个资源版本。
from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

from download_store import DownloadStore, json_bytes

SCHEMA = "haneoka-story-offline-v1"
RECIPE = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
COMMON_SOURCES = (
    "Assets/AddressableResources/Common/Prefab/CameraManager.prefab",
    "Assets/AddressableResources/Common/Adv/Prefab/AdvCharacterField.prefab",
    "Assets/AddressableResources/Common/Adv/Prefab/AdvBackgroundField.prefab",
    "Assets/AddressableResources/Common/Adv/Settings/FocusData/AdvFocusDataSettings-Sirius.asset",
    "Assets/AddressableResources/UI/Prefab/UIAdvWidget.prefab",
)


class StoryOfflineProjection:
    def __init__(self, store, manifest, cache):
        self.store, self.manifest, self.cache = store, manifest, cache
        self.server = manifest["server"]
        self.entries = {row["path"]: row for row in manifest["entries"]}
        self.catalog = self.read("api/v1/catalog/manifest.json")
        self.entities = {}

    def read(self, path):
        entry = self.entries[path]
        file = self.cache / entry["sha256"]
        if file.is_file():
            body = file.read_bytes()
        else:
            if entry["bytes"] > 32 << 20:
                raise ValueError(f"Offline JSON exceeds byte budget: {path}")
            body = self.store.get_bytes(f"cas/v1/sha256/{entry['sha256'][:2]}/{entry['sha256']}")
            if body is None:
                raise ValueError(f"Offline input missing: {path}")
        if len(body) != entry["bytes"] or hashlib.sha256(body).hexdigest() != entry["sha256"]:
            raise ValueError(f"Offline input digest differs: {path}")
        if not file.is_file():
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(body)
        return json.loads(body)

    def resource(self, name):
        spec = self.catalog["resources"][name]
        return self.read(spec["index"]), spec

    def entity(self, name, key):
        if name not in self.entities:
            spec = self.catalog["resources"][name]["entities"]
            rows = {}
            paths = [spec["prefix"] + shard + ".json" for shard in spec["shards"]]
            with ThreadPoolExecutor(max_workers=4) as executor:
                values = list(executor.map(self.read, paths))
            for path, records in zip(paths, values):
                for identity, value in records.items():
                    rows[identity] = (value, path)
            self.entities[name] = rows
        return self.entities[name][key]

    def api(self, tail):
        return f"/api/v1/servers/{self.server}/{tail}"

    def media(self, path):
        tree, tail = path.split("/", 1)
        return f"/{tree}/{self.server}/{tail}"

    def collect(self, seeds, documents):
        paths = set()
        refs = dict(documents)
        pending = list(seeds)

        def source(value):
            descriptor = f"metadata/sources/{value}.json"
            if descriptor in self.entries:
                refs[self.api("sources/" + value)] = {"path": descriptor}
                pending.append(descriptor)

        def visit(value, parent=""):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in {"raw", "preloadObjectReferences", "references", "candidateBundles"}:
                        continue
                    if key == "stageRef" and isinstance(child, str):
                        source(f"Assets/AddressableResources/Adv/Stage/{child}/{child}.prefab")
                    visit(child, parent)
            elif isinstance(value, list):
                for child in value:
                    visit(child, parent)
            elif isinstance(value, str):
                raw = unquote(urlsplit(value).path)
                path = None
                for tree in ("assets", "runtime", "objects"):
                    prefix = f"/{tree}/{self.server}/"
                    if raw.startswith(prefix):
                        path = tree + "/" + raw[len(prefix):]
                        break
                if raw.startswith(("Assets/", "Packages/")):
                    path = "assets/" + raw
                    if raw.endswith((".prefab", ".asset")):
                        source(raw)
                elif raw.startswith(("runtime/", "objects/", "assets/")):
                    path = raw
                elif raw and not raw.startswith("/") and "." in raw and parent:
                    candidate = str(PurePosixPath(parent).parent / raw)
                    if ".." not in PurePosixPath(candidate).parts:
                        path = candidate
                if path in self.entries:
                    refs[self.media(path)] = {"path": path}
                    pending.append(path)

        for value in seeds:
            visit(value)
        pending = [value for value in pending if isinstance(value, str) and value in self.entries]
        pending.extend(row["path"] for row in refs.values())
        while pending:
            path = pending.pop()
            if path in paths:
                continue
            paths.add(path)
            standalone = path.endswith((".motion3.json", ".exp3.json", "/physics3.json", "/pose3.json", "/cdi3.json"))
            if path.endswith(".json") and not standalone:
                selector = next((row.get("selector") for row in documents.values() if row["path"] == path and "selector" in row), None)
                if selector is not None:
                    continue
                value = self.read(path)
                if path.startswith("metadata/sources/"):
                    visit(value.get("objectArchive", {}), path)
                elif path == self.catalog["resources"]["stories"]["index"]:
                    continue
                elif path == self.catalog["resources"]["story-runtime"]["index"]:
                    visit({key: child for key, child in value.items() if key != "stages"}, path)
                else:
                    visit(value[selector] if selector is not None else value, path)
        return {
            "schema": SCHEMA,
            "resources": {url: {"sha256": self.entries[row["path"]]["sha256"],
                                **({"selector": row["selector"]} if "selector" in row else {})}
                          for url, row in sorted(refs.items())},
            "objects": {self.entries[path]["sha256"]: {"bytes": self.entries[path]["bytes"],
                                                       "mediaType": self.entries[path]["mediaType"]}
                        for path in sorted(paths)},
        }

    def publish(self):
        release, server = self.manifest["releaseId"], self.server
        prefix = f"servers/{server}/releases/{release}/offline/"
        previous = self.store.get_json(prefix + "latest.json")
        if previous and previous.get("schema") == SCHEMA and previous.get("recipeSHA256") == RECIPE:
            return previous
        documents = {}
        indexes = {}
        for name in ("stories", "story-runtime", "characters", "bands"):
            value, spec = self.resource(name)
            indexes[name] = value
            documents[self.api(name)] = {"path": spec["index"]}
        common_sources = [f"metadata/sources/{path}.json" for path in COMMON_SOURCES]
        common_sources.extend(path for path in self.entries if path.startswith("metadata/sources/Assets/AddressableResources/Adv/Transition/"))
        for path in common_sources:
            if path in self.entries:
                documents[self.api("sources/" + path[len("metadata/sources/"):-5])] = {"path": path}
        for path in self.entries:
            if path.startswith("assets/Assets/AddressableResources/Adv/Chat/Stamp/"):
                documents[self.media(path)] = {"path": path}
        common = self.collect([], documents)
        allowed = dict(common["objects"])

        def publish_manifest(value):
            body = json_bytes(value)
            sha = hashlib.sha256(body).hexdigest()
            self.store.put_bytes(prefix + f"manifests/{sha}.json", body)
            return sha

        common_hash = publish_manifest(common)
        grouped = defaultdict(list)
        for key, episode in indexes["stories"].get("episodes", {}).items():
            grouped[str(episode.get("chapterId") or episode.get("chapterKey") or key)].append((key, episode))
        packages = []
        for chapter, episodes in sorted(grouped.items()):
            refs, seeds = {}, []
            for key, summary in episodes:
                value, path = self.entity("stories", key)
                refs[self.api("stories/" + key)] = {"path": path, "selector": key}
                seeds.append(value)
                for model in value.get("assets", {}).get("live2d", []):
                    key = model["live2dKey"]
                    model_value, model_path = self.entity("live2d", key)
                    refs[self.api("live2d/" + key)] = {"path": model_path, "selector": key}
                    runtime = model_value.get("runtime", {})
                    seeds.append({"sourcePath": model_value.get("sourcePath"),
                                  "runtime": {key: runtime[key] for key in ("moc", "textures") if key in runtime}})
            package = self.collect(seeds, refs)
            allowed.update(package["objects"])
            first = episodes[0][1]
            packages.append({"id": "chapter-" + chapter, "title": first.get("chapterName") or first.get("title"),
                             "bandId": first.get("bandId"), "manifest": publish_manifest(package),
                             "bytes": sum(row["bytes"] for row in package["objects"].values()),
                             "episodes": [{"id": key, "title": value.get("title"), "episodeNumber": value.get("episodeNumber")}
                                          for key, value in episodes]})
            print(f"Prepared {server} chapter {chapter}: {len(package['objects'])} objects", flush=True)
        root = {"schema": SCHEMA, "server": server, "common": common_hash, "packages": packages,
                "totalBytes": sum(row["bytes"] for row in allowed.values()), "objectCount": len(allowed)}
        root_body = json_bytes(root)
        root_hash = hashlib.sha256(root_body).hexdigest()
        shards = defaultdict(dict)
        for digest, entry in allowed.items():
            shards[digest[:2]][digest] = entry
        for shard, rows in shards.items():
            if previous:
                rows = {**(self.store.get_json(prefix + f"objects/{shard}.json") or {}), **rows}
            self.store.put_bytes(prefix + f"objects/{shard}.json", json_bytes(rows))
        self.store.put_bytes(prefix + f"manifests/{root_hash}.json", root_body)
        pointer = {"schema": SCHEMA, "server": server, "releaseId": release, "sourceId": self.manifest["sourceId"],
                   "sha256": root_hash, "recipeSHA256": RECIPE,
                   "manifestUrl": f"/downloads/stories/{server}/{release}/manifests/{root_hash}.json"}
        self.store.put_bytes(prefix + "latest.json", json_bytes(pointer))
        return pointer


def publish_story_offline(store, manifest, cache):
    if manifest["server"] not in {"jp", "intl"}:
        return None
    cache.mkdir(parents=True, exist_ok=True)
    return StoryOfflineProjection(store, manifest, cache).publish()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", choices=("jp", "intl"), required=True)
    parser.add_argument("--wrangler", action="store_true")
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    store = DownloadStore("hotdori-assets", wrangler=args.wrangler)
    with tempfile.TemporaryDirectory(prefix="haneoka-story-offline-") as temporary:
        cache = args.directory or Path(temporary)
        for _ in range(3):
            pointer = store.get_json(f"servers/{args.server}/current.json")
            result = store.get_json(f"servers/{args.server}/releases/{pointer['releaseId']}/offline/latest.json")
            if not result or result.get("schema") != SCHEMA or result.get("recipeSHA256") != RECIPE:
                manifest = store.get_json(pointer["releaseManifest"])
                if manifest["releaseId"] != pointer["releaseId"] or manifest["sourceId"] != pointer["sourceId"]:
                    raise ValueError("Offline projection release identity differs")
                result = publish_story_offline(store, manifest, cache)
            current = store.get_json(f"servers/{args.server}/current.json")
            if current["releaseId"] != pointer["releaseId"] or current["sourceId"] != pointer["sourceId"]:
                continue
            key = f"servers/{args.server}/offline/current.json"
            if store.get_json(key) != result:
                store.put_bytes(key, json_bytes(result), cache_control="public, max-age=60, must-revalidate")
            print(json.dumps(result))
            return
    raise ValueError("Resource release kept changing; complete offline snapshot retained")


if __name__ == "__main__":
    main()
