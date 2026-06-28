"""Build and verify the immutable original-client resource contract."""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath
from typing import Any

from core.config import load_server_config
from core.contracts import GAME_CLIENT_ADDRESSABLES_INDEX_SCHEMA, GAME_CLIENT_SCHEMA
from core.hashes import sha256_file
from core.manifests import read_json, write_json
from core.paths import source_layout, validate_release_path
from core.process import hardlink_or_copy
from core.storage import (
    RELEASE_INDEX_ALGORITHM,
    RELEASE_INDEX_SHARDS,
    release_index_shard,
    validate_sha256,
)
from extract.master import ENCRYPTED_DIRECTORY, VERSION_FILE
from verify.source import validate_source_manifest


MASTER_TABLE_FILE = re.compile(r"^Master[A-Za-z0-9_]+\.bin$")
ADDRESSABLE_ROLES = frozenset(
    {"catalog", "catalog-hash", "embedded-catalog", "unity-bundle"}
)
REQUIRED_ADDRESSABLE_ROLES = frozenset({"catalog", "catalog-hash", "embedded-catalog"})
ADDRESSABLE_INDEX_PREFIX = "addressables/index/"


def _safe_filename(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or PurePosixPath(value).name != value:
        raise ValueError(f"invalid {label}: {value}")
    validate_release_path(value)
    return value


def _source_addressables(
    server: str, source_id: str
) -> tuple[dict[str, Any], dict[str, list[Any]]]:
    source_file = source_layout(server, source_id).manifest
    source = read_json(source_file)
    records = validate_source_manifest(source, server, source_id)
    selected = [record for record in records if record.get("role") in ADDRESSABLE_ROLES]
    role_counts = Counter(str(record["role"]) for record in selected)
    missing = sorted(
        role for role in REQUIRED_ADDRESSABLE_ROLES if role_counts[role] != 1
    )
    if missing:
        raise ValueError(
            f"source must contain exactly one of each required Addressables role: {missing}"
        )
    if role_counts["unity-bundle"] < 1:
        raise ValueError("source contains no Unity bundles")

    entries: dict[str, list[Any]] = {}
    for record in selected:
        role = str(record["role"])
        original = _safe_filename(record.get("originalFilename"), f"{role} filename")
        filename = "catalog_main.bin" if role == "embedded-catalog" else original
        if role == "catalog-hash" and filename != "catalog_main.hash":
            raise ValueError(f"unexpected catalog hash filename: {filename}")
        if role == "catalog" and not re.fullmatch(
            r"catalog_[a-f0-9]{32}\.bin", filename
        ):
            raise ValueError(f"unexpected remote catalog filename: {filename}")
        if role == "unity-bundle" and not filename.endswith(".bundle"):
            raise ValueError(f"unexpected Unity bundle filename: {filename}")
        value = [validate_sha256(record.get("sha256")), record.get("bytes"), role]
        if not isinstance(value[1], int) or isinstance(value[1], bool) or value[1] < 0:
            raise ValueError(f"invalid Addressables byte count: {filename}")
        if role == "catalog-hash" and value[1] != 32:
            raise ValueError("catalog_main.hash must contain one 32-byte catalog hash")
        if filename in entries:
            raise ValueError(f"duplicate Addressables filename: {filename}")
        entries[filename] = value

    catalog = source.get("catalog")
    if not isinstance(catalog, dict):
        raise ValueError("source catalog metadata is missing")
    catalog_hash = catalog.get("hash")
    catalog_file = PurePosixPath(str(catalog.get("file") or "")).name
    if (
        not isinstance(catalog_hash, str)
        or not re.fullmatch(r"[a-f0-9]{32}", catalog_hash)
        or catalog_file != f"catalog_{catalog_hash}.bin"
        or catalog_file not in entries
    ):
        raise ValueError("source catalog hash and filename do not agree")
    return source, entries


def assemble_game_client(
    server: str, source_id: str, master_root: Path, output: Path
) -> dict[str, Any]:
    """Create small release-local indexes while retaining large bundles in source CAS."""

    config = load_server_config(server)
    master = read_json(master_root / "master.json")
    if not isinstance(master, dict) or master.get("schema") != "haneoka-master-v2":
        raise ValueError(
            "the Master build does not contain the encrypted-client v2 contract"
        )
    if not isinstance(master.get("systemVersion"), str) or not master["systemVersion"]:
        raise ValueError("the Master system version is missing")
    tables = master.get("tables")
    if (
        not isinstance(tables, list)
        or master.get("tableCount") != len(tables)
        or not tables
    ):
        raise ValueError("the Master table manifest is invalid")

    encrypted_root = master_root / ENCRYPTED_DIRECTORY
    master_output = output / "master"
    version_source = encrypted_root / VERSION_FILE
    if not version_source.is_file():
        raise FileNotFoundError(
            f"encrypted Master version file is missing: {version_source}"
        )
    if version_source.read_text("utf-8").strip() != master["systemVersion"]:
        raise ValueError("encrypted Master version file does not match master.json")
    if version_source.stat().st_size != master.get("versionBytes") or sha256_file(
        version_source
    ) != master.get("versionSha256"):
        raise ValueError("encrypted Master version file integrity mismatch")
    hardlink_or_copy(version_source, master_output / VERSION_FILE)

    client_tables: list[dict[str, Any]] = []
    for table in tables:
        if not isinstance(table, dict) or not isinstance(table.get("name"), str):
            raise ValueError("invalid Master table record")
        filename = f"{table['name']}.bin"
        if not MASTER_TABLE_FILE.fullmatch(filename):
            raise ValueError(f"invalid encrypted Master filename: {filename}")
        source = encrypted_root / filename
        if not source.is_file():
            raise FileNotFoundError(f"encrypted Master table is missing: {source}")
        digest = sha256_file(source)
        if source.stat().st_size != table.get("sourceBytes") or digest != table.get(
            "sourceSha256"
        ):
            raise ValueError(f"encrypted Master table integrity mismatch: {filename}")
        hardlink_or_copy(source, master_output / filename)
        client_tables.append(
            {"bytes": source.stat().st_size, "file": filename, "sha256": digest}
        )

    _, addressables = _source_addressables(server, source_id)
    shards: dict[str, dict[str, list[Any]]] = defaultdict(dict)
    for filename, value in addressables.items():
        shard = release_index_shard(f"asset/{config.platform}/{filename}")
        shards[shard][filename] = value
    for index in range(RELEASE_INDEX_SHARDS):
        shard = f"{index:02x}"
        write_json(
            output / ADDRESSABLE_INDEX_PREFIX / f"{shard}.json",
            {
                "schema": GAME_CLIENT_ADDRESSABLES_INDEX_SCHEMA,
                "server": server,
                "sourceId": source_id,
                "platform": config.platform,
                "algorithm": RELEASE_INDEX_ALGORITHM,
                "shard": shard,
                "entries": shards.get(shard, {}),
            },
        )

    catalog_hash = PurePosixPath(
        next(
            filename
            for filename, value in addressables.items()
            if value[2] == "catalog"
        )
    ).stem.removeprefix("catalog_")
    manifest = {
        "schema": GAME_CLIENT_SCHEMA,
        "server": server,
        "sourceId": source_id,
        "master": {
            "systemVersion": master["systemVersion"],
            "versionFile": VERSION_FILE,
            "tableCount": len(client_tables),
            "totalBytes": sum(item["bytes"] for item in client_tables)
            + version_source.stat().st_size,
            "tables": client_tables,
        },
        "addressables": {
            "platform": config.platform,
            "catalogHash": catalog_hash,
            "catalogFile": f"catalog_{catalog_hash}.bin",
            "catalogHashFile": "catalog_main.hash",
            "embeddedCatalogFile": "catalog_main.bin",
            "bundleCount": sum(
                value[2] == "unity-bundle" for value in addressables.values()
            ),
            "fileCount": len(addressables),
            "totalBytes": sum(int(value[1]) for value in addressables.values()),
            "index": {
                "algorithm": RELEASE_INDEX_ALGORITHM,
                "shards": RELEASE_INDEX_SHARDS,
                "prefix": ADDRESSABLE_INDEX_PREFIX,
            },
        },
        "routes": {
            "master": "master/{filename}",
            "addressables": f"asset/{config.platform}/{{filename}}",
        },
    }
    write_json(output / "manifest.json", manifest, pretty=True)
    return manifest


def verify_game_client_release(
    root: Path, server: str, source_id: str, declared: set[str]
) -> dict[str, Any]:
    manifest_file = root / "manifest.json"
    manifest = read_json(manifest_file)
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != GAME_CLIENT_SCHEMA
        or manifest.get("server") != server
        or manifest.get("sourceId") != source_id
    ):
        raise ValueError("game-client manifest identity is invalid")

    master = manifest.get("master")
    if not isinstance(master, dict) or not isinstance(master.get("tables"), list):
        raise ValueError("game-client Master manifest is invalid")
    version_file = root / "master" / VERSION_FILE
    if not version_file.is_file() or version_file.read_text(
        "utf-8"
    ).strip() != master.get("systemVersion"):
        raise ValueError("game-client Master version is invalid")
    if (
        "game-client/manifest.json" not in declared
        or f"game-client/master/{VERSION_FILE}" not in declared
    ):
        raise ValueError(
            "game-client manifest or Master version is absent from the release manifest"
        )
    master_bytes = version_file.stat().st_size
    seen_tables: set[str] = set()
    for table in master["tables"]:
        if not isinstance(table, dict):
            raise ValueError("game-client Master table record is invalid")
        filename = _safe_filename(table.get("file"), "game-client Master filename")
        if not MASTER_TABLE_FILE.fullmatch(filename) or filename in seen_tables:
            raise ValueError(
                f"invalid or duplicate game-client Master filename: {filename}"
            )
        seen_tables.add(filename)
        file = root / "master" / filename
        if (
            not file.is_file()
            or file.stat().st_size != table.get("bytes")
            or sha256_file(file) != table.get("sha256")
        ):
            raise ValueError(f"game-client Master table integrity mismatch: {filename}")
        master_bytes += file.stat().st_size
        if f"game-client/master/{filename}" not in declared:
            raise ValueError(
                f"game-client Master table is absent from the release manifest: {filename}"
            )
    if (
        master.get("tableCount") != len(seen_tables)
        or master.get("totalBytes") != master_bytes
    ):
        raise ValueError("game-client Master totals do not match")

    addressables = manifest.get("addressables")
    if not isinstance(addressables, dict) or not isinstance(
        addressables.get("platform"), str
    ):
        raise ValueError("game-client Addressables manifest is invalid")
    platform = addressables["platform"]
    index_contract = addressables.get("index")
    if index_contract != {
        "algorithm": RELEASE_INDEX_ALGORITHM,
        "shards": RELEASE_INDEX_SHARDS,
        "prefix": ADDRESSABLE_INDEX_PREFIX,
    }:
        raise ValueError("game-client Addressables index contract is invalid")

    indexed: dict[str, list[Any]] = {}
    for index in range(RELEASE_INDEX_SHARDS):
        shard = f"{index:02x}"
        relative = f"addressables/index/{shard}.json"
        if f"game-client/{relative}" not in declared:
            raise ValueError(
                f"game-client Addressables shard is absent from the release manifest: {shard}"
            )
        document = read_json(root / relative)
        if (
            not isinstance(document, dict)
            or document.get("schema") != GAME_CLIENT_ADDRESSABLES_INDEX_SCHEMA
            or document.get("server") != server
            or document.get("sourceId") != source_id
            or document.get("platform") != platform
            or document.get("algorithm") != RELEASE_INDEX_ALGORITHM
            or document.get("shard") != shard
            or not isinstance(document.get("entries"), dict)
        ):
            raise ValueError(f"game-client Addressables shard is invalid: {shard}")
        for filename, value in document["entries"].items():
            _safe_filename(filename, "game-client Addressables filename")
            if release_index_shard(f"asset/{platform}/{filename}") != shard:
                raise ValueError(
                    f"game-client Addressables entry is in the wrong shard: {filename}"
                )
            if filename in indexed:
                raise ValueError(
                    f"duplicate game-client Addressables filename: {filename}"
                )
            if (
                not isinstance(value, list)
                or len(value) != 3
                or not isinstance(value[1], int)
                or isinstance(value[1], bool)
                or value[1] < 0
                or value[2] not in ADDRESSABLE_ROLES
            ):
                raise ValueError(f"invalid game-client Addressables entry: {filename}")
            validate_sha256(value[0])
            indexed[filename] = value

    _, expected = _source_addressables(server, source_id)
    if indexed != expected:
        missing = sorted(set(expected) - set(indexed))
        extra = sorted(set(indexed) - set(expected))
        raise ValueError(
            f"game-client Addressables source mismatch: missing={missing[:10]}, extra={extra[:10]}"
        )
    catalog_hash = addressables.get("catalogHash")
    if (
        not isinstance(catalog_hash, str)
        or addressables.get("catalogFile") != f"catalog_{catalog_hash}.bin"
        or addressables.get("catalogHashFile") != "catalog_main.hash"
        or addressables.get("embeddedCatalogFile") != "catalog_main.bin"
        or addressables.get("fileCount") != len(indexed)
        or addressables.get("bundleCount")
        != sum(value[2] == "unity-bundle" for value in indexed.values())
        or addressables.get("totalBytes")
        != sum(int(value[1]) for value in indexed.values())
    ):
        raise ValueError(
            "game-client Addressables totals or catalog identity do not match"
        )
    return manifest
