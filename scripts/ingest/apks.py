from __future__ import annotations

import gzip
import ipaddress
import itertools
import json
import os
import posixpath
import re
import socket
import sys
import threading
import time
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from core.config import ServerConfig
from core.contracts import PACKAGE_MAX_BYTES, SOURCE_SCHEMA
from core.hashes import sha256_file
from core.manifests import read_json, write_json
from core.paths import source_layout
from core.zip_io import open_validated_zip
from ingest.addressables import downloadable_locations
from ingest.unity import index_unity_dependencies


UNITY_HEADERS = {
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "User-Agent": "UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)",
    "X-Unity-Version": "6000.3.12f1",
}
AUTHORIZATION_ENVIRONMENT = "RESOURCE_CDN_AUTHORIZATION"
AUTHORIZATION_VALUE = re.compile(r"^[A-Za-z][A-Za-z0-9._~+-]* [^\r\n]{1,4096}$")
PUBLIC_DNS_CACHE_SECONDS = 60
_public_dns_cache: dict[tuple[str, int], float] = {}
_public_dns_lock = threading.Lock()
STREAM_CHUNK_BYTES = 1024 * 1024


def _required_file_size(file: Path, label: str) -> int:
    if not file.is_file():
        raise FileNotFoundError(f"{label} is not a file: {file}")
    size = file.stat().st_size
    if size == 0:
        raise ValueError(f"{label} is empty: {file}")
    return size


def _required_package_size(file: Path, label: str) -> int:
    size = _required_file_size(file, label)
    if size > PACKAGE_MAX_BYTES:
        raise ValueError(
            f"{label} exceeds the {PACKAGE_MAX_BYTES}-byte package limit: {size}"
        )
    return size


def _copy_stream(source: Any, target: Any) -> int:
    copied = 0
    for chunk in iter(lambda: source.read(STREAM_CHUNK_BYTES), b""):
        target.write(chunk)
        copied += len(chunk)
    return copied


