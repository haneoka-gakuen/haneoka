"""Read canonical Unity source descriptors and their immutable object archives."""

from __future__ import annotations

import gzip
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from core.manifests import read_json


def iter_unity_object_archive(file: Path) -> Iterator[tuple[int, dict[str, Any]]]:
    """Yield one JSONL record at a time from a Unity object archive."""

    label = f"Unity object archive {file}"
    with file.open("rb") as raw, gzip.GzipFile(fileobj=raw, mode="rb") as stream:
        for record_count, line in enumerate(stream, 1):
            try:
                value = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(
                    f"{label} has invalid JSON at line {record_count}"
                ) from error
            if not isinstance(value, dict):
                raise ValueError(
                    f"{label} has a non-object JSON record at line {record_count}"
                )
            yield record_count, value


class UnityObjectStore:
    def __init__(self, layout: Any, index: dict[str, Any]):
        self.layout = layout
        self.index = index.get("sources", {})
        self.serialized_files = index.get("serializedFiles", {})
        self.descriptors: dict[str, dict[str, Any]] = {}
        self.current_digest = ""
        self.current_serialized_file = ""
        self.current_records: dict[str, dict[str, Any]] = {}

    def descriptor(self, source_path: str) -> dict[str, Any]:
        if source_path not in self.descriptors:
            entry = self.index.get(source_path)
            if not entry:
                raise KeyError(f"Unity source is missing from the index: {source_path}")
            self.descriptors[source_path] = read_json(self.layout.metadata / entry["descriptor"])
        return self.descriptors[source_path]

    def records(
        self, digest: str, serialized_file: str
    ) -> dict[str, dict[str, Any]]:
        if (
            self.current_digest == digest
            and self.current_serialized_file == serialized_file
        ):
            return self.current_records
        archive = self.layout.objects / "unity" / f"{digest}.jsonl.gz"
        serialized_file_entry = self.serialized_files.get(serialized_file)
        if (
            not isinstance(serialized_file_entry, dict)
            or serialized_file_entry.get("bundleSha256") != digest
        ):
            raise ValueError(
                f"Unity serialized file is absent from the bundle index: "
                f"{digest}:{serialized_file}"
            )
        records: dict[str, dict[str, Any]] = {}
        header_seen = False
        archive_records = 0
        for line_number, value in iter_unity_object_archive(archive):
            if value.get("record") == "header":
                if (
                    header_seen
                    or value.get("format") != "haneoka-unity-objects-jsonl-v1"
                    or value.get("bundleSha256") != digest
                    or serialized_file not in value.get("serializedFiles", [])
                ):
                    raise ValueError(f"Unity archive header mismatch: {archive}")
                header_seen = True
                continue
            if value.get("record") != "object":
                raise ValueError(
                    f"Unity archive has an unknown record: {archive}:{line_number}"
                )
            archive_records += 1
            if value.get("serializedFile") != serialized_file:
                continue
            object_id = str(value["pathId"])
            if object_id in records:
                raise ValueError(
                    f"Unity archive repeats pathId {object_id}: {archive}"
                )
            records[object_id] = value
        if (
            not header_seen
            or len(records) != int(serialized_file_entry.get("objectCount") or -1)
            or archive_records
            != int(serialized_file_entry.get("archiveObjectCount") or -1)
        ):
            raise ValueError(f"Unity archive record count mismatch: {archive}")
        self.current_digest = digest
        self.current_serialized_file = serialized_file
        self.current_records = records
        return records

    def source_data(self, source_path: str) -> dict[str, Any] | None:
        descriptor = self.descriptor(source_path)
        records = self.records(
            descriptor["selectedBundle"], descriptor["serializedFile"]
        )
        for object_id in descriptor.get("rootObjects", []):
            data = records.get(str(object_id), {}).get("data")
            if isinstance(data, dict):
                return data
        return None
