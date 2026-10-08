from __future__ import annotations

import os
import re
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from build.catalog_storage import RESOURCE_SPECS, ViewSpec, valid_catalog_route_key
from build.game_client import verify_game_client_release
from build.media import ACTIVE_CONTENT_SUFFIXES, media_type
from core.contracts import (
    ANON_TOKYO_SCHEMA,
    CATALOG_PARTITION_ALGORITHM,
    CATALOG_PARTITION_SHARDS,
    CATALOG_OPTIONAL_RESOURCES,
    CATALOG_PROVENANCE_SCHEMA,
    CATALOG_REQUIRED_RESOURCES,
    CATALOG_RESOURCES,
    CATALOG_STORAGE_SCHEMA,
    CATALOG_SUMMARY_SCHEMA,
    POINTER_SCHEMA,
    RELEASE_SCHEMA,
    RELEASE_IDENTITY_FILENAME,
    release_identity_descriptor,
    RELEASE_TREES,
    SOURCE_INDEX_STORAGE_SCHEMA,
    SPINE_CATALOG_SCHEMA,
    STORY_ASSETS_SCHEMA,
)
from core.hashes import sha256_bytes, sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import (
    release_layout,
    server_layout,
    validate_release_path,
    validate_unity_path,
)
from core.process import walk_files
from core.storage import (
    RELEASE_INDEX_ALGORITHM,
    RELEASE_INDEX_SHARDS,
    fnv1a32_shard,
    release_index_prefix,
)


FORBIDDEN_SEGMENTS = {"legacy", "_unity"}
SHA256 = re.compile(r"^[a-f0-9]{64}$")
KTX2_MAGIC = b"\xabKTX 20\xbb\r\n\x1a\n"
KTX2_ASTC_6X6_UNORM = 165
KTX2_BC7_UNORM = 145
KTX2_HEADER_BYTES = 104
ZLIB_CHUNK_BYTES = 1024 * 1024


def release_entries(root: Path) -> list[dict[str, Any]]:
    jobs: list[tuple[str, str, Path]] = []
    for tree in RELEASE_TREES:
        tree_root = root / tree
        for file in walk_files(tree_root):
            relative = f"{tree}/{file.relative_to(tree_root).as_posix()}"
            if (
                tree in {"assets", "runtime", "objects"}
                and file.suffix.lower() in ACTIVE_CONTENT_SUFFIXES
            ):
                raise ValueError(
                    f"active content is forbidden in public release media: {relative}"
                )
            jobs.append((relative, tree, file))

    def entry(job: tuple[str, str, Path]) -> dict[str, Any]:
        relative, tree, file = job
        return {
            "path": relative,
            "role": tree,
            "bytes": file.stat().st_size,
            "sha256": sha256_file(file),
            "mediaType": media_type(file),
        }

    # Hashing is IO-bound per file (hashlib releases the GIL between chunks);
    # a release carries six figures of small objects, so a serial pass here
    # used to dominate build-release.
    with ThreadPoolExecutor(max_workers=max(1, min(16, len(jobs) or 1))) as executor:
        entries = list(executor.map(entry, jobs))
    return sorted(entries, key=lambda item: item["path"])


def describe_release(root: Path, server: str, source_id: str) -> dict[str, Any]:
    entries = release_entries(root)
    identity = {
        "schema": RELEASE_SCHEMA,
        "server": server,
        "sourceId": source_id,
        "entries": entries,
    }
    release_id = f"r-{sha256_bytes(stable_json(identity))[:20]}"
    return {
        **identity,
        "releaseId": release_id,
        "entryCount": len(entries),
        "totalBytes": sum(item["bytes"] for item in entries),
    }


def write_release_manifest(root: Path, server: str, source_id: str) -> dict[str, Any]:
    manifest = describe_release(root, server, source_id)
    write_json(root / "release.json", manifest, pretty=True)
    write_json(
        root / RELEASE_IDENTITY_FILENAME,
        release_identity_descriptor(server, manifest["releaseId"], manifest),
    )
    return manifest


def write_release_identity_files(
    root: Path, server: str, source_id: str, entries: list[dict[str, Any]]
) -> dict[str, Any]:
    """Write a release manifest from precomputed entries (delta composition)."""

    identity = {
        "schema": RELEASE_SCHEMA,
        "server": server,
        "sourceId": source_id,
        "entries": entries,
    }
    manifest = {
        **identity,
        "releaseId": f"r-{sha256_bytes(stable_json(identity))[:20]}",
        "entryCount": len(entries),
        "totalBytes": sum(item["bytes"] for item in entries),
    }
    write_json(root / "release.json", manifest, pretty=True)
    write_json(
        root / RELEASE_IDENTITY_FILENAME,
        release_identity_descriptor(server, manifest["releaseId"], manifest),
    )
    return manifest


def _forbidden_path(value: str) -> bool:
    parts = value.split("/")
    return any(
        part.lower() in FORBIDDEN_SEGMENTS or part.lower().endswith("_rip")
        for part in parts
    )


def _expected_release_id(manifest: dict[str, Any]) -> str:
    identity = {
        "schema": manifest.get("schema"),
        "server": manifest.get("server"),
        "sourceId": manifest.get("sourceId"),
        "entries": manifest.get("entries"),
    }
    return f"r-{sha256_bytes(stable_json(identity))[:20]}"


def _catalog_resource_errors(root: Path, server: str, declared: set[str]) -> list[str]:
    """Reject legacy URLs and verify every release-local API resource exactly."""
    errors: list[str] = []
    api_root = root / "api" / "v1" / "catalog"
    asset_prefix = f"/assets/{server}/"
    runtime_prefix = f"/runtime/{server}/"

    def verify_value(value: Any, source: str) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                verify_value(item, f"{source}.{key}")
            return
        if isinstance(value, list):
            for index, item in enumerate(value):
                verify_value(item, f"{source}[{index}]")
            return
        if not isinstance(value, str):
            return

        raw_path = urlsplit(value).path
        relative: str | None = None
        tree: str | None = None
        public_url = False
        if raw_path.startswith("/asset/") or raw_path.startswith("/api/assets/"):
            errors.append(f"legacy resource URL in {source}: {value}")
            return
        if raw_path.startswith("/assets/"):
            if not raw_path.startswith(asset_prefix):
                errors.append(f"cross-server or legacy asset URL in {source}: {value}")
                return
            relative = unquote(raw_path.removeprefix(asset_prefix))
            if not relative.startswith(("Assets/", "Packages/")):
                errors.append(f"non-canonical Unity asset URL in {source}: {value}")
                return
            tree = "assets"
            public_url = True
        elif raw_path.startswith("/runtime/"):
            if not raw_path.startswith(runtime_prefix):
                errors.append(f"cross-server runtime URL in {source}: {value}")
                return
            relative = unquote(raw_path.removeprefix(runtime_prefix))
            tree = "runtime"
            public_url = True
        elif value.startswith(("Assets/", "Packages/")):
            relative = value
            tree = "assets"
        elif value.startswith("runtime/"):
            relative = value.removeprefix("runtime/")
            tree = "runtime"

        if relative is None or tree is None:
            return
        if _forbidden_path(relative):
            errors.append(f"legacy resource path in {source}: {value}")
            return
        try:
            release_path = validate_release_path(f"{tree}/{relative}")
        except ValueError as error:
            errors.append(f"{source}: {error}")
            return
        # The manifest comparison is deliberately case-sensitive. Path.is_file()
        # alone is insufficient on the default macOS filesystem and could let an
        # all-lowercase legacy URL resolve to the canonical Unity path.
        if public_url and release_path not in declared:
            errors.append(
                f"catalog resource does not resolve exactly in {source}: {value}"
            )

    for file in sorted(api_root.rglob("*.json")):
        try:
            document = read_json(file)
        except Exception as error:
            errors.append(f"invalid catalog JSON {file.name}: {error}")
            continue
        verify_value(document, file.relative_to(root).as_posix())
    return errors


