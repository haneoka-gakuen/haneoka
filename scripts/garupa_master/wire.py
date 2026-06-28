from __future__ import annotations

import base64
import math
import struct
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any, Iterable


MAX_SAFE_JSON_INTEGER = (1 << 53) - 1
MAX_MESSAGE_DEPTH = 96
MAX_WIRE_FIELD_BYTES = 64 * 1024 * 1024
MAX_MESSAGE_FIELD_OCCURRENCES = 250_000
MAX_TOTAL_DECODED_WIRE_FIELD_OCCURRENCES = 16_000_000
MAX_TOTAL_PACKED_SCALAR_VALUES = 4_000_000


class ProtobufDecodeError(ValueError):
    """Raised when a protobuf payload is malformed or violates local limits."""


@dataclass(frozen=True)
class WireValue:
    number: int
    wire_type: int
    value: int | bytes
    encoded: bytes


@dataclass
class DecodeStats:
    known_fields: int = 0
    unknown_fields: int = 0
    wire_field_occurrences: int = 0
    packed_scalar_values: int = 0
    duplicate_singular_fields: int = 0
    maximum_depth: int = 0
    unknown_by_contract: dict[str, set[int]] = field(default_factory=dict)

    def claim_wire_field(self) -> None:
        if self.wire_field_occurrences >= MAX_TOTAL_DECODED_WIRE_FIELD_OCCURRENCES:
            raise ProtobufDecodeError(
                "decoded wire field occurrences exceed "
                f"{MAX_TOTAL_DECODED_WIRE_FIELD_OCCURRENCES}"
            )
        self.wire_field_occurrences += 1

    def claim_packed_scalar(self) -> None:
        if self.packed_scalar_values >= MAX_TOTAL_PACKED_SCALAR_VALUES:
            raise ProtobufDecodeError(
                f"decoded packed scalar values exceed {MAX_TOTAL_PACKED_SCALAR_VALUES}"
            )
        self.packed_scalar_values += 1

    def record_unknown(self, contract: str, number: int) -> None:
        self.unknown_fields += 1
        self.unknown_by_contract.setdefault(contract, set()).add(number)

    def as_json(self) -> dict[str, Any]:
        return {
            "knownFieldOccurrences": self.known_fields,
            "unknownFieldOccurrences": self.unknown_fields,
            "wireFieldOccurrences": self.wire_field_occurrences,
            "packedScalarValues": self.packed_scalar_values,
            "duplicateSingularFieldOccurrences": self.duplicate_singular_fields,
            "maximumDepth": self.maximum_depth,
            "unknownFieldsByContract": {
                name: sorted(numbers) for name, numbers in sorted(self.unknown_by_contract.items())
            },
        }


def read_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    for _ in range(10):
        if offset >= len(data):
            raise ProtobufDecodeError("truncated varint")
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, offset
        shift += 7
    raise ProtobufDecodeError("varint exceeds 64 bits")


def iter_wire_values(
    data: bytes,
    *,
    maximum_occurrences: int = MAX_MESSAGE_FIELD_OCCURRENCES,
    maximum_field_bytes: int = MAX_WIRE_FIELD_BYTES,
) -> Iterable[WireValue]:
    if maximum_occurrences <= 0 or maximum_field_bytes <= 0:
        raise ProtobufDecodeError("protobuf wire limits must be positive")
    offset = 0
    occurrences = 0
    while offset < len(data):
        occurrences += 1
        if occurrences > maximum_occurrences:
            raise ProtobufDecodeError(
                f"message field occurrences exceed {maximum_occurrences}"
            )
        start = offset
        key, offset = read_varint(data, offset)
        number = key >> 3
        wire_type = key & 7
        if number <= 0:
            raise ProtobufDecodeError(f"invalid field number {number}")
        if wire_type == 0:
            value, offset = read_varint(data, offset)
        elif wire_type == 1:
            end = offset + 8
            if end > len(data):
                raise ProtobufDecodeError("truncated fixed64")
            value = data[offset:end]
            offset = end
        elif wire_type == 2:
            length, offset = read_varint(data, offset)
            if length > maximum_field_bytes:
                raise ProtobufDecodeError(
                    f"length-delimited field exceeds {maximum_field_bytes} bytes"
                )
            end = offset + length
            if end > len(data):
                raise ProtobufDecodeError("truncated length-delimited value")
            value = data[offset:end]
            offset = end
        elif wire_type == 5:
            end = offset + 4
            if end > len(data):
                raise ProtobufDecodeError("truncated fixed32")
            value = data[offset:end]
            offset = end
        elif wire_type in {3, 4}:
            raise ProtobufDecodeError("deprecated protobuf groups are not supported")
        else:
            raise ProtobufDecodeError(f"invalid wire type {wire_type}")
        yield WireValue(number=number, wire_type=wire_type, value=value, encoded=data[start:offset])


