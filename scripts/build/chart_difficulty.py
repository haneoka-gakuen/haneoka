"""Invoke the one TypeScript difficulty model on selected-source chart files."""
from __future__ import annotations

import json
import math
import re
import subprocess
from pathlib import Path
from typing import Any

from core.hashes import sha256_file
from core.manifests import read_json


def build_difficulty_estimates(
    data: Any, source_id: str, files: dict[str, Path], scores: dict[int, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    if not files:
        return {}
    source = read_json(data.root / "metadata/source-index.json")
    if source.get("server") != data.server or source.get("sourceId") != source_id:
        raise ValueError("Difficulty chart source identity mismatch")
    charts = {}
    root = data.root.resolve()
    for score_id, file in files.items():
        resolved = file.resolve()
        if not resolved.is_relative_to(root):
            raise ValueError("Difficulty chart file belongs to another build")
        relative = resolved.relative_to(root).as_posix()
        logical = relative.removeprefix("assets/")
        output = next((item for item in source.get("sources", {}).get(logical, {}).get("outputs", [])
                       if item.get("path") == relative), None)
        digest = sha256_file(resolved)
        if not output or output.get("sha256") != digest:
            raise ValueError(f"Difficulty chart source projection mismatch:{score_id}")
        count = scores[int(score_id)].get("_fullComboCount")
        charts[score_id] = {"path": relative, "sha256": digest,
                            "masterJudgedCount": count if type(count) is int and count > 0 else None}
    request = {"schema": "haneoka-chart-difficulty-build-v1", "server": data.server,
               "sourceId": source_id, "buildRoot": str(root), "charts": charts}
    result = subprocess.run(["node", str(Path(__file__).with_suffix(".ts"))],
                            input=json.dumps(request), text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError("Chart difficulty producer failed:\n" + result.stderr.strip())
    estimates = json.loads(result.stdout)
    if not isinstance(estimates, dict) or set(estimates) != set(files):
        raise ValueError("Difficulty estimate chart coverage mismatch")
    for score_id, estimate in estimates.items():
        pin = estimate.get("pin", {})
        value = estimate.get("estimatedConstant")
        if (estimate.get("target") != "fc-operation-load" or pin.get("sourceId") != source_id or
                pin.get("chartSha256") != charts[score_id]["sha256"] or
                not re.fullmatch(r"[a-f0-9]{64}", str(pin.get("canonicalConverterSha256", ""))) or
                not re.fullmatch(r"[a-f0-9]{64}", str(pin.get("algorithmSha256", ""))) or
                not re.fullmatch(r"[a-f0-9]{64}", str(pin.get("calibrationSha256", ""))) or
                estimate.get("quality", {}).get("status") not in ("estimated", "low-confidence", "unavailable") or
                (value is not None and (type(value) not in (float, int) or not math.isfinite(value) or
                                       estimate.get("quality", {}).get("status") == "unavailable"))):
            raise ValueError(f"Difficulty estimate identity/shape mismatch:{score_id}")
    return estimates
