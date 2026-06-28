from __future__ import annotations

import bz2
import hashlib
import re
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .wire import DecodeStats, decode_message


DEFAULT_BASE_URL = "https://api.garupa.jp"
APPLICATION_PATH = "/api/application"
SUITE_MASTER_PATH = "/api/suite/master"
AES_KEY = b"mikumikulukaluka"
AES_IV = b"lukalukamikumiku"
MAX_APPLICATION_BYTES = 2 * 1024 * 1024
MAX_SUITE_ENCRYPTED_BYTES = 128 * 1024 * 1024
MAX_SUITE_PROTOBUF_BYTES = 256 * 1024 * 1024
READ_CHUNK_BYTES = 1024 * 1024
CLIENT_VERSION_PATTERN = re.compile(r"^[0-9]+(?:[.][0-9]+)*$")


class GarupaRequestError(RuntimeError):
    """Raised when the public game API returns an unusable response."""


@dataclass(frozen=True)
class HttpPayload:
    body: bytes
    headers: dict[str, str]
    status: int
    url: str


@dataclass(frozen=True)
class ApplicationVersions:
    client_version: str
    data_version: str
    master_data_version: str
    decoded: dict[str, object]


@dataclass(frozen=True)
class GarupaResponses:
    application_encrypted: bytes
    application_protobuf: bytes
    application_headers: dict[str, str]
    suite_encrypted: bytes
    suite_compressed: bytes
    suite_protobuf: bytes
    suite_headers: dict[str, str]
    versions: ApplicationVersions


@dataclass(frozen=True)
class GarupaApplicationResponse:
    application_encrypted: bytes
    application_protobuf: bytes
    application_headers: dict[str, str]
    versions: ApplicationVersions


def _validate_base_url(base_url: str, allow_http: bool) -> str:
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme not in ({"https", "http"} if allow_http else {"https"}):
        raise GarupaRequestError("Garupa API base URL must use HTTPS")
    if not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise GarupaRequestError("invalid Garupa API base URL")
    return base_url.rstrip("/")


def _request_headers(client_version: str) -> dict[str, str]:
    return {
        "Accept": "application/octet-stream",
        "Accept-Encoding": "identity",
        "Content-Type": "application/octet-stream",
        "User-Agent": "Haneoka-Garupa-Master-Sync/1",
        "X-ClientPlatform": "Android",
        "X-ClientVersion": client_version,
        "X-Signature": "",
        "X-Token": "",
    }


def _read_limited(response: object, maximum: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(min(READ_CHUNK_BYTES, maximum + 1 - total))  # type: ignore[attr-defined]
        if not chunk:
            break
        total += len(chunk)
        if total > maximum:
            raise GarupaRequestError(f"response exceeds {maximum} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def fetch(
    url: str,
    headers: Mapping[str, str],
    *,
    maximum_bytes: int,
    timeout_seconds: float,
    attempts: int = 3,
) -> HttpPayload:
    context = ssl.create_default_context()
    last_error: BaseException | None = None
    for attempt in range(attempts):
        request = urllib.request.Request(url=url, method="GET", headers=dict(headers))
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds, context=context) as response:
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > maximum_bytes:
                    raise GarupaRequestError(f"response Content-Length exceeds {maximum_bytes} bytes")
                body = _read_limited(response, maximum_bytes)
                return HttpPayload(
                    body=body,
                    headers={name.lower(): value.strip() for name, value in response.headers.items()},
                    status=int(response.status),
                    url=response.geturl(),
                )
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code < 500 or attempt + 1 >= attempts:
                try:
                    detail = _read_limited(exc, 4096).decode("utf-8", errors="replace")
                except Exception:
                    detail = ""
                raise GarupaRequestError(f"Garupa API returned HTTP {exc.code}: {detail[:400]}") from exc
        except (OSError, TimeoutError, urllib.error.URLError, GarupaRequestError) as exc:
            last_error = exc
            if attempt + 1 >= attempts:
                break
        time.sleep(1.5 * (attempt + 1))
    raise GarupaRequestError(f"Garupa API request failed after {attempts} attempts: {last_error}")


def decrypt_aes_128_cbc(ciphertext: bytes) -> bytes:
    if not ciphertext or len(ciphertext) % 16:
        raise GarupaRequestError("encrypted response is empty or not AES-block aligned")
    command = [
        "openssl",
        "enc",
        "-d",
        "-aes-128-cbc",
        "-K",
        AES_KEY.hex(),
        "-iv",
        AES_IV.hex(),
        "-nopad",
    ]
    try:
        result = subprocess.run(command, input=ciphertext, capture_output=True, check=False)
    except FileNotFoundError as exc:
        raise GarupaRequestError("OpenSSL is required to decrypt Garupa responses") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise GarupaRequestError(f"OpenSSL AES decryption failed: {detail}")
    return result.stdout


def remove_iso10126_padding(plaintext: bytes) -> bytes:
    if not plaintext or len(plaintext) % 16:
        raise GarupaRequestError("decrypted response is not AES-block aligned")
    padding = plaintext[-1]
    if padding < 1 or padding > 16 or padding > len(plaintext):
        raise GarupaRequestError(f"invalid ISO10126 padding length {padding}")
    return plaintext[:-padding]


