"""Invoke the one TypeScript difficulty model on selected-source chart files."""
from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path
from typing import Any


def build_difficulty_estimates(
    data: Any, source_id: str, files: dict[str, Path], scores: dict[int, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    if not files:
        return {}
    charts = {}
    root = data.root.resolve()
    for score_id, file in files.items():
        resolved = file.resolve()
        if not resolved.is_relative_to(root):
            raise ValueError("Difficulty chart file belongs to another build")
        relative = resolved.relative_to(root).as_posix()
        count = scores[int(score_id)].get("_fullComboCount")
        charts[score_id] = {"path": relative,
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
        value = estimate.get("estimatedConstant")
        if (estimate.get("target") != "fc-operation-load" or estimate.get("sourceId") != source_id or
                estimate.get("quality", {}).get("status") not in ("estimated", "low-confidence", "unavailable") or
                (value is not None and (type(value) not in (float, int) or not math.isfinite(value) or
                                       estimate.get("quality", {}).get("status") == "unavailable"))):
            raise ValueError(f"Difficulty estimate identity/shape mismatch:{score_id}")
    return estimates
