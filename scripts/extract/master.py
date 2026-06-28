from __future__ import annotations

import gzip
import json
import os
import tempfile
import threading
import zipfile
from pathlib import Path

from py3rijndael import Pkcs7Padding, RijndaelCbc

from core.config import ServerConfig
from core.contracts import PACKAGE_MAX_BYTES
from core.hashes import sha256_bytes
from core.manifests import atomic_write, write_json
from core.zip_io import open_validated_zip


MASTER_PREFIX = "assets/Master/"
VERSION_FILE = "MasterDataSystemVersion.txt"
ENCRYPTED_DIRECTORY = "encrypted"
STREAM_CHUNK_BYTES = 1024 * 1024


def _copy_archive_entry(
    archive: zipfile.ZipFile,
    entry: zipfile.ZipInfo,
    output: Path,
    label: str,
    *,
    maximum_bytes: int | None = None,
) -> None:
    if entry.is_dir():
        raise ValueError(f"{label} is a directory: {entry.filename}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(
        f".{output.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    try:
        copied = 0
        with archive.open(entry) as source, temporary.open("wb") as target:
            for chunk in iter(lambda: source.read(STREAM_CHUNK_BYTES), b""):
                copied += len(chunk)
                if maximum_bytes is not None and copied > maximum_bytes:
                    raise ValueError(
                        f"{label} exceeds the {maximum_bytes}-byte package limit"
                    )
                target.write(chunk)
        if copied != entry.file_size:
            raise ValueError(
                f"{label} size mismatch: expected {entry.file_size}, got {copied}"
            )
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _asset_pack(input_file: Path, scratch: Path) -> Path:
    with open_validated_zip(input_file, "Master package") as archive:
        members = archive.infolist()
        if any(member.filename.startswith(MASTER_PREFIX) for member in members):
            return input_file
        candidates = [
            member
            for member in members
            if Path(member.filename).name
            in {"split_UnityDataAssetPack.apk", "UnityDataAssetPack.apk"}
        ]
        if len(candidates) != 1:
            raise ValueError(
                f"input must contain exactly one UnityDataAssetPack split; found {len(candidates)}"
            )
        target = scratch / "UnityDataAssetPack.apk"
        _copy_archive_entry(
            archive,
            candidates[0],
            target,
            "Unity asset-pack APK",
            maximum_bytes=PACKAGE_MAX_BYTES,
        )
        return target


def extract_master(input_file: Path, output: Path, config: ServerConfig) -> dict:
    package_bytes = input_file.stat().st_size if input_file.is_file() else 0
    if package_bytes < 1:
        raise ValueError(f"Master package is missing or empty: {input_file}")
    if package_bytes > PACKAGE_MAX_BYTES:
        raise ValueError(
            f"Master package exceeds the {PACKAGE_MAX_BYTES}-byte package limit: "
            f"{package_bytes}"
        )
    crypto = config.master_crypto
    if set(crypto) != {"salt", "key", "iv"}:
        raise ValueError(f"master crypto is not configured for {config.id}")
    salt = bytes.fromhex(crypto["salt"])
    key = bytes.fromhex(crypto["key"])
    iv = bytes.fromhex(crypto["iv"])
    cipher = RijndaelCbc(key, iv, Pkcs7Padding(32), block_size=32)

    with tempfile.TemporaryDirectory(prefix="haneoka-master-") as directory:
        asset_pack = _asset_pack(input_file, Path(directory))
        with open_validated_zip(asset_pack, "Unity asset-pack APK") as archive:
            members = sorted(
                (
                    member
                    for member in archive.infolist()
                    if member.filename.startswith(MASTER_PREFIX)
                ),
                key=lambda member: member.filename,
            )
            bins = [
                member
                for member in members
                if Path(member.filename).name.startswith("Master")
                and member.filename.endswith(".bin")
            ]
            if not bins:
                raise ValueError("package contains no encrypted Master tables")
            names = [Path(member.filename).name for member in bins]
            if len(names) != len(set(names)):
                raise ValueError(
                    "package contains duplicate encrypted Master table filenames"
                )
            version_entries = [
                member
                for member in members
                if Path(member.filename).name == VERSION_FILE
            ]
            if len(version_entries) != 1:
                raise ValueError(f"{VERSION_FILE} is missing")
            version_entry = version_entries[0]
            output.mkdir(parents=True, exist_ok=True)
            encrypted_output = output / ENCRYPTED_DIRECTORY
            encrypted_output.mkdir(parents=True, exist_ok=True)
            tables = []
            total_encrypted_bytes = 0
            for entry in bins:
                raw = archive.read(entry)
                if raw[:64] != salt + iv:
                    raise ValueError(
                        f"master crypto constants do not match {Path(entry.filename).name}"
                    )
                decoded = gzip.decompress(cipher.decrypt(raw[64:]))
                value = json.loads(decoded.decode("utf-8"))
                if not isinstance(value.get("_allData"), list):
                    raise ValueError(f"invalid Master table: {entry.filename}")
                name = Path(entry.filename).stem
                atomic_write(encrypted_output / f"{name}.bin", raw)
                write_json(output / f"{name}.json", value)
                total_encrypted_bytes += len(raw)
                tables.append(
                    {
                        "name": name,
                        "rows": len(value["_allData"]),
                        "sourceBytes": len(raw),
                        "sourceSha256": sha256_bytes(raw),
                    }
                )
            version_bytes = archive.read(version_entry)
            try:
                version = version_bytes.decode("utf-8").strip()
            except UnicodeDecodeError as error:
                raise ValueError(f"{VERSION_FILE} is not UTF-8") from error
            if not version:
                raise ValueError(f"{VERSION_FILE} is empty")
            atomic_write(encrypted_output / VERSION_FILE, version_bytes)
    manifest = {
        "schema": "haneoka-master-v2",
        "systemVersion": version,
        "versionBytes": len(version_bytes),
        "versionSha256": sha256_bytes(version_bytes),
        "tableCount": len(tables),
        "rowCount": sum(item["rows"] for item in tables),
        "encryptedBytes": total_encrypted_bytes,
        "tables": tables,
    }
    write_json(output / "master.json", manifest, pretty=True)
    return manifest
