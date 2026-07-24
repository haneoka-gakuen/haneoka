"""Build the repository-owned Sonolus payload from a canonical release."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from core.config import PROJECT_ROOT
from core.paths import build_layout


ENGINE_FILES = (
    "EngineConfiguration",
    "EnginePlayData",
    "EngineWatchData",
    "EnginePreviewData",
    "EngineTutorialData",
)


def _verify_engine_artifact(directory: Path) -> None:
    missing = [name for name in ENGINE_FILES if not (directory / name).is_file()]
    if missing:
        raise FileNotFoundError(
            "Sonolus engine artifact is incomplete: "
            + ", ".join(missing)
            + ". Build or restore packages/sonolus/engine/dist first."
        )


def build_sonolus(release_server: str, build_id: str) -> dict:
    layout = build_layout(release_server, build_id)
    _verify_engine_artifact(PROJECT_ROOT / "packages" / "sonolus" / "engine" / "dist")
    inputs = layout.root / "sonolus-inputs"
    if inputs.exists():
        shutil.rmtree(inputs)
    shutil.copytree(PROJECT_ROOT / "packages" / "sonolus" / "assets" / "original", inputs)
    environment = {
        **os.environ,
        "RELEASE_SERVER": release_server,
        "RESOURCE_BUILD_ROOT": str(layout.root.resolve()),
        "SONOLUS_ORIGINAL_ASSETS_DIR": str(inputs.resolve()),
        "SONOLUS_WORKER_ASSETS_DIR": str(layout.runtime.resolve()),
    }
    try:
        subprocess.run(["pnpm", "sonolus:release"], cwd=PROJECT_ROOT, env=environment, check=True)
    finally:
        shutil.rmtree(inputs, ignore_errors=True)
    return {"server": release_server, "buildId": build_id, "path": "runtime/sonolus", "built": True}
