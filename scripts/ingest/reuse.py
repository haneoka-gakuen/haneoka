"""Cross-source artifact reuse backed by the R2 content-addressed store."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from core.config import ServerConfig
from core.storage import cas_key

REUSABLE_ROLES = frozenset({"unity-bundle", "cri-payload"})


@dataclass(frozen=True)
class ReuseEntry:
    sha256: str
    bytes: int


def build_reuse_index(store: Any, config: ServerConfig, max_sources: int = 6) -> dict[str, ReuseEntry]:
    root = f"servers/{config.id}/sources/"
    prefixes = sorted(store.iter_prefixes(root))[:max_sources]
    index: dict[str, ReuseEntry] = {}
    dropped: set[str] = set()
    for prefix in prefixes:
        manifest = store.get_json(prefix + "source.json")
        if not isinstance(manifest, dict) or manifest.get("server") != config.id:
            continue
        for item in manifest.get("files", []):
            if not isinstance(item, dict) or item.get("role") not in REUSABLE_ROLES:
                continue
            name = str(item.get("originalFilename") or "")
            digest = str(item.get("sha256") or "")
            size = int(item.get("bytes") or 0)
            if not name or len(digest) != 64 or size <= 0:
                continue
            entry = ReuseEntry(sha256=digest, bytes=size)
            existing = index.get(name)
            if existing is None:
                if name in dropped:
                    continue
                index[name] = entry
            elif existing != entry:
                del index[name]
                dropped.add(name)
    return index


def restore_reusable(store: Any, entry: ReuseEntry, output: Path) -> bool:
    try:
        store.download_file(
            cas_key(entry.sha256),
            output,
            expected_bytes=entry.bytes,
            expected_sha256=entry.sha256,
        )
    except Exception:
        output.unlink(missing_ok=True)
        return False
    return True
