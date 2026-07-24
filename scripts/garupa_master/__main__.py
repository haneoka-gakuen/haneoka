from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from .archive import archive_responses, atomic_write_bytes, atomic_write_json
from .client import (
    DEFAULT_BASE_URL,
    GarupaRequestError,
    digest,
    request_application,
    request_live_master,
)
from .package import PackagePreparationError, prepare_package
from .projection import ProjectionError, build_projections
from .schema import generate_schema, load_schema, write_schema


@dataclass(frozen=True)
class _R2BucketConfig:
    """The only resource-pipeline configuration Garupa R2 needs."""

    r2_bucket: str


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m scripts.garupa_master",
        description="Synchronize and decode the Garupa JP Suite Master response.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    package = commands.add_parser(
        "prepare-package",
        help="safely select a base APK and extract only manifest-listed XAPK splits",
    )
    package.add_argument("--package", type=Path, required=True)
    package.add_argument("--output-dir", type=Path, required=True)
    package.add_argument("--selection", type=Path, required=True)
    package.add_argument("--package-name", default="jp.co.craftegg.band")

    probe = commands.add_parser(
        "probe",
        help="fetch and decode only /api/application version metadata",
    )
    probe.add_argument("--output-dir", type=Path, required=True)
    probe.add_argument(
        "--schema",
        type=Path,
        required=True,
        help="runtime schema JSON generated from the current package",
    )
    probe.add_argument("--base-url", default=DEFAULT_BASE_URL)
    probe.add_argument("--timeout-seconds", type=float, default=45)
    probe.add_argument("--allow-http", action="store_true", help=argparse.SUPPRESS)
    probe.add_argument("--application-body", type=Path, help="offline encrypted /api/application fixture")
    probe.add_argument(
        "--request-client-version",
        help="client version read from the current package (required for a live request)",
    )

    sync = commands.add_parser("sync", help="fetch, archive, decode, and project the live Master")
    sync.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="ephemeral lossless archive directory",
    )
    sync.add_argument(
        "--projection-dir",
        type=Path,
        required=True,
        help="ephemeral web projection directory",
    )
    sync.add_argument(
        "--schema",
        type=Path,
        required=True,
        help="runtime schema JSON generated from the current package",
    )
    sync.add_argument("--base-url", default=DEFAULT_BASE_URL)
    sync.add_argument("--timeout-seconds", type=float, default=45)
    sync.add_argument("--allow-http", action="store_true", help=argparse.SUPPRESS)
    sync.add_argument("--application-body", type=Path, help="offline encrypted /api/application fixture")
    sync.add_argument("--suite-body", type=Path, help="offline encrypted /api/suite/master fixture")
    sync.add_argument(
        "--request-client-version",
        help="client version read from the current package (required for a live request)",
    )

    candidate = commands.add_parser(
        "schema-candidate",
        help="generate a runtime protobuf schema from an Il2CppDumper dump.cs",
    )
    candidate.add_argument("--dump-cs", type=Path, required=True)
    candidate.add_argument("--package-name", default="jp.co.craftegg.band")
    candidate.add_argument("--output", type=Path, required=True)
    candidate.add_argument("--report", type=Path)

    r2_publish = commands.add_parser(
        "publish-r2",
        help="publish a verified archive, runtime schema, and projections to R2 CAS",
    )
    r2_publish.add_argument("--archive-dir", type=Path, required=True)
    r2_publish.add_argument("--schema-dir", type=Path, required=True)
    r2_publish.add_argument("--projection-dir", type=Path, required=True)
    r2_publish.add_argument("--server", default="jp")
    r2_publish.add_argument(
        "--r2-bucket",
        default=os.environ.get("R2_BUCKET"),
        help="shared R2 bucket for Garupa snapshots (or set R2_BUCKET)",
    )
    r2_publish.add_argument("--concurrency", type=int, default=32)

    r2_verify = commands.add_parser(
        "verify-r2",
        help="verify the selected Garupa Master snapshot and every referenced CAS object",
    )
    r2_verify.add_argument("--server", default="jp")
    r2_verify.add_argument(
        "--r2-bucket",
        default=os.environ.get("R2_BUCKET"),
        help="shared R2 bucket for Garupa snapshots (or set R2_BUCKET)",
    )
    r2_verify.add_argument("--snapshot-id")
    r2_verify.add_argument("--concurrency", type=int, default=32)

    local_seed = commands.add_parser(
        "seed-local-r2",
        help="seed local Wrangler R2 from a real, validated Garupa sync",
    )
    local_seed.add_argument("--archive-dir", type=Path, required=True)
    local_seed.add_argument("--schema-dir", type=Path, required=True)
    local_seed.add_argument("--projection-dir", type=Path, required=True)
    local_seed.add_argument("--state-dir", type=Path, required=True)
    local_seed.add_argument("--wrangler-config", type=Path, required=True)
    local_seed.add_argument("--bucket", default="haneoka-assets-local")

    return parser


def _prepare_package(args: argparse.Namespace) -> int:
    selection = prepare_package(
        args.package,
        args.output_dir,
        args.selection,
        package_name=args.package_name,
    )
    print(json.dumps(selection, ensure_ascii=False))
    return 0


