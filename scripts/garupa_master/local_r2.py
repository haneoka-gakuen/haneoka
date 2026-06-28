from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .archive import atomic_write_json
from .r2 import POINTER_CACHE, WEB_PATHS, build_snapshot_manifest, pointer_key, snapshot_manifest_key


def _put(
    bucket: str,
    key: str,
    source: Path,
    media_type: str,
    cache_control: str,
    *,
    config: Path,
    state: Path,
) -> None:
    executable = "pnpm.cmd" if os.name == "nt" else "pnpm"
    result = subprocess.run(
        [
            executable,
            "exec",
            "wrangler",
            "r2",
            "object",
            "put",
            f"{bucket}/{key}",
            "--file",
            str(source),
            "--content-type",
            media_type,
            "--cache-control",
            cache_control,
            "--force",
            "--config",
            str(config),
            "--local",
            "--persist-to",
            str(state),
        ],
        check=False,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise OSError(f"local R2 upload failed for {key}: {detail}")


def seed_local_r2(
    archive: Path,
    schema: Path,
    projections: Path,
    state: Path,
    config: Path,
    *,
    bucket: str,
) -> dict[str, Any]:
    """Expose a validated real snapshot to the local playlist API.

    The immutable manifest describes the complete real sync. Only the playlist
    projection is copied into local R2 because it is the sole CAS object read
    by the current local web route.
    """

    manifest, sources = build_snapshot_manifest(
        archive.resolve(),
        schema.resolve(),
        projections.resolve(),
    )
    playlist_path = WEB_PATHS["playlists"]
    playlist_entry = next(entry for entry in manifest["files"] if entry["path"] == playlist_path)
    playlist_source = sources[playlist_path]
    snapshot_id = str(manifest["snapshotId"])
    manifest_key = snapshot_manifest_key("jp", snapshot_id)
    state = state.resolve()
    config = config.resolve()
    state.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="haneoka-garupa-local-r2-") as directory:
        temporary = Path(directory)
        manifest_source = temporary / "manifest.json"
        pointer_source = temporary / "current.json"
        atomic_write_json(manifest_source, manifest)
        atomic_write_json(
            pointer_source,
            {
                "schema": "haneoka-garupa-master-pointer-v1",
                "server": "jp",
                "snapshotId": snapshot_id,
                "manifest": manifest_key,
            },
        )

        digest = str(playlist_entry["sha256"])
        _put(
            bucket,
            f"cas/v1/sha256/{digest[:2]}/{digest}",
            playlist_source,
            str(playlist_entry["mediaType"]),
            "public, max-age=31536000, immutable",
            config=config,
            state=state,
        )
        _put(
            bucket,
            manifest_key,
            manifest_source,
            "application/json; charset=utf-8",
            "public, max-age=31536000, immutable",
            config=config,
            state=state,
        )
        _put(
            bucket,
            pointer_key(),
            pointer_source,
            "application/json; charset=utf-8",
            POINTER_CACHE,
            config=config,
            state=state,
        )

    playlists = json.loads(playlist_source.read_text(encoding="utf-8"))["playlists"]
    return {
        "snapshotId": snapshot_id,
        "playlistCount": len(playlists),
        "playlistSha256": playlist_entry["sha256"],
    }
