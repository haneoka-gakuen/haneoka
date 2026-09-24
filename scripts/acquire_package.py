"""Discover production Android packages before staging them in R2.

The international publisher serves a direct APK from its own website. The
Japanese publisher links only to Google Play, so the JP transport is a Play
split-package mirror. Package bytes receive a fresh SHA-256 CAS key each run.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from core.contracts import PACKAGE_MAX_BYTES
from core.storage import cas_key

USER_AGENT = "HaneokaResourcePipeline/1.0"
INTL_SITE = "https://bdon.biligames.com/"
JP_MIRROR = "https://apkcombo.com/bang-dream-our-notes/com.bushiroad.sirius/download/apk"
SERVERS = ("intl", "jp")


def _host(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("package source must use an ordinary HTTPS URL")
    return (parsed.hostname or "").lower()


class _AllowedRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, hosts: set[str]):
        self.hosts = hosts

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        resolved = urllib.parse.urljoin(request.full_url, newurl)
        if _host(resolved) not in self.hosts:
            raise ValueError("package download redirected outside its verified hosts")
        return super().redirect_request(request, fp, code, msg, headers, resolved)


def _open(url: str, hosts: set[str]):
    if _host(url) not in hosts:
        raise ValueError("package source host is not allowed")
    opener = urllib.request.build_opener(_AllowedRedirects(hosts))
    response = opener.open(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=180)
    if _host(response.geturl()) not in hosts:
        response.close()
        raise ValueError("package source resolved outside its verified hosts")
    return response


def _read_small(url: str, hosts: set[str], limit: int = 2_000_000) -> str:
    with _open(url, hosts) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("package discovery document is unexpectedly large")
    return data.decode("utf-8")


def _discover_intl() -> tuple[str, str, set[str]]:
    page = _read_small(INTL_SITE, {"bdon.biligames.com"})
    scripts = re.findall(
        r"(?:https?:)?//s1\.biligames\.com/fe-static/game-global-bangdreamon/gw/js/chunk-common\.[a-f0-9]+\.js",
        page,
    )
    if len(set(scripts)) != 1:
        raise ValueError("international official site did not expose one application script")
    script_url = "https:" + scripts[0] if scripts[0].startswith("//") else scripts[0]
    script = _read_small(script_url, {"s1.biligames.com"})
    urls = set(re.findall(r"https://l\d+-pkg-download\.biligames\.com/sirius/apk/[A-Za-z0-9_.-]+\.apk", script))
    if len(urls) != 1:
        raise ValueError("international official site did not expose one APK URL")
    url = urls.pop()
    host = _host(url)
    return url, "publisher-website", {host}


def _discover_jp() -> tuple[str, str, set[str]]:
    page = _read_small(JP_MIRROR, {"apkcombo.com"})
    variants = []
    for match in re.finditer(r'<a\s+href="([^"]+)"\s+class="variant"[^>]*>(.*?)</a>', page, re.S):
        body = match.group(2)
        code_match = re.search(r'class="vercode">\((\d+)\)', body)
        if not code_match or "type-xapk" not in body:
            continue
        wrapper = urllib.parse.urlsplit(html.unescape(match.group(1)))
        if wrapper.scheme != "https" or wrapper.hostname != "apkcombo.com" or wrapper.path != "/d":
            continue
        values = urllib.parse.parse_qs(wrapper.query).get("u", [])
        if len(values) != 1:
            continue
        url = base64.b64decode(values[0], validate=True).decode("utf-8")
        if _host(url) != "download.pureapk.com":
            continue
        variants.append((int(code_match.group(1)), url))
    if not variants:
        raise ValueError("Japanese mirror has no verifiable XAPK variant")
    _, url = max(variants)
    return url, "play-package-mirror", {"download.pureapk.com", "data.winudf.com"}


def _download(url: str, hosts: set[str], output: Path) -> tuple[int, str]:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".part")
    digest = hashlib.sha256()
    total = 0
    try:
        with _open(url, hosts) as response, temporary.open("wb") as target:
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > PACKAGE_MAX_BYTES:
                raise ValueError("package exceeds the pipeline size limit")
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                total += len(chunk)
                if total > PACKAGE_MAX_BYTES:
                    raise ValueError("package exceeds the pipeline size limit")
                digest.update(chunk)
                target.write(chunk)
            if declared and total != int(declared):
                raise ValueError("package download length mismatch")
        if total < 1:
            raise ValueError("empty package download")
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return total, digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=SERVERS, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    url, provenance, hosts = _discover_intl() if args.server == "intl" else _discover_jp()
    size, digest = _download(url, hosts, args.output)
    print(json.dumps({
        "server": args.server,
        "provenance": provenance,
        "bytes": size,
        "sha256": digest,
        "casKey": cas_key(digest),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
