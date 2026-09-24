"""Pack one immutable Unity input shard for a single R2 transfer."""

from __future__ import annotations

import argparse
import json
import os
import tarfile
from pathlib import Path, PurePosixPath

from core.hashes import sha256_file
from core.manifests import read_json
from core.paths import source_layout
from publish.r2 import _expand_unity_dependencies
from verify.source import validate_source_manifest


def _add_file(archive: tarfile.TarFile, file: Path, name: str) -> None:
    info = tarfile.TarInfo(name)
    info.size = file.stat().st_size
    info.mode = 0o644
    info.mtime = 0
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    with file.open("rb") as stream:
        archive.addfile(info, stream)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--shard-index", type=int, required=True)
    parser.add_argument("--shard-count", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.shard_count < 1 or not 0 <= args.shard_index < args.shard_count:
        parser.error("shard index must be within shard count")

    layout = source_layout(args.server, args.source)
    manifest = read_json(layout.manifest)
    records = validate_source_manifest(
        manifest, args.server, args.source, require_storage=False
    )
    selected = [
        record for record in records
        if record.get("role") == "unity-bundle"
        and int(str(record["sha256"])[:16], 16) % args.shard_count == args.shard_index
    ]
    if not selected:
        raise ValueError(f"Unity input shard {args.shard_index} has no bundles")
    expanded = _expand_unity_dependencies(records, selected)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    try:
        with tarfile.open(temporary, "w", format=tarfile.PAX_FORMAT) as archive:
            _add_file(archive, layout.manifest, "source.json")
            for record in expanded:
                path = PurePosixPath(str(record["path"]))
                file = layout.root.joinpath(*path.parts)
                if not file.is_file() or file.is_symlink() or not file.resolve().is_relative_to(layout.root.resolve()):
                    raise ValueError(f"Unity shard input is missing or unsafe: {path}")
                if file.stat().st_size != int(record["bytes"]) or sha256_file(file) != record["sha256"]:
                    raise ValueError(f"Unity shard input fails integrity checks: {path}")
                _add_file(archive, file, path.as_posix())
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({
        "server": args.server,
        "sourceId": args.source,
        "shardIndex": args.shard_index,
        "shardCount": args.shard_count,
        "bundleCount": len(selected),
        "inputCount": len(expanded),
        "archiveBytes": output.stat().st_size,
        "sha256": sha256_file(output),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
