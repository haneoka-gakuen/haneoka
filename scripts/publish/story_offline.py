# L3 — GEB
# Input: 一份完整的正式服 release、目录分片与原生剧情依赖。
# Output: 按章节组织的内容清单、对象允许索引和固定 release 的离线入口。
# Pos: [Map](L2-2.md)；App 剧情离线资源投影。
# Effects/Dependencies: 按摘要去重并有界读取 R2 JSON、并发发布对象索引，全部成功后切换入口；媒体复用原有 CAS。
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

SCHEMA = "haneoka-story-offline-v2"
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
        self.story_context = None

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

    def read_many(self, paths, executor):
        representatives = {}
        for path in paths:
            entry = self.entries[path]
            previous = representatives.setdefault(entry["sha256"], path)
            if self.entries[previous]["bytes"] != entry["bytes"]:
                raise ValueError(f"Offline input size conflicts for one digest: {path}")
        values = dict(zip(representatives, executor.map(self.read, representatives.values())))
        return [values[self.entries[path]["sha256"]] for path in paths]

    def entity(self, name, key):
        if name not in self.entities:
            spec = self.catalog["resources"][name]["entities"]
            rows = {}
            paths = [spec["prefix"] + shard + ".json" for shard in spec["shards"]]
            with ThreadPoolExecutor(max_workers=4) as executor:
                values = self.read_many(paths, executor)
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
                    suffix = PurePosixPath(path).suffix
                    if suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                        for language in ("en", "ko", "zh-Hans", "zh-Hant"):
                            localized = f"{path[:-len(suffix)]}({language}){suffix}"
                            if localized in self.entries:
                                refs[self.media(localized)] = {"path": localized}
                                pending.append(localized)

        for value in seeds:
            visit(value)
        pending = [value for value in pending if isinstance(value, str) and value in self.entries]
        pending.extend(row["path"] for row in refs.values())
        selectors = {}
        for row in documents.values():
            if "selector" in row:
                selectors.setdefault(row["path"], row["selector"])
        selected_paths = {path for path, selector in selectors.items() if selector is not None}
        with ThreadPoolExecutor(max_workers=8) as executor:
            while pending:
                batch = []
                while pending and len(batch) < 8:
                    path = pending.pop()
                    if path in paths:
                        continue
                    paths.add(path)
                    standalone = path.endswith((".motion3.json", ".exp3.json", "/physics3.json", "/pose3.json", "/cdi3.json"))
                    if path.endswith(".json") and not standalone and path not in selected_paths:
                        batch.append(path)
                for path, value in zip(batch, self.read_many(batch, executor)):
                    if path.startswith("metadata/sources/"):
                        visit(value.get("objectArchive", {}), path)
                    elif path == self.catalog["resources"]["stories"]["index"]:
                        continue
                    elif path == self.catalog["resources"]["story-runtime"]["index"]:
                        visit({key: child for key, child in value.items() if key != "stages"}, path)
                    else:
                        visit(value, path)
        return {
            "schema": SCHEMA,
            "resources": {url: {"sha256": self.entries[row["path"]]["sha256"],
                                **({"selector": row["selector"]} if "selector" in row else {})}
                          for url, row in sorted(refs.items())},
            "objects": {self.entries[path]["sha256"]: {"bytes": self.entries[path]["bytes"],
                                                       "mediaType": self.entries[path]["mediaType"]}
                        for path in sorted(paths)},
        }

    def common_manifest(self):
        documents = {}
        for name in ("stories", "story-runtime", "characters", "bands"):
            spec = self.catalog["resources"][name]
            documents[self.api(name)] = {"path": spec["index"]}
        common_sources = [f"metadata/sources/{path}.json" for path in COMMON_SOURCES]
        common_sources.extend(
            path for path in self.entries
            if path.startswith("metadata/sources/Assets/AddressableResources/Adv/Transition/")
        )
        for path in common_sources:
            if path in self.entries:
                documents[self.api("sources/" + path[len("metadata/sources/"):-5])] = {"path": path}
        for path in self.entries:
            if path.startswith("assets/Assets/AddressableResources/Adv/Chat/Stamp/"):
                documents[self.media(path)] = {"path": path}
        return self.collect([], documents)

    def thumbnail(self, key, summary):
        value, _ = self.entity("stories", key)
        candidates = [summary.get(field) for field in ("episodeImage", "thumbnail", "image")]
        backgrounds = value.get("assets", {}).get("backgrounds") or {}
        if isinstance(backgrounds, dict):
            candidates.extend(backgrounds.values())
        elif isinstance(backgrounds, list):
            candidates.extend(backgrounds)
        for item in candidates:
            if isinstance(item, dict):
                item = item.get("url") or item.get("imageUrl") or item.get("src")
            if not isinstance(item, str):
                continue
            raw = unquote(urlsplit(item).path)
            for tree in ("assets", "runtime", "objects"):
                prefix = f"/{tree}/{self.server}/"
                if not raw.startswith(prefix):
                    continue
                path = tree + "/" + raw[len(prefix):]
                record = self.entries.get(path)
                if record and record["mediaType"].split(";", 1)[0] in {"image/jpeg", "image/png", "image/webp"}:
                    return self.media(path)
        return None

    def story_presentation(self, key, episode):
        if self.story_context is None:
            index, _ = self.resource("stories")
            chapters = {str(row.get("chapterId")): row for row in index.get("chapters", {}).values()}
            spots = {
                str(talk.get("storyKey")): spot
                for spot in index.get("homeSpots", {}).values()
                for talk in spot.get("talks", [])
                if talk.get("storyKey")
            }
            self.story_context = index.get("episodes", {}), chapters, spots
        episodes, chapters, spots = self.story_context
        return [episodes.get(key), chapters.get(str(episode.get("chapterId"))), spots.get(key)]

    def episode_manifest(self, key, thumbnail=None):
        value, path = self.entity("stories", key)
        refs = {self.api("stories/" + key): {"path": path, "selector": key}}
        seeds = [value, thumbnail, *self.story_presentation(key, value)]
        models = {model["live2dKey"] for model in value.get("assets", {}).get("live2d", [])}
        for key in sorted(models):
            model, path = self.entity("live2d", key)
            refs[self.api("live2d/" + key)] = {"path": path, "selector": key}
            seeds.append({
                "sourcePath": model.get("sourcePath"),
                "runtime": model.get("runtime", {}),
                "motions": model.get("motions", []),
                "expressions": model.get("expressions", []),
            })
        return self.collect(seeds, refs)

    def publish(self):
        release, server = self.manifest["releaseId"], self.server
        prefix = f"servers/{server}/releases/{release}/offline/"
        previous = self.store.get_json(prefix + "latest.json")
        if previous and previous.get("schema") == SCHEMA and previous.get("recipeSHA256") == RECIPE:
            return previous
        stories = self.resource("stories")[0]
        common = self.common_manifest()
        allowed = dict(common["objects"])

        def manifest_bytes(value):
            body = json_bytes(value)
            return hashlib.sha256(body).hexdigest(), body

        def publish_manifest(encoded):
            sha, body = encoded
            self.store.put_bytes(prefix + f"manifests/{sha}.json", body)

        common_hash, body = manifest_bytes(common)
        publish_manifest((common_hash, body))
        grouped = defaultdict(list)
        for key, episode in stories.get("episodes", {}).items():
            grouped[str(episode.get("chapterId") or episode.get("chapterKey") or key)].append((key, episode))
        packages = []
        with ThreadPoolExecutor(max_workers=8) as executor:
            for chapter, episodes in sorted(grouped.items()):
                objects = {}
                rows, writes = [], {}
                for key, summary in episodes:
                    thumbnail = self.thumbnail(key, summary)
                    value = self.episode_manifest(key, thumbnail)
                    objects.update(value["objects"])
                    digest, body = manifest_bytes(value)
                    writes[digest] = body
                    rows.append({"id": key, "title": summary.get("title"),
                                 "episodeNumber": summary.get("episodeNumber"), "manifest": digest, "thumbnail": thumbnail,
                                 "bytes": sum(entry["bytes"] for entry in value["objects"].values())})
                allowed.update(objects)
                first = episodes[0][1]
                list(executor.map(publish_manifest, writes.items()))
                packages.append({"id": "chapter-" + chapter, "title": first.get("chapterName") or first.get("title"),
                                 "bandId": first.get("bandId"),
                                 "thumbnail": next((row["thumbnail"] for row in rows if row["thumbnail"]), None),
                                 "bytes": sum(row["bytes"] for row in objects.values()), "episodes": rows})
                print(f"Prepared {server} chapter {chapter}: {len(rows)} episode manifests", flush=True)
        root = {"schema": SCHEMA, "server": server, "common": common_hash, "packages": packages,
                "totalBytes": sum(row["bytes"] for row in allowed.values()), "objectCount": len(allowed)}
        root_body = json_bytes(root)
        root_hash = hashlib.sha256(root_body).hexdigest()
        shards = defaultdict(dict)
        for digest, entry in allowed.items():
            shards[digest[:2]][digest] = entry

        def publish_objects(item):
            shard, rows = item
            if previous and previous.get("schema") == SCHEMA:
                rows = {**(self.store.get_json(prefix + f"objects/{shard}.json") or {}), **rows}
            self.store.put_bytes(prefix + f"objects/{shard}.json", json_bytes(rows))

        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(publish_objects, shards.items()))
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
