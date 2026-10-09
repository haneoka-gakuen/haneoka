"""Resolve the configured environment's live resource and Master endpoints."""

from __future__ import annotations

import re
import subprocess
import tempfile
from dataclasses import replace
from pathlib import Path
from urllib.parse import urlsplit

from build.announcements import _decode_fields, _first, _grpc_body, _text, _trusted_bootstrap_urls
from core.config import ServerConfig
from core.private_config import github_masks
from ingest.apks import _request
from ingest.master import discover_master_version
from ingest.version_api import _public_https, proxy_from_env


def resolve_resource_endpoints(config: ServerConfig, settings: dict) -> tuple[dict, dict]:
    discovery = config.cdn_discovery
    if not discovery:
        return settings, {"server": config.id, "resolved": False}
    _public_https(discovery["endpoint"], config.skip_public_resolution_check)
    proxy = proxy_from_env(config.version_proxy_env)
    body = _grpc_body(
        discovery["endpoint"], b"",
        {"x-platform": config.platform, "x-client-version": discovery["clientVersion"]},
        attempts=2, proxy=proxy,
    )
    records = []
    for item in _decode_fields(body).get(1, []):
        if isinstance(item, bytes):
            fields = _decode_fields(item)
            if _text(_first(fields, 1)).strip() == discovery["environment"]:
                records.append(fields)
    if len(records) != 1:
        raise ValueError("server discovery did not return exactly one configured environment")
    suffixes = tuple(discovery["hostSuffixes"])
    cdns = _trusted_bootstrap_urls(_text(_first(records[0], 2)), allow_path=True, host_suffixes=suffixes)
    apis = _trusted_bootstrap_urls(_text(_first(records[0], 3)), allow_path=False, host_suffixes=suffixes)
    if not cdns or not apis:
        raise ValueError("server discovery returned no allowed resource or Master endpoint")
    previous_api = urlsplit(config.master_version_endpoint)
    preferred_api = f"{previous_api.scheme}://{previous_api.netloc}"
    api = preferred_api if preferred_api in apis else apis[0]
    master_endpoint = api + previous_api.path
    github_masks({"cdnRoots": list(cdns), "apiRoots": list(apis), "masterEndpoint": master_endpoint})
    _master_version, resource_version = discover_master_version(
        master_endpoint, skip_resolution_check=config.skip_public_resolution_check, proxy=proxy,
    )
    if not re.fullmatch(r"\d+(?:\.\d+){3}", resource_version):
        raise ValueError("server discovery returned an unsupported resource version")
    # Check a tiny real catalog hash before choosing a node. curl bounds the
    # complete connection across all DNS addresses, unlike urllib's socket timeout.
    selected = None
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
                continue
            if result.returncode == 0 and result.stdout == b"200" and output.is_file() and re.fullmatch(
                rb"[a-fA-F0-9]{32}\s*", output.read_bytes(),
            ):
                selected = (index, cdn)
                break
    if selected is None:
        raise RuntimeError("all announced CDN nodes failed the bounded catalog hash check; retaining the published release")
    index, cdn = selected
    resolved = {**settings, "remoteRoot": cdn + discovery["assetPath"],
                "masterRemoteRoot": cdn + discovery["masterPath"],
                "masterVersionEndpoint": master_endpoint,
                "remoteRootMirrors": [root + discovery["assetPath"] for root in cdns if root != cdn],
                "masterRemoteRootMirrors": [root + discovery["masterPath"] for root in cdns if root != cdn]}
    return resolved, {"server": config.id, "resolved": True, "cdnCandidates": len(cdns),
                      "selectedNode": index + 1, "resourceVersion": resource_version,
                      "endpointsChanged": any(resolved[key] != settings.get(key) for key in
                                              ("remoteRoot", "masterRemoteRoot", "masterVersionEndpoint"))}
