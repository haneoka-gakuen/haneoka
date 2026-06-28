"""ZIP structural validation without application-defined resource budgets."""

from __future__ import annotations

import stat
import struct
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


_EOCD_SIGNATURE = b"PK\x05\x06"
_ZIP64_LOCATOR_SIGNATURE = b"PK\x06\x07"
_ZIP64_EOCD_SIGNATURE = b"PK\x06\x06"
_EOCD_SIZE = 22
_ZIP_COMMENT_MAX_BYTES = 0xFFFF


def _zip_member_count(file: Path, label: str) -> int:
    """Read the protocol-declared member count and reject multi-disk ZIPs."""

    size = file.stat().st_size
    tail_size = min(size, _EOCD_SIZE + _ZIP_COMMENT_MAX_BYTES)
    with file.open("rb") as stream:
        stream.seek(size - tail_size)
        tail = stream.read(tail_size)
        position = tail.rfind(_EOCD_SIGNATURE)
        fields: tuple[int | bytes, ...] | None = None
        while position >= 0:
            if position + _EOCD_SIZE <= len(tail):
                candidate = struct.unpack_from("<4s4H2LH", tail, position)
                if position + _EOCD_SIZE + int(candidate[-1]) == len(tail):
                    fields = candidate
                    break
            position = tail.rfind(_EOCD_SIGNATURE, 0, position)
        if fields is None:
            raise zipfile.BadZipFile(
                f"{label} has no valid end-of-central-directory record"
            )

        (
            _,
            disk_number,
            directory_disk,
            disk_entries,
            total_entries,
            directory_size,
            directory_offset,
            _,
        ) = fields
        eocd_offset = size - tail_size + position
        uses_zip64 = any(
            value == sentinel
            for value, sentinel in (
                (disk_number, 0xFFFF),
                (directory_disk, 0xFFFF),
                (disk_entries, 0xFFFF),
                (total_entries, 0xFFFF),
                (directory_size, 0xFFFFFFFF),
                (directory_offset, 0xFFFFFFFF),
            )
        )
        if uses_zip64:
            locator_offset = eocd_offset - 20
            if locator_offset < 0:
                raise zipfile.BadZipFile(f"{label} is missing its ZIP64 locator")
            stream.seek(locator_offset)
            locator = stream.read(20)
            if len(locator) != 20:
                raise zipfile.BadZipFile(f"{label} has a truncated ZIP64 locator")
            signature, zip64_disk, zip64_offset, disk_count = struct.unpack(
                "<4sLQL", locator
            )
            if (
                signature != _ZIP64_LOCATOR_SIGNATURE
                or zip64_disk != 0
                or disk_count != 1
            ):
                raise zipfile.BadZipFile(
                    f"{label} uses an unsupported multi-disk ZIP64 archive"
                )
            stream.seek(zip64_offset)
            record = stream.read(56)
            if len(record) != 56:
                raise zipfile.BadZipFile(
                    f"{label} has a truncated ZIP64 directory record"
                )
            (
                signature,
                record_size,
                _,
                _,
                zip64_disk_number,
                zip64_directory_disk,
                zip64_disk_entries,
                zip64_total_entries,
                _,
                _,
            ) = struct.unpack("<4sQ2H2L4Q", record)
            if (
                signature != _ZIP64_EOCD_SIGNATURE
                or record_size < 44
                or zip64_disk_number != 0
                or zip64_directory_disk != 0
                or zip64_disk_entries != zip64_total_entries
            ):
                raise zipfile.BadZipFile(
                    f"{label} has an unsupported ZIP64 directory"
                )
            return int(zip64_total_entries)

        if disk_number != 0 or directory_disk != 0 or disk_entries != total_entries:
            raise zipfile.BadZipFile(
                f"{label} uses an unsupported multi-disk ZIP archive"
            )
        return int(total_entries)


def _validate_zip_members(
    members: list[zipfile.ZipInfo], expected_count: int, label: str
) -> None:
    if len(members) != expected_count:
        raise zipfile.BadZipFile(
            f"{label} member count differs from its central directory"
        )
    names: set[str] = set()
    for member in members:
        if member.filename in names:
            raise ValueError(
                f"{label} contains a duplicate ZIP member: {member.filename}"
            )
        names.add(member.filename)
        if "\0" in member.filename:
            raise ValueError(f"{label} contains an invalid ZIP member name")
        if member.flag_bits & 0x1:
            raise ValueError(
                f"{label} contains an encrypted ZIP member: {member.filename}"
            )
        if member.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            raise ValueError(
                f"{label} contains an unsupported ZIP compression method: "
                f"{member.filename}"
            )
        if member.create_system == 3:
            file_type = stat.S_IFMT(member.external_attr >> 16)
            if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
                raise ValueError(
                    f"{label} contains a non-regular ZIP member: {member.filename}"
                )


@contextmanager
def open_validated_zip(file: Path, label: str) -> Iterator[zipfile.ZipFile]:
    if not file.is_file():
        raise FileNotFoundError(f"{label} is not a file: {file}")
    if file.stat().st_size == 0:
        raise ValueError(f"{label} is empty: {file}")
    expected_count = _zip_member_count(file, label)
    archive = zipfile.ZipFile(file)
    try:
        _validate_zip_members(archive.infolist(), expected_count, label)
        yield archive
    finally:
        archive.close()
