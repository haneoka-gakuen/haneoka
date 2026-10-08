"""Validate private configuration and upload a single-line GitHub secret."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from core.config import CONFIG_ROOT, load_server_config
from core.private_config import redact_private_text, runtime_settings


def secret_payload(settings: dict) -> str:
    # GitHub masks each line of a multiline secret independently. Pretty JSON
    # registers braces/brackets as secrets and suppresses unrelated job outputs.
    payload = json.dumps(settings, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if len(payload.encode("utf-8")) > 48 * 1024:
        raise ValueError("configuration exceeds the GitHub secret size limit")
    return payload


def sync_configuration(server: str, directory: Path, repo: str, *, check_only: bool = False) -> dict:
    filename = directory / (server + ".json")
    variables = ("RESOURCE_PIPELINE_CONFIG", "RESOURCE_PIPELINE_CONFIG_FILE")
    previous = {name: os.environ.get(name) for name in variables}
    try:
        os.environ.pop(variables[0], None)
        os.environ[variables[1]] = str(filename.absolute())
        load_server_config(server)
        payload = secret_payload(runtime_settings())
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    if not check_only:
        result = subprocess.run(
            ["gh", "secret", "set", "RESOURCE_PIPELINE_CONFIG", "--repo", repo,
             "--env", "resource-" + server],
            input=payload, text=True, capture_output=True,
        )
        if result.returncode:
            raise RuntimeError("GitHub secret upload failed; check gh authentication and environment access")
    return {"server": server, "environment": "resource-" + server, "file": filename.name,
            "normalizedSha256": hashlib.sha256(payload.encode("utf-8")).hexdigest()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--server", choices=sorted(file.stem for file in CONFIG_ROOT.glob("*.json")))
    selection.add_argument("--all", action="store_true")
    parser.add_argument("--directory", type=Path,
                        default=Path(__file__).resolve().parents[1] / ".secrets" / "resource-pipeline")
    parser.add_argument("--repo", default="haneoka-gakuen/haneoka")
    parser.add_argument("--check", action="store_true", help="validate without uploading or changing the manifest")
    args = parser.parse_args()
    servers = sorted(file.stem for file in CONFIG_ROOT.glob("*.json")) if args.all else [args.server]
    try:
        for server in servers:
            record = sync_configuration(server, args.directory, args.repo, check_only=args.check)
            if not args.check:
                manifest_path = args.directory / "manifest.json"
                manifest = json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {}
                records = {item["server"]: item for item in manifest.get("files", [])}
                records[server] = record
                manifest = {"secretName": "RESOURCE_PIPELINE_CONFIG",
                            "files": [records[name] for name in sorted(records)]}
                temporary = manifest_path.with_suffix(".json.tmp")
                temporary.touch(mode=0o600)
                temporary.chmod(0o600)
                temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
                temporary.replace(manifest_path)
            print(json.dumps({"status": "validated" if args.check else "uploaded", **record}))
    except (ValueError, OSError, RuntimeError) as error:
        print(redact_private_text(str(error)), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
