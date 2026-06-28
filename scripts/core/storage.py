"""Canonical R2 object keys and release-index partitioning."""

from __future__ import annotations

import re

from core.paths import validate_release_path


CAS_PREFIX = "cas/v1/sha256"
RELEASE_INDEX_ALGORITHM = "fnv1a32-mod-256"
RELEASE_INDEX_SHARDS = 256
SHA256 = re.compile(r"^[a-f0-9]{64}$")


def validate_sha256(value: object) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise ValueError(f"invalid sha256: {value}")
    return value


def cas_key(digest: object) -> str:
    value = validate_sha256(digest)
    return f"{CAS_PREFIX}/{value[:2]}/{value}"


def parse_cas_key(key: object) -> str:
    if not isinstance(key, str):
        raise ValueError(f"invalid CAS key: {key}")
    parts = key.split("/")
    if len(parts) != 5 or "/".join(parts[:3]) != CAS_PREFIX:
        raise ValueError(f"invalid CAS key: {key}")
    digest = validate_sha256(parts[4])
    if parts[3] != digest[:2] or key != cas_key(digest):
        raise ValueError(f"non-canonical CAS key: {key}")
    return digest


def _fnv1a32(value: bytes) -> int:
    result = 0x811C9DC5
    for byte in value:
        result ^= byte
        result = (result * 0x01000193) & 0xFFFFFFFF
    return result


def fnv1a32_shard(value: str, shards: int = RELEASE_INDEX_SHARDS) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("partition key must be a non-empty string")
    if not isinstance(shards, int) or isinstance(shards, bool) or not 1 <= shards <= 256:
        raise ValueError(f"invalid partition shard count: {shards}")
    width = max(2, len(f"{shards - 1:x}"))
    return f"{_fnv1a32(value.encode('utf-8')) % shards:0{width}x}"


def release_index_shard(path: object) -> str:
    relative = validate_release_path(path)
    return fnv1a32_shard(relative, RELEASE_INDEX_SHARDS)


def release_index_prefix(server: str, release_id: str) -> str:
    return f"servers/{server}/releases/{release_id}/index/"


def release_index_key(server: str, release_id: str, shard: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{2}", shard):
        raise ValueError(f"invalid release index shard: {shard}")
    return f"{release_index_prefix(server, release_id)}{shard}.json"
