from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.garupa_master.archive import archive_responses
from scripts.garupa_master.client import (
    ApplicationVersions,
    GarupaResponses,
    remove_iso10126_padding,
)
from scripts.garupa_master.schema import parse_dump_contracts
from scripts.garupa_master.wire import (
    DecodeStats,
    decode_message,
    dictionary_entries,
)


def varint(value: int) -> bytes:
    result = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        result.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(result)


def field(number: int, wire_type: int, value: bytes | int) -> bytes:
    encoded = bytearray(varint((number << 3) | wire_type))
    if wire_type == 0:
        encoded.extend(varint(int(value)))
    elif wire_type == 2:
        assert isinstance(value, bytes)
        encoded.extend(varint(len(value)))
        encoded.extend(value)
    else:
        raise AssertionError("test helper only supports varint and length-delimited fields")
    return bytes(encoded)


TEST_SCHEMA = {
    "contracts": {
        "Root": {
            "fields": {
                "1": {"name": "identifier", "type": "uint"},
                "2": {"name": "names", "type": "string[]"},
                "3": {"name": "values", "type": "uint[]"},
                "4": {"name": "children", "type": "Dictionary<uint, Child>"},
            }
        },
        "Child": {"fields": {"1": {"name": "title", "type": "string"}}},
    }
}


class WireDecoderTests(unittest.TestCase):
    def test_decodes_repeated_packed_and_dictionary_values(self) -> None:
        dictionary_entry = field(1, 0, 7) + field(2, 2, field(1, 2, "七".encode()))
        payload = b"".join(
            [
                field(1, 0, 42),
                field(2, 2, b"first"),
                field(2, 2, b"second"),
                field(3, 2, varint(3) + varint(8) + varint(13)),
                field(4, 2, dictionary_entry),
            ]
        )
        result = decode_message(payload, "Root", TEST_SCHEMA)
        self.assertEqual(result["identifier"], 42)
        self.assertEqual(result["names"], ["first", "second"])
        self.assertEqual(result["values"], [3, 8, 13])
        self.assertEqual(dictionary_entries(result["children"]), {"7": {"title": "七"}})

    def test_preserves_unknown_fields_and_reports_coverage(self) -> None:
        stats = DecodeStats()
        result = decode_message(field(99, 2, b"future"), "Root", TEST_SCHEMA, stats)
        self.assertEqual(stats.unknown_fields, 1)
        self.assertEqual(stats.unknown_by_contract, {"Root": {99}})
        self.assertEqual(result["__unknownFields"][0]["fieldNumber"], 99)
        self.assertEqual(result["__unknownFields"][0]["value"]["length"], 6)
        self.assertEqual(
            result["__unknownFields"][0]["encoded"]["length"],
            len(field(99, 2, b"future")),
        )

class SchemaParserTests(unittest.TestCase):
    def test_parses_properties_public_fields_and_nested_contract_names(self) -> None:
        dump = """
[ProtoContract]
public class Root
{
    [ProtoMember(1)]
    public uint id { get; set; }
    [ProtoMember(2, DataFormat = DataFormat.ZigZag)]
    public List<Root.Child> children;
}
[ProtoContract]
public class Root.Child
{
    [ProtoMember(1)]
    public string name { get; set; }
}
"""
        contracts = parse_dump_contracts(dump)
        self.assertEqual(contracts["Root"]["fields"]["1"], {"name": "id", "type": "uint"})
        self.assertEqual(
            contracts["Root"]["fields"]["2"],
            {"name": "children", "type": "List<Root.Child>", "dataFormat": "ZigZag"},
        )
        self.assertIn("Root.Child", contracts)


class PaddingTests(unittest.TestCase):
    def test_removes_iso10126_padding(self) -> None:
        plaintext = b"payload" + bytes(range(1, 9)) + b"\x09"
        self.assertEqual(len(plaintext), 16)
        self.assertEqual(remove_iso10126_padding(plaintext), b"payload")

class ArchiveCoverageTests(unittest.TestCase):
    def test_duplicate_singular_field_prevents_schema_complete(self) -> None:
        schema = {
            "clientVersion": "1.0.0",
            "roots": {"suite": "Suite"},
            "coverage": {"unresolvedReferencedTypes": []},
            "contracts": {
                "Suite": {"fields": {"1": {"name": "table", "type": "Child"}}},
                "Child": {"fields": {"1": {"name": "identifier", "type": "uint"}}},
            },
        }
        child = field(1, 0, 1) + field(1, 0, 2)
        responses = GarupaResponses(
            application_encrypted=b"application-encrypted",
            application_protobuf=b"application-protobuf",
            application_headers={},
            suite_encrypted=b"suite-encrypted",
            suite_compressed=b"suite-compressed",
            suite_protobuf=field(1, 2, child),
            suite_headers={},
            versions=ApplicationVersions(
                client_version="1.0.0",
                data_version="1.0.0",
                master_data_version="1.0.0",
                decoded={},
            ),
        )
        with TemporaryDirectory() as directory:
            decoded = archive_responses(Path(directory), responses, schema)

        self.assertTrue(decoded.coverage["archiveComplete"])
        self.assertFalse(decoded.coverage["schemaComplete"])
        self.assertEqual(
            decoded.coverage["nested"]["duplicateSingularFieldOccurrences"],
            1,
        )
        self.assertIn("knownTopLevelEncodedByteRatio", decoded.coverage)
        self.assertNotIn("knownByteRatio", decoded.coverage)

if __name__ == "__main__":
    unittest.main()
