"""Resolve operator configuration without exposing it in diagnostics."""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

_private_values: set[str] = set()
_current_settings: dict[str, Any] | None = None


def redact_private_text(text: str) -> str:
    for value in sorted(_private_values, key=len, reverse=True):
        text = text.replace(value, "[configured]")
    return text


class _PrivateDiagnostics:
    def __init__(self, stream):
        self.stream = stream

    def write(self, text: str) -> int:
        self.stream.write(redact_private_text(text))
        return len(text)

    def __getattr__(self, name):
        return getattr(self.stream, name)


def _remember(value: Any, sensitive: bool = False) -> None:
    if isinstance(value, dict):
        for name, child in value.items():
            _remember(child, sensitive or name in {"masterCrypto", "bundleCrypto", "criHcaKey", "packageAcquisition", "hostSuffixes", "cdnDiscovery"})
    elif isinstance(value, list):
        for child in value:
            _remember(child, sensitive)
    elif isinstance(value, str) and len(value) >= 8 and (sensitive or "://" in value):
        _private_values.add(value)
        if "://" in value:
            parsed = urlsplit(value)
            if parsed.hostname:
                _private_values.add(parsed.hostname)
                _private_values.add(f"{parsed.scheme}://{parsed.netloc}")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("runtime configuration contains duplicate fields")
        result[key] = value
    return result


def load_private_settings(server: str, registry: Path) -> dict[str, Any]:
    global _current_settings
    reference = json.loads(registry.read_text("utf-8"))
    if set(reference) - {"$schema", "id", "configurationEnv"} or reference.get("id") != server:
        raise ValueError(f"invalid server configuration reference: {registry.name}")
    name = reference.get("configurationEnv")
    if name != "RESOURCE_PIPELINE_CONFIG":
        raise ValueError(f"invalid runtime configuration variable: {registry.name}")
    raw = os.environ.get(name, "")
    filename = os.environ.get(name + "_FILE", "")
    if raw and filename:
        raise ValueError(f"set either {name} or {name}_FILE, not both")
    if filename:
        file = Path(filename)
        try:
            info = file.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 131_072:
                raise ValueError("runtime configuration file must be a private regular file, at most 128 KiB")
            raw = file.read_text("utf-8")
        except OSError:
            raise ValueError("cannot read runtime configuration file") from None
    if not raw:
        raise ValueError(f"{server} requires its environment-scoped {name} secret")
    if len(raw.encode("utf-8")) > 131_072:
        raise ValueError("runtime configuration exceeds 128 KiB")
    try:
        value = json.loads(raw, object_pairs_hook=_unique_object)
    except (json.JSONDecodeError, UnicodeError):
        raise ValueError("runtime configuration is not valid JSON") from None
    if not isinstance(value, dict):
        raise ValueError("runtime configuration must be an object")
    _remember(value)
    if not isinstance(sys.stderr, _PrivateDiagnostics):
        sys.stderr = _PrivateDiagnostics(sys.stderr)
    if value.get("id") != server:
        raise ValueError("runtime configuration belongs to a different server")
    _current_settings = value
    return value


def runtime_settings() -> dict[str, Any]:
    if _current_settings is not None:
        return _current_settings
    raw = os.environ.get("RESOURCE_PIPELINE_CONFIG", "")
    filename = os.environ.get("RESOURCE_PIPELINE_CONFIG_FILE", "")
    if not raw and filename:
        # The full loader checks file permissions before using these values.
        raw = Path(filename).read_text("utf-8")
    try:
        server = json.loads(raw).get("id")
    except (ValueError, AttributeError):
        raise ValueError("private runtime configuration is required for bundle decoding") from None
    import re
    if not isinstance(server, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", server):
        raise ValueError("invalid runtime server identity")
    return load_private_settings(server, Path(__file__).resolve().parents[1] / "config" / "servers" / (server + ".json"))


def github_masks(value: Any) -> list[str]:
    _remember(value)
    return ["::add-mask::" + text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            for text in sorted(_private_values)]
