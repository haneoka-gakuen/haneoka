from __future__ import annotations

import json
import re
import stat
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


MAX_PACKAGE_BYTES = 1024 * 1024 * 1024
MAX_XAPK_ENTRIES = 256
MAX_XAPK_TOTAL_BYTES = 1024 * 1024 * 1024
MAX_XAPK_MEMBER_BYTES = 512 * 1024 * 1024
MAX_XAPK_MANIFEST_BYTES = 1024 * 1024
MAX_XAPK_COMPRESSION_RATIO = 200
MAX_XAPK_SPLITS = 64
SAFE_APK_NAME = re.compile(r"^[A-Za-z0-9._-]+[.]apk$")


class PackagePreparationError(ValueError):
    """Raised when an APK/XAPK cannot be selected without unsafe extraction."""


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def prepare_package(
    package_path: Path,
    output_dir: Path,
    selection_path: Path,
    *,
    package_name: str,
) -> dict[str, Any]:
    package_bytes = package_path.stat().st_size
    if not 1 <= package_bytes <= MAX_PACKAGE_BYTES:
        raise PackagePreparationError("downloaded package exceeds the package byte limit")
    if not zipfile.is_zipfile(package_path):
        raise PackagePreparationError("downloaded package is not a ZIP-based APK/XAPK")

    with zipfile.ZipFile(package_path) as archive:
        infos = archive.infolist()
        manifest_info = next(
            (info for info in infos if info.filename == "manifest.json"),
            None,
        )
        if manifest_info is None:
            selection = {
                "format": "haneoka-garupa-package-selection-v1",
                "kind": "apk",
                "baseApk": str(package_path.resolve()),
                "declaredVersion": None,
                "splits": [str(package_path.resolve())],
            }
            _write_json(selection_path, selection)
            return selection

        if not infos or len(infos) > MAX_XAPK_ENTRIES:
            raise PackagePreparationError("XAPK has an invalid entry count")
        names: dict[str, zipfile.ZipInfo] = {}
        total_bytes = 0
        for info in infos:
            name = info.filename
            path = PurePosixPath(name)
            if (
                not name
                or name.startswith("/")
                or "\\" in name
                or ".." in path.parts
                or name in names
                or info.flag_bits & 0x1
            ):
                raise PackagePreparationError(
                    f"unsafe or duplicate XAPK entry: {name!r}"
                )
            mode = (info.external_attr >> 16) & 0o170000
            if mode and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise PackagePreparationError(f"non-regular XAPK entry: {name!r}")
            if info.file_size < 0 or info.file_size > MAX_XAPK_MEMBER_BYTES:
                raise PackagePreparationError(f"oversized XAPK entry: {name!r}")
            if info.file_size and (
                info.compress_size <= 0
                or info.file_size / info.compress_size
                > MAX_XAPK_COMPRESSION_RATIO
            ):
                raise PackagePreparationError(
                    f"suspicious XAPK compression ratio: {name!r}"
                )
            total_bytes += info.file_size
            if total_bytes > MAX_XAPK_TOTAL_BYTES:
                raise PackagePreparationError(
                    "XAPK exceeds the extraction byte limit"
                )
            names[name] = info

        if manifest_info.file_size > MAX_XAPK_MANIFEST_BYTES:
            raise PackagePreparationError("XAPK manifest is oversized")
        try:
            manifest = json.loads(archive.read(manifest_info))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PackagePreparationError("XAPK manifest is invalid JSON") from exc
        if not isinstance(manifest, dict):
            raise PackagePreparationError("XAPK manifest is not an object")
        if manifest.get("package_name") != package_name:
            raise PackagePreparationError("XAPK package id is unexpected")
        declared_version = manifest.get("version_name")
        if not isinstance(declared_version, str):
            raise PackagePreparationError("XAPK version_name is missing")
        split_entries = manifest.get("split_apks")
        if not isinstance(split_entries, list) or not 1 <= len(
            split_entries
        ) <= MAX_XAPK_SPLITS:
            raise PackagePreparationError("XAPK split_apks is missing or oversized")

        split_names: list[str] = []
        base_names: list[str] = []
        for split in split_entries:
            if not isinstance(split, dict):
                raise PackagePreparationError("XAPK split entry is not an object")
            name = split.get("file")
            if (
                not isinstance(name, str)
                or not SAFE_APK_NAME.fullmatch(name)
                or name not in names
                or names[name].is_dir()
                or name in split_names
            ):
                raise PackagePreparationError(f"invalid XAPK split path: {name!r}")
            split_names.append(name)
            if split.get("id") == "base":
                base_names.append(name)
        if len(base_names) != 1:
            raise PackagePreparationError(
                "XAPK must identify exactly one base split"
            )

        output_dir.mkdir(parents=True, exist_ok=True)
        if any(output_dir.iterdir()):
            raise PackagePreparationError("XAPK output directory is not empty")
        extracted: list[str] = []
        for name in split_names:
            source_info = names[name]
            target = output_dir / name
            with archive.open(source_info) as source, target.open("xb") as output:
                copied = 0
                while chunk := source.read(1024 * 1024):
                    copied += len(chunk)
                    if copied > source_info.file_size:
                        raise PackagePreparationError(
                            f"XAPK split exceeded declared size: {name}"
                        )
                    output.write(chunk)
            if copied != source_info.file_size:
                raise PackagePreparationError(f"XAPK split size mismatch: {name}")
            target.chmod(0o644)
            extracted.append(str(target.resolve()))

    selection = {
        "format": "haneoka-garupa-package-selection-v1",
        "kind": "xapk",
        "baseApk": str((output_dir / base_names[0]).resolve()),
        "declaredVersion": declared_version,
        "splits": extracted,
    }
    _write_json(selection_path, selection)
    return selection
