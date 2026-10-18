"""Resolve the configured environment's live resource and Master endpoints."""

from __future__ import annotations

import re
import socket
import subprocess
import tempfile
import urllib.error
from dataclasses import replace
from pathlib import Path
from urllib.parse import urlsplit

from acquire_package import discover_package
from build.announcements import (
    GrpcResponseError, _decode_fields, _first, _grpc_body, _text, _trusted_bootstrap_urls,
)
from core.config import ServerConfig
from core.private_config import github_masks
from ingest.apks import _request
from ingest.master import discover_master_version
from ingest.version_api import (
    DiscoveryUnavailable,
    RETRYABLE_HTTP_STATUS,
    _public_https,
    curl_transport_error,
    is_versioned_catalog_version,
    proxy_curl_flags,
    proxy_from_env,
)


def resolve_resource_endpoints(config: ServerConfig, settings: dict) -> tuple[dict, dict]:
    discovery = config.cdn_discovery
    if not discovery:
        return settings, {"server": config.id, "resolved": False}
    proxy = proxy_from_env(config.version_proxy_env)
    proxy_curl_flags(proxy)
    suffixes = tuple(discovery["hostSuffixes"])
    previous_api = urlsplit(config.master_version_endpoint)
    preferred_api = f"{previous_api.scheme}://{previous_api.netloc}"
    discovery_reason = ""
    client_version = discovery["clientVersion"]
    client_version_source = "configured"
    publisher_unavailable = ""
    if config.package_acquisition:
        try:
            _url, _provenance, _hosts, fingerprint = discover_package(config.package_acquisition)
        except urllib.error.HTTPError as error:
            if error.code not in RETRYABLE_HTTP_STATUS:
                raise
            publisher_unavailable = "service"
        except urllib.error.URLError as error:
            if not isinstance(error.reason, (TimeoutError, ConnectionError, socket.gaierror)):
                raise
            publisher_unavailable = "transport"
        except TimeoutError:
            publisher_unavailable = "timeout"
        else:
            client_version = fingerprint.get("versionName", "")
            if not re.fullmatch(r"\d+(?:\.\d+){1,3}", client_version):
                raise ValueError("publisher package has no valid client version for server discovery")
            client_version_source = "publisher"
    try:
        _public_https(discovery["endpoint"], config.skip_public_resolution_check)
        body = _grpc_body(
            discovery["endpoint"], b"",
            {"x-platform": config.platform, "x-client-version": client_version},
            attempts=2, proxy=proxy,
        )
    except GrpcResponseError as error:
        if error.status != "2" or error.message != "client update required":
            raise
        discovery_reason = "client-update-required"
    except DiscoveryUnavailable as error:
        discovery_reason = error.reason
    if discovery_reason:
        asset_roots = _trusted_bootstrap_urls(
            "|".join((config.remote_root, *config.remote_root_mirrors)),
            allow_path=True, host_suffixes=suffixes,
        )
        master_roots = set(_trusted_bootstrap_urls(
            "|".join((config.master_remote_root, *config.master_remote_root_mirrors)),
            allow_path=True, host_suffixes=suffixes,
        ))
        cdns = tuple(root.removesuffix(discovery["assetPath"]) for root in asset_roots
                     if root.endswith(discovery["assetPath"])
                     and root.removesuffix(discovery["assetPath"]) + discovery["masterPath"] in master_roots)
        apis = _trusted_bootstrap_urls(preferred_api, allow_path=False, host_suffixes=suffixes)
        if not cdns or not apis:
            raise ValueError("configured fallback has no allowed matching resource and Master endpoints")
    else:
        records = []
        for item in _decode_fields(body).get(1, []):
            if isinstance(item, bytes):
                fields = _decode_fields(item)
                if _text(_first(fields, 1)).strip() == discovery["environment"]:
                    records.append(fields)
        if len(records) != 1:
            raise ValueError("server discovery did not return exactly one configured environment")
        cdns = _trusted_bootstrap_urls(_text(_first(records[0], 2)), allow_path=True, host_suffixes=suffixes)
        apis = _trusted_bootstrap_urls(_text(_first(records[0], 3)), allow_path=False, host_suffixes=suffixes)
        if not cdns or not apis:
            raise ValueError("server discovery returned no allowed resource or Master endpoint")
    api = preferred_api if preferred_api in apis else apis[0]
    master_endpoint = api + previous_api.path
    github_masks({"cdnRoots": list(cdns), "apiRoots": list(apis), "masterEndpoint": master_endpoint})
    master_version, resource_version = discover_master_version(
        master_endpoint, skip_resolution_check=config.skip_public_resolution_check, proxy=proxy,
    )
    if not is_versioned_catalog_version(resource_version):
        raise ValueError("server discovery returned an unsupported resource version")
    # Check a tiny real catalog hash before choosing a node. curl bounds the
    # complete connection across all DNS addresses, unlike urllib's socket timeout.
    selected = None
    failures = []
    hard_failure = False
    for index, cdn in enumerate(cdns):
        candidate = replace(config, remote_root=cdn + discovery["assetPath"])
        request = _request(f"{candidate.remote_root}/catalog_{resource_version}.hash", candidate)
        arguments = [item for name, value in request.header_items() for item in ("-H", f"{name}: {value}")]
        with tempfile.TemporaryDirectory(prefix="haneoka-cdn-bootstrap-") as directory:
            output = Path(directory) / "hash"
            try:
                result = subprocess.run(
                    ["curl", "-sS", "--connect-timeout", "5", "--max-time", "12",
                     "--max-filesize", "1024", "-o", str(output), "-w", "%{http_code}",
                     *arguments, request.full_url],
                    capture_output=True, timeout=17, check=False,
                )
            except subprocess.TimeoutExpired:
                failures.append(f"node {index + 1}: process timeout")
                continue
            if result.returncode == 0 and result.stdout == b"200":
                if not output.is_file() or not re.fullmatch(rb"[a-fA-F0-9]{32}\s*", output.read_bytes()):
                    raise ValueError("resource CDN returned an invalid catalog hash")
                selected = (index, cdn)
                break
            status = result.stdout.decode("ascii", "replace").strip() or "unknown"
            failures.append(f"node {index + 1}: HTTP {status}, curl {result.returncode}")
            if result.returncode:
                hard_failure |= not isinstance(curl_transport_error("catalog", result.returncode), DiscoveryUnavailable)
            else:
                hard_failure |= not (status.isdecimal() and int(status) in RETRYABLE_HTTP_STATUS)
    if selected is None:
        message = (
            "all resource CDN nodes failed the bounded catalog hash check "
            f"(resource {resource_version}; {'; '.join(failures)})"
        )
        if hard_failure:
            raise RuntimeError(message)
        raise DiscoveryUnavailable("service", message)
    index, cdn = selected
    resolved = {**settings, "remoteRoot": cdn + discovery["assetPath"],
                "masterRemoteRoot": cdn + discovery["masterPath"],
                "masterVersionEndpoint": master_endpoint,
                "remoteRootMirrors": [root + discovery["assetPath"] for root in cdns if root != cdn],
                "masterRemoteRootMirrors": [root + discovery["masterPath"] for root in cdns if root != cdn]}
    return resolved, {"server": config.id, "resolved": True, "cdnCandidates": len(cdns),
                      "selectedNode": index + 1, "resourceVersion": resource_version,
                      "masterVersion": master_version,
                      "clientVersion": client_version, "clientVersionSource": client_version_source,
                      **({"publisherUnavailable": publisher_unavailable} if publisher_unavailable else {}),
                      "endpointDiscovery": "configured" if discovery_reason else "live",
                      **({"discoveryReason": discovery_reason} if discovery_reason else {}),
                      "endpointsChanged": any(resolved[key] != settings.get(key) for key in
                                              ("remoteRoot", "masterRemoteRoot", "masterVersionEndpoint"))}
