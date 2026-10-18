"""Add precompressed MOC transport bytes to one immutable public release."""
from __future__ import annotations

import argparse
import gzip
import hashlib
from http.client import IncompleteRead
import json
import os
import re
import subprocess
import sys
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build.http_encoding import compress_moc, moc_gzip_path
from core.config import load_server_config
from core.hashes import sha256_file
from core.manifests import atomic_write, write_json
from core.storage import cas_key
from publish.r2 import R2Store, _validate_release_manifest_for_gc
from verify.release import release_entries, write_release_identity_files


def read_public(url: str, maximum: int) -> bytes:
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={"Accept-Encoding": "identity", "User-Agent": "Mozilla/5.0"}), timeout=30) as response:
                return response.read(maximum + 1)
        except HTTPError as error:
            error.close()
            if error.code not in {408, 429, 500, 502, 503, 504} or attempt == 2:
                raise
        except (TimeoutError, ConnectionError, URLError, IncompleteRead):
            if attempt == 2:
                raise
        sys.stderr.write(f"MOC public read interrupted; retrying {url} ({attempt + 2}/3)\n")
        time.sleep(2 ** attempt)
    raise AssertionError("MOC public read attempts exhausted")


def prepare(base: dict, read_entry, staging: Path, models: tuple[str, ...] = ()) -> dict:
    server, release_id = base["server"], base["releaseId"]
    records = _validate_release_manifest_for_gc(
        base, f"servers/{server}/releases/{release_id}/release.json", server, release_id,
    )
    entries = {row["path"]: row for row in records}
    selected = [row for row in records if moc_gzip_path(row["path"]) and (
        not models or row["path"] in {f"runtime/live2d/{model}/model.moc3" for model in models}
    )]
    if models and len(selected) != len(set(models)):
        raise ValueError("selected MOC is absent from the release")

    def compress(entry):
        encoded_path = moc_gzip_path(entry["path"])
        if encoded_path in entries:
            return None
        encoded = staging / encoded_path
        body = None
        if encoded.is_file():
            try:
                with gzip.open(encoded, "rb") as retained:
                    previous = retained.read(entry["bytes"] + 1)
                if len(previous) == entry["bytes"] and hashlib.sha256(previous).hexdigest() == entry["sha256"]:
                    body = previous
            except (OSError, EOFError, zlib.error):
                pass
        if body is None:
            body = read_entry(entry)
            if not isinstance(body, bytes) or len(body) != entry["bytes"] or hashlib.sha256(body).hexdigest() != entry["sha256"]:
                raise ValueError(f"MOC bytes differ from immutable release: {entry['path']}")
            unique = hashlib.sha256(entry["path"].encode()).hexdigest()[:12]
            raw = staging / ".inputs" / f"{entry['sha256']}-{unique}"
            atomic_write(raw, body)
            try:
                compress_moc(raw, encoded)
            finally:
                raw.unlink(missing_ok=True)
        if gzip.decompress(encoded.read_bytes()) != body:
            raise ValueError(f"MOC transport does not decode to its source: {entry['path']}")
        return {"path": entry["path"], "bytes": len(body), "sha256": entry["sha256"],
                "gzipBytes": encoded.stat().st_size, "gzipSha256": sha256_file(encoded)}

    with ThreadPoolExecutor(max_workers=2) as executor:
        receipts = [row for row in executor.map(compress, selected) if row is not None]
    changed = release_entries(staging)
    allowed = {moc_gzip_path(row["path"]) for row in selected}
    if any(row["path"] not in allowed for row in changed):
        raise ValueError("MOC publication contains unrelated outputs")
    # A rerun can reuse its previously prepared encoded files, but not replace
    # an existing immutable representation with different bytes.
    for row in changed:
        previous = entries.get(row["path"])
        if previous is not None and previous != row:
            raise ValueError("existing MOC encoding differs from its release entry")
    combined = {**entries, **{row["path"]: row for row in changed}}
    manifest = write_release_identity_files(staging, server, base["sourceId"],
                                            sorted(combined.values(), key=lambda row: row["path"]))
    _validate_release_manifest_for_gc(manifest,
        f"servers/{server}/releases/{manifest['releaseId']}/release.json", server, manifest["releaseId"])
    return {"manifest": manifest, "changedEntries": changed, "receipts": receipts,
            "noOp": manifest == base}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=("jp", "intl"), required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--model", action="append", default=[])
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"r-[a-f0-9]{20}", args.release):
        raise ValueError("invalid immutable release id")
    store = None
    current = None
    if args.publish:
        pin = os.environ["PRODUCER_PIN"]
        if (not re.fullmatch(r"[a-f0-9]{40}", pin)
                or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != pin
                or subprocess.run(["git", "diff", "--quiet", "HEAD", "--", "scripts"], check=False).returncode):
            raise ValueError("MOC publication producer is not a clean pinned revision")
        store = R2Store(load_server_config(args.server), concurrency=2)
        current = store.get_json_with_version(f"servers/{args.server}/current.json")
        if current is None or current[0].get("releaseId") != args.release:
            raise ValueError("current differs from the reviewed MOC release")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_url = f"https://haneoka.org/api/v1/servers/{args.server}/release?release={args.release}"
    if args.manifest:
        base = json.loads(args.manifest.read_bytes())
    elif store is not None:
        base = store.get_json(f"servers/{args.server}/releases/{args.release}/release.json")
    else:
        payload = read_public(manifest_url, 64 * 1024 * 1024)
        if len(payload) > 64 * 1024 * 1024:
            raise ValueError("release manifest exceeds byte budget")
        base = json.loads(payload)
    if not isinstance(base, dict) or base.get("server") != args.server or base.get("releaseId") != args.release:
        raise ValueError("MOC publication input identity differs")

    def read_entry(entry):
        if store is not None:
            return store.get_bytes(cas_key(entry["sha256"]))
        path = quote(entry["path"].removeprefix("runtime/"), safe="/")
        url = f"https://haneoka.org/runtime/{args.server}/{path}?release={args.release}"
        return read_public(url, entry["bytes"])

    staging = args.output / "release"
    staging.mkdir(exist_ok=True)
    prepared = prepare(base, read_entry, staging, tuple(args.model))
    receipt = {"schema": "haneoka-moc-http-encoding-v1", "server": args.server,
               "baseReleaseId": args.release, "releaseId": prepared["manifest"]["releaseId"],
               "sourceId": base["sourceId"], "codec": "gzip6-mtime0", "published": False,
               "pythonVersion": sys.version, "zlibVersion": zlib.ZLIB_RUNTIME_VERSION,
               "noOp": prepared["noOp"], "manifestSource": manifest_url,
               "originalMocBytesPreserved": True, "pipelineFingerprintPreserved": True,
               "changedEntries": prepared["changedEntries"], "receipts": prepared["receipts"]}
    if args.publish and not prepared["noOp"]:
        from publish.band_descriptions import publish
        prepared.update(pointer=current[0], pointerETag=current[1])
        receipt["pointer"] = publish(store, load_server_config(args.server), prepared, staging)
        receipt["published"] = True
    write_json(args.output / "publication-receipt.json", receipt, pretty=True)


if __name__ == "__main__":
    main()
