from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any

from .client import GarupaResponses, digest
from .wire import DecodeStats, ProtobufDecodeError, WireValue, decode_message, iter_wire_values


ARCHIVE_FORMAT = "haneoka-garupa-master-archive-v1"
MAX_SUITE_TABLE_OCCURRENCES = 4096


@dataclass(frozen=True)
class DecodedSuite:
    tables: dict[int, dict[str, Any]]
    top_level_values: dict[int, WireValue]
    coverage: dict[str, Any]


def atomic_write_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(value)
    temporary.replace(path)


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _safe_name(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-").lower()
    return normalized[:96] or "field"


def initial_manifest(responses: GarupaResponses, schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "format": ARCHIVE_FORMAT,
        "status": "application-fetched",
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "server": "jp",
        "packageName": schema.get("packageName"),
        "clientVersion": responses.versions.client_version,
        "dataVersion": responses.versions.data_version,
        "masterDataVersion": responses.versions.master_data_version,
        "application": {
            "encrypted": digest(responses.application_encrypted),
            "protobuf": digest(responses.application_protobuf),
            "decoded": responses.versions.decoded,
        },
    }


def archive_responses(
    output_dir: Path,
    responses: GarupaResponses,
    schema: dict[str, Any],
) -> DecodedSuite:
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = initial_manifest(responses, schema)
    atomic_write_json(output_dir / "manifest.json", manifest)
    atomic_write_bytes(output_dir / "application" / "response.encrypted", responses.application_encrypted)
    atomic_write_bytes(output_dir / "application" / "response.pb", responses.application_protobuf)
    atomic_write_json(output_dir / "application" / "response.json", responses.versions.decoded)
    atomic_write_bytes(output_dir / "suite" / "response.encrypted", responses.suite_encrypted)
    atomic_write_bytes(output_dir / "suite" / "response.bz2", responses.suite_compressed)
    atomic_write_bytes(output_dir / "suite" / "response.pb", responses.suite_protobuf)

    roots = schema.get("roots", {})
    suite_root = str(roots.get("suite", "SuiteMasterGetResponse"))
    suite_contract = schema.get("contracts", {}).get(suite_root, {})
    suite_fields = suite_contract.get("fields", {}) if isinstance(suite_contract, dict) else {}
    tables: dict[int, dict[str, Any]] = {}
    values: dict[int, WireValue] = {}
    occurrences: dict[int, int] = {}
    unknown_top_level: set[int] = set()
    failed_fields: list[dict[str, Any]] = []
    nested_stats = DecodeStats()
    known_encoded_bytes = 0
    unknown_encoded_bytes = 0
    table_index: list[dict[str, Any]] = []

    for suite_table_count, wire_value in enumerate(
        iter_wire_values(responses.suite_protobuf),
        start=1,
    ):
        if suite_table_count > MAX_SUITE_TABLE_OCCURRENCES:
            raise ProtobufDecodeError(
                "Suite table occurrences exceed "
                f"{MAX_SUITE_TABLE_OCCURRENCES}"
            )
        occurrences[wire_value.number] = occurrences.get(wire_value.number, 0) + 1
        occurrence = occurrences[wire_value.number]
        field_schema = suite_fields.get(str(wire_value.number))
        known = isinstance(field_schema, dict)
        field_name = str(field_schema.get("name")) if known else f"field-{wire_value.number}"
        field_type = str(field_schema.get("type")) if known else None
        filename = f"{wire_value.number:04d}-{_safe_name(field_name)}"
        if occurrence > 1:
            filename += f"-{occurrence:04d}"
        raw_value = (
            wire_value.value if isinstance(wire_value.value, bytes) else wire_value.encoded
        )
        atomic_write_bytes(output_dir / "suite" / "tables" / f"{filename}.pb", raw_value)
        table: dict[str, Any] = {
            "fieldNumber": wire_value.number,
            "occurrence": occurrence,
            "name": field_name if known else None,
            "contract": field_type,
            "wireType": wire_value.wire_type,
            "encodedBytes": len(wire_value.encoded),
            "valueBytes": len(raw_value),
            "valueSha256": sha256(raw_value).hexdigest(),
            "rawPath": f"suite/tables/{filename}.pb",
        }
        if known:
            known_encoded_bytes += len(wire_value.encoded)
            try:
                if wire_value.wire_type != 2 or not isinstance(wire_value.value, bytes):
                    raise ProtobufDecodeError("Suite Master table is not length-delimited")
                decoded = decode_message(wire_value.value, field_type, schema, nested_stats)
                decoded_path = output_dir / "suite" / "decoded" / f"{filename}.json"
                atomic_write_json(decoded_path, decoded)
                table["decodedPath"] = f"suite/decoded/{filename}.json"
                table["decoded"] = decoded
                if occurrence == 1:
                    values[wire_value.number] = wire_value
            except (OSError, ValueError, ProtobufDecodeError) as exc:
                table["decodeError"] = str(exc)
                failed_fields.append({"fieldNumber": wire_value.number, "name": field_name, "error": str(exc)})
        else:
            unknown_encoded_bytes += len(wire_value.encoded)
            unknown_top_level.add(wire_value.number)
            if occurrence == 1:
                values[wire_value.number] = wire_value
        table_index.append({key: value for key, value in table.items() if key != "decoded"})
        tables.setdefault(wire_value.number, table)

    total_encoded_bytes = len(responses.suite_protobuf)
    duplicate_top_level_fields = sorted(
        number for number, count in occurrences.items() if count > 1
    )
    schema_coverage = schema.get("coverage")
    schema_unresolved_types = (
        schema_coverage.get("unresolvedReferencedTypes", [])
        if isinstance(schema_coverage, dict)
        else ["missing-schema-coverage"]
    )
    if not isinstance(schema_unresolved_types, list):
        schema_unresolved_types = ["invalid-schema-coverage"]
    schema_complete = (
        not unknown_top_level
        and not failed_fields
        and nested_stats.unknown_fields == 0
        and nested_stats.duplicate_singular_fields == 0
        and not duplicate_top_level_fields
        and not schema_unresolved_types
    )
    coverage = {
        "archiveComplete": True,
        "schemaComplete": schema_complete,
        "semanticStatus": "complete" if schema_complete else "partial",
        "suiteFieldOccurrences": sum(occurrences.values()),
        "suiteDistinctFieldCount": len(occurrences),
        "schemaSuiteFieldCount": len(suite_fields),
        "knownTopLevelFields": sorted(number for number in occurrences if str(number) in suite_fields),
        "unknownTopLevelFields": sorted(unknown_top_level),
        "duplicateTopLevelFields": duplicate_top_level_fields,
        "missingSchemaFields": sorted(int(number) for number in suite_fields if int(number) not in occurrences),
        "failedKnownFields": failed_fields,
        "schemaUnresolvedReferencedTypes": schema_unresolved_types,
        "knownEncodedBytes": known_encoded_bytes,
        "unknownEncodedBytes": unknown_encoded_bytes,
        "totalProtobufBytes": total_encoded_bytes,
        "knownTopLevelEncodedByteRatio": (
            round(known_encoded_bytes / total_encoded_bytes, 8)
            if total_encoded_bytes
            else 0
        ),
        "nested": nested_stats.as_json(),
    }
    table_index.sort(key=lambda item: (item["fieldNumber"], item["occurrence"]))
    atomic_write_json(output_dir / "suite" / "tables.json", {"tables": table_index})
    atomic_write_json(output_dir / "suite" / "schema-coverage.json", coverage)

    manifest.update(
        {
            "status": "archive-complete",
            "suite": {
                "encrypted": digest(responses.suite_encrypted),
                "compressed": digest(responses.suite_compressed),
                "protobuf": digest(responses.suite_protobuf),
                "distinctTableCount": len(occurrences),
            },
            "schemaCoverage": coverage,
        }
    )
    atomic_write_json(output_dir / "manifest.json", manifest)
    return DecodedSuite(tables=tables, top_level_values=values, coverage=coverage)
