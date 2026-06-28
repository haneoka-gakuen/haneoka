from __future__ import annotations

import json
import ipaddress
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit


PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_ROOT = PROJECT_ROOT / "scripts" / "config" / "servers"
SERVER_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
HEX_64 = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class ServerConfig:
    id: str
    package_name: str
    platform: str
    unity_version: str
    extraction_shards: int
    r2_bucket: str
    release_retention: int
    authorization_required: bool
    remote_root: str
    cri_hca_key: str
    master_crypto: dict[str, str]
    file: Path


def validate_server_id(value: str) -> str:
    if not SERVER_ID.fullmatch(value):
        raise ValueError(f"invalid server id: {value}")
    return value


def load_server_config(server: str = "jp-cbt") -> ServerConfig:
    server = validate_server_id(server)
    file = CONFIG_ROOT / f"{server}.json"
    value = json.loads(file.read_text("utf-8"))
    if value.get("id") != server:
        raise ValueError(f"server configuration id mismatch: {file}")
    allowed = {
        "$schema",
        "id",
        "packageName",
        "platform",
        "unityVersion",
        "extractionShards",
        "r2Bucket",
        "releaseRetention",
        "authorizationRequired",
        "remoteRoot",
        "criHcaKey",
        "masterCrypto",
    }
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"unknown server configuration fields in {file}: {unknown}")
    shards = value.get("extractionShards")
    if not isinstance(shards, int) or not 1 <= shards <= 128:
        raise ValueError(f"invalid extractionShards: {file}")
    retention = value.get("releaseRetention")
    if not isinstance(retention, int) or not 2 <= retention <= 10:
        raise ValueError(f"invalid releaseRetention: {file}")
    required_strings = ("packageName", "unityVersion", "r2Bucket", "remoteRoot", "criHcaKey")
    if any(not isinstance(value.get(key), str) or not value[key] for key in required_strings):
        raise ValueError(f"required server configuration string is missing: {file}")
    remote_root = urlsplit(value["remoteRoot"])
    remote_hostname = (remote_root.hostname or "").lower().rstrip(".")
    try:
        remote_port = remote_root.port
    except ValueError as error:
        raise ValueError(f"invalid remoteRoot port: {file}") from error
    if (
        value.get("platform") != "Android"
        or remote_root.scheme.lower() != "https"
        or not remote_hostname
        or remote_root.username is not None
        or remote_root.password is not None
        or remote_root.query
        or remote_root.fragment
        or remote_port not in {None, 443}
        or "\\" in remote_root.path
        or unquote(unquote(remote_root.path)) != unquote(remote_root.path)
        or any(part in {".", ".."} for part in unquote(remote_root.path).split("/"))
    ):
        raise ValueError(f"unsupported platform or remoteRoot: {file}")
    try:
        remote_address = ipaddress.ip_address(remote_hostname)
    except ValueError:
        if remote_hostname == "localhost" or remote_hostname.endswith((".localhost", ".local")):
            raise ValueError(f"remoteRoot must use a public host: {file}")
    else:
        if not remote_address.is_global:
            raise ValueError(f"remoteRoot must use a public address: {file}")
    authorization_required = value.get("authorizationRequired")
    if not isinstance(authorization_required, bool):
        raise ValueError(f"invalid authorizationRequired: {file}")
    if not value["criHcaKey"].isdigit():
        raise ValueError(f"invalid criHcaKey: {file}")
    crypto = value.get("masterCrypto", {})
    if not isinstance(crypto, dict) or set(crypto) != {"salt", "key", "iv"} or any(
        not isinstance(item, str) or not HEX_64.fullmatch(item) for item in crypto.values()
    ):
        raise ValueError(f"invalid masterCrypto: {file}")
    return ServerConfig(
        id=server,
        package_name=value["packageName"],
        platform=value["platform"],
        unity_version=value["unityVersion"],
        extraction_shards=shards,
        r2_bucket=value["r2Bucket"],
        release_retention=retention,
        authorization_required=authorization_required,
        remote_root=value.get("remoteRoot", "").rstrip("/"),
        cri_hca_key=str(value.get("criHcaKey", "")),
        master_crypto=crypto,
        file=file,
    )
