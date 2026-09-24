"""Discover and verify production Android packages before staging them in R2.

The international publisher serves a direct APK from its own website. The
Japanese publisher links only to Google Play, so the JP transport is a Play
split-package mirror. Its signing certificate is pinned; a changed or
incomplete mirror package stops the scheduled run.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from apkutils2 import APK

from core.contracts import PACKAGE_MAX_BYTES
from core.storage import cas_key

USER_AGENT = "HaneokaResourcePipeline/1.0"
INTL_SITE = "https://bdon.biligames.com/"
JP_MIRROR = "https://apkcombo.com/bang-dream-our-notes/com.bushiroad.sirius/download/apk"
PACKAGE_NAMES_AND_SIGNING_CERT_SHA256 = {
    "intl": ("com.bilibili.sirius.official", "bf683e367551a3f629b90e16a63b315af74e387bcc5d94f26dcd626e7eea3637"),
    "jp": ("com.bushiroad.sirius", "34fd32c2860f454dd320930f6ba0876ea8cc8e60a3d8320b3277aa761072508e"),
}


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


def _discover_intl() -> tuple[str, str, set[str], int | None]:
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
    return url, "publisher-website", {host}, None


def _discover_jp() -> tuple[str, str, set[str], int | None]:
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
    version, url = max(variants)
    return url, "play-package-mirror", {"download.pureapk.com", "data.winudf.com"}, version


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


def _apksigner() -> Path:
    direct = shutil.which("apksigner")
    if direct:
        return Path(direct)
    for root_name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        root = os.environ.get(root_name)
        if root:
            candidates = sorted(Path(root).glob("build-tools/*/apksigner"), reverse=True)
            if candidates:
                return candidates[0]
    raise RuntimeError("Android apksigner is required to verify package signatures")


def _verify_apk(file: Path, package_name: str, certificate: str, signer: Path) -> int:
    result = subprocess.run(
        [str(signer), "verify", "--print-certs", str(file)],
        capture_output=True,
        text=True,
        check=True,
    )
    signatures = re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})$", result.stdout, re.M)
    if signatures != [certificate]:
        raise ValueError("APK signing certificate changed or has multiple signers")
    manifest = APK(str(file)).get_manifest()
    if manifest.get("@package") != package_name:
        raise ValueError("APK package name does not match the selected server")
    version = int(manifest.get("@android:versionCode", 0))
    if version < 1:
        raise ValueError("APK has no valid version code")
    return version


def _validate_package(file: Path, server: str, expected_version: int | None) -> int:
    package_name, certificate = PACKAGE_NAMES_AND_SIGNING_CERT_SHA256[server]
    signer = _apksigner()
    with zipfile.ZipFile(file) as archive, tempfile.TemporaryDirectory(prefix="haneoka-apk-verify-") as temporary:
        members = {item.filename for item in archive.infolist()}
        if server == "intl":
            if "AndroidManifest.xml" not in members:
                raise ValueError("international download is not an APK")
            version = _verify_apk(file, package_name, certificate, signer)
            asset_archive = archive
        else:
            if "manifest.json" not in members:
                raise ValueError("Japanese download is not an XAPK")
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("package_name") != package_name:
                raise ValueError("XAPK package name does not match Japan production")
            apk_names = sorted(name for name in members if name.endswith(".apk"))
            if not apk_names or "UnityDataAssetPack.apk" not in members:
                raise ValueError("XAPK omits its Unity asset pack")
            base_name = f"{package_name}.apk"
            if base_name not in apk_names:
                raise ValueError("XAPK omits its base APK")
            versions = set()
            for name in apk_names:
                target = Path(temporary) / Path(name).name
                if target.name != name:
                    raise ValueError("XAPK contains a nested APK path")
                with archive.open(name) as source, target.open("wb") as destination:
                    shutil.copyfileobj(source, destination, 1024 * 1024)
                versions.add(_verify_apk(target, package_name, certificate, signer))
            if len(versions) != 1:
                raise ValueError("XAPK split APK version codes disagree")
            version = versions.pop()
            if int(manifest.get("version_code", 0)) != version:
                raise ValueError("XAPK manifest version code disagrees with signed APKs")
            asset_archive = zipfile.ZipFile(Path(temporary) / "UnityDataAssetPack.apk")
        if expected_version and version != expected_version:
            raise ValueError("mirror page version code disagrees with signed APK")
        try:
            names = asset_archive.namelist()
            if not any(name.startswith("assets/Master/") and name.endswith(".bin") for name in names):
                raise ValueError("package omits encrypted Master tables")
            if "assets/aa/catalog.bin" not in names and "assets/aa/Android/catalog_main.bin" not in names:
                raise ValueError("package omits its embedded Addressables catalog")
        finally:
            if asset_archive is not archive:
                asset_archive.close()
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=sorted(PACKAGE_NAMES_AND_SIGNING_CERT_SHA256), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    url, provenance, hosts, expected_version = _discover_intl() if args.server == "intl" else _discover_jp()
    size, digest = _download(url, hosts, args.output)
    try:
        version = _validate_package(args.output, args.server, expected_version)
    except BaseException:
        args.output.unlink(missing_ok=True)
        raise
    print(json.dumps({
        "server": args.server,
        "provenance": provenance,
        "versionCode": version,
        "bytes": size,
        "sha256": digest,
        "casKey": cas_key(digest),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
