from __future__ import annotations

import json
import ipaddress
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlsplit

from core.private_config import load_private_settings


PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_ROOT = PROJECT_ROOT / "scripts" / "config" / "servers"
SERVER_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
HEX_64 = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class AnnouncementRegion:
    name: str
    id: str
    language: str


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
    offline: bool
    closed: bool
    skip_public_resolution_check: bool
    remote_root: str
    version_endpoint: str
    version_catalog_path: str
    version_basic_user: str
    cri_hca_key: str
    master_crypto: dict[str, str]
    catalog_version: str
    catalog_locales: tuple[str, ...]
    file: Path
    master_remote_root: str = ""
    master_version_endpoint: str = ""
    version_proxy_env: str = ""
    announcements_endpoint: str = ""
    announcements_regions: tuple[AnnouncementRegion, ...] = ()
    announcements_proxy_env: str = ""
    announcements_language: str = ""
    package_acquisition: dict = field(default_factory=dict)
    bundle_crypto: dict[str, str] = field(default_factory=dict)
    announcements_host_suffixes: tuple[str, ...] = ()
    authorization_env: str = "RESOURCE_CDN_AUTHORIZATION"
    cri_compatibility_key_sha256: str = ""
    cdn_discovery: dict = field(default_factory=dict)
    remote_root_mirrors: tuple[str, ...] = ()
    master_remote_root_mirrors: tuple[str, ...] = ()


def validate_server_id(value: str) -> str:
    if not SERVER_ID.fullmatch(value):
        raise ValueError(f"invalid server id: {value}")
    return value


def _validate_service_endpoint(value: str, file: Path) -> None:
    endpoint = urlsplit(value)
    endpoint_hostname = (endpoint.hostname or "").lower().rstrip(".")
    try:
        endpoint_port = endpoint.port
    except ValueError as error:
        raise ValueError(f"invalid service endpoint port: {file}") from error
    if (
        endpoint.scheme.lower() != "https"
        or not endpoint_hostname
        or endpoint.username is not None
        or endpoint.password is not None
        or endpoint_port not in {None, 443}
        or endpoint.query
        or endpoint.fragment
        or "\\" in endpoint.path
        or ".." in endpoint.path.split("/")
    ):
        raise ValueError(f"invalid service endpoint: {file}")
    try:
        endpoint_address = ipaddress.ip_address(endpoint_hostname)
    except ValueError:
        if endpoint_hostname == "localhost" or endpoint_hostname.endswith(
            (".localhost", ".local")
        ):
            raise ValueError(f"service endpoint must use a public host: {file}")
    else:
        if not endpoint_address.is_global:
            raise ValueError(f"service endpoint must use a public address: {file}")


