"""Publish the shared global Sonolus engine payload to R2.

The engine + presentation payload (built by ``pnpm sonolus:build`` into
``data/sonolus/current/sonolus``) is server-agnostic and shared by every Sonolus
server. This uploads it under the R2 prefix ``sonolus/``, which the Worker serves
before falling back to a per-release runtime tree.

Unlike release publication this is a plain path -> key copy: the payload is small,
flat, and rebuilt in place on every engine change, so there is no content-addressed
manifest or index to maintain. The keys are stable, so a rebuilt engine simply
overwrites the previous objects.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin

# Allow running both as `python -m scripts.publish.sonolus` and as a direct
# `python scripts/publish/sonolus.py` invocation.
_SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from publish.r2 import R2Store  # noqa: E402
from core.hashes import sha256_file  # noqa: E402

SONOLUS_PREFIX = "sonolus"
SONOLUS_REVISION_KEY = "operation/sonolus/revision.json"
DEFAULT_PAYLOAD_DIR = (
    Path(__file__).resolve().parents[2] / "data" / "sonolus" / "current" / "sonolus"
)

_REPOSITORY_PREFIX = f"{SONOLUS_PREFIX}/repository/"
_LICENSES_PREFIX = f"{SONOLUS_PREFIX}/licenses/"
_OCTET_STREAM = "application/octet-stream"
_TEXT = "text/plain; charset=utf-8"
_JSON = "application/json; charset=utf-8"


@dataclass(frozen=True)
class _BucketConfig:
    """The only configuration Sonolus publication needs (see :class:`R2Store`)."""

    r2_bucket: str


def _content_type(key: str) -> str:
    if key.startswith(_REPOSITORY_PREFIX):
        return _OCTET_STREAM
    if key.startswith(_LICENSES_PREFIX):
        return _TEXT
    return _JSON


def _validate_skin_catalog(payload_dir: Path, catalog_dir: Path | None = None) -> None:
    """Keep resource snapshots consistent before the first remote write."""
    roots = [payload_dir] + ([catalog_dir] if catalog_dir is not None else [])

    def files(group: str) -> list[Path]:
        return sorted({path.relative_to(root) for root in roots
                       for path in (root / group).rglob("*") if path.is_file()})

    if not any((root / "skins").is_dir() for root in roots):
        if files("engines"):
            raise ValueError("Engine publication requires the complete skins catalog")
        return

    def load(relative_path: Path) -> dict:
        path = next((root / relative_path for root in roots
                     if (root / relative_path).is_file()), payload_dir / relative_path)
        value = json.loads(path.read_bytes())
        if not isinstance(value, dict):
            raise ValueError(f"Invalid Sonolus document: {path}")
        return value

    def binding(item: dict) -> dict:
        value = dict(item)
        for key in ("data", "texture", "thumbnail"):
            reference = item.get(key)
            if not isinstance(reference, dict) or not isinstance(reference.get("url"), str):
                raise ValueError(f"Invalid skin {key} reference: {item.get('name')}")
            value[key] = {**reference, "url": urljoin(item.get("source") or "", reference["url"])}
        return value

    pages = [path for path in files("skins/list") if path.name.startswith("page-")]
    if not pages:
        raise ValueError("Skin publication requires list pages")
    canonical = {}
    for path in pages:
        for item in load(path)["items"]:
            name = item["name"]
            if name in canonical:
                raise ValueError(f"Duplicate skin in list pages: {name}")
            canonical[name] = binding(item)

    def validate(item: dict, location: str) -> None:
        if canonical.get(item.get("name")) != binding(item):
            raise ValueError(f"Inconsistent skin snapshot: {location}/{item.get('name')}")

    def sections(document: dict, location: str) -> None:
        for section in document.get("sections", []):
            if section.get("itemType") == "skin":
                for item in section.get("items", []):
                    validate(item, location)

    sections(load(Path("skins/info")), "skins/info")
    for name in canonical:
        details = load(Path("skins") / name)
        validate(details["item"], f"skins/{name}")
        sections(details, f"skins/{name}/sections")

    load(Path("engines/info"))
    engine_pages = [path for path in files("engines/list") if path.name.startswith("page-")]
    if not engine_pages:
        raise ValueError("Skin publication requires the current engine catalog")
    for path in engine_pages:
        for item in load(path)["items"]:
            load(Path("engines") / item["name"])

    def embedded(value, location: str) -> None:
        if isinstance(value, dict):
            if "playData" in value and isinstance(value.get("skin"), dict):
                validate(value["skin"], location)
            for child in value.values():
                embedded(child, location)
        elif isinstance(value, list):
            for child in value:
                embedded(child, location)

    for group in ("engines", "levels", "playlists"):
        for path in files(group):
            embedded(load(path), path.as_posix())
def publish_sonolus_payload(store: R2Store, payload_dir: Path, catalog_dir: Path | None = None) -> dict:
    """Validate final metadata, then upload only the supplied payload files."""
    if not payload_dir.is_dir():
        raise FileNotFoundError(f"Sonolus payload directory not found: {payload_dir}")
    _validate_skin_catalog(payload_dir, catalog_dir)
    files = sorted(path for path in payload_dir.rglob("*") if path.is_file())
    digest = hashlib.sha256()
    for path in files:
        relative = path.relative_to(payload_dir).as_posix()
        digest.update(f"{relative}\0{sha256_file(path)}\n".encode("utf-8"))
    # Referenced bytes reach the repository before their item documents.
    for path in sorted(
        files,
        key=lambda path: (path.relative_to(payload_dir).parts[0] != "repository", path),
    ):
        key = f"{SONOLUS_PREFIX}/{path.relative_to(payload_dir).as_posix()}"
        store.upload_path(path, key, _content_type(key))
    revision = digest.hexdigest()
    store.put_json(SONOLUS_REVISION_KEY, {"revision": revision}, "private, no-store")
    return {
        "bucket": store.bucket,
        "prefix": f"{SONOLUS_PREFIX}/",
        "objects": len(files),
        "revision": revision,
    }


def _store(r2_bucket: str | None, concurrency: int) -> R2Store:
    bucket = (r2_bucket or os.environ.get("R2_BUCKET") or "").strip()
    if not bucket:
        raise ValueError("set --r2-bucket or R2_BUCKET for Sonolus publication")
    return R2Store(_BucketConfig(bucket), concurrency)


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="python -m scripts.publish.sonolus",
        description="Publish the shared global Sonolus engine payload to R2 (prefix sonolus/).",
    )
    parser.add_argument("--payload-dir", type=Path, default=DEFAULT_PAYLOAD_DIR)
    parser.add_argument(
        "--r2-bucket",
        default=None,
        help="R2 bucket (default: R2_BUCKET environment variable).",
    )
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument(
        "--catalog-dir", type=Path, default=None,
        help="Fresh verified current raw Sonolus metadata snapshot for checking metadata-only updates; never uploaded.",
    )
    args = parser.parse_args()

    result = publish_sonolus_payload(
        _store(args.r2_bucket, args.concurrency), args.payload_dir, args.catalog_dir
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
