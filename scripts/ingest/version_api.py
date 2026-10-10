"""Live asset-version and CDN credential lookup against the game service.

Requires HTTP/2 (``curl``). The endpoint belongs to the selected server configuration.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import time
import shutil
import socket
import subprocess
import urllib.parse
from dataclasses import dataclass

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


def resolve_version_endpoint(configured: str) -> str:
    endpoint = configured.strip()
    if not endpoint:
        raise ValueError("no version endpoint in the selected server configuration")
    return endpoint


def proxy_from_env(name: str) -> "str | None":
    """Resolve the egress proxy for blocked version endpoints, if configured."""

    if not name:
        return None
    return os.environ.get(name, "").strip() or None


def proxy_curl_flags(proxy: "str | None") -> list[str]:
    """Validate one proxy URL and render curl's -x flag pair."""

    value = (proxy or "").strip()
    if not value:
        return []
    parsed = urllib.parse.urlsplit(value)
    if (
        parsed.scheme.lower() not in {"http", "https", "socks5", "socks5h"}
        or not parsed.hostname
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"version egress proxy must be a plain proxy URL: {value}")
    return ["-x", value]


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


def is_versioned_catalog_version(value: str) -> bool:
    """Accept a numeric catalog generation and its optional live content hash."""
    return re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}(?:\.[a-fA-F0-9]{8})?", value) is not None


def resource_version_key(value: str) -> tuple[int, ...]:
    """Compare generations while retaining the full hash-qualified catalog identity."""
    if is_versioned_catalog_version(value):
        return tuple(int(part) for part in value.split(".")[:4])
    return version_key(value)


def version_key(value: object) -> tuple[int, ...]:
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
        key = version_key(version)
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
    proxy: "str | None" = None,
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
        *proxy_curl_flags(proxy),
        "-o",
        "/dev/null",
        "-D",
        "-",
        "-H",
        "content-type: application/grpc",
        "-H",
        "te: trailers",
        "-H",
        "x-platform: Android",
        "-A",
        GRPC_USER_AGENT,
        "--data-binary",
        "@-",
        endpoint,
    ]
    # One stalled egress (direct or through a JP proxy node) must not fail
    # the whole ingestion; mirror the Master version lookup's short backoff.
    result = None
    for delay in (0, 3, 8):
        if delay:
            time.sleep(delay)
        result = subprocess.run(command, input=EMPTY_GRPC_FRAME, capture_output=True, timeout=timeout + 10)
        if result.returncode == 0:
            break
    if result is None or result.returncode != 0:
        raise RuntimeError(f"version endpoint request failed: {result.stderr.decode('utf-8', 'replace').strip()}")
    headers: dict[str, str] = {}
    for raw_line in result.stdout.decode("utf-8", "replace").splitlines():
        if ":" not in raw_line:
            continue
        name, value = raw_line.split(":", 1)
        headers.setdefault(name.strip().lower(), value.strip())
    if VERSION_HEADER not in headers:
        status = next(
            (line.strip() for line in result.stdout.decode("utf-8", "replace").splitlines() if line.startswith("HTTP/")),
            "unknown status",
        )
        # Header NAMES only: values may carry credentials.
        raise RuntimeError(
            "version endpoint response carries no version header "
            f"({status}; received headers: {', '.join(sorted(headers)) or 'none'})"
        )
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
