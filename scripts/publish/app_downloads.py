# L3 — GEB
# Input: GitHub 正式应用发布及 R2 下载桶。
# Output: 经摘要校验的不可变镜像、分发清单和最后切换的最新指针。
# Pos: [Map](L2-2.md)；Haneoka 安装包镜像发布器。
# Effects/Dependencies: 下载 GitHub 附件、流式读写文件及 R2；不修改安装包签名。
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

from download_store import DownloadStore, json_bytes

REPOSITORY = "haneoka-gakuen/haneoka-app"
ORIGIN = "https://haneoka.org/downloads/app/"
FEEDS = {"altstore-source.json", "scoop-haneoka.json", "Haneoka.Haneoka.installer.yaml", "haneoka.rb",
         "haneoka-windows-x64.appinstaller", "haneoka-windows-arm64.appinstaller"}


def github_release():
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "HaneokaDownloads"}
    if os.environ.get("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    with urlopen(Request(f"https://api.github.com/repos/{REPOSITORY}/releases/latest", headers=headers), timeout=30) as response:
        release = json.load(response)
    if release["draft"] or release["prerelease"] or not re.fullmatch(r"v\d+\.\d+\.\d+", release["tag_name"]):
        raise ValueError("A published stable release is required")
    return release


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def mirror(store: DownloadStore, directory: Path):
    release = github_release()
    tag = release["tag_name"]
    source = {asset["name"]: asset["digest"] for asset in release["assets"]}
    previous = store.get_json("app/latest.json")
    if previous and previous.get("tag_name") == tag and previous.get("sourceAssets") == source:
        return {"release": tag, "changed": False}
    published = store.get_json(f"app/{tag}/release.json")
    if published:
        if published.get("sourceAssets") != source:
            raise ValueError("Published app release changed; publish a new version")
        store.put_bytes("app/latest.json", json_bytes(published), cache_control="public, max-age=60, must-revalidate")
        return {"release": tag, "changed": True, "assets": len(published["assets"])}
    directory.mkdir(parents=True, exist_ok=True)
    files = {}
    for asset in release["assets"]:
        name = asset["name"]
        if name != Path(name).name or not re.fullmatch(r"[A-Za-z0-9_.+-]+", name):
            raise ValueError("Invalid release filename")
        file = directory / name
        expected = asset["digest"]
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", expected or ""):
            raise ValueError(f"Missing release digest: {name}")
        if file.is_file() and name in FEEDS:
            original = file.read_text().replace(ORIGIN + tag + "/", f"https://github.com/{REPOSITORY}/releases/download/{tag}/")
            original = original.replace(ORIGIN + "latest/", f"https://github.com/{REPOSITORY}/releases/latest/download/")
            original = original.replace("https://haneoka.org/android-chrome-512x512.png",
                f"https://raw.githubusercontent.com/{REPOSITORY}/{tag}/assets/brand/android-chrome-512x512.png")
            if hashlib.sha256(original.encode()).hexdigest() == expected[7:]:
                file.write_text(original)
        if name == "SHA256SUMS":
            original = "".join(f"{value[7:]}  {key}\n" for key, value in sorted(source.items()) if key != name)
            if hashlib.sha256(original.encode()).hexdigest() == expected[7:]:
                file.write_text(original)
        if not file.is_file() or file.stat().st_size != asset["size"] or digest(file) != expected[7:]:
            file.unlink(missing_ok=True)
            urls = [asset["url"], asset["browser_download_url"]] if asset["size"] < 1024 * 1024 else [asset["browser_download_url"]]
            for url in urls:
                result = subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--retry-all-errors",
                    "--connect-timeout", "15", "--max-time", "90" if asset["size"] < 1024 * 1024 else "600",
                    "--silent", "--show-error", "--header", "Accept: application/octet-stream", url, "--output", str(file)])
                if result.returncode == 0 and file.is_file() and file.stat().st_size == asset["size"] and digest(file) == expected[7:]:
                    break
        if file.stat().st_size != asset["size"] or digest(file) != expected[7:]:
            raise ValueError(f"Release digest differs: {name}")
        files[name] = file
        print(f"Verified {name}", flush=True)
    output = directory / "mirror"
    output.mkdir(exist_ok=True)
    for name in FEEDS & files.keys():
        text = files[name].read_text()
        text = text.replace(f"https://github.com/{REPOSITORY}/releases/download/{tag}/", ORIGIN + tag + "/")
        text = text.replace(f"https://github.com/{REPOSITORY}/releases/latest/download/", ORIGIN + "latest/")
        text = text.replace(f"https://raw.githubusercontent.com/{REPOSITORY}/{tag}/assets/brand/android-chrome-512x512.png",
                            "https://haneoka.org/android-chrome-512x512.png")
        file = output / name
        file.write_text(text)
        files[name] = file
    sums = {name: digest(file) for name, file in files.items() if name != "SHA256SUMS"}
    files["SHA256SUMS"] = output / "SHA256SUMS"
    files["SHA256SUMS"].write_text("".join(f"{value}  {name}\n" for name, value in sorted(sums.items())))
    sums["SHA256SUMS"] = digest(files["SHA256SUMS"])
    assets = []
    inventory = store.inventory(f"app/{tag}/")
    for name, file in files.items():
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        if store.matches(f"app/{tag}/{name}", sums[name], file.stat().st_size, file=file, inventory=inventory):
            print(f"Reused verified mirror {name}", flush=True)
        else:
            store.put_file(f"app/{tag}/{name}", file, content_type)
        assets.append({"name": name, "size": file.stat().st_size, "digest": "sha256:" + sums[name], "state": "uploaded",
                       "browser_download_url": ORIGIN + tag + "/" + name})
        print(f"Mirrored {name}", flush=True)
    metadata = json.loads(files["release-version.json"].read_text())
    manifest = {"schema": "haneoka-app-release-v1", "tag_name": tag, "version": metadata["version"],
                "buildNumber": metadata["buildNumber"], "body": release["body"], "draft": False, "prerelease": False,
                "html_url": release["html_url"], "published_at": release["published_at"], "assets": assets, "sourceAssets": source}
    body = json_bytes(manifest)
    store.put_bytes(f"app/{tag}/release.json", body)
    latest = github_release()
    if latest["id"] != release["id"] or {a["name"]: a["digest"] for a in latest["assets"]} != source:
        raise ValueError("GitHub release changed during mirroring; latest pointer retained")
    store.put_bytes("app/latest.json", body, cache_control="public, max-age=60, must-revalidate")
    return {"release": tag, "changed": True, "assets": len(assets)}


def main():
    parser = argparse.ArgumentParser()
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument("--wrangler", action="store_true")
    credentials.add_argument("--cloudflare-token", action="store_true")
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    store = DownloadStore("haneoka-downloads", wrangler=args.wrangler, cloudflare_token=args.cloudflare_token)
    if args.directory:
        result = mirror(store, args.directory)
    else:
        with tempfile.TemporaryDirectory(prefix="haneoka-app-downloads-") as directory:
            result = mirror(store, Path(directory))
    if args.output:
        args.output.write_bytes(json_bytes(result))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