def _split_generic_arguments(value: str) -> list[str]:
    arguments: list[str] = []
    depth = 0
    start = 0
    for index, char in enumerate(value):
        if char == "<":
            depth += 1
        elif char == ">":
            depth -= 1
        elif char == "," and depth == 0:
            arguments.append(value[start:index].strip())
            start = index + 1
    arguments.append(value[start:].strip())
    return [argument for argument in arguments if argument]


def type_shape(csharp_type: str) -> tuple[str, tuple[str, ...]]:
    value = " ".join(csharp_type.replace("global::", "").split()).strip()
    if value.endswith("?"):
        return type_shape(value[:-1])
    if value.startswith("Nullable<") and value.endswith(">"):
        return type_shape(value[len("Nullable<") : -1])
    if value == "byte[]":
        return "scalar", (value,)
    if value.endswith("[]"):
        return "repeated", (value[:-2].strip(),)
    for prefix in ("List", "IList", "IReadOnlyList", "ICollection", "IEnumerable", "HashSet"):
        marker = f"{prefix}<"
        if value.startswith(marker) and value.endswith(">"):
            return "repeated", (value[len(marker) : -1].strip(),)
    if value.startswith("Dictionary<") and value.endswith(">"):
        arguments = _split_generic_arguments(value[len("Dictionary<") : -1])
        if len(arguments) == 2:
            return "dictionary", (arguments[0], arguments[1])
    return "scalar", (value,)


INTEGER_TYPES = {
    "byte",
    "sbyte",
    "short",
    "ushort",
    "int",
    "uint",
    "long",
    "ulong",
    "Int16",
    "UInt16",
    "Int32",
    "UInt32",
    "Int64",
    "UInt64",
}
SIGNED_INTEGER_TYPES = {"sbyte", "short", "int", "long", "Int16", "Int32", "Int64"}


def referenced_types(csharp_type: str) -> set[str]:
    shape, arguments = type_shape(csharp_type)
    if shape in {"repeated", "dictionary"}:
        result: set[str] = set()
        for argument in arguments:
            result.update(referenced_types(argument))
        return result
    value = arguments[0]
    if value in INTEGER_TYPES | {"bool", "string", "byte[]", "float", "double", "decimal", "char", "object"}:
        return set()
    return {value}


def _json_integer(value: int) -> int | str:
    return value if -MAX_SAFE_JSON_INTEGER <= value <= MAX_SAFE_JSON_INTEGER else str(value)


def _zig_zag_decode(value: int) -> int:
    return (value >> 1) ^ -(value & 1)


def _signed_varint(value: int, bits: int = 64) -> int:
    sign = 1 << (bits - 1)
    mask = (1 << bits) - 1
    value &= mask
    return value - (1 << bits) if value & sign else value


def _bytes_json(value: bytes, kind: str = "bytes") -> dict[str, Any]:
    return {
        f"${kind}": base64.b64encode(value).decode("ascii"),
        "length": len(value),
        "sha256": sha256(value).hexdigest(),
    }


def _unknown_json(value: WireValue) -> dict[str, Any]:
    result: dict[str, Any] = {
        "fieldNumber": value.number,
        "wireType": value.wire_type,
        "encoded": _bytes_json(value.encoded, "wire"),
    }
    if value.wire_type == 0:
        result["varint"] = _json_integer(int(value.value))
    else:
        assert isinstance(value.value, bytes)
        result["value"] = _bytes_json(value.value, "raw")
    return result


def _scalar_expected_wire(csharp_type: str) -> int | None:
    if csharp_type in INTEGER_TYPES | {"bool", "char"}:
        return 0
    if csharp_type == "float":
        return 5
    if csharp_type == "double":
        return 1
    if csharp_type in {"string", "byte[]", "decimal"}:
        return 2
    return None


