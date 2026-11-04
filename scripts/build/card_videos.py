# L3 — GEB
# Input: 成员卡的 CRI 视频、透明度、背景及固定 release 的复用记录。
# Output: 完整画面的 H.264 MP4 和按卡／片段索引的摘要清单。
# Pos: [Map](L2-2.md)；目录构建前的卡面视频派生。
# Effects/Dependencies: 按需恢复输入，调用 FFmpeg／ffprobe，写入 runtime 与 metadata。
"""Build the same complete card frames for playback and downloading."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any

from core.hashes import sha256_bytes, sha256_file
from core.manifests import read_json, stable_json, write_json


SCHEMA = "haneoka-card-videos-v1"
MANIFEST = "metadata/card-videos.json"


def _run(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{command[0]} failed: {result.stderr.strip()}")
    return result.stdout


def _probe(file: Path) -> dict[str, Any]:
    return json.loads(_run([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(file),
    ]))


def _digest(data, relative: str) -> str:
    file = data.root / relative
    if file.is_file():
        return sha256_file(file)
    return data.base_release_entries[relative]["sha256"]


def _file(data, relative: str) -> Path:
    file = data.root / relative
    if not file.is_file() and data.restore_output is not None:
        data.restore_output(relative, file)
    if not file.is_file():
        raise FileNotFoundError(f"Card video input is missing: {relative}")
    return file


def _encode(source: Path, background: Path | None, target: Path) -> dict[str, Any]:
    source_probe = _probe(source)
    video = next(stream for stream in source_probe["streams"] if stream["codec_type"] == "video")
    width, height = int(video["width"]), int(video["height"])
    rate = video["r_frame_rate"]
    command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-i", str(source)]
    if background:
        width //= 2
        command.extend([
            "-loop", "1", "-framerate", rate, "-i", str(background),
            "-filter_complex_threads", "1", "-filter_complex",
            "[0:v]format=rgb24,split=2[colour][mask];"
            f"[colour]crop={width}:{height}:0:0,setsar=1[c];"
            f"[mask]crop={width}:{height}:{width}:0,extractplanes=r[a];"
            "[c][a]alphamerge[fg];"
            f"[1:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},setsar=1,format=rgb24[bg];"
            "[bg][fg]overlay=shortest=1:format=rgb:alpha=straight,"
            "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]",
            "-map", "[v]",
        ])
    else:
        command.extend(["-map", "0:v:0"])
    command.extend(["-map", "0:a?", "-map_metadata", "-1"])
    if not background and video["codec_name"] == "h264" and video["pix_fmt"] == "yuv420p":
        command.extend(["-c:v", "copy"])
    else:
        command.extend([
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-threads", "2",
            "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709",
            "-color_primaries", "bt709", "-color_trc", "bt709",
        ])
    command.extend(["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"])
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.stem}.{os.getpid()}.tmp.mp4")
    try:
        _run([*command, str(temporary)])
        probe = _probe(temporary)
        streams = probe["streams"]
        encoded = next(stream for stream in streams if stream["codec_type"] == "video")
        if (encoded["codec_name"] != "h264" or encoded["pix_fmt"] != "yuv420p"
                or (int(encoded["width"]), int(encoded["height"])) != (width, height)
                or int(encoded["nb_frames"]) <= 0):
            raise ValueError(f"Invalid card video output: {target}")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return {
        "width": width, "height": height, "frameRate": encoded["r_frame_rate"],
        "duration": float(encoded["duration"]), "frames": int(encoded["nb_frames"]),
        "hasAudio": any(stream["codec_type"] == "audio" for stream in streams),
        "bytes": target.stat().st_size, "sha256": sha256_file(target),
    }


def build_card_videos(data) -> dict[str, dict[str, Any]]:
    """Reuse complete frames by input identity, including an unchanged delta base."""
    file = data.root / MANIFEST
    if not file.is_file() and MANIFEST in data.base_release_entries:
        _file(data, MANIFEST)
    previous = read_json(file) if file.is_file() else {}
    prior_cards = previous.get("cards", {}) if previous.get("schema") == SCHEMA else {}
    recipe = None
    cards: dict[str, dict[str, Any]] = {}
    generated = reused = 0
    for row in data.rows("MasterMemberCard"):
        card = int(row["_id"])
        movies = data.card_movies(card)
        if not movies:
            continue
        if recipe is None:
            recipe = {
                "schema": SCHEMA, "producer": sha256_file(Path(__file__)),
                "ffmpeg": _run(["ffmpeg", "-version"]).splitlines()[0],
            }
        outputs = {}
        for key, movie in movies.items():
            transparent = bool(movie["hasAlpha"])
            source = movie["outputPath"]
            background = None
            if transparent:
                if movie.get("alphaLayout") != "color-left-alpha-right":
                    raise ValueError(f"Card video has no synchronized alpha: {card}/{key}")
                source = "runtime/" + str(movie["alphaPackedUrl"]).split(f"/runtime/{data.server}/", 1)[1]
                background = f"assets/Assets/AddressableResources/MemberCard/{card}/member_background.png"
            inputs = {relative: _digest(data, relative) for relative in (source, background) if relative}
            digest = sha256_bytes(stable_json({"recipe": recipe, "inputs": inputs}))
            relative = f"runtime/card-videos/{card}/{key}-{digest[:20]}.mp4"
            old = prior_cards.get(str(card), {}).get(key, {})
            if (old.get("inputSha256") == digest and old.get("path") == relative
                    and data.output_integrity(relative, old["sha256"], old["bytes"])):
                output = old
                reused += 1
            else:
                output = {
                    **_encode(_file(data, source), _file(data, background) if background else None, data.root / relative),
                    "path": relative, "inputSha256": digest,
                }
                generated += 1
            outputs[key] = output
            if (data.root / relative).is_file():
                data.runtime_path_set.add(PurePosixPath(relative).relative_to("runtime").as_posix())
        cards[str(card)] = outputs
    write_json(file, {"schema": SCHEMA, "server": data.server, "cards": cards})
    print(f"card videos: {generated} generated, {reused} reused", file=sys.stderr)
    return cards