def decompress_bzip2_limited(data: bytes, maximum: int = MAX_SUITE_PROTOBUF_BYTES) -> bytes:
    decompressor = bz2.BZ2Decompressor()
    chunks: list[bytes] = []
    total = 0
    offset = 0
    while offset < len(data):
        chunk = data[offset : offset + READ_CHUNK_BYTES]
        offset += len(chunk)
        while chunk:
            remaining = maximum - total
            if remaining <= 0:
                raise GarupaRequestError(f"decompressed Suite response exceeds {maximum} bytes")
            produced = decompressor.decompress(chunk, max_length=remaining + 1)
            if len(produced) > remaining:
                raise GarupaRequestError(f"decompressed Suite response exceeds {maximum} bytes")
            if produced:
                chunks.append(produced)
                total += len(produced)
            chunk = b""
            while not decompressor.needs_input and not decompressor.eof:
                remaining = maximum - total
                produced = decompressor.decompress(b"", max_length=remaining + 1)
                if len(produced) > remaining:
                    raise GarupaRequestError(f"decompressed Suite response exceeds {maximum} bytes")
                if not produced:
                    break
                chunks.append(produced)
                total += len(produced)
    if not decompressor.eof:
        raise GarupaRequestError("truncated bzip2 Suite response")
    if decompressor.unused_data:
        raise GarupaRequestError("Suite response has trailing data after bzip2 stream")
    return b"".join(chunks)


def decode_application(data: bytes, schema: dict[str, object]) -> ApplicationVersions:
    roots = schema.get("roots")
    if not isinstance(roots, dict):
        raise GarupaRequestError("schema has no roots object")
    root = str(roots.get("application", "AppGetResponse"))
    stats = DecodeStats()
    decoded = decode_message(data, root, schema, stats)
    client_version = decoded.get("clientVersion")
    data_version = decoded.get("dataVersion")
    master_data_version = decoded.get("masterDataVersion")
    versions = (client_version, data_version, master_data_version)
    if not all(isinstance(value, str) and 1 <= len(value) <= 64 for value in versions):
        raise GarupaRequestError("application response omitted one or more version strings")
    return ApplicationVersions(
        client_version=str(client_version),
        data_version=str(data_version),
        master_data_version=str(master_data_version),
        decoded=decoded,
    )


def request_application(
    schema: dict[str, object],
    *,
    base_url: str = DEFAULT_BASE_URL,
    timeout_seconds: float = 45,
    allow_http: bool = False,
    application_body: Path | None = None,
    request_client_version: str | None = None,
) -> GarupaApplicationResponse:
    base_url = _validate_base_url(base_url, allow_http)

    if application_body is not None:
        application_encrypted = application_body.read_bytes()
        application_headers: dict[str, str] = {}
    else:
        header_client_version = str(request_client_version or "")
        if not CLIENT_VERSION_PATTERN.fullmatch(header_client_version):
            raise GarupaRequestError(
                "a valid request client version from the current package is required"
            )
        response = fetch(
            f"{base_url}{APPLICATION_PATH}",
            _request_headers(header_client_version),
            maximum_bytes=MAX_APPLICATION_BYTES,
            timeout_seconds=timeout_seconds,
        )
        application_encrypted = response.body
        application_headers = response.headers
    application_protobuf = remove_iso10126_padding(decrypt_aes_128_cbc(application_encrypted))
    versions = decode_application(application_protobuf, schema)
    return GarupaApplicationResponse(
        application_encrypted=application_encrypted,
        application_protobuf=application_protobuf,
        application_headers=application_headers,
        versions=versions,
    )


def request_live_master(
    schema: dict[str, object],
    *,
    base_url: str = DEFAULT_BASE_URL,
    timeout_seconds: float = 45,
    allow_http: bool = False,
    application_body: Path | None = None,
    suite_body: Path | None = None,
    request_client_version: str | None = None,
) -> GarupaResponses:
    base_url = _validate_base_url(base_url, allow_http)
    application = request_application(
        schema,
        base_url=base_url,
        timeout_seconds=timeout_seconds,
        allow_http=allow_http,
        application_body=application_body,
        request_client_version=request_client_version,
    )
    versions = application.versions

    suite_headers = _request_headers(versions.client_version)
    suite_headers["X-DataVersion"] = versions.data_version
    suite_headers["X-MasterDataVersion"] = versions.master_data_version
    if suite_body is not None:
        suite_encrypted = suite_body.read_bytes()
        response_headers = {"x-encoding": "bzip2"}
    else:
        response = fetch(
            f"{base_url}{SUITE_MASTER_PATH}",
            suite_headers,
            maximum_bytes=MAX_SUITE_ENCRYPTED_BYTES,
            timeout_seconds=timeout_seconds,
        )
        suite_encrypted = response.body
        response_headers = response.headers

    suite_compressed = remove_iso10126_padding(decrypt_aes_128_cbc(suite_encrypted))
    encoding = response_headers.get("x-encoding", "").lower()
    if encoding not in {"bzip2", "bz2"}:
        raise GarupaRequestError(f"unexpected Suite X-Encoding: {encoding or '(missing)'}")
    suite_protobuf = decompress_bzip2_limited(suite_compressed)
    if not suite_protobuf:
        raise GarupaRequestError("SuiteMasterGetResponse decoded to an empty payload")
    return GarupaResponses(
        application_encrypted=application.application_encrypted,
        application_protobuf=application.application_protobuf,
        application_headers=application.application_headers,
        suite_encrypted=suite_encrypted,
        suite_compressed=suite_compressed,
        suite_protobuf=suite_protobuf,
        suite_headers=response_headers,
        versions=versions,
    )


def digest(data: bytes) -> dict[str, int | str]:
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