def _copy_file(source: Path, target: Path, label: str) -> int:
    size = _required_file_size(source, label)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(
        f".{target.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    try:
        with source.open("rb") as input_stream, temporary.open("wb") as output_stream:
            copied = _copy_stream(input_stream, output_stream)
        if copied != size:
            raise ValueError(f"{label} size changed while copying: {size} != {copied}")
        os.replace(temporary, target)
        return copied
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _download_filename(value: Any) -> str:
    filename = str(value or "")
    if (
        not filename
        or filename in {".", ".."}
        or Path(filename).name != filename
        or "/" in filename
        or "\\" in filename
        or "\0" in filename
        or len(filename.encode("utf-8", "surrogatepass")) > 255
    ):
        raise ValueError(f"invalid Addressables download filename: {filename!r}")
    return filename


def _readable_catalog(source: Path, scratch: Path) -> tuple[Path, str]:
    _required_file_size(source, "Addressables catalog")
    with source.open("rb") as stream:
        signature = stream.read(2)
    if signature != b"\x1f\x8b":
        return source, "identity"
    scratch.mkdir(parents=True, exist_ok=True)
    output = scratch / f"{source.name}.decoded"
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    try:
        with gzip.open(source, "rb") as decoded, temporary.open("wb") as target:
            decoded_size = _copy_stream(decoded, target)
        os.replace(temporary, output)
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise ValueError(f"invalid compressed Addressables catalog: {source}") from error
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    if decoded_size == 0:
        output.unlink(missing_ok=True)
        raise ValueError(f"invalid compressed Addressables catalog: {source}")
    return output, "gzip"


def _deterministic_split_archive(directory: Path, output: Path) -> list[dict[str, Any]]:
    files: list[Path] = []
    for candidate in directory.rglob("*"):
        if not candidate.is_file():
            continue
        files.append(candidate)
        _required_file_size(candidate, "split package member")
    files.sort()
    if not files or not any(file.suffix.lower() == ".apk" for file in files):
        raise ValueError(f"split directory contains no APK files: {directory}")
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for file in files:
            info = zipfile.ZipInfo(file.relative_to(directory).as_posix(), (1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            with file.open("rb") as source, archive.open(info, "w", force_zip64=True) as target:
                _copy_stream(source, target)
    _required_package_size(output, "normalized split package")
    return [
        {
            "name": file.relative_to(directory).as_posix(),
            "bytes": _required_file_size(file, "split package member"),
            "sha256": sha256_file(file),
        }
        for file in files
    ]


def normalize_package_input(value: Path, scratch: Path) -> tuple[Path, str, dict[str, Any]]:
    value = value.resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    if value.is_dir():
        output = scratch / "original.apks"
        members = _deterministic_split_archive(value, output)
        return output, "split-directory", {"members": members}
    if not value.is_file():
        raise FileNotFoundError(f"package input not found: {value}")
    _required_package_size(value, "package input")
    # URLs and CI artifacts frequently lose the original extension. Inspect
    # the archive itself: a standalone APK owns AndroidManifest.xml at root;
    # APKS/XAPK containers own one or more nested APK members.
    with open_validated_zip(value, "package input") as archive:
        names = {member.filename for member in archive.infolist()}
    kind = "apk" if "AndroidManifest.xml" in names else "apks"
    output = scratch / f"original.{kind}"
    _copy_file(value, output, "package input")
    return output, kind, {}


def _apk_manifest_metadata(package: Path) -> dict[str, str]:
    from apkutils2 import APK

    manifest = APK(str(package)).get_manifest()
    return {
        "packageName": str(manifest.get("@package", "")),
        "versionCode": str(manifest.get("@android:versionCode", "")),
        "versionName": str(manifest.get("@android:versionName", "")),
        "unityVersion": _apk_unity_version(package),
    }


def _unityfs_version(header: bytes) -> str:
    if not header.startswith(b"UnityFS\0") or len(header) < 16:
        return ""
    cursor = len(b"UnityFS\0") + 4
    values = []
    for _ in range(2):
        end = header.find(b"\0", cursor)
        if end < 0:
            return ""
        values.append(header[cursor:end].decode("ascii", "replace"))
        cursor = end + 1
    return values[1]


def _apk_unity_version(package: Path) -> str:
    with open_validated_zip(package, "APK") as archive:
        entry = next(
            (member for member in archive.infolist() if member.filename.endswith("assets/bin/Data/data.unity3d")),
            None,
        )
        if not entry:
            return ""
        with archive.open(entry) as stream:
            return _unityfs_version(stream.read(128))


def _manifest_metadata(package: Path, scratch: Path) -> dict[str, str]:
    with open_validated_zip(package, "package") as archive:
        members = archive.infolist()
        candidates = [member for member in members if Path(member.filename).name == "manifest.json"]
        for member in sorted(candidates, key=lambda value: (value.filename.count("/"), value.filename)):
            try:
                value = json.loads(archive.read(member))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if value.get("package_name"):
                return {
                    "packageName": str(value.get("package_name", "")),
                    "versionCode": str(value.get("version_code", "")),
                    "versionName": str(value.get("version_name", "")),
                    "unityVersion": "",
                }
        if any(member.filename == "AndroidManifest.xml" for member in members):
            return _apk_manifest_metadata(package)
        base_candidates = [member for member in members if Path(member.filename).name == "base.apk"]
        if len(base_candidates) == 1:
            base = scratch / "base.apk"
            _copy_archive_entry(
                archive,
                base_candidates[0],
                base,
                "base APK",
                maximum_bytes=PACKAGE_MAX_BYTES,
            )
            return _apk_manifest_metadata(base)
    return {"packageName": "", "versionCode": "", "versionName": "", "unityVersion": ""}


def _asset_pack(package: Path, scratch: Path) -> Path:
    with open_validated_zip(package, "package") as archive:
        members = archive.infolist()
        names = [member.filename for member in members]
        if any(name.startswith("assets/aa/") or name.startswith("assets/Master/") for name in names):
            return package
        candidates = [
            member
            for member in members
            if Path(member.filename).name in {"split_UnityDataAssetPack.apk", "UnityDataAssetPack.apk"}
        ]
        if len(candidates) != 1:
            raise ValueError(
                "package does not contain assets/aa and no unique UnityDataAssetPack split was found; "
                f"found {len(candidates)} candidates"
            )
        output = scratch / "UnityDataAssetPack.apk"
        _copy_archive_entry(
            archive,
            candidates[0],
            output,
            "Unity asset-pack APK",
            maximum_bytes=PACKAGE_MAX_BYTES,
        )
        return output


def _embedded_catalog(asset_pack: Path, scratch: Path) -> tuple[Path, Path, str, str, Path, str]:
    """Offline Addressables catalog source: read it from the install-time asset-pack APK.

    Servers without a reachable CDN (e.g. gl-cbt) ship the authoritative
    ``catalog_main.hash`` / ``catalog_main.bin`` inside ``split_UnityDataAssetPack.apk``.
    This returns the same tuple shape the remote-fetch path produces so the rest of
    ``ingest_package`` is unchanged: (hash_file, catalog_file, catalog_hash, catalog_sha,
    readable_catalog, encoding).
    """
    with open_validated_zip(asset_pack, "Unity asset-pack APK") as archive:
        members = archive.infolist()
        hash_entries = [member for member in members if member.filename.endswith("assets/aa/Android/catalog_main.hash")]
        catalog_entries = [
            member for member in members if member.filename.endswith("assets/aa/Android/catalog_main.bin")
        ]
        if len(hash_entries) != 1 or len(catalog_entries) != 1:
            raise ValueError(
                "offline ingest requires exactly one embedded catalog_main.hash and one "
                f"catalog_main.bin in the asset-pack APK; found {len(hash_entries)}/{len(catalog_entries)}"
            )
        hash_file = scratch / "catalog_main.hash"
        _copy_archive_entry(archive, hash_entries[0], hash_file, "embedded catalog hash")
        catalog_hash = hash_file.read_text("utf-8").strip()
        if len(catalog_hash) != 32 or any(value not in "0123456789abcdef" for value in catalog_hash.lower()):
            raise ValueError(f"invalid embedded catalog hash: {catalog_hash}")
        catalog_file = scratch / f"catalog_{catalog_hash}.bin"
        _copy_archive_entry(archive, catalog_entries[0], catalog_file, "embedded Addressables catalog")
    catalog_sha = sha256_file(catalog_file)
    readable_catalog, catalog_encoding = _readable_catalog(catalog_file, scratch)
    return hash_file, catalog_file, catalog_hash, catalog_sha, readable_catalog, catalog_encoding


def _authorization(config: ServerConfig) -> str:
    value = os.environ.get(AUTHORIZATION_ENVIRONMENT, "").strip()
    if config.authorization_required and not value:
        raise ValueError(
            f"{config.id} requires the server-scoped {AUTHORIZATION_ENVIRONMENT} variable"
        )
    if value and " " not in value:
        value = f"Basic {value}"
    if value and not AUTHORIZATION_VALUE.fullmatch(value):
        raise ValueError(f"invalid {AUTHORIZATION_ENVIRONMENT} header value")
    return value


def _trusted_download_url(url: str, config: ServerConfig) -> str:
    if not isinstance(url, str) or not url or any(ord(character) < 32 or ord(character) == 127 for character in url):
        raise ValueError(f"invalid download URL for {config.id}")
    parsed = urllib.parse.urlsplit(url)
    root = urllib.parse.urlsplit(config.remote_root)
    try:
        parsed_port = parsed.port
        root_port = root.port
    except ValueError as error:
        raise ValueError(f"invalid download URL port for {config.id}") from error
    parsed_origin = (parsed.scheme.lower(), (parsed.hostname or "").lower().rstrip("."), parsed_port or 443)
    root_origin = (root.scheme.lower(), (root.hostname or "").lower().rstrip("."), root_port or 443)
    if (
        parsed_origin != root_origin
        or parsed_origin[0] != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ValueError(f"download URL escapes the configured HTTPS origin for {config.id}")

    decoded_path = urllib.parse.unquote(parsed.path)
    if (
        "\\" in decoded_path
        or urllib.parse.unquote(decoded_path) != decoded_path
        or any(part in {".", ".."} for part in decoded_path.split("/"))
    ):
        raise ValueError(f"download URL contains an unsafe path for {config.id}")
    root_path = posixpath.normpath(urllib.parse.unquote(root.path) or "/")
    target_path = posixpath.normpath(decoded_path or "/")
    root_prefix = root_path.rstrip("/") + "/"
    if target_path != root_path and not target_path.startswith(root_prefix):
        raise ValueError(f"download URL escapes remoteRoot for {config.id}")
    return urllib.parse.urlunsplit(parsed)


def _require_public_resolution(url: str, config: ServerConfig) -> None:
    if config.skip_public_resolution_check:
        # Opt-out for CDNs reached through a host proxy whose fake-IP DNS maps public
        # hosts into a reserved range (e.g. RFC 2544 198.18.0.0/15 used by Clash/Surge).
        return
    parsed = urllib.parse.urlsplit(url)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    port = parsed.port or 443
    cache_key = (hostname, port)
    now = time.monotonic()
    with _public_dns_lock:
        if _public_dns_cache.get(cache_key, 0) > now:
            return
    try:
        addresses = {
            result[4][0]
            for result in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
            if result[4]
        }
    except socket.gaierror as error:
        raise ValueError(f"remoteRoot DNS resolution failed for {config.id}") from error
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError(f"remoteRoot resolved to a non-public address for {config.id}")
    with _public_dns_lock:
        _public_dns_cache[cache_key] = now + PUBLIC_DNS_CACHE_SECONDS


class _TrustedRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, config: ServerConfig):
        super().__init__()
        self.config = config

    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        resolved_url = urllib.parse.urljoin(request.full_url, new_url)
        trusted_url = _trusted_download_url(resolved_url, self.config)
        _require_public_resolution(trusted_url, self.config)
        return super().redirect_request(request, file_pointer, code, message, headers, trusted_url)


def _request(url: str, config: ServerConfig, unity_version: str = "") -> urllib.request.Request:
    version = unity_version or config.unity_version
    headers = {
        **UNITY_HEADERS,
        "User-Agent": f"UnityPlayer/{version} (UnityWebRequest/1.0, libcurl/8.10.1-DEV)",
        "X-Unity-Version": version,
    }
    authorization = _authorization(config)
    if authorization:
        headers["Authorization"] = authorization
    trusted_url = _trusted_download_url(url, config)
    _require_public_resolution(trusted_url, config)
    return urllib.request.Request(trusted_url, headers=headers)


def _download(
    url: str,
    output: Path,
    config: ServerConfig,
    *,
    expected_bytes: int = 0,
    unity_version: str = "",
    missing_ok: bool = False,
    quiet: bool = False,
) -> bool:
    if expected_bytes < 0:
        raise ValueError("download expected size cannot be negative")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(
        f".{output.name}.{os.getpid()}.{threading.get_ident()}.part"
    )
    failure: Exception | None = None
    opener = urllib.request.build_opener(_TrustedRedirectHandler(config))
    for attempt in range(5):
        try:
            with opener.open(_request(url, config, unity_version), timeout=120) as response, temporary.open(
                "wb"
            ) as stream:
                _trusted_download_url(response.geturl(), config)
                content_encoding = str(response.headers.get("Content-Encoding", "identity")).strip().lower()
                if content_encoding == "gzip":
                    # Some CDNs (e.g. the jp-cbt Bushiroad CDN) auto-compress responses
                    # with gzip. Decompress on the fly; Content-Length is the compressed
                    # size so skip the declared-length check.
                    source = gzip.GzipFile(fileobj=response)
                    declared_length = None
                elif content_encoding not in {"", "identity"}:
                    raise ValueError(f"download returned unsupported Content-Encoding: {content_encoding}")
                else:
                    source = response
                declared_length = response.headers.get("Content-Length") if content_encoding != "gzip" else None
                if declared_length is not None:
                    try:
                        declared_bytes = int(declared_length)
                    except ValueError as error:
                        raise ValueError("download returned an invalid Content-Length") from error
                    if declared_bytes < 0:
                        raise ValueError("download returned a negative Content-Length")
                    if expected_bytes and declared_bytes != expected_bytes:
                        raise ValueError(
                            f"download Content-Length mismatch: expected {expected_bytes}, got {declared_bytes}"
                        )
                actual_bytes = 0
                for chunk in iter(lambda: source.read(STREAM_CHUNK_BYTES), b""):
                    actual_bytes += len(chunk)
                    if expected_bytes and actual_bytes > expected_bytes:
                        raise ValueError(
                            f"download size mismatch: expected {expected_bytes}, "
                            f"received more than declared"
                        )
                    stream.write(chunk)
            if expected_bytes and actual_bytes != expected_bytes:
                failure = ValueError(
                    f"download size mismatch: expected {expected_bytes}, got {actual_bytes}"
                )
            else:
                failure = None
                break
        except urllib.error.HTTPError as error:
            failure = error
            if error.code in {403, 404} and missing_ok:
                # Some CDNs return 403 instead of 404 for non-existent objects.
                temporary.unlink(missing_ok=True)
                if not quiet:
                    sys.stderr.write(f"warning: {error.code} for {url}, skipping (missing_ok)\n")
                return False
            if error.code in {401, 403, 404} or error.code < 500:
                hint = f"; configure {AUTHORIZATION_ENVIRONMENT}" if error.code == 401 else ""
                temporary.unlink(missing_ok=True)
                raise RuntimeError(f"download failed: {error.code} {url}{hint}") from error
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            failure = error
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        temporary.unlink(missing_ok=True)
        if attempt < 4:
            time.sleep(2**attempt)
    if failure is not None:
        raise RuntimeError(f"download failed after 5 attempts: {url}: {failure}") from failure
    os.replace(temporary, output)
    return True


def _resolve_catalog_version(
    config: ServerConfig, floor: str, scratch: Path, *, unity_version: str
) -> str:
    """Resolve the newest catalog version published at or above ``floor``.

    Versioned-catalog CDNs (e.g. gl-cbt) publish ``catalog_{version}.hash`` with
    no version pointer, so the live version has to be discovered by probing.

    The build (4th) component is a contiguous hotfix counter within a line and is
    walked upward from the floor — this tracks every hot-update, the common case
    (e.g. ``0.3.1.5 -> 0.3.1.6``). Each higher line (next patch ``0.3.2``,
    minor ``0.4``, major ``1.x``) is then probed at its build-0 catalog, drilling
    into the build dimension on a hit. Each dimension stops after 3 consecutive
    misses to tolerate small gaps.

    The higher-line probe assumes a newly published line starts at build 0
    (verified for the current line — ``0.3.1.0`` exists). If a future bump skips
    build 0 it will not be auto-found; bump ``catalog.version`` in the server
    config and the pipeline fetches that floor verbatim. The probe is additive —
    a wrong assumption only means a missed bump, never a stale wrong answer, and
    a floor whose own catalog has been unpublished fails loudly downstream.

    Non four-part-numeric schemes are returned unchanged.
    """
    parts = floor.split(".")
    if len(parts) != 4 or not all(part.isdigit() for part in parts):
        return floor
    base = tuple(int(part) for part in parts)

    def exists(version_tuple: tuple[int, ...]) -> bool:
        candidate = ".".join(str(component) for component in version_tuple)
        probe = scratch / f".probe_catalog_{candidate}.hash"
        hit = _download(
            f"{config.remote_root}/catalog_{candidate}.hash",
            probe,
            config,
            unity_version=unity_version,
            missing_ok=True,
            quiet=True,
        )
        probe.unlink(missing_ok=True)
        return hit

    def line_max(major: int, minor: int, patch: int, start_build: int) -> int | None:
        # Highest build on a line walking upward from start_build. Returns None
        # when start_build itself is absent, so a single request decides whether
        # a line is published at/above the floor.
        if not exists((major, minor, patch, start_build)):
            return None
        latest = start_build
        consecutive_misses = 0
        build = start_build + 1
        while build <= start_build + 128 and consecutive_misses < 3:
            if exists((major, minor, patch, build)):
                latest = build
                consecutive_misses = 0
            else:
                consecutive_misses += 1
            build += 1
        return latest

    best = base
    build = line_max(base[0], base[1], base[2], base[3])
    if build is not None:
        best = (base[0], base[1], base[2], build)

    # Probe each higher dimension at build 0 (patch, then minor, then major),
    # drilling into the build dimension on any line the CDN publishes.
    for dim in (2, 1, 0):
        consecutive_misses = 0
        component = base[dim] + 1
        while consecutive_misses < 3:
            line = list(base)
            for index in range(dim + 1, 4):
                line[index] = 0
            line[dim] = component
            high = line_max(line[0], line[1], line[2], 0)
            if high is not None:
                candidate = (line[0], line[1], line[2], high)
                if candidate > best:
                    best = candidate
                consecutive_misses = 0
            else:
                consecutive_misses += 1
            component += 1

    latest = ".".join(str(component) for component in best)
    if latest != floor:
        sys.stderr.write(f"catalog: advanced {floor} -> {latest}\n")
    return latest


def _copy_archive_entry(
    archive: zipfile.ZipFile,
    entry: zipfile.ZipInfo,
    output: Path,
    label: str,
    *,
    maximum_bytes: int | None = None,
) -> None:
    if entry.is_dir():
        raise ValueError(f"{label} is a directory: {entry.filename}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(
        f".{output.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    try:
        with archive.open(entry) as source, temporary.open("wb") as target:
            copied = 0
            for chunk in iter(lambda: source.read(STREAM_CHUNK_BYTES), b""):
                copied += len(chunk)
                if maximum_bytes is not None and copied > maximum_bytes:
                    raise ValueError(
                        f"{label} exceeds the {maximum_bytes}-byte package limit"
                    )
                target.write(chunk)
        if copied != entry.file_size:
            raise ValueError(
                f"{label} size mismatch: expected {entry.file_size}, got {copied}"
            )
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _file_record(root: Path, file: Path, role: str, addressables: dict[str, Any] | None = None) -> dict[str, Any]:
    value = {
        "role": role,
        "path": file.relative_to(root).as_posix(),
        "originalFilename": file.name,
        "bytes": file.stat().st_size,
        "sha256": sha256_file(file),
    }
    if addressables:
        value["addressables"] = addressables
    return value


def ingest_package(
    input_value: Path,
    config: ServerConfig,
    artifact_cache: Path | None = None,
    concurrency: int = 12,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="haneoka-source-") as temporary:
        scratch = Path(temporary)
        package, package_kind, input_metadata = normalize_package_input(input_value, scratch)
        package_sha = sha256_file(package)
        package_metadata = _manifest_metadata(package, scratch)
        if not package_metadata.get("unityVersion"):
            with open_validated_zip(package, "package") as archive:
                base_entry = next(
                    (member for member in archive.infolist() if Path(member.filename).name == "base.apk"),
                    None,
                )
                if base_entry:
                    base = scratch / "unity-version-base.apk"
                    _copy_archive_entry(
                        archive,
                        base_entry,
                        base,
                        "base APK",
                        maximum_bytes=PACKAGE_MAX_BYTES,
                    )
                    package_metadata["unityVersion"] = _apk_unity_version(base)
        unity_version = package_metadata.get("unityVersion") or config.unity_version
        if package_metadata["packageName"] and package_metadata["packageName"] != config.package_name:
            raise ValueError(f"package name mismatch: {package_metadata['packageName']} != {config.package_name}")
        asset_pack = _asset_pack(package, scratch)

        # Parse locale:path pairs from HANEOKA_SOURCE_CATALOGS (or single path from
        # HANEOKA_SOURCE_CATALOG). Each extra-locale catalog's bundles are tagged so
        # the extraction can namespace locale-variant assets (avoiding path collisions).
        _raw_catalogs = os.environ.get("HANEOKA_SOURCE_CATALOGS", "").strip()
        _raw_single = os.environ.get("HANEOKA_SOURCE_CATALOG", "").strip()
        catalog_entries: list[tuple[str, Path]] = []
        for entry in (_raw_catalogs.split(",") if _raw_catalogs else [_raw_single] if _raw_single else []):
            entry = entry.strip()
            if not entry:
                continue
            if ":" in entry and not entry.startswith("/"):
                locale_str, path_str = entry.split(":", 1)
                catalog_entries.append((locale_str.strip(), Path(path_str.strip())))
            else:
                catalog_entries.append(("", Path(entry)))
        extra_readable_catalogs: list[tuple[str, Path]] = []
        if catalog_entries:
            _primary_locale, catalog_path = catalog_entries[0]
            catalog_sha = sha256_file(catalog_path)
            catalog_hash = catalog_sha[:32]
            remote_hash_file = scratch / "catalog_main.hash"
            remote_hash_file.write_text(catalog_hash, "utf-8")
            remote_catalog = scratch / f"catalog_{catalog_hash}.bin"
            _copy_file(catalog_path, remote_catalog, "override Addressables catalog (primary)")
            readable_catalog, catalog_encoding = _readable_catalog(remote_catalog, scratch)
            for locale_tag, extra_path in catalog_entries[1:]:
                extra_copy = scratch / f"catalog_extra_{locale_tag or 'x'}.bin"
                _copy_file(extra_path, extra_copy, f"override Addressables catalog ({locale_tag})")
                extra_readable, _ = _readable_catalog(extra_copy, scratch)
                extra_readable_catalogs.append((locale_tag, extra_readable))
        elif config.offline:
            (
                remote_hash_file,
                remote_catalog,
                catalog_hash,
                catalog_sha,
                readable_catalog,
                catalog_encoding,
            ) = _embedded_catalog(asset_pack, scratch)
        elif config.catalog_version:
            # Versioned, per-locale Addressables catalogs (e.g. gl-cbt). Unlike the
            # standard Addressables layout, this CDN publishes
            # catalog_{version}[_{locale}].{hash,bin} and exposes no version pointer
            # (catalog_main.hash is absent), so the resource version comes from
            # configuration. The locale-less base catalog is the primary; each locale
            # catalog is merged under its locale tag, reusing the same namespacing the
            # HANEOKA_SOURCE_CATALOGS override applies to locale-variant bundles.
            # The configured version is a known-good floor; builds on its line are
            # contiguous, so the newest published build is auto-discovered by probing.
            catalog_version = _resolve_catalog_version(
                config, config.catalog_version, scratch, unity_version=unity_version
            )
            if not config.remote_root:
                raise ValueError(f"remoteRoot is not configured for {config.id}")
            remote_hash_file = scratch / "catalog_main.hash"
            _download(
                f"{config.remote_root}/catalog_{catalog_version}.hash",
                remote_hash_file,
                config,
                unity_version=unity_version,
            )
            catalog_hash = remote_hash_file.read_text("utf-8").strip()
            if len(catalog_hash) != 32 or any(
                character not in "0123456789abcdef" for character in catalog_hash.lower()
            ):
                raise ValueError(
                    f"invalid remote catalog hash for {catalog_version}: {catalog_hash}"
                )
            remote_catalog = scratch / f"catalog_{catalog_version}.bin"
            _download(
                f"{config.remote_root}/catalog_{catalog_version}.bin",
                remote_catalog,
                config,
                unity_version=unity_version,
            )
            catalog_sha = sha256_file(remote_catalog)
            readable_catalog, catalog_encoding = _readable_catalog(remote_catalog, scratch)
            for locale in config.catalog_locales:
                locale_catalog = scratch / f"catalog_{catalog_version}_{locale}.bin"
                _download(
                    f"{config.remote_root}/catalog_{catalog_version}_{locale}.bin",
                    locale_catalog,
                    config,
                    unity_version=unity_version,
                )
                extra_readable, _ = _readable_catalog(locale_catalog, scratch)
                extra_readable_catalogs.append((locale, extra_readable))
        else:
            remote_hash_file = scratch / "catalog_main.hash"
            if not config.remote_root:
                raise ValueError(f"remoteRoot is not configured for {config.id}")
            _download(
                f"{config.remote_root}/catalog_main.hash",
                remote_hash_file,
                config,
                unity_version=unity_version,
            )
            catalog_hash = remote_hash_file.read_text("utf-8").strip()
            if len(catalog_hash) != 32 or any(value not in "0123456789abcdef" for value in catalog_hash.lower()):
                raise ValueError(f"invalid remote catalog hash: {catalog_hash}")
            remote_catalog = scratch / f"catalog_{catalog_hash}.bin"
            _download(
                f"{config.remote_root}/catalog_{catalog_hash}.bin",
                remote_catalog,
                config,
                unity_version=unity_version,
            )
            catalog_sha = sha256_file(remote_catalog)
            readable_catalog, catalog_encoding = _readable_catalog(remote_catalog, scratch)

        version = package_metadata["versionCode"] or "unknown"
        source_id = f"v{version}-{package_sha[:12]}-{catalog_sha[:12]}"
        layout = source_layout(config.id, source_id)
        if layout.manifest.is_file():
            value = read_json(layout.manifest)
            package_path = value.get("package", {}).get("file")
            package_record = next((item for item in value.get("files", []) if item.get("path") == package_path), {})
            if value.get("schema") != SOURCE_SCHEMA or package_record.get("sha256") != package_sha:
                raise ValueError(f"source identity collision: {layout.root}")
            return value
        if layout.root.exists():
            marker = layout.root / ".incomplete"
            if not marker.is_file():
                raise FileExistsError(f"unrecognized source directory exists: {layout.root}")
            if marker.read_text("utf-8").strip() != source_id:
                raise ValueError(f"incomplete source marker mismatch: {marker}")
        layout.bundles.mkdir(parents=True, exist_ok=True)
        layout.cri.mkdir(parents=True, exist_ok=True)
        layout.catalogs.mkdir(parents=True, exist_ok=True)
        layout.package_dir.mkdir(parents=True, exist_ok=True)
        (layout.root / ".incomplete").write_text(source_id, "utf-8")
        package_target = layout.package_dir / f"original.{package_kind if package_kind != 'split-directory' else 'apks'}"
        _copy_file(package, package_target, "package")
        _copy_file(
            remote_hash_file,
            layout.catalogs / remote_hash_file.name,
            "catalog hash",
        )
        _copy_file(
            remote_catalog,
            layout.catalogs / remote_catalog.name,
            "Addressables catalog",
        )

        addressables_by_file: dict[Path, dict[str, Any]] = {}
        with open_validated_zip(asset_pack, "Unity asset-pack APK") as archive:
            members = archive.infolist()
            catalog_entries = [
                member for member in members if member.filename.endswith("assets/aa/Android/catalog_main.bin")
            ]
            if len(catalog_entries) != 1:
                raise ValueError(f"expected one embedded Android catalog, found {len(catalog_entries)}")
            _copy_archive_entry(
                archive,
                catalog_entries[0],
                layout.catalogs / "embedded_catalog_main.bin",
                "embedded Addressables catalog",
            )
            bundle_entries = sorted(
                (
                    member
                    for member in members
                    if member.filename.startswith("assets/aa/Android/") and member.filename.endswith(".bundle")
                ),
                key=lambda member: member.filename,
            )
            bundle_names = [Path(entry.filename).name for entry in bundle_entries]
            if len(bundle_names) != len(set(bundle_names)):
                raise ValueError(
                    "Unity asset-pack APK contains colliding bundle filenames"
                )
            for entry in bundle_entries:
                target = layout.bundles / Path(entry.filename).name
                _copy_archive_entry(
                    archive,
                    entry,
                    target,
                    f"embedded Unity bundle {entry.filename}",
                )

        all_locations = [
            (locale_tag, loc)
            for locale_tag, cat in [("", readable_catalog), *extra_readable_catalogs]
            for loc in downloadable_locations(cat, config.remote_root)
        ]
        plans: dict[str, tuple[dict[str, Any], Path, dict[str, Any], int]] = {}
        for locale_tag, location in all_locations:
            filename = _download_filename((location.get("primaryParts") or [""])[0])
            is_bundle = filename.endswith(".bundle")
            target = (layout.bundles if is_bundle else layout.cri) / filename
            expected = int(location["data"].get("bundleSize") or 0)
            if expected < 0:
                raise ValueError(
                    f"Addressables artifact {filename} declares an invalid size: {expected}"
                )
            addressables = {
                "hash": location["data"].get("hash", ""),
                "bundleName": location["data"].get("bundleName", ""),
                "primaryKey": location.get("primaryKey", ""),
                "primaryParts": location.get("primaryParts", []),
                "url": location["remoteUrl"],
            }
            if locale_tag:
                addressables["locale"] = locale_tag
            existing_plan = plans.get(filename)
            if existing_plan:
                # Shared bundles appear in multiple locale catalogs. The locale tag
                # is the only difference; compare without it to detect real collisions.
                _strip_locale = lambda d: {k: v for k, v in d.items() if k != "locale"}
                if _strip_locale(existing_plan[2]) != _strip_locale(addressables) or existing_plan[3] != expected:
                    raise ValueError(f"Addressables filename collision: {filename}")
                continue
            plans[filename] = (location, target, addressables, expected)

        def materialize(plan: tuple[dict[str, Any], Path, dict[str, Any], int]) -> tuple[Path, dict[str, Any]] | None:
            location, target, addressables, expected = plan
            filename = target.name
            if target.is_file() and (not expected or target.stat().st_size == expected):
                actual = _required_file_size(target, f"artifact {filename}")
            elif target.exists():
                raise ValueError(f"artifact filename collision with different bytes: {filename}")
            else:
                cached = artifact_cache / filename if artifact_cache else None
                if cached and cached.is_file() and (not expected or cached.stat().st_size == expected):
                    actual = _copy_file(cached, target, f"cached artifact {filename}")
                else:
                    if not _download(
                        location["remoteUrl"],
                        target,
                        config,
                        expected_bytes=expected,
                        unity_version=unity_version,
                        missing_ok=True,
                    ):
                        sys.stderr.write(f"warning: artifact not on CDN, skipping: {filename}\n")
                        return None
                    actual = _required_file_size(target, f"artifact {filename}")
            if expected and actual != expected:
                raise ValueError(
                    f"artifact size mismatch: expected {expected}, got {actual}: {filename}"
                )
            return target, addressables

        with ThreadPoolExecutor(max_workers=max(1, min(int(concurrency), 32))) as executor:
            for result in executor.map(materialize, plans.values()):
                if result is None:
                    continue
                target, addressables = result
                addressables_by_file[target] = addressables

        # Embedded and remote catalogs may point to the same filename. Rebuild a
        # deterministic record list from disk so every source object appears once.
        downloaded = [
            *(
                _file_record(layout.root, file, "unity-bundle", addressables_by_file.get(file))
                for file in sorted(layout.bundles.iterdir())
            ),
            *(
                _file_record(layout.root, file, "cri-payload", addressables_by_file.get(file))
                for file in sorted(layout.cri.iterdir())
            ),
        ]
        source_files = [
            _file_record(layout.root, package_target, "package"),
            _file_record(layout.root, layout.catalogs / remote_hash_file.name, "catalog-hash"),
            _file_record(layout.root, layout.catalogs / remote_catalog.name, "catalog"),
            _file_record(layout.root, layout.catalogs / "embedded_catalog_main.bin", "embedded-catalog"),
            *downloaded,
        ]
        source_files.sort(key=lambda item: item["path"])
        unity_index = index_unity_dependencies(layout.root, source_files)
        manifest = {
            "schema": SOURCE_SCHEMA,
            "server": config.id,
            "sourceId": source_id,
            "package": {
                "kind": package_kind,
                "file": package_target.relative_to(layout.root).as_posix(),
                **package_metadata,
                **input_metadata,
            },
            "catalog": {
                "hash": catalog_hash,
                "file": (layout.catalogs / remote_catalog.name).relative_to(layout.root).as_posix(),
                "encoding": catalog_encoding,
            },
            "unityIndex": unity_index,
            "files": source_files,
            "fileCount": len(source_files),
            "fileBytes": sum(item["bytes"] for item in source_files),
        }
        write_json(layout.manifest, manifest, pretty=True)
        (layout.root / ".incomplete").unlink()
        return manifest