def _probe(args: argparse.Namespace) -> int:
    schema = load_schema(args.schema)
    response = request_application(
        schema,
        base_url=args.base_url,
        timeout_seconds=args.timeout_seconds,
        allow_http=args.allow_http,
        application_body=args.application_body,
        request_client_version=args.request_client_version,
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(args.output_dir / "response.encrypted", response.application_encrypted)
    atomic_write_bytes(args.output_dir / "response.pb", response.application_protobuf)
    atomic_write_json(args.output_dir / "response.json", response.versions.decoded)
    manifest = {
        "format": "haneoka-garupa-application-probe-v1",
        "status": "application-probe-complete",
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "server": "jp",
        "clientVersion": response.versions.client_version,
        "dataVersion": response.versions.data_version,
        "masterDataVersion": response.versions.master_data_version,
        "application": {
            "encrypted": digest(response.application_encrypted),
            "protobuf": digest(response.application_protobuf),
        },
    }
    atomic_write_json(args.output_dir / "manifest.json", manifest)
    print(
        json.dumps(
            {
                "clientVersion": response.versions.client_version,
                "dataVersion": response.versions.data_version,
                "masterDataVersion": response.versions.master_data_version,
                "manifest": str(args.output_dir / "manifest.json"),
            },
            ensure_ascii=False,
        )
    )
    return 0


def _schema_candidate(args: argparse.Namespace) -> int:
    schema = generate_schema(
        args.dump_cs,
        package_name=args.package_name,
    )
    write_schema(args.output, schema)
    if args.report:
        atomic_write_json(
            args.report,
            {
                "format": "haneoka-garupa-schema-candidate-report-v1",
                "packageName": args.package_name,
                "schemaPath": str(args.output),
                "source": schema["source"],
                "coverage": schema["coverage"],
            },
        )
    print(
        json.dumps(
            {
                "schema": str(args.output),
                "contractCount": schema["coverage"]["contractCount"],
                "suiteFieldCount": schema["coverage"]["suiteFieldCount"],
            },
            ensure_ascii=False,
        )
    )
    return 0


def _sync(args: argparse.Namespace) -> int:
    schema = load_schema(args.schema)
    responses = request_live_master(
        schema,
        base_url=args.base_url,
        timeout_seconds=args.timeout_seconds,
        allow_http=args.allow_http,
        application_body=args.application_body,
        suite_body=args.suite_body,
        request_client_version=args.request_client_version,
    )
    decoded = archive_responses(args.output_dir, responses, schema)
    projection_manifest = build_projections(
        args.projection_dir,
        responses,
        decoded,
        schema,
    )

    archive_manifest_path = args.output_dir / "manifest.json"
    archive_manifest = json.loads(archive_manifest_path.read_text(encoding="utf-8"))
    archive_manifest["projection"] = {
        "status": "generated",
        "projection": projection_manifest,
    }
    atomic_write_json(archive_manifest_path, archive_manifest)
    print(
        json.dumps(
            {
                "clientVersion": responses.versions.client_version,
                "dataVersion": responses.versions.data_version,
                "masterDataVersion": responses.versions.master_data_version,
                "semanticMasterStatus": decoded.coverage.get("semanticStatus"),
                "unknownTopLevelFields": decoded.coverage.get("unknownTopLevelFields"),
                "projected": True,
                "archiveManifest": str(archive_manifest_path),
                "projectionManifest": str(args.projection_dir / "manifest.json"),
            },
            ensure_ascii=False,
        )
    )
    return 0


def _r2_store(r2_bucket: object, concurrency: int):
    # The resource pipeline modules are also executable as top-level modules
    # with PYTHONPATH=scripts. Make the same imports work for the package-style
    # `python -m scripts.garupa_master` entry point used in local runs.
    scripts_root = Path(__file__).resolve().parents[1]
    scripts_path = str(scripts_root)
    if scripts_path not in sys.path:
        sys.path.insert(0, scripts_path)
    from publish.r2 import R2Store

    bucket = str(r2_bucket or "").strip()
    if not bucket:
        raise ValueError("set --r2-bucket or R2_BUCKET for Garupa R2 publication")
    return R2Store(_R2BucketConfig(bucket), concurrency)


def _publish_r2(args: argparse.Namespace) -> int:
    from .r2 import publish_snapshot

    result = publish_snapshot(
        _r2_store(args.r2_bucket, args.concurrency),
        args.archive_dir,
        args.schema_dir,
        args.projection_dir,
        server=args.server,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


def _verify_r2(args: argparse.Namespace) -> int:
    from .r2 import verify_snapshot

    result = verify_snapshot(
        _r2_store(args.r2_bucket, args.concurrency),
        server=args.server,
        snapshot_id=args.snapshot_id,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


def _seed_local_r2(args: argparse.Namespace) -> int:
    from .local_r2 import seed_local_r2

    result = seed_local_r2(
        args.archive_dir,
        args.schema_dir,
        args.projection_dir,
        args.state_dir,
        args.wrangler_config,
        bucket=args.bucket,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare-package":
            return _prepare_package(args)
        if args.command == "probe":
            return _probe(args)
        if args.command == "schema-candidate":
            return _schema_candidate(args)
        if args.command == "sync":
            return _sync(args)
        if args.command == "publish-r2":
            return _publish_r2(args)
        if args.command == "verify-r2":
            return _verify_r2(args)
        if args.command == "seed-local-r2":
            return _seed_local_r2(args)
    except (
        GarupaRequestError,
        PackagePreparationError,
        ProjectionError,
        OSError,
        ValueError,
    ) as exc:
        print(f"garupa-master: {exc}", file=sys.stderr)
        return 2
    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
