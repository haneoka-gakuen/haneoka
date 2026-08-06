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
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

# Allow running both as `python -m scripts.publish.sonolus` and as a direct
# `python scripts/publish/sonolus.py` invocation.
_SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from publish.r2 import R2Store  # noqa: E402

SONOLUS_PREFIX = "sonolus"
DEFAULT_PAYLOAD_DIR = Path(__file__).resolve().parents[2] / "data" / "sonolus" / "current" / "sonolus"

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


def publish_sonolus_payload(store: R2Store, payload_dir: Path) -> dict:
    """Upload every file under ``payload_dir`` to R2 key ``sonolus/<relative>``."""
    if not payload_dir.is_dir():
        raise FileNotFoundError(f"Sonolus payload directory not found: {payload_dir}")
    files = sorted(path for path in payload_dir.rglob("*") if path.is_file())
    for path in files:
        key = f"{SONOLUS_PREFIX}/{path.relative_to(payload_dir).as_posix()}"
        store.upload_path(path, key, _content_type(key))
    return {"bucket": store.bucket, "prefix": f"{SONOLUS_PREFIX}/", "objects": len(files)}


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
    args = parser.parse_args()

    result = publish_sonolus_payload(_store(args.r2_bucket, args.concurrency), args.payload_dir)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
