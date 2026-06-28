from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .wire import referenced_types


SCHEMA_FORMAT = "haneoka-garupa-protobuf-schema-v1"
ROOT_CONTRACTS = ("AppGetResponse", "SuiteMasterGetResponse")

CLASS_PATTERN = re.compile(
    r"\[ProtoContract(?:\([^\]]*\))?\]\s*"
    r"(?:\[[^\]]+\]\s*)*"
    r"public\s+(?:sealed\s+|partial\s+|abstract\s+)*class\s+([A-Za-z_][A-Za-z0-9_.]*)[^{]*\{",
    re.MULTILINE,
)
MEMBER_PATTERN = re.compile(
    r"\[ProtoMember\(([^)]*)\)\]\s*"
    r"(?:\[[^\]]+\]\s*)*"
    r"public\s+(?!const\s)([A-Za-z0-9_.$<>,? \[\]]+?)\s+(@?[A-Za-z_][A-Za-z0-9_]*)\s*"
    r"(?:\{\s*get;\s*set;\s*\}|;)",
    re.MULTILINE,
)


class SchemaGenerationError(ValueError):
    """Raised when Il2CppDumper output cannot form an unambiguous schema."""


def _matching_brace(source: str, opening: int) -> int:
    depth = 0
    for index in range(opening, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    raise SchemaGenerationError("unbalanced class braces in dump.cs")


def _proto_member_args(value: str) -> tuple[int, str | None]:
    first, *rest = value.split(",", 1)
    try:
        number = int(first.strip())
    except ValueError as exc:
        raise SchemaGenerationError(f"invalid ProtoMember number: {value}") from exc
    data_format = None
    if rest:
        match = re.search(
            r"DataFormat\s*=\s*DataFormat\.([A-Za-z0-9_]+)",
            rest[0],
        )
        if match:
            data_format = match.group(1)
    return number, data_format


def parse_dump_contracts(source: str) -> dict[str, dict[str, Any]]:
    contracts: dict[str, dict[str, Any]] = {}
    duplicates: dict[str, int] = {}
    for match in CLASS_PATTERN.finditer(source):
        name = match.group(1)
        opening = source.find("{", match.start())
        closing = _matching_brace(source, opening)
        block = source[opening + 1 : closing]
        fields: dict[str, dict[str, Any]] = {}
        for member in MEMBER_PATTERN.finditer(block):
            number, data_format = _proto_member_args(member.group(1))
            csharp_type = " ".join(member.group(2).split())
            field_name = member.group(3).lstrip("@")
            candidate: dict[str, Any] = {
                "name": field_name,
                "type": csharp_type,
            }
            if data_format:
                candidate["dataFormat"] = data_format
            existing = fields.get(str(number))
            if existing is not None and existing != candidate:
                raise SchemaGenerationError(
                    f"{name} has conflicting ProtoMember({number}) declarations: "
                    f"{existing} vs {candidate}"
                )
            fields[str(number)] = candidate
        if not fields:
            continue
        candidate_contract = {
            "fields": dict(
                sorted(fields.items(), key=lambda item: int(item[0]))
            )
        }
        if name in contracts and contracts[name] != candidate_contract:
            duplicates[name] = duplicates.get(name, 1) + 1
            continue
        contracts[name] = candidate_contract
    if duplicates:
        names = ", ".join(
            f"{name} ({count})" for name, count in sorted(duplicates.items())
        )
        raise SchemaGenerationError(
            f"ambiguous duplicate protobuf contracts: {names}"
        )
    return contracts


def _contract_closure(
    contracts: dict[str, dict[str, Any]],
    roots: tuple[str, ...],
) -> tuple[set[str], set[str]]:
    missing_roots = [root for root in roots if root not in contracts]
    if missing_roots:
        raise SchemaGenerationError(
            f"missing root contract(s): {', '.join(missing_roots)}"
        )
    included: set[str] = set()
    unresolved: set[str] = set()
    pending = list(roots)
    while pending:
        name = pending.pop()
        if name in included:
            continue
        contract = contracts.get(name)
        if contract is None:
            unresolved.add(name)
            continue
        included.add(name)
        for field in contract["fields"].values():
            for referenced in referenced_types(str(field["type"])):
                if referenced in contracts and referenced not in included:
                    pending.append(referenced)
                elif referenced not in contracts:
                    unresolved.add(referenced)
    return included, unresolved


def generate_schema(
    dump_path: Path,
    *,
    package_name: str = "jp.co.craftegg.band",
) -> dict[str, Any]:
    source_bytes = dump_path.read_bytes()
    source = source_bytes.decode("utf-8", errors="strict")
    contracts = parse_dump_contracts(source)
    included, unresolved = _contract_closure(contracts, ROOT_CONTRACTS)
    selected = {name: contracts[name] for name in sorted(included)}
    suite_fields = selected["SuiteMasterGetResponse"]["fields"]
    return {
        "format": SCHEMA_FORMAT,
        "packageName": package_name,
        "roots": {
            "application": "AppGetResponse",
            "suite": "SuiteMasterGetResponse",
        },
        "source": {
            "kind": "Il2CppDumper-dump.cs",
            "sha256": hashlib.sha256(source_bytes).hexdigest(),
            "bytes": len(source_bytes),
        },
        "coverage": {
            "contractCount": len(selected),
            "suiteFieldCount": len(suite_fields),
            "suiteFieldNumbers": sorted(int(number) for number in suite_fields),
            "unresolvedReferencedTypes": sorted(unresolved),
        },
        "contracts": selected,
    }


def load_schema(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("format") != SCHEMA_FORMAT:
        raise SchemaGenerationError(f"unsupported schema format in {path}")
    if not isinstance(value.get("contracts"), dict):
        raise SchemaGenerationError(f"schema has no contracts object: {path}")
    return value


def write_schema(path: Path, schema: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = (
        json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=False)
        + "\n"
    )
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(rendered, encoding="utf-8")
    temporary.replace(path)