def _decode_primitive(value: WireValue, csharp_type: str, data_format: str | None) -> Any:
    if csharp_type == "string":
        if value.wire_type != 2 or not isinstance(value.value, bytes):
            raise ProtobufDecodeError("string used a non length-delimited wire type")
        try:
            return value.value.decode("utf-8")
        except UnicodeDecodeError:
            return _bytes_json(value.value, "invalidUtf8")
    if csharp_type == "byte[]":
        if value.wire_type != 2 or not isinstance(value.value, bytes):
            raise ProtobufDecodeError("byte[] used a non length-delimited wire type")
        return _bytes_json(value.value)
    if csharp_type == "bool":
        if value.wire_type != 0:
            raise ProtobufDecodeError("bool used a non-varint wire type")
        return bool(value.value)
    if csharp_type in INTEGER_TYPES | {"char"}:
        if value.wire_type == 0:
            number = int(value.value)
            if data_format == "ZigZag":
                number = _zig_zag_decode(number)
            elif csharp_type in SIGNED_INTEGER_TYPES:
                bits = 32 if csharp_type in {"sbyte", "short", "int", "Int16", "Int32"} else 64
                number = _signed_varint(number, bits)
            return _json_integer(number)
        if value.wire_type in {1, 5} and isinstance(value.value, bytes):
            number = int.from_bytes(value.value, "little", signed=csharp_type in SIGNED_INTEGER_TYPES)
            return _json_integer(number)
        raise ProtobufDecodeError(f"{csharp_type} used incompatible wire type {value.wire_type}")
    if csharp_type == "float":
        if value.wire_type != 5 or not isinstance(value.value, bytes):
            raise ProtobufDecodeError("float used a non-fixed32 wire type")
        number = struct.unpack("<f", value.value)[0]
        return number if math.isfinite(number) else str(number)
    if csharp_type == "double":
        if value.wire_type != 1 or not isinstance(value.value, bytes):
            raise ProtobufDecodeError("double used a non-fixed64 wire type")
        number = struct.unpack("<d", value.value)[0]
        return number if math.isfinite(number) else str(number)
    raise KeyError(csharp_type)


def _decode_packed(
    payload: bytes,
    csharp_type: str,
    data_format: str | None,
    stats: DecodeStats,
) -> list[Any]:
    expected = _scalar_expected_wire(csharp_type)
    if expected not in {0, 1, 5}:
        raise ProtobufDecodeError(f"{csharp_type} is not a packable scalar")
    values: list[Any] = []
    offset = 0
    while offset < len(payload):
        stats.claim_packed_scalar()
        start = offset
        if expected == 0:
            raw, offset = read_varint(payload, offset)
            wire_value = WireValue(1, 0, raw, payload[start:offset])
        else:
            size = 8 if expected == 1 else 4
            end = offset + size
            if end > len(payload):
                raise ProtobufDecodeError("truncated packed scalar")
            raw_bytes = payload[offset:end]
            offset = end
            wire_value = WireValue(1, expected, raw_bytes, payload[start:offset])
        values.append(_decode_primitive(wire_value, csharp_type, data_format))
    return values


def decode_message(
    data: bytes,
    contract_name: str,
    schema: dict[str, Any],
    stats: DecodeStats | None = None,
    *,
    depth: int = 0,
) -> dict[str, Any]:
    if depth > MAX_MESSAGE_DEPTH:
        raise ProtobufDecodeError(f"message nesting exceeds {MAX_MESSAGE_DEPTH}")
    stats = stats or DecodeStats()
    stats.maximum_depth = max(stats.maximum_depth, depth)
    contracts = schema.get("contracts", {})
    contract = contracts.get(contract_name)
    if not isinstance(contract, dict):
        return _bytes_json(data, "protobuf") | {"contract": contract_name}
    field_schemas = contract.get("fields", {})
    result: dict[str, Any] = {}
    unknown: list[dict[str, Any]] = []

    for value in iter_wire_values(data):
        stats.claim_wire_field()
        field_schema = field_schemas.get(str(value.number))
        if not isinstance(field_schema, dict):
            stats.record_unknown(contract_name, value.number)
            unknown.append(_unknown_json(value))
            continue
        stats.known_fields += 1
        field_name = str(field_schema["name"])
        csharp_type = str(field_schema["type"])
        data_format = field_schema.get("dataFormat")
        decoded, repeated = _decode_typed_value(
            value,
            csharp_type,
            schema,
            stats,
            data_format=str(data_format) if data_format else None,
            depth=depth + 1,
        )
        if repeated:
            existing = result.setdefault(field_name, [])
            if not isinstance(existing, list):
                existing = [existing]
                result[field_name] = existing
            existing.extend(decoded if isinstance(decoded, list) else [decoded])
        elif field_name in result:
            stats.duplicate_singular_fields += 1
            duplicates = result.setdefault("__duplicateKnownFields", [])
            assert isinstance(duplicates, list)
            duplicates.append({"name": field_name, "value": decoded})
            result[field_name] = decoded
        else:
            result[field_name] = decoded
    if unknown:
        result["__unknownFields"] = unknown
    return result


