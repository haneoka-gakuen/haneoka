"""Optional KTX2 transcoding stage.

PNG is authoritative. Invoking this stage is an explicit request, so a missing
encoder is an error instead of a silently successful no-op.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from core.manifests import write_json
from core.paths import build_layout
from core.process import walk_files


def build_ktx2(server: str, build_id: str) -> dict:
    encoder = shutil.which("basisu")
    if not encoder:
        raise RuntimeError("KTX2 was requested but basisu is not installed")
    layout = build_layout(server, build_id)
    count = 0
    for source in walk_files(layout.assets):
        if source.suffix.lower() != ".png":
            continue
        relative = source.relative_to(layout.assets)
        output = layout.runtime / "ktx2" / relative.with_suffix(".ktx2")
        output.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [encoder, "-ktx2", "-y_flip", "-output_file", str(output), str(source)],
            check=True,
        )
        count += 1
    result = {
        "schema": "haneoka-ktx2-build-v1",
        "server": server,
        "buildId": build_id,
        "encoder": Path(encoder).name,
        "outputCount": count,
    }
    write_json(layout.reports / "ktx2.json", result, pretty=True)
    return result
