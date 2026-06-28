from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from core.config import PROJECT_ROOT, validate_server_id


SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def safe_id(value: str, label: str = "id") -> str:
    if not SAFE_ID.fullmatch(value):
        raise ValueError(f"invalid {label}: {value}")
    return value


def normalize_release_path(value: str) -> str:
    original = str(value).replace("\\", "/")
    if original.startswith("/") or "//" in original:
        raise ValueError(f"invalid release path: {value}")
    raw = original.strip("/")
    path = PurePosixPath(raw)
    if (
        not raw
        or path.is_absolute()
        or any(part in ("", ".", "..") or "\0" in part for part in path.parts)
    ):
        raise ValueError(f"invalid release path: {value}")
    return path.as_posix()


def validate_release_path(value: object) -> str:
    """Validate an already-canonical, release-relative POSIX path.

    Release manifests are content-addressed inputs.  Unlike Unity source paths,
    they must never silently normalize platform separators or dot segments.
    """

    if not isinstance(value, str) or "\\" in value:
        raise ValueError(f"invalid release path: {value}")
    normalized = normalize_release_path(value)
    if normalized != value:
        raise ValueError(f"non-canonical release path: {value}")
    return normalized


def validate_unity_path(value: str) -> str:
    value = normalize_release_path(value)
    if not value.startswith(("Assets/", "Packages/")):
        raise ValueError(
            f"Unity source path must start with Assets/ or Packages/: {value}"
        )
    return value


@dataclass(frozen=True)
class ServerLayout:
    id: str
    root: Path
    sources: Path
    builds: Path
    releases: Path
    current: Path


@dataclass(frozen=True)
class SourceLayout:
    root: Path
    package_dir: Path
    catalogs: Path
    bundles: Path
    cri: Path
    manifest: Path


@dataclass(frozen=True)
class BuildLayout:
    root: Path
    shards: Path
    database: Path
    assets: Path
    runtime: Path
    objects: Path
    master: Path
    api: Path
    metadata: Path
    reports: Path
    manifest: Path


@dataclass(frozen=True)
class ReleaseLayout:
    root: Path
    assets: Path
    runtime: Path
    objects: Path
    api: Path
    metadata: Path
    game_client: Path
    manifest: Path


def server_layout(server: str) -> ServerLayout:
    server = validate_server_id(server)
    root = PROJECT_ROOT / "data" / "servers" / server
    return ServerLayout(
        server,
        root,
        root / "sources",
        root / "builds",
        root / "releases",
        root / "current.json",
    )


def source_layout(server: str, source_id: str) -> SourceLayout:
    root = server_layout(server).sources / safe_id(source_id, "source id")
    return SourceLayout(
        root=root,
        package_dir=root / "package",
        catalogs=root / "android" / "catalogs",
        bundles=root / "android" / "bundles",
        cri=root / "android" / "cri",
        manifest=root / "source.json",
    )


def build_layout(server: str, build_id: str) -> BuildLayout:
    root = server_layout(server).builds / safe_id(build_id, "build id")
    return BuildLayout(
        root=root,
        shards=root / "shards",
        database=root / "unity.sqlite",
        assets=root / "assets",
        runtime=root / "runtime",
        objects=root / "objects",
        master=root / "master",
        api=root / "api" / "v1" / "catalog",
        metadata=root / "metadata",
        reports=root / "reports",
        manifest=root / "build.json",
    )


def release_layout(server: str, release_id: str) -> ReleaseLayout:
    root = server_layout(server).releases / safe_id(release_id, "release id")
    return ReleaseLayout(
        root=root,
        assets=root / "assets",
        runtime=root / "runtime",
        objects=root / "objects",
        api=root / "api" / "v1" / "catalog",
        metadata=root / "metadata",
        game_client=root / "game-client",
        manifest=root / "release.json",
    )