def _decode_dictionary_entry(
    payload: bytes,
    key_type: str,
    value_type: str,
    schema: dict[str, Any],
    stats: DecodeStats,
    data_format: str | None,
    depth: int,
) -> tuple[Any, Any]:
    key: Any = None
    mapped_value: Any = None
    unknown: list[dict[str, Any]] = []
    for wire_value in iter_wire_values(payload):
        stats.claim_wire_field()
        if wire_value.number == 1:
            key, _ = _decode_typed_value(
                wire_value, key_type, schema, stats, data_format=data_format, depth=depth + 1
            )
        elif wire_value.number == 2:
            mapped_value, _ = _decode_typed_value(
                wire_value, value_type, schema, stats, data_format=data_format, depth=depth + 1
            )
        else:
            stats.record_unknown(f"Dictionary<{key_type},{value_type}>", wire_value.number)
            unknown.append(_unknown_json(wire_value))
    if unknown:
        mapped_value = {"value": mapped_value, "__unknownFields": unknown}
    return key, mapped_value


def _decode_typed_value(
    value: WireValue,
    csharp_type: str,
    schema: dict[str, Any],
    stats: DecodeStats,
    *,
    data_format: str | None,
    depth: int,
) -> tuple[Any, bool]:
    shape, arguments = type_shape(csharp_type)
    if shape == "dictionary":
        if value.wire_type != 2 or not isinstance(value.value, bytes):
            raise ProtobufDecodeError("dictionary entry used a non length-delimited wire type")
        key, mapped_value = _decode_dictionary_entry(
            value.value, arguments[0], arguments[1], schema, stats, data_format, depth
        )
        return [{"key": key, "value": mapped_value}], True
    if shape == "repeated":
        inner_type = arguments[0]
        expected = _scalar_expected_wire(inner_type)
        if value.wire_type == 2 and expected in {0, 1, 5} and isinstance(value.value, bytes):
            return _decode_packed(value.value, inner_type, data_format, stats), True
        decoded, _ = _decode_typed_value(
            value, inner_type, schema, stats, data_format=data_format, depth=depth
        )
        return [decoded], True

    scalar_type = arguments[0]
    try:
        return _decode_primitive(value, scalar_type, data_format), False
    except KeyError:
        pass

    contract_name = scalar_type if scalar_type in schema.get("contracts", {}) else scalar_type.rsplit(".", 1)[-1]
    if contract_name in schema.get("contracts", {}):
        if value.wire_type != 2 or not isinstance(value.value, bytes):
            raise ProtobufDecodeError(f"message {contract_name} used a non length-delimited wire type")
        return decode_message(value.value, contract_name, schema, stats, depth=depth), False

    # Types not present in the protobuf-contract closure are normally enums.
    if value.wire_type == 0:
        return _json_integer(int(value.value)), False
    if value.wire_type == 2 and isinstance(value.value, bytes):
        return _bytes_json(value.value, "unresolvedProtobuf") | {"type": scalar_type}, False
    if isinstance(value.value, bytes):
        return _bytes_json(value.value, "unresolvedScalar") | {"type": scalar_type}, False
    return _json_integer(int(value.value)), False


def dictionary_entries(value: Any) -> dict[str, Any]:
    """Convert the decoder's lossless dictionary-entry list to a JSON object."""

    if not isinstance(value, list):
        return {}
    result: dict[str, Any] = {}
    for entry in value:
        if not isinstance(entry, dict) or "key" not in entry:
            continue
        result[str(entry["key"])] = entry.get("value")
    return result
