"""Small filesystem and subprocess primitives for pipeline stages."""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Iterable

from core.hashes import sha256_file


def walk_files(root: Path) -> Iterable[Path]:
    if root.is_dir():
        yield from sorted(file for file in root.rglob("*") if file.is_file() and file.name != ".DS_Store")


def hardlink_or_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if target.stat().st_size == source.stat().st_size and sha256_file(target) == sha256_file(source):
            return
        raise FileExistsError(f"output collision: {target}")
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)
