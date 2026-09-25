"""Discover production Android packages before staging them in R2.

The international publisher serves a direct APK from its own website. The
Japanese publisher links only to Google Play, so the JP transport is an APKPure
XAPK mirror whose direct-download link embeds the Play versionCode.
"""

from __future__ import annotations

import argparse
import hashlib
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
JP_MIRROR = "https://apkpure.com/bang-dream-our-notes/com.bushiroad.sirius/download"
JP_XAPK_LINK = re.compile(r"https://d\.apkpure\.com/b/XAPK/com\.bushiroad\.sirius\?versionCode=(\d+)")
SERVERS = ("jp", "intl")


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


def _discover_intl() -> tuple[str, str, set[str], dict[str, str]]:
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
    filename = url.rsplit("/", 1)[-1]
    version = re.search(r"(\d+\.\d+\.\d+)", filename)
    fingerprint = {"file": filename}
    if version:
        fingerprint["versionName"] = version.group(1)
    return url, "publisher-website", {host}, fingerprint


def _discover_jp() -> tuple[str, str, set[str], dict[str, str]]:
    page = _read_small(JP_MIRROR, {"apkpure.com"})
    # The download page embeds the direct XAPK link once per variant; the
    # versionCode query parameter is the authoritative Play versionCode.
    codes = set(JP_XAPK_LINK.findall(page))
    if not codes:
        raise ValueError("Japanese mirror exposed no XAPK download variant")
    code = max(int(value) for value in codes)
    version = re.search(r'data-dt-version="([^"]+)"', page)
    fingerprint = {"versionCode": str(code)}
    if version:
        fingerprint["versionName"] = version.group(1)
    return (
        f"https://d.apkpure.com/b/XAPK/com.bushiroad.sirius?versionCode={code}",
        "apkpure-mirror",
        {"d.apkpure.com", "data.winudf.com"},
        fingerprint,
    )


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
    parser.add_argument("--output", type=Path)
    parser.add_argument("--probe", action="store_true", help="discover the publisher fingerprint without downloading")
    args = parser.parse_args()
    url, provenance, hosts, fingerprint = _discover_intl() if args.server == "intl" else _discover_jp()
    if args.probe:
        print(json.dumps({"server": args.server, "provenance": provenance, **fingerprint}, sort_keys=True))
        return 0
    if not args.output:
        parser.error("--output is required unless --probe is given")
    size, digest = _download(url, hosts, args.output)
    print(json.dumps({
        "server": args.server,
        "provenance": provenance,
        **fingerprint,
        "bytes": size,
        "sha256": digest,
        "casKey": cas_key(digest),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
