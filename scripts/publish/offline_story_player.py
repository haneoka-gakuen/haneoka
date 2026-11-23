# L3 — GEB
# Input: A complete web player build and an authorized Tauri signing key.
# Output: An immutable player ZIP and a signed release pointer.
# Pos: [Map](L2-2.md); independent App story-player publication.
# Effects/Dependencies: Uses the Tauri signer, then uploads the ZIP before the pointer.
import argparse
import base64
import hashlib
import io
import json
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from download_store import DownloadStore, json_bytes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, default=Path(".output/offline-story-player"))
    parser.add_argument("--release", required=True)
    parser.add_argument("--output", type=Path, default=Path(".output/offline-story-player-release"))
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if not all((args.directory / name).is_file() for name in ("index.html", "player.js", "player.css")):
        parser.error("Build the complete offline story player before signing")
    args.output.mkdir(parents=True, exist_ok=True)

    contents = io.BytesIO()
    with ZipFile(contents, "w") as archive:
        for file in sorted(args.directory.rglob("*")):
            if file.is_file():
                entry = ZipInfo(file.relative_to(args.directory).as_posix())
                archive.writestr(entry, file.read_bytes(), compress_type=ZIP_DEFLATED)
    payload = contents.getvalue()
    digest = hashlib.sha256(payload).hexdigest()
    package = args.output / f"{digest}.zip"
    package.write_bytes(payload)
    manifest = args.output / "release.json"
    manifest.write_bytes(json_bytes({
        "schema": "haneoka-story-player-v2",
        "version": args.release,
        "sha256": digest,
        "bytes": len(payload),
    }))
    signature = manifest.with_suffix(".json.sig")
    signature.unlink(missing_ok=True)
    subprocess.run(["tauri", "signer", "sign", str(manifest)], check=True)
    latest = json_bytes({
        "manifest": base64.b64encode(manifest.read_bytes()).decode("ascii"),
        "signature": signature.read_text().strip(),
    })
    (args.output / "latest.json").write_bytes(latest)
    if args.publish:
        store = DownloadStore("haneoka-downloads")
        store.put_file(f"story-player/{package.name}", package, "application/zip")
        store.put_bytes("story-player/v1/latest.json", latest, cache_control="public, max-age=60, must-revalidate")


if __name__ == "__main__":
    main()
