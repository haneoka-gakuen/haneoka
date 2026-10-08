"""Refresh stamp derivatives from published originals without rebuilding Unity/CRI."""
from __future__ import annotations
import argparse
import hashlib
import shutil
import sys
import tempfile
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build.stamp_id_cache import StampIdCache
from build.stamp_pipeline import build_textless_stamps, MANIFEST, OBJECT_PREFIX, SERVERS
from core.config import load_server_config
from core.manifests import read_json, write_json, stable_json
from core.paths import build_layout, validate_release_path
from core.storage import cas_key, fnv1a32_shard
from publish.band_descriptions import document, entry_json, publish
from publish.r2 import R2Store, current_release_document
from verify.release import release_entries, write_release_identity_files


def refresh(store, config, output):
    pointer_key = f"servers/{config.id}/current.json"
    head = store.head(pointer_key)
    pointer = document(store, pointer_key, 4096)
    base = document(store, pointer["releaseManifest"])
    entries = {entry["path"]: entry for entry in base["entries"]}
    loaded = {}
    def read(path):
        if path not in loaded:
            loaded[path] = entry_json(store, entries[path], 32 * 1024 * 1024)
        return loaded[path]
    catalog = read("api/v1/catalog/manifest.json")
    stamps = read(catalog["resources"]["stamps"]["index"])
    layout = build_layout(config.id, "stamp-refresh-" + pointer["releaseId"])
    layout.api.mkdir(parents=True, exist_ok=True)
    layout.metadata.mkdir(parents=True, exist_ok=True)
    write_json(layout.api / "stamps.json", stamps)
    with StampIdCache(store) as cache:
        previous = []
        for peer in SERVERS:
            snapshot = current_release_document(store, replace(config, id=peer), MANIFEST)
            if snapshot:
                previous.append(snapshot["document"])
        existing_ids = set(cache.records) | {str(record["stampId"]) for value in previous for record in value["records"] if record.get("publishable")}
        unknown = {key: row for key, row in stamps.items() if key not in existing_ids and row.get("image")}
        selected_sources = {}
        source_manifest = read("metadata/source-index/manifest.json")
        parts = source_manifest["sources"]
        reports = set()
        for row in unknown.values():
            image = row["image"]
            variants = set([image, *row.get("imageVariants", {}).get(image, {}).values()])
            for value in variants:
                logical = validate_release_path(value.removeprefix(f"/assets/{config.id}/"))
                shard = fnv1a32_shard(logical)
                source = read(parts["prefix"] + shard + ".json").get(logical)
                if source is None:
                    # Localized files can share the native base source row.
                    logical = validate_release_path(image.removeprefix(f"/assets/{config.id}/"))
                    source = read(parts["prefix"] + fnv1a32_shard(logical) + ".json").get(logical)
                if source is None:
                    raise ValueError("new stamp has no published source geometry")
                selected_sources[logical] = source
                reports.update(item["bundleSha256"] for item in source.get("outputs", []))
        def restore(path):
            path = validate_release_path(path)
            entry = entries[path]
            store.download_file(cas_key(entry["sha256"]), layout.root / path,
                                expected_bytes=entry["bytes"], expected_sha256=entry["sha256"])
        for digest in sorted(reports):
            report_path = f"metadata/bundles/{digest}.json"
            report = read(report_path)
            write_json(layout.root / report_path, report)
            restore(report["objectArchive"]["path"])
            for source in report.get("sources", []):
                if not source.get("basePath", source.get("sourcePath", "")).startswith("Assets/AddressableResources/Stamp/"):
                    continue
                for item in source.get("outputs", []):
                    if item["path"] in entries:
                        restore(item["path"])
        write_json(layout.metadata / "source-index.json", {"server": config.id, "sourceId": pointer["sourceId"], "sources": selected_sources})
        result = build_textless_stamps(config.id, pointer["sourceId"], layout.root.name,
                                       id_cache=cache, previous_manifests=previous)
    with tempfile.TemporaryDirectory(prefix="stamp-publication-") as folder:
        staging = Path(folder)
        manifest = read_json(layout.root / MANIFEST)
        prior = next((value for value in previous if value["server"] == config.id), None)
        if prior == manifest:
            return {**result, "noOp": True, "releaseId": pointer["releaseId"]}
        target = staging / MANIFEST
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(layout.root / MANIFEST, target)
        for record in manifest["records"]:
            asset = record["artifacts"]["sourceImage"]
            path = "assets/" + asset["path"].removeprefix(f"/assets/{config.id}/")
            destination = staging / validate_release_path(path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(layout.root / path, destination)
        changed = release_entries(staging)
        if any(entry["path"] != MANIFEST and not entry["path"].startswith(OBJECT_PREFIX + "/") for entry in changed):
            raise ValueError("stamp publication escaped its path scope")
        changed_paths = {entry["path"] for entry in changed}
        reused = [entry for entry in base["entries"] if entry["path"] not in changed_paths]
        release = write_release_identity_files(staging, config.id, pointer["sourceId"], sorted(reused + changed, key=lambda entry: entry["path"]))
        prepared = {"pointer": pointer, "pointerETag": head["ETag"], "manifest": release, "changedEntries": changed}
        promoted = publish(store, config, prepared, staging)
        return {**result, "noOp": False, "releaseId": promoted["releaseId"], "baseReleaseId": pointer["releaseId"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=SERVERS, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    config = load_server_config(args.server)
    result = refresh(R2Store(config, 8), config, args.output)
    write_json(args.output / "stamp-publication.json", result)
    print(stable_json(result))


if __name__ == "__main__":
    main()
