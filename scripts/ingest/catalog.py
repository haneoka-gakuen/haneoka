from __future__ import annotations

import struct
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

UINT32_MAX = 0xFFFFFFFF
UNICODE_STRING_FLAG = 0x80000000
DYNAMIC_STRING_FLAG = 0x40000000
CLEAR_FLAGS_MASK = 0x3FFFFFFF


def _has_type(type_name: str | None, tail: str) -> bool:
    return bool(type_name and (tail in type_name.split(".") or type_name.endswith(tail)))


def _remote_url(parts: list[str]) -> str:
    if not parts or urlsplit(parts[-1]).scheme.lower() not in {"http", "https"}:
        return "/".join(parts)
    values = list(reversed(parts))
    return f"{values[0]}/{'/'.join(values[1:])}"


class CatalogReader:
    def __init__(self, data: bytes):
        self.data = data
        self._keys: list[dict[str, Any]] | None = None

    def require_range(self, offset: int, size: int) -> None:
        if offset < 0 or size < 0 or offset + size > len(self.data):
            raise ValueError(f"Addressables catalog range is invalid: {offset}+{size}")

    def u32(self, offset: int) -> int:
        self.require_range(offset, 4)
        return struct.unpack_from("<I", self.data, offset)[0]

    def i32(self, offset: int) -> int:
        self.require_range(offset, 4)
        return struct.unpack_from("<i", self.data, offset)[0]

    def values(self, offset: int, size: int, read_item):
        if offset == UINT32_MAX:
            return []
        if size < 1 or offset < 4:
            raise ValueError("Addressables catalog table has an invalid offset or item size")
        byte_count = self.u32(offset - 4)
        if byte_count % size:
            raise ValueError("Addressables catalog table has a misaligned byte count")
        count = byte_count // size
        self.require_range(offset, byte_count)
        return [read_item(offset + index * size) for index in range(count)]

    def auto_string(self, identifier: int) -> str | None:
        if identifier == UINT32_MAX:
            return None
        encoding = "utf-16-le" if identifier & UNICODE_STRING_FLAG else "ascii"
        offset = identifier & CLEAR_FLAGS_MASK if identifier & UNICODE_STRING_FLAG else identifier
        if offset < 4:
            raise ValueError("Addressables catalog string has an invalid offset")
        size = self.u32(offset - 4)
        self.require_range(offset, size)
        return self.data[offset : offset + size].decode(encoding)

    def string_parts(self, identifier: int) -> list[str]:
        if identifier == UINT32_MAX:
            return []
        if not identifier & DYNAMIC_STRING_FLAG:
            return [self.auto_string(identifier) or ""]
        parts: list[str] = []
        offset = identifier & CLEAR_FLAGS_MASK
        seen: set[int] = set()
        while True:
            if offset in seen:
                raise ValueError("Addressables catalog dynamic string contains a cycle")
            seen.add(offset)
            parts.append(self.auto_string(self.u32(offset)) or "")
            next_id = self.u32(offset + 4)
            if next_id == UINT32_MAX:
                return parts
            offset = next_id

    def string(self, identifier: int, separator: str = "") -> str | None:
        if identifier == UINT32_MAX:
            return None
        return separator.join(self.string_parts(identifier)) if separator else self.auto_string(identifier)

    def type_name(self, offset: int) -> str | None:
        return None if offset == UINT32_MAX else self.string(self.u32(offset + 4), ".")

    def object_of_type(self, type_name: str | None, offset: int) -> Any:
        if offset == UINT32_MAX:
            return None
        if _has_type(type_name, "String"):
            separator = chr(struct.unpack_from("<H", self.data, offset + 4)[0])
            return self.string(self.u32(offset), separator if separator != "\0" else "")
        if _has_type(type_name, "Type"):
            return self.type_name(offset)
        if _has_type(type_name, "Int32"):
            return self.i32(offset)
        if _has_type(type_name, "Boolean"):
            return self.data[offset] != 0
        if _has_type(type_name, "Int64"):
            return struct.unpack_from("<q", self.data, offset)[0]
        if _has_type(type_name, "Hash128"):
            return self.data[offset : offset + 16].hex()
        if _has_type(type_name, "AssetBundleRequestOptions"):
            common = self.u32(offset + 16)
            return {
                "hash": self.data[self.u32(offset) : self.u32(offset) + 16].hex(),
                "bundleName": self.string(self.u32(offset + 4), "_"),
                "crc": self.u32(offset + 8),
                "bundleSize": self.u32(offset + 12),
                "flags": self.i32(common + 4),
            }
        return {"type": type_name, "offset": offset}

    def object(self, offset: int) -> Any:
        if offset == UINT32_MAX:
            return None
        return self.object_of_type(self.object_of_type("Type", self.u32(offset)), self.u32(offset + 4))

    def location(self, offset: int, dependencies: bool = True) -> dict[str, Any] | None:
        if offset == UINT32_MAX:
            return None
        dependency_offset = self.u32(offset + 12)
        internal_parts = self.string_parts(self.u32(offset + 4))
        value = {
            "offset": offset,
            "primaryKey": self.string(self.u32(offset), "/"),
            "primaryParts": self.string_parts(self.u32(offset)),
            "internalId": self.string(self.u32(offset + 4), "/"),
            "internalParts": internal_parts,
            "remoteUrl": _remote_url(internal_parts),
            "providerId": self.string(self.u32(offset + 8), "."),
            "data": self.object(self.u32(offset + 20)) if self.u32(offset + 20) != UINT32_MAX else None,
            "resourceType": self.type_name(self.u32(offset + 24)),
        }
        value["dependencies"] = (
            self.values(dependency_offset, 4, lambda item: self.location(self.u32(item), False))
            if dependencies and dependency_offset != UINT32_MAX
            else []
        )
        return value

    def keys(self) -> list[dict[str, Any]]:
        if self._keys is None:
            keys_offset = self.u32(8)
            self._keys = self.values(
                keys_offset,
                8,
                lambda offset: {"key": self.object(self.u32(offset)), "locations": self.u32(offset + 4)},
            )
        return self._keys

    def locate(self, row: dict[str, Any]) -> list[dict[str, Any]]:
        return self.values(row["locations"], 4, lambda offset: self.location(self.u32(offset), True))

    def unique_locations(self) -> list[dict[str, Any]]:
        found: dict[int, dict[str, Any]] = {}
        for row in self.keys():
            for location in self.locate(row):
                for value in (location, *location.get("dependencies", [])):
                    if value:
                        found.setdefault(value["offset"], value)
        return [found[key] for key in sorted(found)]


def read_catalog(file: Path) -> CatalogReader:
    return CatalogReader(file.read_bytes())


def downloadable_locations(file: Path) -> list[dict[str, Any]]:
    return [
        value
        for value in read_catalog(file).unique_locations()
        if isinstance(value.get("data"), dict)
        and value["data"].get("bundleName")
        and urlsplit(str(value.get("remoteUrl", ""))).scheme.lower() == "https"
    ]
