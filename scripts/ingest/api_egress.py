# L3 — GEB
# Input: Production JP API/CDN requests and job-local proxy controller settings.
# Output: Bounded exit failover; callers retain download and payload validation.
# Pos: [Map](L2-2.md); shared resource and announcement transport.
# Effects/Dependencies: curl, urllib, loopback Mihomo selector API and a job-local lock.
"""Rotate production JP resource exits after network or access failures."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Any

RETRYABLE_CURL_CODES = frozenset({5, 6, 7, 18, 28, 35, 52, 55, 56, 92})
_HTTP_FAILURES = {403, 407, 502, 503, 504}
_READ_PATHS = {
    "/app.masterdata.MasterdataService/Version",
    "/app.announcement.AnnouncementService/GetList",
    "/app.announcement.AnnouncementService/Get",
}
_LOCK = threading.Lock()


@contextmanager
def _selector_lock():
    import fcntl

    with _LOCK, Path(os.environ["JP_VERSION_PROXY_LOCK"]).open("a") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        yield


def _controller(method: str = "GET", node: str | None = None) -> dict[str, Any]:
    root = os.environ["JP_VERSION_PROXY_CONTROLLER"].rstrip("/")
    parsed = urllib.parse.urlsplit(root)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
        raise ValueError("JP proxy controller must use loopback HTTP")
    request = urllib.request.Request(
        root + "/proxies/JP-EGRESS", method=method,
        data=json.dumps({"name": node}).encode() if node is not None else None,
        headers={"Authorization": "Bearer " + os.environ["JP_VERSION_PROXY_SECRET"],
                 "Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=5) as response:
        payload = response.read()
    return json.loads(payload) if payload else {}


def _nodes(group: dict[str, Any]) -> list[str]:
    priority = ("JP-M1", "JP-M2", "JP-Z1", "JP-G1")
    return sorted(dict.fromkeys(group["all"]), key=lambda node: (
        next((i for i, part in enumerate(priority) if part in node), len(priority)), node,
    ))[:8]


def next_cdn_opener(url: str, visited: set[str], *handlers) -> urllib.request.OpenerDirector | None:
    target = urllib.parse.urlsplit(url)
    proxy = os.environ.get("JP_VERSION_PROXY")
    if (target.scheme != "https" or target.hostname != "static.bang-dream-on.jp"
            or not proxy or not os.environ.get("JP_VERSION_PROXY_CONTROLLER")):
        return None
    with _selector_lock():
        group = _controller()
        remaining = [node for node in _nodes(group) if node not in visited]
        if not remaining:
            return None
        node = group["now"] if group["now"] in remaining else remaining[0]
        _controller("PUT", node)
        visited.add(node)
    print(f"JP CDN egress: trying {node}", file=sys.stderr)
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy, "https": proxy}), *handlers,
    )


def _http_status(command: list[str], stdout: bytes) -> int | None:
    headers = stdout
    for option in ("-D", "--dump-header"):
        if option in command:
            filename = command[command.index(option) + 1]
            if filename != "-":
                path = Path(filename)
                headers = path.read_bytes() if path.exists() else b""
            break
    statuses = re.findall(rb"^HTTP/\S+\s+(\d{3})", headers, re.MULTILINE)
    return int(statuses[-1]) if statuses else None


def run_api_curl(
    command: list[str], *, proxy: str | None, input: bytes, timeout: float,
    capture_output: bool = True, check: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    target = urllib.parse.urlsplit(command[-1])
    managed = (
        proxy and proxy == os.environ.get("JP_VERSION_PROXY")
        and os.environ.get("JP_VERSION_PROXY_CONTROLLER")
        and target.hostname == "api.bang-dream-on.jp" and target.path in _READ_PATHS
    )
    if not managed:
        return subprocess.run(command, input=input, timeout=timeout, capture_output=capture_output, check=check)
    visited: set[str] = set()
    attempts = 0
    while True:
        attempts += 1
        with _selector_lock():
            group = _controller()
            node = group["now"]
        visited.add(node)
        try:
            result: subprocess.CompletedProcess[bytes] | subprocess.TimeoutExpired = subprocess.run(
                command, input=input, timeout=timeout, capture_output=capture_output, check=check,
            )
        except subprocess.TimeoutExpired as error:
            result = error
            failure = "timeout"
        else:
            status = _http_status(command, result.stdout)
            if result.returncode not in RETRYABLE_CURL_CODES and not (
                result.returncode == 0 and status in _HTTP_FAILURES
            ):
                return result
            failure = f"curl {result.returncode}" if result.returncode else f"HTTP {status}"
        with _selector_lock():
            group = _controller()
            if group["now"] not in visited and attempts < 8:
                continue
            remaining = [item for item in _nodes(group) if item not in visited]
            if not remaining or attempts >= 8:
                if isinstance(result, subprocess.TimeoutExpired):
                    raise result
                return result
            selected = remaining[0]
            _controller("PUT", selected)
            print(f"JP API egress: {node} failed ({failure}); trying {selected}", file=sys.stderr)


def select_preferred_exit() -> None:
    with _selector_lock():
        nodes = _nodes(_controller())
        if not nodes:
            raise RuntimeError("subscription has no Japanese exits")
        _controller("PUT", nodes[0])