def _variant_release_path(value: Any, server: str) -> tuple[str | None, str | None]:
    """Resolve a rewritten resource URL to the release manifest namespace."""

    if not isinstance(value, str):
        return None, "resource URL must be a string"
    raw_path = urlsplit(value).path
    asset_prefix = f"/assets/{server}/"
    runtime_prefix = f"/runtime/{server}/"
    if raw_path.startswith(asset_prefix):
        relative = unquote(raw_path.removeprefix(asset_prefix))
        tree = "assets"
    elif raw_path.startswith(runtime_prefix):
        relative = unquote(raw_path.removeprefix(runtime_prefix))
        tree = "runtime"
    elif value.startswith("assets/"):
        relative = value.removeprefix("assets/")
        tree = "assets"
    elif value.startswith("runtime/"):
        relative = value.removeprefix("runtime/")
        tree = "runtime"
    else:
        return None, f"resource URL is outside the {server} release: {value}"
    try:
        return validate_release_path(f"{tree}/{relative}"), None
    except ValueError as error:
        return None, str(error)


def _validate_zlib_level(
    file: Path,
    offset: int,
    length: int,
    expected_uncompressed: int,
) -> None:
    """Validate a BC7 zlib level without allocating an unbounded buffer."""

    decoder = zlib.decompressobj()
    produced = 0
    remaining = length
    try:
        with file.open("rb") as stream:
            stream.seek(offset)
            while remaining:
                chunk = stream.read(min(ZLIB_CHUNK_BYTES, remaining))
                if not chunk:
                    raise ValueError("KTX2 zlib level is truncated")
                remaining -= len(chunk)
                pending = chunk
                while pending:
                    if decoder.eof:
                        raise ValueError("KTX2 zlib level has trailing bytes")
                    limit = min(
                        ZLIB_CHUNK_BYTES,
                        max(1, expected_uncompressed - produced + 1),
                    )
                    output = decoder.decompress(pending, limit)
                    produced += len(output)
                    if produced > expected_uncompressed:
                        raise ValueError(
                            "KTX2 zlib level exceeds declared uncompressed size"
                        )
                    if decoder.unused_data:
                        raise ValueError("KTX2 zlib level has trailing bytes")
                    pending = decoder.unconsumed_tail
    except zlib.error as error:
        raise ValueError(f"KTX2 zlib level is invalid: {error}") from error
    if not decoder.eof:
        raise ValueError("KTX2 zlib level is incomplete")
    if produced != expected_uncompressed:
        raise ValueError(
            "KTX2 zlib level size does not match dimensions: "
            f"expected {expected_uncompressed}, got {produced}"
        )