def load_server_config(server: str = "jp-cbt") -> ServerConfig:
    server = validate_server_id(server)
    file = CONFIG_ROOT / f"{server}.json"
    value = load_private_settings(server, file)
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
        "offline",
        "closed",
        "skipPublicResolutionCheck",
        "remoteRoot",
        "assetVersion",
        "criHcaKey",
        "masterCrypto",
        "catalog",
        "masterRemoteRoot",
        "masterVersionEndpoint",
        "announcements",
        "packageAcquisition",
        "bundleCrypto",
        "authorizationEnv",
        "criCompatibilityKeySha256",
        "cdnDiscovery",
        "remoteRootMirrors",
        "masterRemoteRootMirrors",
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
    offline = value.get("offline", False)
    if not isinstance(offline, bool):
        raise ValueError(f"invalid offline: {file}")
    skip_public_resolution_check = value.get("skipPublicResolutionCheck", False)
    if not isinstance(skip_public_resolution_check, bool):
        raise ValueError(f"invalid skipPublicResolutionCheck: {file}")
    closed = value.get("closed", False)
    if not isinstance(closed, bool):
        raise ValueError(f"invalid closed: {file}")
    required_strings = ("packageName", "unityVersion", "r2Bucket", "criHcaKey")
    if any(
        not isinstance(value.get(key), str) or not value[key]
        for key in required_strings
    ):
        raise ValueError(f"required server configuration string is missing: {file}")
    remote_root_value = value.get("remoteRoot")
    if isinstance(remote_root_value, str) and remote_root_value:
        # Validate whenever a remoteRoot is supplied — for online builds and for offline
        # builds that still download non-embedded bundles from the CDN (intl-cbt model).
        remote_root = urlsplit(remote_root_value)
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
            if remote_hostname == "localhost" or remote_hostname.endswith(
                (".localhost", ".local")
            ):
                raise ValueError(f"remoteRoot must use a public host: {file}")
        else:
            if not remote_address.is_global:
                raise ValueError(f"remoteRoot must use a public address: {file}")
    elif not offline:
        raise ValueError(f"required server configuration string is missing: {file}")
    authorization_required = value.get("authorizationRequired")
    if not isinstance(authorization_required, bool):
        raise ValueError(f"invalid authorizationRequired: {file}")
    authorization_env = value.get("authorizationEnv", "RESOURCE_CDN_AUTHORIZATION")
    if not isinstance(authorization_env, str) or not ENV_NAME.fullmatch(authorization_env):
        raise ValueError(f"invalid authorizationEnv: {file}")
    compatible_key_sha = value.get("criCompatibilityKeySha256", "")
    if not isinstance(compatible_key_sha, str) or (compatible_key_sha and not HEX_64.fullmatch(compatible_key_sha)):
        raise ValueError(f"invalid CRI compatibility key identity: {file}")
    if not value["criHcaKey"].isdigit():
        raise ValueError(f"invalid criHcaKey: {file}")
    crypto = value.get("masterCrypto", {})
    if (
        not isinstance(crypto, dict)
        or set(crypto) != {"salt", "key", "iv"}
        or any(
            not isinstance(item, str) or not HEX_64.fullmatch(item)
            for item in crypto.values()
        )
    ):
        raise ValueError(f"invalid masterCrypto: {file}")
    asset_version = value.get("assetVersion", {})
    if not isinstance(asset_version, dict):
        raise ValueError(f"invalid assetVersion block: {file}")
    unknown_asset_version = sorted(
        set(asset_version) - {"endpoint", "catalogPath", "basicUser", "proxyEnv"}
    )
    if unknown_asset_version:
        raise ValueError(
            f"unknown assetVersion fields in {file}: {unknown_asset_version}"
        )
    version_proxy_env = str(asset_version.get("proxyEnv", "")).strip()
    if version_proxy_env and not ENV_NAME.fullmatch(version_proxy_env):
        raise ValueError(
            f"assetVersion.proxyEnv must be an environment variable name: {file}"
        )
    version_endpoint = str(asset_version.get("endpoint", "")).strip()
    if not version_endpoint and asset_version.get("endpoint") is not None:
        raise ValueError(
            f"assetVersion.endpoint must be a non-empty string when present: {file}"
        )
    if version_endpoint:
        _validate_service_endpoint(version_endpoint, file)
    master_version_endpoint = value.get("masterVersionEndpoint", "")
    if not isinstance(master_version_endpoint, str):
        raise ValueError(f"invalid masterVersionEndpoint: {file}")
    if master_version_endpoint:
        _validate_service_endpoint(master_version_endpoint, file)
    mirrors = {}
    for key in ("remoteRootMirrors", "masterRemoteRootMirrors"):
        urls = value.get(key, [])
        if not isinstance(urls, list) or len(urls) > 4 or any(not isinstance(url, str) or not url for url in urls):
            raise ValueError(f"invalid resource mirror list: {file}")
        for url in urls:
            _validate_service_endpoint(url, file)
        mirrors[key] = tuple(dict.fromkeys(url.rstrip("/") for url in urls))
    cdn_discovery = value.get("cdnDiscovery", {})
    if not isinstance(cdn_discovery, dict):
        raise ValueError(f"invalid cdnDiscovery block: {file}")
    if cdn_discovery:
        required = {"endpoint", "clientVersion", "environment", "hostSuffixes", "assetPath", "masterPath"}
        if set(cdn_discovery) != required:
            raise ValueError(f"invalid cdnDiscovery fields: {file}")
        endpoint = cdn_discovery["endpoint"]
        if not isinstance(endpoint, str) or not endpoint:
            raise ValueError(f"invalid cdnDiscovery endpoint: {file}")
        _validate_service_endpoint(endpoint, file)
        if not isinstance(cdn_discovery["clientVersion"], str) or not re.fullmatch(r"\d+(?:\.\d+){1,3}", cdn_discovery["clientVersion"]):
            raise ValueError(f"invalid cdnDiscovery clientVersion: {file}")
        if not isinstance(cdn_discovery["environment"], str) or not re.fullmatch(r"[ -~]{1,128}", cdn_discovery["environment"]):
            raise ValueError(f"invalid cdnDiscovery environment: {file}")
        suffixes = cdn_discovery["hostSuffixes"]
        if not isinstance(suffixes, list) or not suffixes or any(
            not isinstance(suffix, str) or suffix.count(".") < 2
            or not re.fullmatch(r"\.[a-z0-9]+(?:[.-][a-z0-9]+)*", suffix)
            for suffix in suffixes
        ):
            raise ValueError(f"invalid cdnDiscovery host allowlist: {file}")
        for key in ("assetPath", "masterPath"):
            if not isinstance(cdn_discovery[key], str) or not re.fullmatch(r"/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*", cdn_discovery[key]):
                raise ValueError(f"invalid cdnDiscovery resource path: {file}")
        if not master_version_endpoint or not value.get("masterRemoteRoot") or offline or closed:
            raise ValueError(f"cdnDiscovery requires a live Master service: {file}")
    announcements = value.get("announcements", {})
    if not isinstance(announcements, dict):
        raise ValueError(f"invalid announcements block: {file}")
    unknown_announcements = sorted(set(announcements) - {"endpoint", "serverList", "proxyEnv", "language", "hostSuffixes"})
    if unknown_announcements:
        raise ValueError(
            f"unknown announcements fields in {file}: {unknown_announcements}"
        )
    announcements_endpoint = str(announcements.get("endpoint", "")).strip()
    announcements_language = str(announcements.get("language", "")).strip()
    if announcements_language and not re.fullmatch(r"[a-z]{2,8}(?:-[A-Za-z0-9]{1,8})*", announcements_language):
        raise ValueError(f"announcements.language must be an explicit source language tag: {file}")
    announcements_proxy_env = str(announcements.get("proxyEnv", "")).strip()
    if announcements_proxy_env and not ENV_NAME.fullmatch(announcements_proxy_env):
        raise ValueError(f"announcements.proxyEnv must be an environment variable name: {file}")
    if announcements_endpoint:
        _validate_service_endpoint(announcements_endpoint, file)
    server_list = announcements.get("serverList", {})
    if not isinstance(server_list, dict):
        raise ValueError(f"invalid announcements.serverList block: {file}")
    unknown_server_list = sorted(set(server_list) - {"regions"})
    if unknown_server_list:
        raise ValueError(
            f"unknown announcements.serverList fields in {file}: {unknown_server_list}"
        )
    announcements_regions: list[AnnouncementRegion] = []
    host_suffixes = announcements.get("hostSuffixes", [])
    if not isinstance(host_suffixes, list) or any(
        not isinstance(suffix, str) or suffix.count(".") < 2
        or not re.fullmatch(r"\.[a-z0-9]+(?:[.-][a-z0-9]+)*", suffix)
        for suffix in host_suffixes
    ):
        raise ValueError(f"invalid announcements host allowlist: {file}")
    region_names: set[str] = set()
    regions_value = server_list.get("regions", {})
    if not isinstance(regions_value, dict):
        raise ValueError(f"invalid announcements.serverList.regions block: {file}")
    for name, region in regions_value.items():
        if (
            not isinstance(name, str)
            or not name.strip()
            or not isinstance(region, dict)
        ):
            raise ValueError(f"invalid announcements server region in {file}")
        normalized_name = name.strip().casefold()
        if normalized_name in region_names:
            raise ValueError(f"duplicate announcements server region name: {file}")
        region_names.add(normalized_name)
        if set(region) != {"id", "language"}:
            raise ValueError(f"invalid announcements server region fields in {file}")
        region_id = region.get("id")
        language = region.get("language")
        if (
            not isinstance(region_id, str)
            or not SERVER_ID.fullmatch(region_id)
            or not isinstance(language, str)
            or not re.fullmatch(r"[a-z]{2,8}(?:-[A-Za-z0-9]{1,8})*", language)
        ):
            raise ValueError(
                f"invalid announcements server region id or language in {file}"
            )
        announcements_regions.append(
            AnnouncementRegion(name.strip(), region_id, language)
        )
    if server_list:
        if not host_suffixes:
            raise ValueError(f"announcements.serverList requires hostSuffixes: {file}")
        if not announcements_endpoint:
            raise ValueError(
                f"announcements.serverList requires announcements.endpoint: {file}"
            )
        if not announcements_regions:
            raise ValueError(f"announcements.serverList requires regions: {file}")
        if len({region.id for region in announcements_regions}) != len(
            announcements_regions
        ):
            raise ValueError(f"duplicate announcements server region id: {file}")
    if asset_version and not version_endpoint:
        raise ValueError(f"assetVersion requires its own endpoint: {file}")
    version_catalog_path = str(asset_version.get("catalogPath", "")).strip()
    if version_endpoint or asset_version:
        if (
            not version_catalog_path.startswith("/")
            or "{version}" not in version_catalog_path
            or "{hash}" not in version_catalog_path
            or "\\" in version_catalog_path
            or ".." in version_catalog_path.split("/")
            or any(
                part in {".", ".."} for part in unquote(version_catalog_path).split("/")
            )
            or unquote(unquote(version_catalog_path)) != unquote(version_catalog_path)
        ):
            raise ValueError(
                f"assetVersion.catalogPath must be an absolute path with {{version}} and {{hash}}: {file}"
            )
    version_basic_user = str(asset_version.get("basicUser", "")).strip()
    if asset_version and (not version_basic_user or ":" in version_basic_user):
        raise ValueError(
            f"assetVersion.basicUser must be a non-empty user name without ':' : {file}"
        )
    catalog = value.get("catalog", {})
    if not isinstance(catalog, dict):
        raise ValueError(f"invalid catalog block: {file}")
    catalog_version = str(catalog.get("version", "")).strip()
    if catalog_version and not re.fullmatch(r"[A-Za-z0-9._-]+", catalog_version):
        raise ValueError(f"invalid catalog.version: {file}")
    raw_locales = catalog.get("locales", [])
    if not isinstance(raw_locales, list):
        raise ValueError(f"invalid catalog.locales: {file}")
    catalog_locales = tuple(
        part for part in (str(item).strip() for item in raw_locales) if part
    )
    if any(not re.fullmatch(r"[A-Za-z0-9-]+", locale) for locale in catalog_locales):
        raise ValueError(f"invalid catalog.locales entry: {file}")
    master_remote_root = value.get("masterRemoteRoot", "")
    if not isinstance(master_remote_root, str):
        raise ValueError(f"invalid masterRemoteRoot: {file}")
    if master_remote_root and not master_version_endpoint:
        raise ValueError(f"masterRemoteRoot requires masterVersionEndpoint: {file}")
    if master_version_endpoint and not master_remote_root:
        raise ValueError(f"masterVersionEndpoint requires masterRemoteRoot: {file}")
    if master_remote_root:
        master_url = urlsplit(master_remote_root)
        asset_url = urlsplit(value.get("remoteRoot", ""))
        if (
            master_url.scheme != "https"
            or not master_url.hostname
            or master_url.netloc != asset_url.netloc
            or master_url.username is not None
            or master_url.password is not None
            or master_url.query
            or master_url.fragment
            or "\\" in master_url.path
            or unquote(master_url.path) != master_url.path
            or any(part in {".", ".."} for part in master_url.path.split("/"))
        ):
            raise ValueError(
                f"masterRemoteRoot must use the configured CDN origin: {file}"
            )
    bundle_crypto = value.get("bundleCrypto")
    if (not isinstance(bundle_crypto, dict) or set(bundle_crypto) != {"key", "nonceSeed"}
        or not isinstance(bundle_crypto.get("key"), str)
        or not re.fullmatch(r"[a-f0-9]{32}", bundle_crypto["key"])
        or not isinstance(bundle_crypto.get("nonceSeed"), str)
        or not re.fullmatch(r"[a-f0-9]{16}", bundle_crypto["nonceSeed"])):
        raise ValueError(f"invalid bundleCrypto: {file}")
    if not isinstance(value.get("packageAcquisition", {}), dict):
        raise ValueError(f"invalid packageAcquisition: {file}")
    return ServerConfig(
        id=server,
        package_name=value["packageName"],
        platform=value["platform"],
        unity_version=value["unityVersion"],
        extraction_shards=shards,
        r2_bucket=value["r2Bucket"],
        release_retention=retention,
        authorization_required=authorization_required,
        offline=offline,
        closed=closed,
        skip_public_resolution_check=skip_public_resolution_check,
        remote_root=value.get("remoteRoot", "").rstrip("/"),
        version_endpoint=version_endpoint,
        version_catalog_path=version_catalog_path,
        version_basic_user=version_basic_user,
        version_proxy_env=version_proxy_env,
        cri_hca_key=str(value.get("criHcaKey", "")),
        master_crypto=crypto,
        catalog_version=catalog_version,
        catalog_locales=catalog_locales,
        file=file,
        master_remote_root=master_remote_root.rstrip("/"),
        master_version_endpoint=master_version_endpoint,
        announcements_endpoint=announcements_endpoint,
        announcements_regions=tuple(announcements_regions),
        announcements_proxy_env=announcements_proxy_env,
        announcements_language=announcements_language,
        package_acquisition=value.get("packageAcquisition", {}),
        bundle_crypto=bundle_crypto,
        announcements_host_suffixes=tuple(host_suffixes),
        authorization_env=authorization_env,
        cri_compatibility_key_sha256=compatible_key_sha,
        cdn_discovery=cdn_discovery,
        remote_root_mirrors=mirrors["remoteRootMirrors"],
        master_remote_root_mirrors=mirrors["masterRemoteRootMirrors"],
    )


def main() -> None:
    import argparse
    from core.private_config import github_masks

    parser = argparse.ArgumentParser(description="Validate private pipeline configuration and print operational flags.")
    parser.add_argument("--server", required=True)
    parser.add_argument("--field", choices=("extraction-shards", "has-master", "has-announcements"))
    parser.add_argument("--mask-github", action="store_true")
    args = parser.parse_args()
    config = load_server_config(args.server)
    if args.mask_github:
        for command in github_masks(load_private_settings(args.server, config.file)):
            print(command)
        return
    summary = {"server": config.id, "extraction-shards": config.extraction_shards,
               "has-master": bool(config.master_remote_root), "has-announcements": bool(config.announcements_endpoint)}
    print(json.dumps(summary[args.field] if args.field else summary))


if __name__ == "__main__":
    main()
