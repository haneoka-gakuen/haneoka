"""Live asset-version and CDN credential lookup against the game service.

Requires HTTP/2 (``curl``). The endpoint comes from server configuration or
the ``HANEOKA_VERSION_ENDPOINT`` variable.
"""

from __future__ import annotations

import ipaddress
import json
import re
import shutil
import socket
import subprocess
import urllib.parse
from dataclasses import dataclass

VERSION_ENDPOINT_ENVIRONMENT = "HANEOKA_VERSION_ENDPOINT"
GRPC_USER_AGENT = "grpc-dotnet/2.66.0"
EMPTY_GRPC_FRAME = b"\x00\x00\x00\x00\x00"
VERSION_HEADER = "x-asset-version"
CDN_ROOT_HEADER = "x-sirius-env"
CDN_PASSWORD_HEADER = "x-sirius-cred"
HEX_32 = re.compile(r"^[0-9a-f]{32}$")
VERSION_PARTS = re.compile(r"^\d+(?:\.\d+)*$")


@dataclass(frozen=True)
class AssetVersionInfo:
    version: str
    platform_hash: str
    platform: str
    cdn_root: str
    cdn_password: str


def resolve_version_endpoint(configured: str = "") -> str:
    """Combine the configured endpoint with the ``HANEOKA_VERSION_ENDPOINT`` override."""
    import os

    endpoint = (configured or "").strip() or os.environ.get(VERSION_ENDPOINT_ENVIRONMENT, "").strip()
    if not endpoint:
        raise ValueError(
            "no version endpoint configured: set the server configuration or "
            f"{VERSION_ENDPOINT_ENVIRONMENT}"
        )
    return endpoint


def _public_https(url: str, skip_resolution_check: bool = False) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"version endpoint must be a plain HTTPS URL: {url}")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError(f"version endpoint has an invalid port: {url}") from error
    if port not in (None, 443) or parsed.query or parsed.fragment:
        raise ValueError(f"version endpoint must be an ordinary HTTPS URL: {url}")
    if skip_resolution_check:
        return
    hostname = parsed.hostname.lower().rstrip(".")
    try:
        addresses = {
            result[4][0] for result in socket.getaddrinfo(hostname, port or 443, type=socket.SOCK_STREAM)
        }
    except socket.gaierror as error:
        raise ValueError(f"version endpoint DNS resolution failed: {hostname}") from error
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError(f"version endpoint does not resolve publicly: {hostname}")


def _version_key(value: object) -> tuple[int, ...]:
    text = str(value or "")
    if not VERSION_PARTS.fullmatch(text):
        return (-1,)
    return tuple(int(part) for part in text.split("."))


def _select_live_entry(payload: object, platform: str) -> tuple[str, str]:
    """Pick the newest usable live line for ``platform``."""
    if not isinstance(payload, dict) or not isinstance(payload.get("live"), list) or not payload["live"]:
        raise ValueError("asset version payload has no live entries")
    platform_key = "iOS" if platform == "iOS" else "Android"
    best: tuple[tuple[int, ...], str, str] | None = None
    for entry in payload["live"]:
        if not isinstance(entry, dict):
            continue
        version = str(entry.get("version") or "")
        platform_hash = str(entry.get(platform_key) or "")
        if not VERSION_PARTS.fullmatch(version) or not HEX_32.fullmatch(platform_hash):
            continue
        key = _version_key(version)
        if best is None or key >= best[0]:
            best = (key, version, platform_hash)
    if best is None:
        raise ValueError(f"asset version payload has no usable {platform_key} entry")
    return best[1], best[2]


def discover_asset_version(
    endpoint: str,
    platform: str,
    timeout: float = 30.0,
    skip_resolution_check: bool = False,
) -> AssetVersionInfo:
    """Resolve the live asset version of ``platform`` from the game service."""
    curl = shutil.which("curl")
    if not curl:
        raise RuntimeError("curl with HTTP/2 support is required for server version discovery")
    _public_https(endpoint, skip_resolution_check)
    command = [
        curl,
        "-sS",
        "--http2-prior-knowledge",
        "--max-time",
        str(int(timeout)),
        "-o",
        "/dev/null",
        "-D",
        "-",
        "-H",
        "content-type: application/grpc",
        "-H",
        "te: trailers",
        "-A",
        GRPC_USER_AGENT,
        "--data-binary",
        "@-",
        endpoint,
    ]
    result = subprocess.run(command, input=EMPTY_GRPC_FRAME, capture_output=True, timeout=timeout + 10)
    if result.returncode != 0:
        raise RuntimeError(f"version endpoint request failed: {result.stderr.decode('utf-8', 'replace').strip()}")
    headers: dict[str, str] = {}
    for raw_line in result.stdout.decode("utf-8", "replace").splitlines():
        if ":" not in raw_line:
            continue
        name, value = raw_line.split(":", 1)
        headers.setdefault(name.strip().lower(), value.strip())
    if VERSION_HEADER not in headers:
        raise RuntimeError("version endpoint response carries no version header")
    raw_version = headers[VERSION_HEADER]
    if raw_version.strip().lower() == "unknown":
        raise RuntimeError("server reported no asset version for this endpoint state")
    try:
        payload = json.loads(raw_version)
    except json.JSONDecodeError as error:
        raise RuntimeError("version header is not valid JSON") from error
    version, platform_hash = _select_live_entry(payload, platform)
    cdn_root = headers.get(CDN_ROOT_HEADER, "").strip()
    cdn_password = headers.get(CDN_PASSWORD_HEADER, "").strip()
    return AssetVersionInfo(
        version=version,
        platform_hash=platform_hash,
        platform=platform,
        cdn_root=cdn_root,
        cdn_password=cdn_password,
    )


def cdn_authorization(user: str, password: str) -> str:
    import base64

    return f"Basic {base64.b64encode(f'{user}:{password}'.encode('utf-8')).decode('ascii')}"
