"""Bundle-level reuse of Unity extraction outputs from the current release."""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from core.hashes import sha256_file
from core.storage import cas_key

REUSE_SCHEMA = "haneoka-unity-reuse-v1"
EXTRACTOR_SOURCES = ("extract/unity.py", "ingest/bundle_crypto.py")


def extractor_identity() -> str:
    import hashlib

    from core.config import PROJECT_ROOT

    digest = hashlib.sha256()
    for name in EXTRACTOR_SOURCES:
        digest.update(name.encode("utf-8"))
        digest.update((PROJECT_ROOT / "scripts" / name).read_bytes())
    try:
        from importlib.metadata import version

        digest.update(f"UnityPy={version('UnityPy')}".encode("utf-8"))
    except Exception:  # noqa: BLE001 - version metadata is best effort
        pass
    return digest.hexdigest()


def _locales(artifact: dict[str, Any]) -> tuple[str, ...]:
    addressables = artifact.get("addressables") or {}
    values = list(addressables.get("locales") or [])
    if not values:
        values = [str(addressables.get("locale", ""))]
    values = list(dict.fromkeys("" if item == "ja" else item for item in values))
    if "" in values:
        values = [""]
    return tuple(values)


def bundle_context(artifact: dict[str, Any]) -> tuple[Any, ...]:
    return (
        int(artifact.get("bytes") or 0),
        tuple((artifact.get("unity") or {}).get("dependencies") or []),
        _locales(artifact),
        bool(artifact.get("addressables")),
    )


def _release_paths(release: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(entry["path"]): entry
        for entry in release.get("entries", [])
        if isinstance(entry, dict) and entry.get("path")
    }


def prepare_unity_reuse(
    store: Any,
    server: str,
    manifest: dict[str, Any],
    shard_count: int,
    concurrency: int = 32,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    pointer = store.get_json(f"servers/{server}/current.json")
    release_id = str((pointer or {}).get("releaseId") or "")
    stats = {"candidates": 0, "reused": 0, "reports": 0}
    shards: list[dict[str, Any]] = [{} for _ in range(shard_count)]
    if not release_id:
        return shards, stats
    release = store.get_json(f"servers/{server}/releases/{release_id}/release.json")
    if not isinstance(release, dict) or release.get("server") != server:
        return shards, stats
    release_paths = _release_paths(release)
    old_source_id = str(release.get("sourceId") or "")
    old_manifest = store.get_json(f"servers/{server}/sources/{old_source_id}/source.json")
    if not isinstance(old_manifest, dict):
        return shards, stats
    old_contexts = {
        str(item["sha256"]): bundle_context(item)
        for item in old_manifest.get("files", [])
        if isinstance(item, dict) and item.get("role") == "unity-bundle"
    }
    digests: list[tuple[str, dict[str, Any]]] = []
    for item in manifest.get("files", []):
        if not isinstance(item, dict) or item.get("role") != "unity-bundle":
            continue
        digest = str(item["sha256"])
        stats["candidates"] += 1
        if old_contexts.get(digest) == bundle_context(item):
            digests.append((digest, item))

    def build_entry(digest: str) -> tuple[str, dict[str, Any]] | None:
        report_entry = release_paths.get(f"metadata/bundles/{digest}.json")
        archive_entry = release_paths.get(f"objects/unity/{digest}.jsonl.gz")
        if not report_entry or not archive_entry:
            return None
        report = store.get_json(cas_key(report_entry["sha256"]))
        if not isinstance(report, dict) or str((report.get("bundle") or {}).get("sha256")) != digest:
            return None
        media = []
        for source in report.get("sources", []):
            for output in source.get("outputs", []):
                relative = str(output.get("path") or "")
                entry = release_paths.get(relative)
                if (
                    not relative.startswith(("assets/", "runtime/"))
                    or not entry
                    or str(entry.get("sha256")) != str(output.get("sha256"))
                ):
                    return None
                media.append(
                    {"rel": relative, "sha256": str(entry["sha256"]), "bytes": int(entry["bytes"])}
                )
        return digest, {
            "report": {
                "path": report_entry["path"],
                "sha256": str(report_entry["sha256"]),
                "bytes": int(report_entry["bytes"]),
            },
            "archive": {
                "path": archive_entry["path"],
                "sha256": str(archive_entry["sha256"]),
                "bytes": int(archive_entry["bytes"]),
            },
            "media": media,
        }

    with ThreadPoolExecutor(max_workers=max(1, min(int(concurrency), 64))) as executor:
        for result in executor.map(build_entry, [digest for digest, _ in digests]):
            if result is None:
                continue
            digest, entry = result
            shard_index = int(digest[:16], 16) % shard_count
            shards[shard_index][digest] = entry
            stats["reused"] += 1
            stats["reports"] += 1 + len(entry["media"])
    return shards, stats


def load_reuse_manifest(path: Path) -> dict[str, dict[str, Any]]:
    import json

    document = json.loads(path.read_text("utf-8"))
    bundles = document.get("bundles") if isinstance(document, dict) else None
    if document.get("schema") != REUSE_SCHEMA or not isinstance(bundles, dict):
        raise ValueError(f"invalid Unity reuse manifest: {path}")
    if str(document.get("extractor") or "") != extractor_identity():
        raise ValueError(f"Unity reuse manifest was prepared by a different extractor: {path}")
    return bundles


def make_restore(
    store: Any,
    entries: dict[str, dict[str, Any]],
    concurrency: int = 8,
) -> Callable[[str, Path], dict[str, Any] | None]:
    def restore(digest: str, shard_root: Path) -> dict[str, Any] | None:
        import json

        entry = entries.get(digest)
        if entry is None:
            return None
        targets = [
            (entry["report"], shard_root / "metadata" / "bundles" / f"{digest}.json"),
            (entry["archive"], shard_root / "objects" / "unity" / f"{digest}.jsonl.gz"),
            *(
                (item, shard_root / "candidates" / digest / item["rel"])
                for item in entry["media"]
            ),
        ]

        def fetch(pair: tuple[dict[str, Any], Path]) -> None:
            meta, target = pair
            store.download_file(
                cas_key(meta["sha256"]),
                target,
                expected_bytes=meta["bytes"],
                expected_sha256=meta["sha256"],
            )

        try:
            if len(targets) == 1:
                fetch(targets[0])
            else:
                with ThreadPoolExecutor(max_workers=max(1, min(int(concurrency), 12))) as executor:
                    list(executor.map(fetch, targets))
            report = json.loads((shard_root / "metadata" / "bundles" / f"{digest}.json").read_text("utf-8"))
        except Exception as error:  # noqa: BLE001 - fall back to a fresh extraction
            sys.stderr.write(f"warning: Unity reuse failed for {digest}: {error}\n")
            for _, target in targets:
                if target.is_file():
                    target.unlink()
            return None
        if str((report.get("bundle") or {}).get("sha256")) != digest:
            sys.stderr.write(f"warning: Unity reuse report mismatch for {digest}\n")
            (shard_root / "metadata" / "bundles" / f"{digest}.json").unlink()
            return None
        return report

    return restore
