"""Restore fixed, reviewed stamp bootstrap inputs from private R2 storage."""

from __future__ import annotations

import argparse
import re
import shutil
import stat
import zipfile
from pathlib import Path

from core.hashes import sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import PROJECT_ROOT, validate_release_path

SEED_SHA = "10872fdfea417009c7125daea2f59ba7fc0a40db8f4f1cbd38e3dbe27b3de220"
REPAIR_SHA = "b78a5970275217838180fd4f47b3176a62faff1fcce5bca3cf06ea642ce47b80"
PROVENANCE_SHA = "5e9e77eea09bac8b5c877dcf4790bd2fad23721e601c4eb2ac7f76afa9662748"
INPUTS = {
    "seed": {"key": f"private/textless-stamps/seeds/{SEED_SHA}.zip", "sha256": SEED_SHA, "bytes": 7335593},
    "repair": {"key": f"private/textless-stamps/repairs/{REPAIR_SHA}.zip", "sha256": REPAIR_SHA, "bytes": 212480},
}
MAX_UNPACKED_BYTES = 64 * 1024 * 1024


def safe_unpack(archive: Path, target: Path, image_directory: str) -> None:
    """Accept one manifest and flat content-addressed PNG members only."""
    if image_directory not in ("images", "objects") or target.exists():
        raise ValueError("stamp archive needs a fresh, known input directory")
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        names = set(); total = 0
        if not 1 <= len(members) <= 1000:
            raise ValueError("stamp archive member count exceeds its bound")
        for member in members:
            name = validate_release_path(member.filename)
            kind = stat.S_IFMT(member.external_attr >> 16)
            if (name in names or kind not in (0, stat.S_IFREG) or member.is_dir()
                    or member.flag_bits & 1
                    or member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    or (name != "manifest.json" and not re.fullmatch(image_directory + r"/[a-f0-9]{64}\.png", name))):
                raise ValueError("stamp archive contains an unexpected, repeated or special member")
            names.add(name); total += member.file_size
            if total > MAX_UNPACKED_BYTES:
                raise ValueError("stamp archive exceeds 64 MiB unpacked")
        if "manifest.json" not in names:
            raise ValueError("stamp archive omits its manifest")
        target.mkdir(parents=True)
        for member in members:
            file = target / member.filename
            file.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, file.open("xb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            if file.stat().st_size != member.file_size:
                raise ValueError("stamp archive member size changed")


def _check_png(root: Path, path: str, digest: str, directory: str) -> None:
    path = validate_release_path(path)
    if path != f"{directory}/{digest}.png" or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("stamp input filename differs from its content identity")
    if sha256_file(root / path) != digest:
        raise ValueError("reviewed stamp input hash changed")


def restore_reviewed_inputs(store, output: Path) -> dict:
    if output.exists():
        raise ValueError("reviewed stamp inputs need a fresh directory")
    descriptor = PROJECT_ROOT / "scripts/build/textless-stamps-seed-provenance.json"
    if descriptor.stat().st_size != 2945 or sha256_file(descriptor) != PROVENANCE_SHA:
        raise ValueError("stamp source provenance descriptor changed")
    output.mkdir(parents=True)
    for name, record in INPUTS.items():
        file = output / (name + ".zip")
        store.download_file(record["key"], file, expected_bytes=record["bytes"], expected_sha256=record["sha256"])
        if file.stat().st_size != record["bytes"] or sha256_file(file) != record["sha256"]:
            raise ValueError("reviewed stamp bootstrap differs from its fixed identity")
    safe_unpack(output / "seed.zip", output / "seed", "images")
    safe_unpack(output / "repair.zip", output / "repair", "objects")
    shutil.copyfile(descriptor, output / "provenance.json")
    seed = read_json(output / "seed/manifest.json")
    repair = read_json(output / "repair/manifest.json")
    provenance = read_json(output / "provenance.json")
    if (seed.get("schema") != "haneoka-textless-stamps-v1" or seed.get("server") != "intl"
            or seed.get("sourceIdentity", {}).get("server") != "intl"
            or repair.get("schema") != "haneoka-stamp-local-repair-cache-v1"
            or provenance.get("schema") != "haneoka-stamp-seed-provenance-v1"
            or provenance.get("sourceIdentity") != seed.get("sourceIdentity")
            or provenance.get("seedArchiveSha256") != SEED_SHA
            or provenance.get("repairCacheArchiveSha256") != REPAIR_SHA
            or provenance.get("seedManifestSha256") != sha256_file(output / "seed/manifest.json")
            or provenance.get("repairCacheManifestSha256") != sha256_file(output / "repair/manifest.json")):
        raise ValueError("reviewed seed/provenance/cache closure does not match")
    for record in seed["records"]:
        asset = record["artifacts"]["sourceImage"]
        _check_png(output / "seed", asset["path"], asset["sha256"], "images")
    for record in repair["records"]:
        for field in ("patchImage", "patchMask"):
            _check_png(output / "repair", record[field], record[field + "Sha256"], "objects")
    result = {"schema": "haneoka-stamp-bootstrap-restore-v1", "server": "intl", "inputs": INPUTS,
              "seedRecords": len(seed["records"]), "repairRecords": len(repair["records"]),
              "seedManifest": str(output / "seed/manifest.json"), "seedProvenance": str(output / "provenance.json"),
              "repairCacheManifest": str(output / "repair/manifest.json"), "published": False}
    write_json(output / "receipt.json", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=("intl", "intl-test"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    from core.config import load_server_config
    from publish.r2 import R2Store
    config = load_server_config(args.server)
    if config.r2_bucket != "hotdori-assets":
        raise ValueError("reviewed stamp bootstrap belongs to hotdori-assets")
    print(stable_json(restore_reviewed_inputs(R2Store(config, 2), args.output)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