def _native_variant_file_errors(
    root: Path,
    server: str,
    declared: set[str],
    manifest_entries: dict[str, dict[str, Any]],
    verified_absent: set[str] | None = None,
) -> list[str]:
    """Check the authoritative Live2D metadata and KTX2 manifest closure.

    Only ``metadata/live2d.json`` owns this optional table.  Catalog JSON is
    already checked by the normal resource closure, and scanning it again made
    every large KTX2 payload eligible for duplicate validation.

    ``verified_absent`` lists delta-composed entries whose bytes stay in the
    base release; a variant source covered by one is trusted for container
    validation because its sha256 and byte length match the base manifest.
    """

    metadata_file = root / "metadata" / "live2d.json"
    if not metadata_file.is_file():
        return []
    errors: list[str] = []
    try:
        document = read_json(metadata_file)
    except Exception as error:
        return [
            f"invalid Live2D metadata while checking native texture variants: {error}"
        ]
    if not isinstance(document, dict):
        return ["Live2D metadata must be an object"]
    models = document.get("models")
    if not isinstance(models, dict):
        return ["Live2D metadata models must be an object"]

    # Header/index validation is cached by release path.  In particular, do
    # not read the compressed multi-megabyte level again for a second metadata
    # reference or for a second model that happens to share an artifact.
    validated_paths: dict[str, tuple[int, ...] | None] = {}

    def container_flip_y(file: Path, header: bytes) -> bool:
        offset = int.from_bytes(header[56:60], "little")
        length = int.from_bytes(header[60:64], "little")
        if not length:
            return False
        if (
            offset < KTX2_HEADER_BYTES
            or length > 65536
            or offset + length > file.stat().st_size
        ):
            raise ValueError("KTX2 metadata range is invalid")
        with file.open("rb") as stream:
            stream.seek(offset)
            metadata = stream.read(length)
        orientation = "rd"
        cursor = 0
        seen_orientation = False
        while cursor < length:
            if cursor + 4 > length:
                raise ValueError("KTX2 metadata entry is truncated")
            size = int.from_bytes(metadata[cursor : cursor + 4], "little")
            cursor += 4
            if not size or cursor + size > length:
                raise ValueError("KTX2 metadata entry length is invalid")
            key, separator, value = metadata[cursor : cursor + size].partition(b"\0")
            if not separator:
                raise ValueError("KTX2 metadata key is invalid")
            if key == b"KTXorientation":
                if seen_orientation:
                    raise ValueError("KTX2 orientation is repeated")
                seen_orientation = True
                orientation = value.rstrip(b"\0").decode("ascii")
            cursor += (size + 3) & ~3
            if cursor > length:
                raise ValueError("KTX2 metadata padding is truncated")
        if orientation not in {"ru", "rd"}:
            raise ValueError("KTX2 orientation is unsupported")
        return orientation == "ru"

    def validate_container(
        source_path: str,
        variant: dict[str, Any],
        location: str,
    ) -> None:
        source_entry = manifest_entries.get(source_path)
        if source_entry is None or source_path not in declared:
            errors.append(f"{location}.source is absent from release: {source_path}")
            return
        source_file = root / Path(*PurePosixPath(source_path).parts)
        if not source_file.is_file():
            if verified_absent and source_path in verified_absent:
                # Delta-composed from the base release: the container bytes
                # matched the base manifest entry, which passed full
                # verification when the base release was promoted.
                return
            errors.append(f"{location}.source is absent from release: {source_path}")
            return
        byte_length = variant.get("byteLength")
        if source_file.stat().st_size != byte_length:
            errors.append(
                f"{location}.byteLength does not match release file: {source_path}"
            )
        if source_entry.get("bytes") != byte_length:
            errors.append(
                f"{location}.byteLength does not match release manifest: {source_path}"
            )
        if source_entry.get("sha256") != variant.get("sha256"):
            errors.append(
                f"{location}.sha256 does not match release manifest: {source_path}"
            )
        format_name = variant.get("format")
        width_value = variant.get("width")
        height_value = variant.get("height")
        if (
            format_name not in {"astc6x6", "bc7"}
            or not isinstance(width_value, int)
            or isinstance(width_value, bool)
            or width_value <= 0
            or not isinstance(height_value, int)
            or isinstance(height_value, bool)
            or height_value <= 0
        ):
            return
        cached = validated_paths.get(source_path)
        if source_path not in validated_paths:
            cached = None
            if source_file.suffix.casefold() != ".ktx2":
                errors.append(
                    f"{location}.source has unsupported container suffix: {source_path}"
                )
            elif source_file.stat().st_size < KTX2_HEADER_BYTES:
                errors.append(
                    f"{location}.source is a truncated KTX2 container: {source_path}"
                )
            else:
                with source_file.open("rb") as stream:
                    header = stream.read(KTX2_HEADER_BYTES)
                if len(header) < KTX2_HEADER_BYTES or header[:12] != KTX2_MAGIC:
                    errors.append(
                        f"{location}.source is not a KTX2 container: {source_path}"
                    )
                else:
                    cached = (
                        int.from_bytes(header[12:16], "little"),
                        int.from_bytes(header[16:20], "little"),
                        int.from_bytes(header[20:24], "little"),
                        int.from_bytes(header[24:28], "little"),
                        int.from_bytes(header[28:32], "little"),
                        int.from_bytes(header[32:36], "little"),
                        int.from_bytes(header[36:40], "little"),
                        int.from_bytes(header[40:44], "little"),
                        int.from_bytes(header[44:48], "little"),
                        int.from_bytes(header[80:88], "little"),
                    ) + (
                        int.from_bytes(header[88:96], "little"),
                        int.from_bytes(header[96:104], "little"),
                    )
                    (
                        vk_format,
                        type_size,
                        width,
                        height,
                        pixel_depth,
                        layer_count,
                        face_count,
                        levels,
                        scheme,
                        offset,
                        length,
                        uncompressed,
                    ) = cached
                    if type_size != 1:
                        errors.append(
                            f"{location}.source KTX2 typeSize must be 1: {source_path}"
                        )
                    if pixel_depth != 0 or layer_count != 0 or face_count != 1:
                        errors.append(
                            f"{location}.source KTX2 must describe one 2D non-array, non-cubemap texture: {source_path}"
                        )
                    max_levels = max(width, height).bit_length()
                    if levels < 1 or levels > max_levels or (vk_format != KTX2_ASTC_6X6_UNORM and levels != 1):
                        errors.append(
                            f"{location}.source KTX2 mip count is invalid: {source_path}"
                        )
                    elif vk_format == KTX2_ASTC_6X6_UNORM:
                        # Original Unity ASTC pages can carry mip chains. Check
                        # every index entry without decoding or re-encoding them.
                        index_end = 80 + 24 * levels
                        with source_file.open("rb") as stream:
                            stream.seek(80)
                            level_index = stream.read(24 * levels)
                        ranges = []
                        if len(level_index) != 24 * levels:
                            errors.append(f"{location}.source KTX2 mip index is truncated: {source_path}")
                        else:
                            for level in range(levels):
                                entry = level_index[24 * level : 24 * (level + 1)]
                                mip_offset = int.from_bytes(entry[:8], "little")
                                mip_length = int.from_bytes(entry[8:16], "little")
                                mip_uncompressed = int.from_bytes(entry[16:24], "little")
                                mip_width, mip_height = max(1, width >> level), max(1, height >> level)
                                expected_size = ((mip_width + 5) // 6) * ((mip_height + 5) // 6) * 16
                                if (mip_offset < index_end or mip_offset + mip_length > source_file.stat().st_size
                                        or mip_length != expected_size or mip_uncompressed != expected_size):
                                    errors.append(f"{location}.source ASTC mip-{level} range or size is invalid: {source_path}")
                                ranges.append((mip_offset, mip_offset + mip_length))
                            ranges.sort()
                            if any(left[1] > right[0] for left, right in zip(ranges, ranges[1:])):
                                errors.append(f"{location}.source KTX2 mip ranges overlap: {source_path}")
                    if (
                        offset < KTX2_HEADER_BYTES
                        or length <= 0
                        or offset + length > source_file.stat().st_size
                    ):
                        errors.append(
                            f"{location}.source KTX2 level-0 range is invalid: {source_path}"
                        )
                    try:
                        flip_y = container_flip_y(source_file, header)
                        cached += (int(flip_y),)
                    except (ValueError, UnicodeDecodeError) as error:
                        errors.append(f"{location}.source {error}: {source_path}")
                        cached = None
            validated_paths[source_path] = cached
        if cached is not None:
            (
                vk_format,
                type_size,
                width,
                height,
                pixel_depth,
                layer_count,
                face_count,
                levels,
                scheme,
                offset,
                length,
                uncompressed,
                flip_y,
            ) = cached
            mip_count = variant.get("mipCount", levels)
            if not isinstance(mip_count, int) or isinstance(mip_count, bool) or mip_count != levels:
                errors.append(f"{location}.mipCount does not match KTX2 header: {source_path}")
            if variant.get("flipY") is not bool(flip_y):
                errors.append(
                    f"{location}.flipY does not match KTX2 orientation: {source_path}"
                )
            expected_vk = (
                KTX2_ASTC_6X6_UNORM if format_name == "astc6x6" else KTX2_BC7_UNORM
            )
            expected_scheme = 0 if format_name == "astc6x6" else 3
            expected_uncompressed = (
                ((width_value + 5) // 6) * ((height_value + 5) // 6) * 16
                if format_name == "astc6x6"
                else ((width_value + 3) // 4) * ((height_value + 3) // 4) * 16
            )
            if vk_format != expected_vk:
                errors.append(
                    f"{location}.source KTX2 vkFormat does not match {format_name}: {source_path}"
                )
            if scheme != expected_scheme:
                errors.append(
                    f"{location}.source KTX2 supercompression does not match {format_name}: {source_path}"
                )
            if uncompressed != expected_uncompressed:
                errors.append(
                    f"{location}.source KTX2 level size does not match dimensions: {source_path}"
                )
            if format_name == "astc6x6" and length != expected_uncompressed:
                errors.append(
                    f"{location}.source ASTC level-0 size is invalid: {source_path}"
                )
            if (
                format_name == "bc7"
                and scheme == 3
                and offset >= KTX2_HEADER_BYTES
                and length > 0
                and offset + length <= source_file.stat().st_size
            ):
                try:
                    _validate_zlib_level(
                        source_file,
                        offset,
                        length,
                        expected_uncompressed,
                    )
                except ValueError as error:
                    errors.append(
                        f"{location}.source BC7 zlib level is invalid: {error}: {source_path}"
                    )
            if (width, height) != (variant.get("width"), variant.get("height")):
                errors.append(
                    f"{location}.source KTX2 dimensions do not match metadata: {source_path}"
                )

    for model_key, model in models.items():
        location = f"metadata/live2d.json.models[{model_key!r}]"
        if not isinstance(model, dict):
            continue
        runtime = model.get("runtime")
        if not isinstance(runtime, dict):
            continue
        variants = runtime.get("textureVariants")
        if variants is None:
            continue
        textures = runtime.get("textures")
        if not isinstance(textures, list):
            errors.append(f"{location}.runtime.textures must be an array")
            textures = []
        if not isinstance(variants, list):
            errors.append(f"{location}.runtime.textureVariants must be an array")
            continue
        seen: set[tuple[int, str]] = set()
        for item_index, variant in enumerate(variants):
            item_location = f"{location}.runtime.textureVariants[{item_index}]"
            if not isinstance(variant, dict):
                errors.append(f"{item_location} must be an object")
                continue
            texture_index = variant.get("textureIndex")
            format_name = variant.get("format")
            identity = (
                texture_index
                if isinstance(texture_index, int)
                and not isinstance(texture_index, bool)
                else -1,
                str(format_name),
            )
            if (
                not isinstance(texture_index, int)
                or isinstance(texture_index, bool)
                or texture_index < 0
                or texture_index >= len(textures)
            ):
                errors.append(f"{item_location}.textureIndex is invalid")
            if format_name not in {"astc6x6", "bc7"}:
                errors.append(f"{item_location}.format must be astc6x6 or bc7")
            if identity in seen:
                errors.append(f"{item_location} duplicates textureIndex/format")
            else:
                seen.add(identity)
            if (
                isinstance(texture_index, int)
                and 0 <= texture_index < len(textures)
                and variant.get("texture") != textures[texture_index]
            ):
                errors.append(
                    f"{item_location}.texture does not match runtime.textures[{texture_index}]"
                )
            if variant.get("container") != "ktx2":
                errors.append(f"{item_location}.container must be ktx2")
            for field in ("width", "height", "byteLength"):
                value = variant.get(field)
                if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                    errors.append(f"{item_location}.{field} is invalid")
            if not isinstance(variant.get("flipY"), bool):
                errors.append(f"{item_location}.flipY must be a boolean")
            for field in ("sha256", "sourceTextureSha256"):
                if not isinstance(variant.get(field), str) or not SHA256.fullmatch(
                    variant[field]
                ):
                    errors.append(f"{item_location}.{field} is invalid")
            if "cacheKey" in variant and (
                not isinstance(variant.get("cacheKey"), str)
                or not SHA256.fullmatch(variant["cacheKey"])
            ):
                errors.append(f"{item_location}.cacheKey is invalid")
            texture_path, texture_error = _variant_release_path(
                variant.get("texture"), server
            )
            source_path, source_error = _variant_release_path(
                variant.get("source"), server
            )
            if texture_error:
                errors.append(f"{item_location}.texture: {texture_error}")
            if source_error:
                errors.append(f"{item_location}.source: {source_error}")
            if texture_path is None or source_path is None:
                continue
            if texture_path not in declared:
                errors.append(
                    f"{item_location}.texture is absent from release: {texture_path}"
                )
            elif manifest_entries.get(texture_path, {}).get("sha256") != variant.get(
                "sourceTextureSha256"
            ):
                errors.append(
                    f"{item_location}.sourceTextureSha256 does not match canonical PNG: {texture_path}"
                )
            if not source_path.startswith("runtime/live2d/"):
                errors.append(
                    f"{item_location}.source is outside runtime/live2d: {source_path}"
                )
            validate_container(source_path, variant, item_location)
    return errors


def _partition_errors(
    root: Path,
    declared: set[str],
    descriptor: Any,
    prefix: str,
    label: str,
    *,
    catalog_route_keys: bool = False,
    relation_value_mode: str | None = None,
    entity_keys: set[str] | None = None,
) -> tuple[list[str], int, int, set[str], set[str]]:
    errors: list[str] = []
    if not isinstance(descriptor, dict):
        return [f"{label} partition descriptor must be an object"], 0, 0, set(), set()
    if descriptor.get("algorithm") != CATALOG_PARTITION_ALGORITHM:
        errors.append(f"{label} has an unexpected partition algorithm")
    if descriptor.get("prefix") != prefix:
        errors.append(f"{label} has a non-canonical partition prefix")
    count = descriptor.get("count")
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        errors.append(f"{label} has an invalid record count")
        count = 0
    shards = descriptor.get("shards")
    if (
        not isinstance(shards, list)
        or any(
            not isinstance(shard, str) or not re.fullmatch(r"[a-f0-9]{2}", shard)
            for shard in shards
        )
        or shards != sorted(set(shards))
    ):
        errors.append(f"{label} has an invalid shard list")
        return errors, int(count), 0, set(), set()
    if (count == 0) != (len(shards) == 0):
        errors.append(f"{label} has an invalid empty partition")
    found: set[str] = set()
    paths: set[str] = set()
    nested_count = 0
    for shard in shards:
        relative = f"{prefix}{shard}.json"
        paths.add(relative)
        if relative not in declared:
            errors.append(f"{label} shard is absent from release manifest: {relative}")
            continue
        file = root.joinpath(*relative.split("/"))
        try:
            document = read_json(file)
        except Exception as error:
            errors.append(f"invalid {label} shard {relative}: {error}")
            continue
        if not isinstance(document, dict):
            errors.append(f"{label} shard must be an object: {relative}")
            continue
        for key, value in document.items():
            if not isinstance(key, str) or not key:
                errors.append(f"{label} shard contains an invalid key: {relative}")
                continue
            if catalog_route_keys and not valid_catalog_route_key(key):
                errors.append(f"{label} shard contains a non-routable key: {key}")
            if fnv1a32_shard(key, CATALOG_PARTITION_SHARDS) != shard:
                errors.append(f"{label} record is in the wrong shard: {key}")
            if key in found:
                errors.append(f"{label} contains a duplicate key: {key}")
            found.add(key)
            related_ids: list[str] | None = None
            if relation_value_mode == "records":
                if not isinstance(value, dict):
                    errors.append(f"{label} relation value must be an object: {key}")
                elif any(
                    not valid_catalog_route_key(identifier) for identifier in value
                ):
                    errors.append(
                        f"{label} relation contains an invalid entity id: {key}"
                    )
                else:
                    related_ids = list(value)
            elif relation_value_mode == "ids":
                if (
                    not isinstance(value, list)
                    or any(
                        not valid_catalog_route_key(identifier) for identifier in value
                    )
                    or value != sorted(set(value))
                ):
                    errors.append(f"{label} relation id list is invalid: {key}")
                else:
                    related_ids = value
            if related_ids is not None:
                nested_count += len(related_ids)
                if entity_keys is not None:
                    missing = sorted(set(related_ids) - entity_keys)
                    if missing:
                        errors.append(
                            f"{label} references unknown entities: {missing[:10]}"
                        )
    if len(found) != count:
        errors.append(f"{label} record count mismatch: {len(found)} != {count}")
    return errors, int(count), nested_count, paths, found


def _catalog_nested(value: Any, path: tuple[str, ...]) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _view_index_errors(
    value: Any,
    view: ViewSpec,
    expected_shape: str,
    entity_keys: set[str],
    label: str,
) -> list[str]:
    errors: list[str] = []
    if expected_shape == "array":
        if not isinstance(value, list):
            return [f"{label} index must be an array"]
        rows = value
    elif expected_shape == "object":
        if not isinstance(value, dict):
            return [f"{label} index must be an object"]
        rows = list(value.values())
    else:
        return [f"{label} has an invalid index shape"]
    found: set[str] = set()
    allowed = set(view.projection.include or ())
    for row in rows:
        if not isinstance(row, dict):
            errors.append(f"{label} index contains a non-object row")
            continue
        if view.projection.include is not None and not set(row).issubset(allowed):
            errors.append(f"{label} index contains fields outside its projection")
        if any(field in row for field in view.projection.exclude):
            errors.append(f"{label} index contains an excluded field")
        identifier = ""
        for path in view.id_fields:
            candidate = _catalog_nested(row, path)
            if isinstance(candidate, (str, int)) and not isinstance(candidate, bool):
                identifier = str(candidate)
                break
        if not valid_catalog_route_key(identifier):
            errors.append(f"{label} index row has no routable stable id")
            continue
        if identifier in found:
            errors.append(f"{label} index contains a duplicate entity id: {identifier}")
        found.add(identifier)
    if found != entity_keys:
        missing = sorted(entity_keys - found)
        extra = sorted(found - entity_keys)
        errors.append(
            f"{label} index/entity id mismatch: missing={missing[:10]}, extra={extra[:10]}"
        )
    return errors


def _story_assets_index_errors(
    document: Any,
    server: str,
    source_id: str,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(document, dict):
        return ["story-assets index must be an object"]
    if (
        document.get("schema") != STORY_ASSETS_SCHEMA
        or document.get("server") != server
        or document.get("sourceId") != source_id
    ):
        errors.append("story-assets identity does not match the release")
    expected = {
        "backgrounds": ("background", None, None),
        "stills": ("still", None, None),
        "frames": ("frame", None, None),
        "effects": ("effect", None, None),
        "postEffects": ("post-effect", None, None),
        "videos": ("video", None, None),
        "bgms": ("bgm", 0, "Bgm"),
        "soundEffects": ("sound-effect", 1, "Se"),
        "voices": ("voice", 2, "Voice"),
    }
    counts = document.get("counts")
    if not isinstance(counts, dict) or set(counts) != set(expected):
        errors.append("story-assets counts do not match the collection contract")
        counts = {}
    all_ids: set[str] = set()
    for collection, (kind, category, category_name) in expected.items():
        entities = document.get(collection)
        if not isinstance(entities, dict):
            errors.append(f"story-assets collection is invalid: {collection}")
            continue
        if counts.get(collection) != len(entities):
            errors.append(f"story-assets collection count mismatch: {collection}")
        for asset_id, entity in entities.items():
            if (
                not valid_catalog_route_key(asset_id)
                or not isinstance(entity, dict)
                or entity.get("assetId") != asset_id
                or entity.get("kind") != kind
            ):
                errors.append(
                    f"story-assets entity identity is invalid: {collection}/{asset_id}"
                )
                continue
            if asset_id in all_ids:
                errors.append(f"story-assets entity id is repeated: {asset_id}")
            all_ids.add(asset_id)
            if category is not None and (
                entity.get("category") != category
                or entity.get("categoryName") != category_name
                or entity.get("declaredCategoryCode") != category
                or entity.get("declaredCategory") != category_name
            ):
                errors.append(
                    f"story-assets audio category is invalid: {collection}/{asset_id}"
                )
    return errors


def _anon_tokyo_index_errors(
    document: Any,
    server: str,
    source_id: str,
) -> list[str]:
    """Validate the stable availability and localization shell for Anon Tokyo."""

    errors: list[str] = []
    if not isinstance(document, dict):
        return ["anon-tokyo index must be an object"]
    if (
        document.get("schema") != ANON_TOKYO_SCHEMA
        or document.get("server") != server
        or document.get("sourceId") != source_id
    ):
        errors.append("anon-tokyo identity does not match the release")
    if not isinstance(document.get("available"), bool) or not isinstance(
        document.get("reason"), str
    ):
        errors.append("anon-tokyo availability contract is invalid")
    localization = document.get("localization")
    slots = localization.get("localeSlots") if isinstance(localization, dict) else None
    if (
        not isinstance(slots, list)
        or len(slots) != 5
        or [slot.get("index") for slot in slots if isinstance(slot, dict)]
        != list(range(5))
        or any(
            not isinstance(slot, dict)
            or not isinstance(slot.get("locale"), str)
            or not isinstance(slot.get("masterField"), str)
            for slot in slots
        )
        or not isinstance(localization, dict)
        or localization.get("textFallback") != "none"
        or localization.get("imageFallback") != "none"
    ):
        errors.append("anon-tokyo localization contract is invalid")
    source_table_counts = document.get("sourceTableCounts")
    source_tables = document.get("sourceTables")
    if not isinstance(source_table_counts, dict):
        errors.append("anon-tokyo source table counts are invalid")
    if not isinstance(source_tables, dict) or (
        isinstance(source_table_counts, dict)
        and set(source_tables) != set(source_table_counts)
    ):
        errors.append("anon-tokyo raw source table contract is invalid")
    elif isinstance(source_table_counts, dict):
        for table, count in source_table_counts.items():
            source_table = source_tables.get(table)
            rows = source_table.get("rows") if isinstance(source_table, dict) else None
            fields = (
                source_table.get("fields") if isinstance(source_table, dict) else None
            )
            if (
                not isinstance(table, str)
                or not table.startswith("MasterAT")
                or not isinstance(count, int)
                or count < 0
                or not isinstance(source_table, dict)
                or source_table.get("count") != count
                or not isinstance(rows, list)
                or len(rows) != count
                or not isinstance(fields, list)
                or any(not isinstance(field, str) for field in fields)
            ):
                errors.append(f"anon-tokyo raw source table is invalid: {table}")
    spine = document.get("spine")
    if (
        not isinstance(spine, dict)
        or not isinstance(spine.get("available"), bool)
        or spine.get("status") not in {"available", "unavailable"}
        or not isinstance(spine.get("reason"), str)
        or not isinstance(spine.get("models"), dict)
        or not isinstance(spine.get("unavailableModels"), dict)
        or not isinstance(spine.get("renderRecipes"), dict)
        or not isinstance(spine.get("unavailableRenderRecipes"), dict)
    ):
        errors.append("anon-tokyo spine availability contract is invalid")
    if not document.get("available"):
        return errors
    required_sections = {
        "characters",
        "avatars",
        "goods",
        "shop",
        "themes",
        "stages",
        "tasks",
        "progression",
        "staffing",
        "dialogue",
        "guides",
        "map",
        "counts",
        "sourceTables",
    }
    missing = sorted(name for name in required_sections if name not in document)
    if missing:
        errors.append(f"anon-tokyo available document is missing sections: {missing}")

    def records(value: Any, prefix: str, label: str) -> None:
        if not isinstance(value, dict):
            errors.append(f"anon-tokyo {label} records are invalid")
            return
        for identity, entity in value.items():
            if (
                not isinstance(identity, str)
                or not identity.startswith(prefix)
                or not isinstance(entity, dict)
                or entity.get("id") != identity
                or "rawId" not in entity
            ):
                errors.append(f"anon-tokyo {label} identity is invalid: {identity}")

    records(document.get("characters"), "at-character-", "characters")
    goods = document.get("goods")
    if not isinstance(goods, dict):
        errors.append("anon-tokyo goods section is invalid")
    else:
        records(goods.get("items"), "at-good-", "goods")
        records(goods.get("reloading"), "at-reloading-", "reloading")
    shop = document.get("shop")
    if not isinstance(shop, dict):
        errors.append("anon-tokyo shop section is invalid")
    else:
        records(shop.get("decorations"), "at-decoration-", "decorations")
    maps = document.get("map")
    if not isinstance(maps, dict):
        errors.append("anon-tokyo map section is invalid")
    else:
        records(maps.get("configs"), "at-map-", "map configs")
    return errors


def _spine_index_errors(
    document: Any,
    server: str,
    source_id: str,
) -> list[str]:
    """Validate the partitioned Spine collection's small browse index."""

    errors: list[str] = []
    if not isinstance(document, dict):
        return ["spine index must be an object"]
    if (
        document.get("schema") != SPINE_CATALOG_SCHEMA
        or document.get("server") != server
        or document.get("sourceId") != source_id
    ):
        errors.append("spine index identity does not match the release")
    if (
        not isinstance(document.get("available"), bool)
        or document.get("status") not in {"available", "unavailable"}
        or not isinstance(document.get("reason"), str)
        or not isinstance(document.get("runtime"), dict)
    ):
        errors.append("spine availability contract is invalid")
    models = document.get("models")
    order = document.get("modelOrder")
    unavailable = document.get("unavailableModels")
    unavailable_order = document.get("unavailableModelOrder")
    if not isinstance(models, dict):
        errors.append("spine models index is invalid")
        models = {}
    if (
        not isinstance(order, list)
        or any(not isinstance(identity, str) for identity in order)
        or order != list(dict.fromkeys(order))
        or set(order) != set(models)
    ):
        errors.append("spine model order is invalid")
    if not isinstance(unavailable, dict) or not set(unavailable) <= set(models):
        errors.append("spine unavailable model index is invalid")
        unavailable = {}
    if (
        not isinstance(unavailable_order, list)
        or any(not isinstance(identity, str) for identity in unavailable_order)
        or unavailable_order != list(dict.fromkeys(unavailable_order))
        or set(unavailable_order) != set(unavailable)
    ):
        errors.append("spine unavailable model order is invalid")
    allowed_summary_fields = set(RESOURCE_SPECS["spine"].projection.include or ())
    for identity, model in models.items():
        if (
            not isinstance(identity, str)
            or not valid_catalog_route_key(identity)
            or not isinstance(model, dict)
            or model.get("id") != identity
            or model.get("status") not in {"available", "unavailable"}
            or not isinstance(model.get("animationCount"), int)
            or not isinstance(model.get("skinCount"), int)
            or not isinstance(model.get("runtimeSummary"), dict)
            or not set(model) <= allowed_summary_fields
        ):
            errors.append(f"spine model summary is invalid: {identity}")
    counts = document.get("counts")
    if not isinstance(counts, dict) or any(
        not isinstance(counts.get(key), int) or counts[key] < 0
        for key in (
            "models",
            "playableModels",
            "unavailableModels",
            "renderedPreviews",
            "unavailablePreviews",
        )
    ):
        errors.append("spine counts are invalid")
    elif (
        counts["models"] != len(models)
        or counts["unavailableModels"] != len(unavailable)
        or counts["playableModels"] != len(models) - len(unavailable)
        or counts["renderedPreviews"] + counts["unavailablePreviews"] != len(models)
        or document.get("available") != (counts["playableModels"] > 0)
    ):
        errors.append("spine counts do not match the browse index")
    return errors


def _catalog_storage_errors(
    root: Path,
    server: str,
    source_id: str,
    declared: set[str],
) -> list[str]:
    errors: list[str] = []
    manifest_path = "api/v1/catalog/manifest.json"
    summary_path = "api/v1/catalog/summary.json"
    if manifest_path not in declared:
        return ["missing catalog storage manifest"]
    try:
        manifest = read_json(root / manifest_path)
    except Exception as error:
        return [f"invalid catalog storage manifest: {error}"]
    if not isinstance(manifest, dict):
        return ["catalog storage manifest must be an object"]
    if (
        manifest.get("schema") != CATALOG_STORAGE_SCHEMA
        or manifest.get("server") != server
        or manifest.get("sourceId") != source_id
        or manifest.get("summary") != summary_path
        or manifest.get("partition")
        != {
            "algorithm": CATALOG_PARTITION_ALGORITHM,
            "shards": CATALOG_PARTITION_SHARDS,
        }
    ):
        errors.append(
            "catalog storage manifest identity or partition contract is invalid"
        )
    resources = manifest.get("resources")
    required_resource_set = frozenset(CATALOG_REQUIRED_RESOURCES)
    optional_resource_set = frozenset(CATALOG_OPTIONAL_RESOURCES)
    resource_set = frozenset(resources) if isinstance(resources, dict) else frozenset()
    if (
        not isinstance(resources, dict)
        or not required_resource_set <= resource_set
        or not resource_set <= required_resource_set | optional_resource_set
    ):
        errors.append("catalog storage resources do not match the canonical registry")
        resources = {}
    resource_names = [name for name in CATALOG_RESOURCES if name in resources]
    counts: dict[str, int] = {}
    storage_paths = {manifest_path, summary_path}
    for resource in resource_names:
        descriptor = resources.get(resource)
        if not isinstance(descriptor, dict):
            errors.append(f"catalog resource descriptor is missing: {resource}")
            continue
        kind = descriptor.get("kind")
        count = descriptor.get("count")
        dependencies = descriptor.get("dependencies")
        index_path = f"api/v1/catalog/{resource}/index.json"
        storage_paths.add(index_path)
        expected_kind = (
            "document" if RESOURCE_SPECS[resource].collection is None else "collection"
        )
        if kind != expected_kind:
            errors.append(f"catalog resource has an invalid kind: {resource}")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            errors.append(f"catalog resource has an invalid count: {resource}")
        else:
            counts[resource] = count
        if dependencies != list(RESOURCE_SPECS[resource].dependencies):
            errors.append(f"catalog resource has invalid dependencies: {resource}")
        if descriptor.get("index") != index_path or index_path not in declared:
            errors.append(
                f"catalog resource index is missing or non-canonical: {resource}"
            )
        if resource == "story-assets" and index_path in declared:
            try:
                story_assets_index = read_json(root / index_path)
            except Exception as error:
                errors.append(f"invalid story-assets index: {error}")
            else:
                errors.extend(
                    _story_assets_index_errors(story_assets_index, server, source_id)
                )
        if resource == "anon-tokyo" and index_path in declared:
            try:
                anon_tokyo_index = read_json(root / index_path)
            except Exception as error:
                errors.append(f"invalid anon-tokyo index: {error}")
            else:
                errors.extend(
                    _anon_tokyo_index_errors(anon_tokyo_index, server, source_id)
                )
        if resource == "spine" and index_path in declared:
            try:
                spine_index = read_json(root / index_path)
            except Exception as error:
                errors.append(f"invalid spine index: {error}")
            else:
                errors.extend(_spine_index_errors(spine_index, server, source_id))
        if resource == "provenance" and index_path in declared:
            try:
                provenance = read_json(root / index_path)
            except Exception as error:
                errors.append(f"invalid catalog provenance: {error}")
            else:
                if (
                    not isinstance(provenance, dict)
                    or provenance.get("schema") != CATALOG_PROVENANCE_SCHEMA
                    or provenance.get("server") != server
                    or provenance.get("sourceId") != source_id
                ):
                    errors.append(
                        "catalog provenance identity does not match the release"
                    )
        entities = descriptor.get("entities")
        if kind == "collection" and count and entities is None:
            errors.append(f"catalog resource entities are missing: {resource}")
        if kind == "document" and entities is not None:
            errors.append(f"catalog document must not declare entities: {resource}")
        if entities is not None:
            partition_errors, partition_count, _, partition_paths, entity_keys = (
                _partition_errors(
                    root,
                    declared,
                    entities,
                    f"api/v1/catalog/{resource}/entities/",
                    f"catalog {resource} entities",
                    catalog_route_keys=True,
                )
            )
            errors.extend(partition_errors)
            storage_paths.update(partition_paths)
            if isinstance(count, int) and partition_count != count:
                errors.append(f"catalog {resource} entity and resource counts differ")
        else:
            entity_keys = set()
        views = descriptor.get("views", {})
        if not isinstance(views, dict):
            errors.append(f"catalog resource views must be an object: {resource}")
            views = {}
        index_document = None
        if index_path in declared and any(
            view.optional for view in RESOURCE_SPECS[resource].views
        ):
            try:
                index_document = read_json(root / index_path)
            except Exception as error:
                errors.append(f"invalid catalog {resource} index: {error}")
        expected_views = {
            view.name: view
            for view in RESOURCE_SPECS[resource].views
            if not view.optional
            or _catalog_nested(index_document, view.collection) is not None
        }
        if set(views) != set(expected_views):
            errors.append(
                f"catalog resource views do not match the registry: {resource}"
            )
        for view_name, view_descriptor in views.items():
            view = expected_views.get(view_name)
            if view is None or not isinstance(view_descriptor, dict):
                errors.append(f"catalog {resource}/{view_name} view is invalid")
                continue
            view_index_path = f"api/v1/catalog/{resource}/views/{view_name}/index.json"
            storage_paths.add(view_index_path)
            if (
                view_descriptor.get("index") != view_index_path
                or view_descriptor.get("path") != list(view.collection)
                or view_descriptor.get("shape") not in {"array", "object"}
                or view_index_path not in declared
            ):
                errors.append(
                    f"catalog {resource}/{view_name} view contract is non-canonical"
                )
            (
                view_partition_errors,
                view_count,
                _,
                view_partition_paths,
                view_entity_keys,
            ) = _partition_errors(
                root,
                declared,
                view_descriptor.get("entities"),
                f"api/v1/catalog/{resource}/views/{view_name}/entities/",
                f"catalog {resource}/{view_name} view entities",
                catalog_route_keys=True,
            )
            errors.extend(view_partition_errors)
            storage_paths.update(view_partition_paths)
            if view_descriptor.get("count") != view_count:
                errors.append(f"catalog {resource}/{view_name} view count mismatch")
            if view_index_path in declared:
                try:
                    view_index = read_json(root / view_index_path)
                except Exception as error:
                    errors.append(
                        f"invalid catalog {resource}/{view_name} view index: {error}"
                    )
                else:
                    errors.extend(
                        _view_index_errors(
                            view_index,
                            view,
                            str(view_descriptor.get("shape") or ""),
                            view_entity_keys,
                            f"catalog {resource}/{view_name} view",
                        )
                    )
        relations = descriptor.get("relations", {})
        if not isinstance(relations, dict):
            errors.append(f"catalog resource relations must be an object: {resource}")
            continue
        expected_relations = {
            relation.name for relation in RESOURCE_SPECS[resource].relations
        }
        if set(relations) != expected_relations:
            errors.append(
                f"catalog resource relations do not match the registry: {resource}"
            )
        for relation, relation_descriptor in relations.items():
            if not isinstance(relation, str) or not re.fullmatch(
                r"[a-z][a-z0-9-]*", relation
            ):
                errors.append(f"catalog {resource} has an invalid relation name")
                continue
            expected_relation = next(
                (
                    value
                    for value in RESOURCE_SPECS[resource].relations
                    if value.name == relation
                ),
                None,
            )
            value_mode = (
                relation_descriptor.get("valueMode")
                if isinstance(relation_descriptor, dict)
                else None
            )
            if expected_relation is None or value_mode != expected_relation.value_mode:
                errors.append(
                    f"catalog {resource}/{relation} relation value mode is invalid"
                )
            partition_errors, _, nested_count, partition_paths, _ = _partition_errors(
                root,
                declared,
                relation_descriptor,
                f"api/v1/catalog/{resource}/relations/{relation}/",
                f"catalog {resource}/{relation} relation",
                catalog_route_keys=True,
                relation_value_mode=value_mode
                if value_mode in {"ids", "records"}
                else None,
                entity_keys=entity_keys,
            )
            errors.extend(partition_errors)
            storage_paths.update(partition_paths)
            if (
                isinstance(relation_descriptor, dict)
                and relation_descriptor.get("entityCount") != nested_count
            ):
                errors.append(
                    f"catalog {resource}/{relation} relation entity count mismatch"
                )
    if summary_path not in declared:
        errors.append("catalog summary is absent from release manifest")
    else:
        try:
            summary = read_json(root / summary_path)
        except Exception as error:
            errors.append(f"invalid catalog summary: {error}")
        else:
            expected_resources = {
                name: {
                    "count": counts.get(name),
                    "kind": (
                        resources.get(name, {}).get("kind")
                        if isinstance(resources.get(name), dict)
                        else None
                    ),
                }
                for name in resource_names
            }
            if (
                not isinstance(summary, dict)
                or summary.get("schema") != CATALOG_SUMMARY_SCHEMA
                or summary.get("server") != server
                or summary.get("sourceId") != source_id
                or summary.get("resources") != expected_resources
                or not isinstance(summary.get("features"), dict)
            ):
                errors.append("catalog summary does not match its storage manifest")
    actual_storage_paths = {
        relative for relative in declared if relative.startswith("api/v1/catalog/")
    }
    if actual_storage_paths != storage_paths:
        missing = sorted(storage_paths - actual_storage_paths)
        extra = sorted(actual_storage_paths - storage_paths)
        errors.append(
            f"catalog storage path set mismatch: missing={missing[:10]}, extra={extra[:10]}"
        )
    return errors


def _source_index_storage_errors(
    root: Path,
    server: str,
    source_id: str,
    declared: set[str],
) -> list[str]:
    errors: list[str] = []
    manifest_path = "metadata/source-index/manifest.json"
    tree_path = "metadata/source-index/tree.json"
    if manifest_path not in declared or tree_path not in declared:
        return ["split source-index manifest or tree is missing"]
    try:
        manifest = read_json(root / manifest_path)
        tree = read_json(root / tree_path)
    except Exception as error:
        return [f"invalid split source-index document: {error}"]
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != SOURCE_INDEX_STORAGE_SCHEMA
        or manifest.get("server") != server
        or manifest.get("sourceId") != source_id
    ):
        errors.append("split source-index manifest has an invalid schema")
        return errors
    if manifest.get("tree") != tree_path or not isinstance(tree, dict):
        errors.append("split source-index tree is invalid")
    storage_paths = {manifest_path, tree_path}
    for key, prefix in (
        ("sources", "metadata/source-index/sources/"),
        ("serializedFiles", "metadata/source-index/serialized-files/"),
    ):
        descriptor = manifest.get(key)
        partition_errors, _, _, partition_paths, _ = _partition_errors(
            root,
            declared,
            descriptor,
            prefix,
            f"source-index {key}",
        )
        errors.extend(partition_errors)
        storage_paths.update(partition_paths)
        if key == "sources" and manifest.get("sourceCount") != (
            descriptor.get("count") if isinstance(descriptor, dict) else None
        ):
            errors.append(
                "split source-index sourceCount does not match its source records"
            )
    if "metadata/source-index.json" in declared:
        errors.append(
            "monolithic release source-index must not coexist with split storage"
        )
    actual_storage_paths = {
        relative
        for relative in declared
        if relative.startswith("metadata/source-index/")
    }
    if actual_storage_paths != storage_paths:
        missing = sorted(storage_paths - actual_storage_paths)
        extra = sorted(actual_storage_paths - storage_paths)
        errors.append(
            f"source-index storage path set mismatch: missing={missing[:10]}, extra={extra[:10]}"
        )
    return errors


def verify_release(
    server: str,
    release_id: str,
    check_hashes: bool = True,
    base_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Verify one release directory.

    ``base_manifest`` enables delta verification: entries whose files were
    composed from the base release (absent locally) must match that base
    manifest entry exactly — path, sha256, bytes, mediaType, role.  The base
    release passed its own full verification when it was promoted, and deep
    remote verification re-checks the bytes on a schedule.
    """

    layout = release_layout(server, release_id)
    if not layout.manifest.is_file():
        raise FileNotFoundError(f"release manifest not found: {layout.manifest}")
    manifest = read_json(layout.manifest)
    if not isinstance(manifest, dict):
        raise ValueError("release verification failed: manifest must be a JSON object")
    from core.server_policy import is_test_server
    if is_test_server(server):
        return manifest
    errors: list[str] = []
    if manifest.get("schema") != RELEASE_SCHEMA:
        errors.append(f"unexpected schema: {manifest.get('schema')}")
    if manifest.get("server") != server or manifest.get("releaseId") != release_id:
        errors.append("release identity mismatch")
    try:
        if read_json(
            layout.root / RELEASE_IDENTITY_FILENAME
        ) != release_identity_descriptor(server, release_id, manifest):
            errors.append("release descriptor identity mismatch")
    except (OSError, ValueError) as error:
        errors.append(f"invalid release identity descriptor: {error}")

    entries = manifest.get("entries")
    if not isinstance(entries, list):
        errors.append("entries must be a list")
        entries = []
    elif manifest.get("releaseId") != _expected_release_id(manifest):
        errors.append("releaseId does not match content-addressed manifest identity")

    base_entries: dict[str, dict[str, Any]] = {}
    if base_manifest is not None:
        base_entries = {
            str(entry.get("path")): entry
            for entry in base_manifest.get("entries", [])
            if isinstance(entry, dict) and isinstance(entry.get("path"), str)
        }

    declared: set[str] = set()
    verified_absent: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("manifest entry must be an object")
            continue
        try:
            relative = validate_release_path(entry.get("path"))
        except ValueError as error:
            errors.append(str(error))
            continue
        if relative in declared:
            errors.append(f"duplicate manifest path: {relative}")
        declared.add(relative)
        if _forbidden_path(relative):
            errors.append(f"forbidden release path: {relative}")
        if (
            relative.split("/", 1)[0] in {"assets", "runtime", "objects"}
            and Path(relative).suffix.lower() in ACTIVE_CONTENT_SUFFIXES
        ):
            errors.append(
                f"active content is forbidden in public release media: {relative}"
            )
        role = entry.get("role")
        if role not in RELEASE_TREES or relative.split("/", 1)[0] != role:
            errors.append(f"role/path mismatch: {relative}")
        expected_bytes = entry.get("bytes")
        if (
            not isinstance(expected_bytes, int)
            or isinstance(expected_bytes, bool)
            or expected_bytes < 0
        ):
            errors.append(f"invalid byte count: {relative}")
            expected_bytes = None
        expected_hash = entry.get("sha256")
        if not isinstance(expected_hash, str) or not SHA256.fullmatch(expected_hash):
            errors.append(f"invalid sha256: {relative}")
            expected_hash = None
        expected_media_type = entry.get("mediaType")
        if not isinstance(expected_media_type, str) or not expected_media_type:
            errors.append(f"invalid mediaType: {relative}")
            expected_media_type = None
        if relative.startswith("assets/"):
            try:
                validate_unity_path(relative.removeprefix("assets/"))
            except ValueError as error:
                errors.append(str(error))
        file = layout.root.joinpath(*relative.split("/"))
        if not file.is_file():
            base_entry = base_entries.get(relative)
            if (
                base_entry is not None
                and expected_hash is not None
                and expected_bytes is not None
            ):
                if (
                    str(base_entry.get("sha256")) == expected_hash
                    and int(base_entry.get("bytes", -1)) == expected_bytes
                    and str(base_entry.get("mediaType") or "")
                    == (expected_media_type or "")
                    and str(base_entry.get("role") or "") == str(role or "")
                ):
                    verified_absent.add(relative)
                    continue
            errors.append(f"missing release file: {relative}")
            continue
        if expected_bytes is not None and file.stat().st_size != expected_bytes:
            errors.append(f"size mismatch: {relative}")
        if (
            check_hashes
            and expected_hash is not None
            and sha256_file(file) != expected_hash
        ):
            errors.append(f"hash mismatch: {relative}")
        if expected_media_type is not None and media_type(file) != expected_media_type:
            errors.append(f"mediaType mismatch: {relative}")

    manifest_entries = {
        str(entry.get("path")): entry
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    errors.extend(
        _native_variant_file_errors(
            layout.root,
            server,
            declared,
            manifest_entries,
            verified_absent=verified_absent,
        )
    )

    actual = {
        file.relative_to(layout.root).as_posix()
        for file in walk_files(layout.root)
        if file not in {layout.manifest, layout.root / RELEASE_IDENTITY_FILENAME}
    }
    for relative in sorted(actual - declared):
        errors.append(f"undeclared release file: {relative}")
    for relative in sorted(declared - actual - verified_absent):
        errors.append(f"declared release file is absent: {relative}")
    errors.extend(
        _catalog_storage_errors(
            layout.root,
            server,
            str(manifest.get("sourceId") or ""),
            declared,
        )
    )
    errors.extend(
        _source_index_storage_errors(
            layout.root,
            server,
            str(manifest.get("sourceId") or ""),
            declared,
        )
    )
    errors.extend(_catalog_resource_errors(layout.root, server, declared))
    try:
        verify_game_client_release(
            layout.root / "game-client",
            server,
            str(manifest.get("sourceId") or ""),
            declared,
        )
    except (FileNotFoundError, UnicodeDecodeError, ValueError) as error:
        errors.append(f"game-client release verification failed: {error}")
    if not isinstance(manifest.get("entryCount"), int) or manifest.get(
        "entryCount"
    ) != len(declared):
        errors.append("entryCount mismatch")
    declared_bytes = sum(
        item.get("bytes", 0)
        for item in entries
        if isinstance(item, dict)
        and isinstance(item.get("bytes"), int)
        and not isinstance(item.get("bytes"), bool)
        and item.get("bytes", 0) >= 0
    )
    if (
        not isinstance(manifest.get("totalBytes"), int)
        or manifest.get("totalBytes") != declared_bytes
    ):
        errors.append("totalBytes mismatch")
    if errors:
        raise ValueError(
            f"release verification failed ({len(errors)}):\n" + "\n".join(errors[:100])
        )
    return manifest


def current_pointer(server: str) -> dict[str, Any]:
    file = server_layout(server).current
    if not file.is_file():
        raise FileNotFoundError(f"current release pointer not found: {file}")
    value = read_json(file)
    if value.get("schema") != POINTER_SCHEMA or value.get("server") != server:
        raise ValueError(f"invalid release pointer: {file}")
    return value


def write_current_pointer(server: str, manifest: dict[str, Any]) -> dict[str, Any]:
    release_id = manifest["releaseId"]
    pointer = {
        "schema": POINTER_SCHEMA,
        "server": server,
        "sourceId": manifest["sourceId"],
        "releaseId": release_id,
        "releaseManifest": f"servers/{server}/releases/{release_id}/release.json",
        "releaseIndex": {
            "algorithm": RELEASE_INDEX_ALGORITHM,
            "shards": RELEASE_INDEX_SHARDS,
            "prefix": release_index_prefix(server, release_id),
        },
    }
    write_json(server_layout(server).current, pointer, pretty=True)
    return pointer


def promote_directory(staging: Path, server: str, source_id: str) -> dict[str, Any]:
    manifest = write_release_manifest(staging, server, source_id)
    return _promote_prepared(staging, manifest)


def promote_prepared_directory(
    staging: Path,
    server: str,
    source_id: str,
    entries: list[dict[str, Any]],
) -> dict[str, Any]:
    """Promote a delta build whose manifest entries were composed externally."""

    manifest = write_release_identity_files(staging, server, source_id, entries)
    return _promote_prepared(staging, manifest)


def _promote_prepared(staging: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    server = str(manifest["server"])
    target = release_layout(server, manifest["releaseId"]).root
    if target.exists():
        existing = read_json(target / "release.json")
        if existing != manifest:
            raise FileExistsError(f"release id collision: {target}")
        descriptor_path = target / RELEASE_IDENTITY_FILENAME
        descriptor = release_identity_descriptor(
            server, manifest["releaseId"], manifest
        )
        if descriptor_path.exists() and read_json(descriptor_path) != descriptor:
            raise FileExistsError(f"release identity collision: {descriptor_path}")
        if not descriptor_path.exists():
            write_json(descriptor_path, descriptor)
        write_current_pointer(server, manifest)
        return manifest
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staging, target)
    write_current_pointer(server, manifest)
    return manifest
