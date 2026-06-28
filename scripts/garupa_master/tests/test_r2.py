from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from scripts.garupa_master.r2 import (
    POINTER_CACHE,
    POINTER_SCHEMA,
    UPLOAD_CHECKPOINT_CACHE,
    UPLOAD_CHECKPOINT_SCHEMA,
    GarupaR2Error,
    garupa_gc_roots,
    pointer_key,
    prune_snapshots,
    publish_snapshot,
    snapshot_manifest_key,
    upload_checkpoint_key,
    verify_snapshot,
)


def stable_json(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode()


def cas_key(digest: str) -> str:
    return f"cas/v1/sha256/{digest[:2]}/{digest}"


class FakeStore:
    """In-memory implementation of the R2Store surface used by the publisher."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.metadata: dict[str, dict[str, Any]] = {}
        self.puts: list[tuple[str, str]] = []
        self.uploads: list[str] = []
        self.gets: list[str] = []
        self.fail_next_upload = False
        self._clock = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def _write(
        self,
        key: str,
        body: bytes,
        *,
        digest: str,
        content_type: str,
    ) -> None:
        self._clock += timedelta(seconds=1)
        self.objects[key] = body
        self.metadata[key] = {
            "ContentLength": len(body),
            "ContentType": content_type,
            "ETag": f'"{hashlib.md5(body, usedforsecurity=False).hexdigest()}"',
            "LastModified": self._clock,
            "Metadata": {"sha256": digest},
        }

    def head(self, key: str) -> dict[str, Any] | None:
        metadata = self.metadata.get(key)
        return dict(metadata) if metadata is not None else None

    def upload_cas(
        self,
        file: Path,
        digest: str,
        content_type: str,
    ) -> None:
        if self.fail_next_upload:
            self.fail_next_upload = False
            raise OSError("injected CAS upload failure")
        body = file.read_bytes()
        if hashlib.sha256(body).hexdigest() != digest:
            raise AssertionError("publisher supplied a mismatched CAS digest")
        key = cas_key(digest)
        self.uploads.append(key)
        self.puts.append(("cas", key))
        self._write(
            key,
            body,
            digest=digest,
            content_type=content_type,
        )

    def put_json(self, key: str, value: Any, cache_control: str) -> None:
        body = stable_json(value)
        digest = hashlib.sha256(body).hexdigest()
        self.puts.append((cache_control, key))
        self._write(
            key,
            body,
            digest=digest,
            content_type="application/json; charset=utf-8",
        )

    def get_bytes(self, key: str) -> bytes | None:
        self.gets.append(key)
        return self.objects.get(key)

    def get_json(self, key: str) -> Any | None:
        body = self.objects.get(key)
        return json.loads(body) if body is not None else None

    def iter_keys(self, prefix: str) -> Iterable[dict[str, Any]]:
        for key in sorted(self.objects):
            if key.startswith(prefix):
                metadata = self.metadata[key]
                yield {
                    "Key": key,
                    "Size": metadata["ContentLength"],
                    "ETag": metadata["ETag"],
                    "LastModified": metadata["LastModified"],
                }

    def delete_prefix(self, prefix: str) -> int:
        keys = [key for key in self.objects if key.startswith(prefix)]
        return self.delete_keys(keys)

    def delete_keys(self, keys: Iterable[str]) -> int:
        deleted = 0
        for key in keys:
            if key in self.objects:
                deleted += 1
                self.objects.pop(key)
                self.metadata.pop(key)
        return deleted


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(stable_json(value))


def write_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)


def make_roots(parent: Path, *, revision: int = 1) -> tuple[Path, Path, Path]:
    archive = parent / "archive"
    schema = parent / "schema"
    projections = parent / "projections"

    write_json(
        archive / "manifest.json",
        {
            "format": "haneoka-garupa-master-archive-v1",
            "fetchedAt": f"2026-01-{revision:02d}T00:00:00Z",
            "revision": revision,
        },
    )
    write_bytes(
        archive / "application" / "response.encrypted",
        b"application-encrypted",
    )
    write_bytes(archive / "application" / "response.pb", b"application-pb")
    write_json(
        archive / "application" / "response.json",
        {"kind": "application"},
    )
    write_bytes(archive / "suite" / "response.encrypted", b"suite-encrypted")
    write_bytes(archive / "suite" / "response.bz2", b"suite-bz2")
    write_bytes(archive / "suite" / "response.pb", b"suite-pb")
    write_json(archive / "suite" / "tables.json", {"tables": [1]})
    write_json(
        archive / "suite" / "schema-coverage.json",
        {"archiveComplete": True},
    )
    write_bytes(
        archive / "suite" / "tables" / "0001-mastermusiclist.pb",
        b"table-pb",
    )
    write_json(
        archive / "suite" / "decoded" / "0001-mastermusiclist.json",
        {"entries": [{"musicId": 1}]},
    )

    write_json(schema / "schema.json", {"format": "schema", "contracts": {}})

    write_json(projections / "manifest.json", {"projectionSha256": "c" * 64})
    write_json(projections / "bands.json", {"bands": []})
    write_json(projections / "songs.json", {"songs": []})
    write_json(
        projections / "stage-challenges.json",
        {"stageChallenges": []},
    )
    write_json(projections / "playlists.json", {"playlists": []})
    return archive, schema, projections


class GarupaR2Tests(unittest.TestCase):
    def test_publish_orders_pointer_last_and_repeated_publish_is_noop(self) -> None:
        store = FakeStore()
        with tempfile.TemporaryDirectory() as directory:
            roots = make_roots(Path(directory))
            first = publish_snapshot(store, *roots)
            pointer_puts_after_first = [
                item
                for item in store.puts
                if item == (POINTER_CACHE, pointer_key("jp"))
            ]
            upload_count = len(store.uploads)
            second = publish_snapshot(store, *roots)

        self.assertTrue(first["changed"])
        self.assertFalse(second["changed"])
        self.assertEqual(first["snapshotId"], second["snapshotId"])
        self.assertGreater(upload_count, 0)
        self.assertEqual(len(store.uploads), upload_count)
        self.assertEqual(
            [
                item
                for item in store.puts
                if item == (POINTER_CACHE, pointer_key("jp"))
            ],
            pointer_puts_after_first,
        )
        pointer_position = store.puts.index((POINTER_CACHE, pointer_key("jp")))
        manifest_position = store.puts.index(
            (
                "public, max-age=31536000, immutable",
                first["manifest"],
            )
        )
        self.assertGreater(pointer_position, manifest_position)
        self.assertTrue(
            all(
                store.puts.index(("cas", key)) < manifest_position
                for key in store.uploads
            )
        )

        verified = verify_snapshot(store)
        self.assertEqual(verified["snapshotId"], first["snapshotId"])
        self.assertEqual(
            verified["objectsChecked"],
            verified["uniqueObjectCount"],
        )

        manifest = store.get_json(first["manifest"])
        first_digest = manifest["files"][0]["sha256"]
        first_key = cas_key(first_digest)
        original = store.objects[first_key]
        store.objects[first_key] = b"corrupt"
        with self.assertRaisesRegex(GarupaR2Error, "CAS content is invalid"):
            verify_snapshot(store)
        store.objects[first_key] = original

    def test_cas_upload_failure_does_not_write_pointer(self) -> None:
        store = FakeStore()
        store.fail_next_upload = True
        with tempfile.TemporaryDirectory() as directory:
            roots = make_roots(Path(directory))
            with self.assertRaisesRegex(OSError, "injected CAS upload failure"):
                publish_snapshot(store, *roots)

        self.assertNotIn(pointer_key("jp"), store.objects)
        self.assertFalse(
            any(
                key.endswith("/manifest.json")
                and "/snapshots/" in key
                for key in store.objects
            )
        )

    def test_prune_retains_current_plus_two_and_cleans_checkpoints(self) -> None:
        store = FakeStore()
        snapshot_ids: list[str] = []
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            roots = make_roots(parent, revision=1)
            for revision in range(1, 5):
                write_json(
                    roots[0] / "manifest.json",
                    {
                        "format": "haneoka-garupa-master-archive-v1",
                        "fetchedAt": f"2026-01-{revision:02d}T00:00:00Z",
                        "revision": revision,
                    },
                )
                result = publish_snapshot(store, *roots)
                snapshot_ids.append(result["snapshotId"])

        stale_snapshot = "m-" + "0" * 20
        stale_digest = "f" * 64
        stale_key = upload_checkpoint_key("jp", stale_snapshot, "ff")
        store.put_json(
            stale_key,
            {
                "schema": UPLOAD_CHECKPOINT_SCHEMA,
                "server": "jp",
                "snapshotId": stale_snapshot,
                "state": "uploading",
                "updatedAt": (
                    datetime.now(timezone.utc) - timedelta(days=9)
                ).isoformat(),
                "shard": "ff",
                "objects": [stale_digest],
            },
            UPLOAD_CHECKPOINT_CACHE,
        )
        fresh_snapshot = "m-" + "1" * 20
        fresh_digest = "e" * 64
        fresh_key = upload_checkpoint_key("jp", fresh_snapshot, "ee")
        store.put_json(
            fresh_key,
            {
                "schema": UPLOAD_CHECKPOINT_SCHEMA,
                "server": "jp",
                "snapshotId": fresh_snapshot,
                "state": "uploading",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "shard": "ee",
                "objects": [fresh_digest],
            },
            UPLOAD_CHECKPOINT_CACHE,
        )

        report = prune_snapshots(store, retain=3)

        self.assertEqual(report["currentSnapshotId"], snapshot_ids[-1])
        self.assertEqual(
            set(report["retainedSnapshotIds"]),
            set(snapshot_ids[-3:]),
        )
        self.assertEqual(set(report["deletedSnapshots"]), {snapshot_ids[0]})
        self.assertNotIn(
            snapshot_manifest_key("jp", snapshot_ids[0]),
            store.objects,
        )
        self.assertNotIn(stale_key, store.objects)
        self.assertIn(fresh_key, store.objects)
        self.assertEqual(report["deletedUploadCheckpoints"], 1)
        self.assertEqual(
            store.get_json(pointer_key("jp")),
            {
                "schema": POINTER_SCHEMA,
                "server": "jp",
                "snapshotId": snapshot_ids[-1],
                "manifest": snapshot_manifest_key("jp", snapshot_ids[-1]),
            },
        )
        _, remaining_manifests, remaining_checkpoints = garupa_gc_roots(store)
        self.assertEqual(
            remaining_manifests,
            {
                snapshot_manifest_key("jp", snapshot_id)
                for snapshot_id in snapshot_ids[-3:]
            },
        )
        self.assertEqual(remaining_checkpoints, {fresh_key: "uploading"})


if __name__ == "__main__":
    unittest.main()
