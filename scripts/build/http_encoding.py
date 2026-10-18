"""Precompressed HTTP representations of immutable runtime model bytes."""
from __future__ import annotations

import gzip
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from core.hashes import sha256_file


def moc_gzip_path(path: str) -> str | None:
    return path + ".gz" if path.startswith("runtime/live2d/") and path.endswith(".moc3") else None


def compress_moc(source: Path, target: Path) -> None:
    """Write gzip6 with a fixed header and no source filename."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        with source.open("rb") as original:
            if original.read(4) != b"MOC3":
                raise ValueError(f"runtime model is not MOC3: {source}")
            original.seek(0)
            with temporary.open("wb") as encoded:
                with gzip.GzipFile(filename="", mode="wb", compresslevel=6, mtime=0, fileobj=encoded) as body:
                    shutil.copyfileobj(original, body, 1024 * 1024)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def precompress_runtime(root: Path, base_entries: dict[str, dict] | None = None) -> dict[str, int]:
    base = base_entries or {}
    files = sorted((root / "runtime/live2d").rglob("*.moc3"))

    def materialize(source: Path) -> tuple[int, int]:
        relative = source.relative_to(root).as_posix()
        encoded_path = moc_gzip_path(relative)
        assert encoded_path is not None
        target = root / encoded_path
        previous = base.get(relative)
        encoded = base.get(encoded_path)
        if previous and encoded and previous["sha256"] == sha256_file(source):
            # Delta composition retains this exact encoded entry from the base.
            target.unlink(missing_ok=True)
            return 0, 1
        compress_moc(source, target)
        return 1, 0

    with ThreadPoolExecutor(max_workers=2) as executor:
        values = list(executor.map(materialize, files))
    return {"compressed": sum(row[0] for row in values), "reused": sum(row[1] for row in values)}
