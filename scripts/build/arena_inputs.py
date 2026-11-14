# L3 — GEB
# Input: Captured release identities or published pointers and read access to the resource bucket.
# Output: Hash-verified Arena Master inputs keyed by immutable release identity.
# Pos: [Map](L2-2.md); read-only inputs for the first static Arena publication.
# Effects/Dependencies: Reads R2 through the pipeline store or local Wrangler; writes local inputs only.
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

from core.contracts import release_identity_descriptor
from core.manifests import write_json
from core.storage import cas_key
from publish.r2 import R2Store, _current_release_manifest

LOOKUPS = {"MasterLiveMusic", "MasterText", "MasterDegree", "MasterExchange", "MasterBattleLivePlace", "MasterParameter"}


class WranglerReader:
    def __init__(self, bucket):
        self.bucket = bucket

    def download_file(self, key, destination, *, expected_bytes=None, expected_sha256=None):
        destination.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            "pnpm", "exec", "wrangler", "r2", "object", "get", f"{self.bucket}/{key}",
            "--remote", "--file", str(destination),
        ], check=True, stdout=subprocess.DEVNULL)
        body = destination.read_bytes()
        if expected_bytes is not None and len(body) != expected_bytes:
            raise ValueError(f"Arena input size mismatch: {key}")
        if expected_sha256 is not None and hashlib.sha256(body).hexdigest() != expected_sha256:
            raise ValueError(f"Arena input digest mismatch: {key}")

    def get_json(self, key):
        with tempfile.TemporaryDirectory(prefix="arena-input-") as temporary:
            destination = Path(temporary) / "object.json"
            self.download_file(key, destination)
            return json.loads(destination.read_bytes())


def stage(store, output, servers, pins=None):
    receipts = []
    for server in servers:
        config = SimpleNamespace(id=server)
        if pins is None:
            pointer, manifest = _current_release_manifest(store, config)
        else:
            pointer = next(pin for pin in pins if pin["server"] == server)
            manifest = store.get_json(f"servers/{server}/releases/{pointer['releaseId']}/release.json")
        if pointer is None or manifest is None:
            raise ValueError(f"Arena source unavailable: {server}")
        identity = release_identity_descriptor(server, pointer["releaseId"], manifest)
        if identity["sourceId"] != pointer["sourceId"]:
            raise ValueError("Arena source identity mismatch")
        root = output / server / identity["releaseId"]
        selected = {}
        for entry in manifest["entries"]:
            path = entry["path"]
            if not path.startswith("objects/master/") or not path.endswith(".json"):
                continue
            table = Path(path).stem
            if table.startswith("MasterArena") or table in LOOKUPS:
                selected[table] = entry

        def download(pair):
            table, entry = pair
            destination = root / f"{table}.json"
            store.download_file(cas_key(entry["sha256"]), destination,
                                expected_bytes=entry["bytes"], expected_sha256=entry["sha256"])

        root.mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(download, selected.items()))
        write_json(root / "manifest.json", {
            "schema": "haneoka-arena-master-inputs-v1",
            "identity": {key: identity[key] for key in ("server", "releaseId", "sourceId")},
            "tables": {table: {"bytes": row["bytes"], "sha256": row["sha256"]}
                       for table, row in selected.items()},
        })
        receipts.append({"server": server, "releaseId": identity["releaseId"], "tables": len(selected)})
    return receipts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("data/static-arena"))
    parser.add_argument("--server", action="append", choices=("jp", "intl"))
    parser.add_argument("--pins", type=Path)
    parser.add_argument("--wrangler", action="store_true", help="Use local Wrangler authentication for read-only staging")
    args = parser.parse_args()
    bucket = os.environ.get("R2_BUCKET", "hotdori-assets")
    store = WranglerReader(bucket) if args.wrangler else R2Store(SimpleNamespace(r2_bucket=bucket))
    pins = json.loads(args.pins.read_bytes()) if args.pins else None
    print(json.dumps(stage(store, args.output, args.server or ("jp", "intl"), pins)))


if __name__ == "__main__":
    main()
