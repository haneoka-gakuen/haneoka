"""Decode CRI source payloads into deterministic playable runtime media."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from core.config import ServerConfig
from core.hashes import sha256_bytes, sha256_file
from core.manifests import read_json, stable_json, write_json
from core.paths import build_layout, source_layout
from core.process import hardlink_or_copy
from core.unity_objects import UnityObjectStore


HASH_SUFFIX = re.compile(r"_[0-9a-f]{32}$")
CHUNK_SUFFIX = re.compile(r"-(\d+)\.bytes$", re.IGNORECASE)
SHA256 = re.compile(r"^[a-f0-9]{64}$")
CRI_SCHEMA = "haneoka-cri-runtime-v1"
CRI_TRANSFORM_SCHEMA = "haneoka-cri-transform-v2"
# The decode contract pins everything that can change a decoded or muxed
# output byte: decoders, encoders, metadata projection, mux composition.
# Bump it ONLY for deliberate semantic changes — a bump forces one full
# CRI re-decode before adoption resumes. Refactors, logging, orchestration,
# and comment edits must leave it alone; they cannot alter output bytes.
DECODE_CONTRACT = "haneoka-cri-decode-v1"
# Asset locales guide the order of metadata code-page candidates. They are
# hints, not an encoding declaration; video/audio validation remains separate.
USM_LOCALE_ENCODINGS = {
    "": "cp932",
    "ja": "cp932",
    "zh-hans": "gb18030",
    "zh-hant": "big5",
    "ko": "cp949",
}
USM_ENCODING_FALLBACKS = ("cp932", "gb18030", "big5", "cp949", "latin-1")
# Both live releases carry the v2 id already; adoption now only matches the
# current transform id. A DECODE_CONTRACT bump therefore means exactly one
# full re-decode, and nothing else ever does.
NOTE_SE_DECODE_PROFILE = "note-se-original-stream-once-v1"
USM_DECODE_PROFILE = "usm-alpha-full-range-packed-h264-bt709-v4"
RestoreOutput = Callable[[dict[str, Any], Path], None]


def _cri_transform_id(config: ServerConfig) -> str:
    identity = {
        "schema": CRI_TRANSFORM_SCHEMA,
        "decodeContract": DECODE_CONTRACT,
        "hcaKeySha256": sha256_bytes(config.cri_hca_key),
    }
    return sha256_bytes(stable_json(identity))


# Task ids have baked every schema constant into their hash since the
# beginning; a base manifest written under an older schema can only be
# re-keyed by rebuilding ids with that era's string.
TASK_ID_SCHEMAS = (CRI_TRANSFORM_SCHEMA, "haneoka-cri-transform-v1")


def _cri_task_id(
    task: dict[str, Any], transform_id: str, schema: str = CRI_TRANSFORM_SCHEMA
) -> str:
    identity = {
        "schema": schema,
        "transformId": transform_id,
        "source": task["source"],
        "kind": task["kind"],
        "runtimePath": task["relative"].as_posix(),
        "preferredStem": str(task.get("preferred") or ""),
    }
    semantic_decode_profile = str(task.get("semanticDecodeProfile") or "")
    if semantic_decode_profile:
        identity["semanticDecodeProfile"] = semantic_decode_profile
    return sha256_bytes(stable_json(identity))


def _tool(name: str) -> str:
    value = shutil.which(name)
    if not value:
        raise RuntimeError(f"required CRI tool is not installed: {name}")
    return value


def _run(
    command: list[str], cwd: Path | None = None
) -> subprocess.CompletedProcess[str]:
    # vgmstream/ffmpeg may emit non-UTF-8 bytes (e.g. Shift-JIS cue names embedded
    # in ACB UTF tables, or binary-ish header lines). Decode leniently so a stray
    # byte in tool output never crashes an otherwise-decodable source; the JSON
    # metadata parser only consumes well-formed "{" lines regardless.
    result = subprocess.run(
        command, cwd=cwd, text=True, capture_output=True, errors="replace"
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()[:1000]
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n{detail}"
        )
    return result


def _safe_name(value: str, fallback: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", value).strip(" .")
    return name or fallback


def _cri_audio_extension(header: bytes) -> str:
    if header.startswith(b"\x80\x00"):
        return ".adx"
    if bytes(value & 0x7F for value in header[:3]) == b"HCA":
        return ".hca"
    raise ValueError(f"unsupported CRI audio stream header: {header[:4].hex()}")


def _video_output_profile(header: bytes) -> tuple[str, list[str], list[str]]:
    """Select a browser delivery container without transcoding compatible video."""
    if header[:4] == b"DKIF" and header[8:12] == b"VP90":
        return ".webm", ["-c:v", "copy"], ["-c:a", "libopus", "-b:a", "256k"]
    if header[:4] == b"\x00\x00\x01\xb3":
        return (
            ".mp4",
            ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"],
            ["-c:a", "aac", "-b:a", "256k"],
        )
    raise ValueError(f"unsupported CRI video stream header: {header[:12].hex()}")


def _usm_metadata_encodings(locales: Any = None) -> tuple[str, ...]:
    """Return strict locale candidates, then compatibility fallbacks.

    USM metadata is not necessarily UTF-8. The addressable locale is the only
    source-level hint available to this extractor, so use it to prefer
    the corresponding legacy encoding. Latin-1 is deliberately last and only
    preserves bytes for a payload that still has to pass stream validation.
    """
    values = locales if isinstance(locales, (list, tuple, set)) else ()
    encodings = ["UTF-8"]
    for locale in values:
        encoding = USM_LOCALE_ENCODINGS.get(str(locale).casefold())
        if encoding and encoding not in encodings:
            encodings.append(encoding)
    for encoding in USM_ENCODING_FALLBACKS:
        if encoding not in encodings:
            encodings.append(encoding)
    return tuple(encodings)


def _ffmpeg_mp3(wav: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp.mp3")
    _run(
        [
            _tool("ffmpeg"),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(wav),
            "-map_metadata",
            "-1",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "320k",
            str(temporary),
        ]
    )
    os.replace(temporary, output)


def _vgmstream_json_lines(
    result: subprocess.CompletedProcess[str], source: Path
) -> list[dict[str, Any]]:
    values = []
    for line in result.stdout.splitlines():
        text = line.strip()
        if not text.startswith("{"):
            continue
        try:
            value = json.loads(text)
        except json.JSONDecodeError as error:
            raise ValueError(
                f"vgmstream returned invalid JSON metadata for {source}"
            ) from error
        if isinstance(value, dict):
            values.append(value)
    if not values:
        raise ValueError(f"vgmstream returned no stream metadata for {source}")
    return values


def _acb_stream_metadata(source: Path, cwd: Path) -> dict[int, dict[str, Any]]:
    infos = _vgmstream_json_lines(
        _run(
            [_tool("vgmstream-cli"), "-m", "-I", "-S", "0", source.name],
            cwd=cwd,
        ),
        source,
    )
    output: dict[int, dict[str, Any]] = {}
    for info in infos:
        stream = (
            info.get("streamInfo") if isinstance(info.get("streamInfo"), dict) else {}
        )
        index = int(stream.get("index") or 0)
        total = int(stream.get("total") or len(infos))
        sample_rate = int(info.get("sampleRate") or 0)
        total_samples = int(info.get("numberOfSamples") or 0)
        if index <= 0 or index in output:
            raise ValueError(
                f"vgmstream returned an invalid stream index for {source}: {index}"
            )
        if total != len(infos) or sample_rate <= 0 or total_samples <= 0:
            raise ValueError(
                f"vgmstream returned incomplete stream metadata for {source}#{index}"
            )
        loop = (
            info.get("loopingInfo")
            if isinstance(info.get("loopingInfo"), dict)
            else None
        )
        loop_start = int((loop or {}).get("start") or 0)
        loop_end = int((loop or {}).get("end") or 0)
        has_loop = loop is not None and loop_end > loop_start >= 0
        output[index] = {
            "cueName": str(stream.get("name") or ""),
            "streamIndex": index,
            "streamCount": total,
            "sampleRate": sample_rate,
            "channels": int(info.get("channels") or 0),
            "totalSamples": total_samples,
            "durationMs": round(total_samples / sample_rate * 1000),
            "encoding": str(info.get("encoding") or ""),
            "metadataSource": str(info.get("metadataSource") or ""),
            "loopInfo": {
                "isLoop": has_loop,
                "loopStartSample": loop_start if has_loop else None,
                "loopEndSample": loop_end if has_loop else None,
                "loopStartMs": round(loop_start / sample_rate * 1000)
                if has_loop
                else None,
                "loopEndMs": round(loop_end / sample_rate * 1000) if has_loop else None,
            },
        }
    return output


def _decoded_stream_index(path: Path) -> int:
    match = re.match(r"^(\d+)_", path.stem)
    if not match:
        raise ValueError(f"vgmstream output has no stream index: {path.name}")
    return int(match.group(1))


def _decode_acb(
    payload: Path,
    output: Path,
    hca_key: str,
    preferred_stem: str = "",
    semantic_decode_profile: str = "",
) -> list[dict[str, Any]]:
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="haneoka-acb-") as directory:
        scratch = Path(directory)
        source = scratch / "source.acb"
        shutil.copy2(payload, source)
        (scratch / ".hcakey").write_text(hca_key, "ascii")
        metadata = _acb_stream_metadata(source, scratch)
        decode_command = [_tool("vgmstream-cli")]
        if semantic_decode_profile == NOTE_SE_DECODE_PROFILE:
            # Native note-SE playback sets CRIplayerLoop(-3); export one
            # original stream interval and retain the native metadata above.
            decode_command.append("-i")
        decode_command.extend(["-S", "0", "-o", "?s_?n.wav", source.name])
        _run(decode_command, cwd=scratch)
        wavs = sorted(scratch.glob("*.wav"), key=_decoded_stream_index)
        if not wavs:
            raise RuntimeError(f"vgmstream produced no audio: {payload}")
        if len(wavs) != len(metadata):
            raise RuntimeError(
                f"vgmstream metadata/output count mismatch: {payload}: {len(metadata)} != {len(wavs)}"
            )
        records = []
        used: set[str] = set()
        for index, wav in enumerate(wavs):
            stream_index = _decoded_stream_index(wav)
            stream_metadata = metadata.get(stream_index)
            if stream_metadata is None:
                raise RuntimeError(
                    f"vgmstream output has no matching metadata: {payload}#{stream_index}"
                )
            stem = _safe_name(
                f"{preferred_stem}_{index + 1}"
                if preferred_stem and len(wavs) > 1
                else preferred_stem or wav.stem,
                f"stream-{index + 1}",
            )
            name = stem
            counter = 2
            while name.casefold() in used:
                name = f"{stem}-{counter}"
                counter += 1
            used.add(name.casefold())
            target = output / f"{name}.mp3"
            _ffmpeg_mp3(wav, target)
            records.append(
                {
                    "path": target.as_posix(),
                    "bytes": target.stat().st_size,
                    "sha256": sha256_file(target),
                    **stream_metadata,
                }
            )
        return records


def _decode_usm(
    payload: Path,
    output: Path,
    key: str,
    metadata_encodings: tuple[str, ...] | None = None,
) -> list[dict[str, Any]]:
    from wannacri.usm import Usm
    from wannacri.usm.types import OpMode

    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="haneoka-usm-") as directory:
        scratch = Path(directory)
        candidates = metadata_encodings or _usm_metadata_encodings()
        last_decode_error = None
        usm = None
        encoding = "UTF-8"
        for candidate_encoding in candidates:
            try:
                usm = Usm.open(str(payload), key=int(key), encoding=candidate_encoding)
                encoding = candidate_encoding
                last_decode_error = None
                break
            except UnicodeDecodeError as error:
                last_decode_error = error
        if usm is None:
            attempted = ", ".join(candidates)
            raise ValueError(
                f"no supported USM metadata encoding succeeded ({attempted})"
            ) from last_decode_error
        video_files = []
        alpha_files: dict[int, Path] = {}
        for index, _ in enumerate(usm.videos):
            selected = None
            # CRI streams in production are mixed: most require the USM video
            # XOR pass, while some member previews contain unencrypted MPEG
            # video. Try the declared encrypted form first and accept only a
            # stream whose header and FFprobe result agree.
            for mode in (OpMode.DECRYPT, OpMode.NONE):
                active_usm = (
                    usm
                    if mode == OpMode.DECRYPT
                    else Usm.open(str(payload), key=int(key), encoding=encoding)
                )
                active_stream = active_usm.videos[index]
                candidate = scratch / f"video-{index}-{mode.name.lower()}.bin"
                with candidate.open("wb") as file:
                    for packet in active_stream.stream(mode, active_usm.video_key):
                        file.write(packet[0] if isinstance(packet, tuple) else packet)
                with candidate.open("rb") as input_stream:
                    header = input_stream.read(12)
                try:
                    suffix, _, _ = _video_output_profile(header)
                except ValueError:
                    candidate.unlink()
                    continue
                target = candidate.with_suffix(
                    ".ivf" if header.startswith(b"DKIF") else ".m2v"
                )
                os.replace(candidate, target)
                try:
                    probe = _probe_streams(target)
                except (RuntimeError, ValueError):
                    target.unlink()
                    continue
                if probe["videoCount"] != 1:
                    target.unlink()
                    continue
                selected = target
                break
            if selected is None:
                raise ValueError(
                    f"USM video stream {index} is neither a supported encrypted nor plain video"
                )
            video_files.append(selected)
            # Sofdec2 carries per-stream transparency as a parallel alpha
            # mask stream (MPEG-1 grayscale here); pair it with the color
            # stream so the runtime video keeps its transparency.
            alpha_stream = usm.alphas[index] if index < len(usm.alphas) else None
            if alpha_stream is None:
                continue
            alpha_candidate = scratch / f"alpha-{index}.bin"
            with alpha_candidate.open("wb") as file:
                for packet in alpha_stream.stream(mode, active_usm.video_key):
                    file.write(packet[0] if isinstance(packet, tuple) else packet)
            with alpha_candidate.open("rb") as input_stream:
                alpha_header = input_stream.read(12)
            if alpha_header[:4] == b"DKIF" or alpha_header[:4] == b"\x00\x00\x01\xb3":
                alpha_target = alpha_candidate.with_suffix(
                    ".ivf" if alpha_header[:4] == b"DKIF" else ".m2v"
                )
                os.replace(alpha_candidate, alpha_target)
                alpha_files[index] = alpha_target
            else:
                alpha_candidate.unlink()
        audio = None
        for index, stream in enumerate(usm.audios[:1]):
            raw_audio = scratch / f"audio-{index}.bin"
            with raw_audio.open("wb") as file:
                for packet in stream.stream(OpMode.DECRYPT, usm.audio_key):
                    file.write(packet[0] if isinstance(packet, tuple) else packet)
            compressed = raw_audio.with_suffix(
                _cri_audio_extension(raw_audio.read_bytes()[:4])
            )
            os.replace(raw_audio, compressed)
            audio = scratch / "audio.wav"
            if compressed.suffix == ".hca":
                (scratch / ".hcakey").write_text(key, "ascii")
            _run(
                [_tool("vgmstream-cli"), "-o", str(audio), str(compressed)], cwd=scratch
            )
        if not video_files:
            raise RuntimeError(f"USM contains no video stream: {payload}")
        records = []
        for index, video in enumerate(video_files):
            suffix, video_codec, audio_codec = _video_output_profile(
                video.read_bytes()[:12]
            )
            name = (
                f"video{suffix}"
                if len(video_files) == 1
                else f"video-{index + 1}{suffix}"
            )
            target = output / name
            temporary = target.with_name(f".{target.stem}.{os.getpid()}.tmp{suffix}")
            alpha = alpha_files.get(index)
            command = [
                _tool("ffmpeg"),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(video),
            ]
            if alpha is not None:
                # Re-encode color+mask into one VP9 stream with real
                # transparency (WebM alpha_mode); the opaque copy path cannot
                # carry the mask. Expand the declared video range before using
                # luma as alpha: limited-range masks encode clear/opaque as
                # 16/235, while alpha must use the full 0/255 range.
                command.extend(["-i", str(alpha)])
                mask_filter = "format=gray"
                if _probe_streams(alpha).get("videoColorRange") == "tv":
                    mask_filter += ",lut=y='clip((val-16)*255/219,0,255)'"
                if audio:
                    command.extend(["-i", str(audio)])
                command.extend(
                    [
                        "-filter_complex",
                        f"[1:v]{mask_filter},setsar=1[a];[0:v]setsar=1[c];[c][a]alphamerge[v]",
                        "-map",
                        "[v]",
                    ]
                )
                if audio:
                    command.extend(["-map", "2:a:0", *audio_codec])
                command.extend(
                    [
                        "-map_metadata",
                        "-1",
                        "-c:v",
                        "libvpx-vp9",
                        "-pix_fmt",
                        "yuva420p",
                        "-crf",
                        "30",
                        "-b:v",
                        "0",
                        "-row-mt",
                        "1",
                        "-threads",
                        "8",
                        "-auto-alt-ref",
                        "0",
                        "-fflags",
                        "+bitexact",
                    ]
                )
            else:
                if audio:
                    command.extend(["-i", str(audio)])
                command.extend(["-map", "0:v:0"])
                if audio:
                    command.extend(["-map", "1:a:0"])
                command.extend(["-map_metadata", "-1", *video_codec])
                if audio:
                    command.extend(audio_codec)
                if suffix == ".webm":
                    command.extend(["-fflags", "+bitexact"])
                if suffix == ".mp4":
                    command.extend(["-movflags", "+faststart"])
            command.append(str(temporary))
            _run(command)
            os.replace(temporary, target)
            records.append(
                {
                    "path": target.as_posix(),
                    "bytes": target.stat().st_size,
                    "sha256": sha256_file(target),
                }
            )
            if alpha is not None:
                # One H.264 clock carries color on the left and alpha on the
                # right. Video decoders expand the TV-range mask to RGB 0/255;
                # the runtime shader samples its red channel directly.
                packed = output / f"{target.stem}-alpha-packed.mp4"
                packed_temporary = packed.with_name(
                    f".{packed.stem}.{os.getpid()}.tmp.mp4"
                )
                packed_command = [
                    _tool("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error",
                    "-i", str(video), "-i", str(alpha),
                ]
                if audio:
                    packed_command.extend(["-i", str(audio)])
                packed_command.extend([
                    "-filter_complex_threads", "1",
                    "-filter_complex",
                    f"[1:v]{mask_filter},setrange=full,"
                    "scale=in_range=full:out_range=tv:out_color_matrix=bt709,"
                    "format=yuv420p,lutyuv=u=128:v=128,setsar=1[a];"
                    "[0:v]scale=out_range=tv:out_color_matrix=bt709,"
                    "format=yuv420p,setsar=1[c];"
                    "[c][a]hstack=inputs=2:shortest=1,"
                    "setparams=range=limited:color_primaries=bt709:"
                    "color_trc=bt709:colorspace=bt709[v]",
                    "-map", "[v]",
                ])
                if audio:
                    packed_command.extend(["-map", "2:a:0", "-c:a", "aac", "-b:a", "256k"])
                packed_command.extend([
                    "-map_metadata", "-1", "-c:v", "libx264", "-preset", "medium",
                    "-crf", "12", "-pix_fmt", "yuv420p", "-color_range", "tv",
                    "-colorspace", "bt709", "-color_primaries", "bt709",
                    "-color_trc", "bt709",
                    "-threads", "2", "-movflags", "+faststart", str(packed_temporary),
                ])
                try:
                    _run(packed_command)
                    packed_probe = _probe_streams(packed_temporary)
                    color_probe = _probe_streams(video)
                    if (
                        packed_probe["videoCount"] != 1
                        or packed_probe["videoCodec"] != "h264"
                        or packed_probe["videoWidth"] != color_probe["videoWidth"] * 2
                        or packed_probe["videoHeight"] != color_probe["videoHeight"]
                        or packed_probe["videoColorRange"] != "tv"
                        or packed_probe["videoColorSpace"] != "bt709"
                        or packed_probe["videoColorPrimaries"] != "bt709"
                        or packed_probe["videoColorTransfer"] != "bt709"
                    ):
                        raise RuntimeError(f"invalid packed alpha video: {packed_probe}")
                    os.replace(packed_temporary, packed)
                finally:
                    packed_temporary.unlink(missing_ok=True)
                records[-1].update({
                    "alphaLayout": "color-left-alpha-right",
                    "alphaPackedPath": packed.as_posix(),
                    "alphaPackedWidth": packed_probe["videoWidth"],
                    "alphaPackedHeight": packed_probe["videoHeight"],
                    "width": color_probe["videoWidth"],
                    "height": color_probe["videoHeight"],
                    "alphaChannel": "r",
                    "alphaValueRange": "full",
                })
                records.append({
                    "path": packed.as_posix(),
                    "bytes": packed.stat().st_size,
                    "sha256": sha256_file(packed),
                    "role": "alpha-packed",
                })
        return records


def _kind(payload: Path) -> str | None:
    with payload.open("rb") as file:
        magic = file.read(4)
    if magic == b"CRID":
        return "usm"
    if magic in {b"@UTF", b"AFS2"}:
        return "acb"
    return None


def _remote_runtime_path(artifact: dict[str, Any]) -> PurePosixPath:
    addressables = artifact.get("addressables") or {}
    parts = addressables.get("primaryParts") or []
    filename = str(parts[0] if parts else artifact["originalFilename"])
    stem = HASH_SUFFIX.sub("", filename)
    locales = set(str(value) for value in addressables.get("locales", []))
    if locales and not locales.intersection({"", "ja"}):
        if len(locales) != 1 or not locales <= {"en", "zh-Hant", "zh-Hans", "ko"}:
            raise ValueError(
                f"CRI payload has unsupported locale ownership: {filename}: {sorted(locales)}"
            )
        stem = f"{stem}({next(iter(locales))})"
    namespace = str(parts[1] if len(parts) > 1 else "cri_assets_cri/unknown")
    if namespace.startswith("cri_assets_"):
        namespace = namespace.removeprefix("cri_assets_")
    namespace_parts = PurePosixPath(namespace).parts
    # Card payloads are namespaced through their addressable collection
    # (membercard_assets_membercard/51); drop the collection segment so the
    # runtime path stays cri/<card>/... like every other card movie.
    if namespace_parts and namespace_parts[0].startswith("membercard_assets_"):
        namespace_parts = namespace_parts[1:]
    if namespace_parts[:1] != ("cri",):
        namespace_parts = ("cri", *namespace_parts)
    return PurePosixPath(*namespace_parts, stem)


def _serialized_cri_payload(data: dict[str, Any] | None) -> bytes | None:
    references = (data or {}).get("references")
    ref_ids = references.get("RefIds") if isinstance(references, dict) else None
    for reference in ref_ids if isinstance(ref_ids, list) else []:
        kind = reference.get("type") if isinstance(reference, dict) else None
        payload = reference.get("data") if isinstance(reference, dict) else None
        raw = payload.get("data") if isinstance(payload, dict) else None
        if (
            isinstance(kind, dict)
            and kind.get("class") == "CriSerializedBytesAssetImpl"
            and isinstance(raw, list)
            and all(isinstance(value, int) for value in raw)
        ):
            return bytes(value & 255 for value in raw)
    return None


def _embedded_payloads(
    build: Any,
    source_index: dict[str, Any],
    delta: Any = None,
) -> list[tuple[str, bytes, PurePosixPath]]:
    values = []
    prefix = PurePosixPath("Assets/AddressableResources/Cri")
    store = UnityObjectStore(build, source_index)
    for source_path, record in sorted((source_index.get("sources") or {}).items()):
        source = PurePosixPath(source_path)
        try:
            tail = source.relative_to(prefix)
        except ValueError:
            continue
        raw = None
        try:
            raw = _serialized_cri_payload(store.source_data(source_path))
        except FileNotFoundError:
            if delta is None:
                raise
            # Delta build: the source's object archive belongs to a reusable
            # bundle; materialize it once from the base release and retry.
            descriptor = store.descriptor(source_path)
            digest = str(descriptor["selectedBundle"])
            if not delta.reusable(digest):
                raise
            delta.fetch_archive(
                digest,
                build.objects / "unity" / f"{digest}.jsonl.gz",
            )
            raw = _serialized_cri_payload(store.source_data(source_path))
        if raw is None:
            chunks = []
            for output in record.get("outputs", []):
                match = CHUNK_SUFFIX.search(output["path"])
                if match:
                    chunks.append(
                        (
                            int(match.group(1)),
                            str(output["path"]),
                            build.root / output["path"],
                        )
                    )
            if not chunks:
                continue
            for _, relative, file in sorted(chunks):
                if file.is_file() or delta is None:
                    continue
                declared = next(
                    (
                        output
                        for output in record.get("outputs", [])
                        if str(output.get("path")) == relative
                    ),
                    None,
                )
                digest = str((declared or {}).get("bundleSha256") or "")
                if not digest or not delta.reusable(digest):
                    raise FileNotFoundError(
                        f"embedded CRI chunk is missing locally and cannot be restored: {relative}"
                    )
                delta.fetch_release_path(relative, file)
            raw = b"".join(
                bytes(value ^ 0x5A for value in file.read_bytes())
                for _, _, file in sorted(chunks)
            )
        if raw[:4] != b"@UTF":
            continue
        if len(raw) >= 8:
            expected = int.from_bytes(raw[4:8], "big") + 8
            if 8 <= expected <= len(raw):
                raw = raw[:expected]
        if any(part.casefold().startswith("notese_") for part in tail.parts):
            relative = PurePosixPath("note-se")
        else:
            relative = PurePosixPath(
                "cri", *[part.casefold() for part in tail.parts[:-1]], source.stem
            )
        values.append((source_path, raw, relative))
    return values


def _metadata_from_acb_payload(
    payload: Path | bytes, hca_key: str
) -> dict[int, dict[str, Any]]:
    with tempfile.TemporaryDirectory(prefix="haneoka-acb-metadata-") as directory:
        scratch = Path(directory)
        source = scratch / "source.acb"
        if isinstance(payload, Path):
            source.symlink_to(payload.resolve())
        else:
            source.write_bytes(payload)
        (scratch / ".hcakey").write_text(hca_key, "ascii")
        return _acb_stream_metadata(source, scratch)


def _existing_output_stream_index(
    output: dict[str, Any], metadata: dict[int, dict[str, Any]]
) -> int:
    stem = PurePosixPath(str(output.get("path") or "")).stem
    prefix = re.match(r"^(\d+)_", stem)
    if prefix and int(prefix.group(1)) in metadata:
        return int(prefix.group(1))
    suffix = re.search(r"_(\d+)$", stem)
    if suffix and int(suffix.group(1)) in metadata:
        return int(suffix.group(1))
    cue_matches = [
        index
        for index, value in metadata.items()
        if str(value.get("cueName") or "").casefold() == stem.casefold()
    ]
    if len(cue_matches) == 1:
        return cue_matches[0]
    raise ValueError(
        f"CRI output cannot be bound to exact vgmstream metadata: {output.get('path')}"
    )


def refresh_cri_audio_metadata(
    config: ServerConfig,
    source_id: str,
    build_id: str,
    concurrency: int = 4,
) -> dict[str, Any]:
    """Refresh exact ACB cue timing without re-decoding already-built media."""
    source = source_layout(config.id, source_id)
    build = build_layout(config.id, build_id)
    source_manifest = read_json(source.manifest)
    source_index = read_json(build.metadata / "source-index.json")
    manifest_path = build.metadata / "cri.json"
    manifest = read_json(manifest_path)

    artifacts: dict[str, Path] = {}
    for artifact in source_manifest.get("files", []):
        if artifact.get("role") != "cri-payload":
            continue
        name = str(artifact.get("originalFilename") or "")
        if not name or name in artifacts:
            raise ValueError(
                f"CRI source manifest has a missing or duplicate original filename: {name!r}"
            )
        artifacts[name] = source.root / str(artifact.get("path") or "")
    embedded = {
        source_path: payload
        for source_path, payload, _ in _embedded_payloads(build, source_index)
    }

    entries = [
        entry for entry in manifest.get("entries", []) if entry.get("kind") == "acb"
    ]
    tasks: list[tuple[dict[str, Any], Path | bytes]] = []
    for entry in entries:
        source_record = (
            entry.get("source") if isinstance(entry.get("source"), dict) else {}
        )
        original = str(source_record.get("originalFilename") or "")
        unity_source = str(source_record.get("unitySourcePath") or "")
        payload: Path | bytes | None = (
            artifacts.get(original) if original else embedded.get(unity_source)
        )
        if payload is None:
            raise FileNotFoundError(
                f"CRI manifest source payload is missing: {original or unity_source or entry.get('runtimePath')}"
            )
        tasks.append((entry, payload))

    workers = max(1, min(int(concurrency), len(tasks) or 1))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        metadata_rows = list(
            executor.map(
                lambda task: _metadata_from_acb_payload(task[1], config.cri_hca_key),
                tasks,
            )
        )

    output_count = 0
    for (entry, _), metadata in zip(tasks, metadata_rows, strict=True):
        outputs = entry.get("outputs", [])
        if len(outputs) != len(metadata):
            raise ValueError(
                f"CRI output/metadata count mismatch: {entry.get('runtimePath')}: "
                f"{len(outputs)} != {len(metadata)}"
            )
        used: set[int] = set()
        for output in outputs:
            index = _existing_output_stream_index(output, metadata)
            if index in used:
                raise ValueError(
                    f"CRI stream metadata is reused: {entry.get('runtimePath')}#{index}"
                )
            used.add(index)
            output.update(metadata[index])
            output_count += 1
        if used != set(metadata):
            raise ValueError(
                f"CRI stream metadata is incomplete: {entry.get('runtimePath')}"
            )

    write_json(manifest_path, manifest, pretty=True)
    return {
        "schema": manifest.get("schema"),
        "server": config.id,
        "sourceId": source_id,
        "buildId": build_id,
        "acbCount": len(entries),
        "audioOutputCount": output_count,
    }


def _decode_task(
    task: dict[str, Any], config: ServerConfig, root: Path
) -> dict[str, Any]:
    output = root / Path(*task["relative"].parts)
    payload = task.get("payload")
    temporary: Path | None = None
    try:
        if payload is None:
            temporary = root / "embedded.acb"
            temporary.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_bytes(task["bytes"])
            payload = temporary
        files = (
            _decode_acb(
                payload,
                output,
                config.cri_hca_key,
                task.get("preferred", ""),
                task.get("semanticDecodeProfile", ""),
            )
            if task["kind"] == "acb"
            else _decode_usm(
                payload,
                output,
                config.cri_hca_key,
                tuple(task.get("metadataEncodings") or ()),
            )
        )
    except Exception as error:
        raise RuntimeError(
            f"failed to decode CRI source {task['label']}: {error}"
        ) from error
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

    outputs = []
    for file in files:
        staged = Path(file["path"])
        metadata = {
            key: value for key, value in file.items()
            if key not in {"path", "bytes", "sha256"}
        }
        if metadata.get("alphaPackedPath"):
            metadata["alphaPackedPath"] = (
                "runtime/" + Path(metadata["alphaPackedPath"]).relative_to(root).as_posix()
            )
        outputs.append(
            {
                "path": f"runtime/{staged.relative_to(root).as_posix()}",
                "bytes": file["bytes"],
                "sha256": file["sha256"],
                **metadata,
                "_staged": staged,
            }
        )
    return {
        "source": task["source"],
        "kind": task["kind"],
        "runtimePath": task["relative"].as_posix(),
        "taskId": task["taskId"],
        **(
            {"semanticDecodeProfile": task["semanticDecodeProfile"]}
            if task.get("semanticDecodeProfile")
            else {}
        ),
        "outputs": outputs,
    }


def _cached_output_relative(output: dict[str, Any]) -> PurePosixPath:
    relative = PurePosixPath(str(output.get("path") or ""))
    if (
        len(relative.parts) < 3
        or relative.parts[0] != "runtime"
        or relative.parts[1] not in {"cri", "note-se"}
        or ".." in relative.parts
        or not SHA256.fullmatch(str(output.get("sha256") or ""))
        or not isinstance(output.get("bytes"), int)
        or output["bytes"] < 0
    ):
        raise ValueError(f"invalid cached CRI output: {output}")
    return relative


def _cached_records(
    manifest: dict[str, Any] | None, transform_id: str
) -> dict[str, dict[str, Any]]:
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != CRI_SCHEMA
        or manifest.get("transformId") != transform_id
        or not isinstance(manifest.get("entries"), list)
    ):
        return {}
    records: dict[str, dict[str, Any]] = {}
    paths: set[str] = set()
    for record in manifest["entries"]:
        task_id = str(record.get("taskId") or "") if isinstance(record, dict) else ""
        outputs = record.get("outputs") if isinstance(record, dict) else None
        if (
            not SHA256.fullmatch(task_id)
            or task_id in records
            or not isinstance(record.get("source"), dict)
            or record.get("kind") not in {"acb", "usm"}
            or not isinstance(record.get("runtimePath"), str)
            or not isinstance(outputs, list)
            or not outputs
        ):
            raise ValueError(
                "current CRI cache manifest contains an invalid or repeated task"
            )
        for output in outputs:
            if not isinstance(output, dict):
                raise ValueError(
                    "current CRI cache manifest contains a non-object output"
                )
            path = _cached_output_relative(output).as_posix()
            if path in paths:
                raise ValueError(
                    f"current CRI cache manifest repeats an output path: {path}"
                )
            paths.add(path)
        records[task_id] = record
    return records


def _cached_by_source(
    manifest: dict[str, Any] | None,
    transform_id: str,
    key_field: str,
) -> dict[str, dict[str, Any]]:
    """Index cached CRI records by a source-identity field for declare lookups.

    Applies the same compatibility gate as :func:`_cached_records`; the taskId
    remap for compatible transforms happens later against concrete tasks.
    """

    try:
        records = _cached_records(manifest, transform_id)
    except ValueError:
        return {}
    by_source: dict[str, dict[str, Any]] = {}
    for record in records.values():
        key = str((record.get("source") or {}).get(key_field) or "")
        if key:
            by_source.setdefault(key, record)
    return by_source


def _declare_cached_record(
    cached_by_source: dict[str, dict[str, Any]],
    source: dict[str, Any],
    runtime_path: PurePosixPath,
    semantic_decode_profile: str = "",
) -> dict[str, Any] | None:
    """Return the base record adoptable for one source identity, if any.

    Adoption requires the recomputed runtime path to match the base record: a
    changed addressables context changes the task identity and must not adopt.
    """

    key = str(source.get("artifactSha256") or "")
    record = cached_by_source.get(key) if key else None
    if record is None:
        return None
    if str(record.get("runtimePath") or "") != runtime_path.as_posix():
        return None
    if str(record.get("semanticDecodeProfile") or "") != semantic_decode_profile:
        return None
    if not isinstance(record.get("outputs"), list) or not record["outputs"]:
        return None
    return record


def _restore_cached_records(
    tasks: list[dict[str, Any]],
    records: dict[str, dict[str, Any]],
    build_root: Path,
    restore_output: RestoreOutput | None,
    concurrency: int,
    declare: bool = False,
    delta: Any = None,
) -> tuple[dict[int, dict[str, Any]], dict[str, int]]:
    if not records or (restore_output is None and not declare):
        return {}, {
            "candidateSourceCount": 0,
            "reusedSourceCount": 0,
            "reusedOutputCount": 0,
            "reusedBytes": 0,
            "restoreFailureCount": 0,
        }

    candidates: dict[int, dict[str, Any]] = {}
    for index, task in enumerate(tasks):
        record = records.get(task["taskId"])
        if not isinstance(record, dict):
            continue
        if (
            record.get("source") != task["source"]
            or record.get("kind") != task["kind"]
            or record.get("runtimePath") != task["relative"].as_posix()
            or str(record.get("semanticDecodeProfile") or "")
            != str(task.get("semanticDecodeProfile") or "")
        ):
            continue
        cached = deepcopy(record)
        candidates[index] = cached

    if declare:
        # Declare mode: adopted records keep their base manifest entries; no
        # output bytes are restored into the build workspace.  Every adopted
        # output must be declared exactly by the base release manifest.
        reused: dict[int, dict[str, Any]] = {}
        failed: set[int] = set()
        for index, record in candidates.items():
            valid = True
            for output in record["outputs"]:
                try:
                    relative = _cached_output_relative(output).as_posix()
                    entry = delta.require_entry(relative)
                    if str(entry.get("sha256")) != str(output.get("sha256")) or int(
                        entry.get("bytes", -1)
                    ) != int(output.get("bytes")):
                        raise ValueError("base entry mismatch")
                except Exception:
                    valid = False
                    break
            if valid:
                reused[index] = record
            else:
                failed.add(index)
        return reused, {
            "candidateSourceCount": len(candidates),
            "reusedSourceCount": len(reused),
            "reusedOutputCount": sum(
                len(record["outputs"]) for record in reused.values()
            ),
            "reusedBytes": sum(
                int(output["bytes"])
                for record in reused.values()
                for output in record["outputs"]
            ),
            "restoreFailureCount": len(failed),
        }

    jobs: list[tuple[int, dict[str, Any], Path]] = []
    for index, record in candidates.items():
        for output in record["outputs"]:
            relative = _cached_output_relative(output)
            jobs.append((index, output, build_root.joinpath(*relative.parts)))

    def restore(job: tuple[int, dict[str, Any], Path]) -> tuple[int, bool]:
        index, output, target = job
        try:
            restore_output(output, target)
            if (
                target.stat().st_size != output["bytes"]
                or sha256_file(target) != output["sha256"]
            ):
                raise ValueError(
                    f"restored CRI output does not match its cache identity: {output['path']}"
                )
            return index, True
        except Exception:
            target.unlink(missing_ok=True)
            return index, False

    workers = max(1, min(int(concurrency), len(jobs) or 1))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        outcomes = list(executor.map(restore, jobs))
    failed = {index for index, success in outcomes if not success}
    for index in failed:
        for output in candidates[index]["outputs"]:
            relative = _cached_output_relative(output)
            build_root.joinpath(*relative.parts).unlink(missing_ok=True)
    reused = {
        index: record for index, record in candidates.items() if index not in failed
    }
    return reused, {
        "candidateSourceCount": len(candidates),
        "reusedSourceCount": len(reused),
        "reusedOutputCount": sum(len(record["outputs"]) for record in reused.values()),
        "reusedBytes": sum(
            int(output["bytes"])
            for record in reused.values()
            for output in record["outputs"]
        ),
        "restoreFailureCount": len(failed),
    }


def _master_rows(build_root: Path, table: str) -> list[dict[str, Any]]:
    path = build_root / "master" / f"{table}.json"
    if not path.is_file():
        raise FileNotFoundError(f"required Master table is missing: {path}")
    value = read_json(path)
    if isinstance(value, list):
        return value
    rows = value.get("_allData") if isinstance(value, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"invalid Master table shape: {path}")
    return rows


def _runtime_file(build_root: Path, output: dict[str, Any]) -> Path:
    """Resolve one CRI runtime output to its build-tree path.

    Tolerates an absent file: declared outputs of adopted records exist only
    in the base release, and every caller either probes/restores the file or
    rejects the missing case itself.
    """

    relative = PurePosixPath(str(output.get("path") or ""))
    if relative.parts[:1] != ("runtime",) or ".." in relative.parts:
        raise ValueError(f"invalid CRI runtime output path: {relative}")
    return build_root.joinpath(*relative.parts)


def _probe_streams(path: Path) -> dict[str, Any]:
    result = _run(
        [
            _tool("ffprobe"),
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,color_range,color_space,color_primaries,color_transfer,width,height:stream_tags=alpha_mode",
            "-of",
            "json",
            str(path),
        ]
    )
    streams = json.loads(result.stdout or "{}").get("streams", [])
    videos = [stream for stream in streams if stream.get("codec_type") == "video"]
    audios = [stream for stream in streams if stream.get("codec_type") == "audio"]
    return {
        "videoCount": len(videos),
        "videoCodec": videos[0].get("codec_name") if len(videos) == 1 else None,
        "videoColorRange": videos[0].get("color_range") if len(videos) == 1 else None,
        "videoColorSpace": videos[0].get("color_space") if len(videos) == 1 else None,
        "videoColorPrimaries": videos[0].get("color_primaries") if len(videos) == 1 else None,
        "videoColorTransfer": videos[0].get("color_transfer") if len(videos) == 1 else None,
        "videoWidth": videos[0].get("width") if len(videos) == 1 else None,
        "videoHeight": videos[0].get("height") if len(videos) == 1 else None,
        "videoAlpha": (videos[0].get("tags", {}) or {}).get("alpha_mode") == "1"
        if len(videos) == 1
        else False,
        "audioCount": len(audios),
        "audioCodec": audios[0].get("codec_name") if len(audios) == 1 else None,
    }


def _exact_video_entry(
    entries: list[dict[str, Any]], asset_name: str
) -> dict[str, Any] | None:
    """Resolve MasterVideo._assetName by exact normalized runtime path components.

    Returns None when no USM matches (e.g. the video is not present in an offline
    install-time asset pack); raises only on genuine ambiguity (>1 match).
    """
    asset_parts = tuple(part.casefold() for part in PurePosixPath(asset_name).parts)
    if not asset_parts or any(part in {"", ".", ".."} for part in asset_parts):
        raise ValueError(f"invalid MasterVideo._assetName: {asset_name!r}")
    matches = []
    for entry in entries:
        if entry.get("kind") != "usm":
            continue
        runtime_parts = tuple(
            part.casefold()
            for part in PurePosixPath(str(entry.get("runtimePath") or "")).parts
        )
        if (
            len(runtime_parts) >= len(asset_parts)
            and runtime_parts[-len(asset_parts) :] == asset_parts
        ):
            matches.append(entry)
    if len(matches) > 1:
        raise ValueError(
            "MasterVideo._assetName must resolve to exactly one CRI USM runtimePath: "
            f"{asset_name!r} resolved to {len(matches)} entries"
        )
    return matches[0] if matches else None


def _exact_music_audio_entry(
    entries_by_runtime: dict[str, list[dict[str, Any]]], cue_sheet_name: str
) -> dict[str, Any] | None:
    # _embedded_payloads derives this path directly from
    # Assets/AddressableResources/Cri/Sound/MusicScore/<cue sheet>.asset.
    # Returns None when the ACB is not present (e.g. offline install-time pack without
    # the CDN-served music-score ACBs); raises only on genuine ambiguity (>1 match).
    runtime_path = PurePosixPath(
        "cri", "sound", "musicscore", cue_sheet_name
    ).as_posix()
    matches = [
        entry
        for entry in entries_by_runtime.get(runtime_path, [])
        if entry.get("kind") == "acb"
    ]
    if len(matches) > 1:
        raise ValueError(
            "MasterSoundCueSheet._cueSheetName must resolve to exactly one MusicScore ACB "
            f"runtimePath: {cue_sheet_name!r} -> {runtime_path!r} resolved to {len(matches)} entries"
        )
    return matches[0] if matches else None


def _single_output(
    entry: dict[str, Any], suffixes: set[str], description: str
) -> dict[str, Any]:
    outputs = [
        output
        for output in entry.get("outputs", [])
        if PurePosixPath(str(output.get("path") or "")).suffix.casefold() in suffixes
        and output.get("role") != "alpha-packed"
    ]
    if len(outputs) != 1:
        raise ValueError(
            f"{description} must have exactly one matching runtime output, found {len(outputs)}"
        )
    return outputs[0]


def _mux_exact_music_audio(video: Path, audio: Path) -> dict[str, Any]:
    suffix = video.suffix.casefold()
    if suffix not in {".webm", ".mp4"}:
        raise ValueError(f"unsupported browser video container for music mux: {video}")
    temporary = video.with_name(f".{video.stem}.{os.getpid()}.music-audio.tmp{suffix}")
    command = [
        _tool("ffmpeg"),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video),
        "-i",
        str(audio),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-c:v",
        "copy",
    ]
    if suffix == ".webm":
        command.extend(["-c:a", "libopus", "-b:a", "256k", "-fflags", "+bitexact"])
        expected_audio_codec = "opus"
    else:
        command.extend(["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"])
        expected_audio_codec = "aac"
    command.append(str(temporary))
    try:
        _run(command)
        probe = _probe_streams(temporary)
        if probe["videoCount"] != 1 or probe["audioCount"] != 1:
            raise RuntimeError(f"muxed output has unexpected stream layout: {probe}")
        if probe["audioCodec"] != expected_audio_codec:
            raise RuntimeError(
                f"muxed output audio codec is {probe['audioCodec']!r}, expected {expected_audio_codec!r}"
            )
        os.replace(temporary, video)
        return probe
    finally:
        temporary.unlink(missing_ok=True)


def _annotate_video_outputs(
    build_root: Path, entries: list[dict[str, Any]], delta: Any = None
) -> None:
    """Record actual output streams; never copy MasterVideo._hasAudio into the manifest."""
    for entry in entries:
        if entry.get("kind") != "usm":
            continue
        for output in entry.get("outputs", []):
            if PurePosixPath(str(output.get("path") or "")).suffix.casefold() not in {
                ".webm",
                ".mp4",
            }:
                continue
            path = _runtime_file(build_root, output)
            if not path.is_file():
                if (
                    delta is not None
                    and "hasAudio" in output
                    and "videoCodec" in output
                ):
                    # Declared output adopted from the base release: the base
                    # build probed these streams when it produced the file.
                    continue
                if delta is not None:
                    delta.fetch_release_path(str(output["path"]), path)
                else:
                    raise FileNotFoundError(f"CRI video output is missing: {path}")
            probe = _probe_streams(path)
            if probe["videoCount"] != 1:
                raise RuntimeError(
                    f"CRI video output has unexpected video stream count: {path}: {probe}"
                )
            output["hasAudio"] = probe["audioCount"] > 0
            output["videoCodec"] = probe["videoCodec"]
            output["hasAlpha"] = bool(probe.get("videoAlpha"))
            if probe["audioCount"]:
                output["audioCodec"] = probe["audioCodec"]
            else:
                output.pop("audioCodec", None)


def _apply_music_video_audio(
    build_root: Path,
    manifest: dict[str, Any],
    declare: bool = False,
    delta: Any = None,
    restore_output: RestoreOutput | None = None,
    base_bindings: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise ValueError("invalid CRI manifest: entries must be a list")
    entries_by_runtime: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        runtime_path = str(entry.get("runtimePath") or "")
        if not runtime_path:
            raise ValueError("CRI runtimePath must be non-empty")
        entries_by_runtime.setdefault(runtime_path, []).append(entry)
    base_bindings_by_video = {
        str(binding.get("videoOutputPath") or ""): binding
        for binding in (base_bindings or [])
        if isinstance(binding, dict)
    }

    live_music = _master_rows(build_root, "MasterLiveMusic")
    videos = {
        int(row.get("_id") or 0): row for row in _master_rows(build_root, "MasterVideo")
    }
    sounds = {
        int(row.get("_id") or 0): row for row in _master_rows(build_root, "MasterSound")
    }
    cue_sheets = {
        int(row.get("_id") or 0): row
        for row in _master_rows(build_root, "MasterSoundCueSheet")
    }

    bindings = []
    claimed_outputs: dict[str, tuple[int, int]] = {}
    for music in sorted(live_music, key=lambda row: int(row.get("_id") or 0)):
        music_id = int(music.get("_id") or 0)
        video_ids = [int(value) for value in music.get("_musicVideoIDs", [])]
        if not video_ids:
            continue
        sound_id = int(music.get("_musicSoundID") or 0)
        sound = sounds.get(sound_id)
        if not sound:
            raise ValueError(
                f"MasterLiveMusic {music_id} references missing MasterSound {sound_id}"
            )
        cue_sheet_id = int(sound.get("_soundCueSheetID") or 0)
        cue_sheet = cue_sheets.get(cue_sheet_id)
        if not cue_sheet:
            raise ValueError(
                f"MasterSound {sound_id} references missing MasterSoundCueSheet {cue_sheet_id}"
            )
        cue_sheet_name = str(cue_sheet.get("_cueSheetName") or "")
        audio_entry = _exact_music_audio_entry(entries_by_runtime, cue_sheet_name)
        if audio_entry is None:
            sys.stderr.write(
                f"warning: skipping music {music_id} audio/video binding; MusicScore ACB not available: {cue_sheet_name!r}\n"
            )
            continue
        audio_output = _single_output(
            audio_entry, {".mp3"}, f"music ACB {cue_sheet_name}"
        )
        audio_path = _runtime_file(build_root, audio_output)
        if audio_path.is_file():
            audio_sha256 = sha256_file(audio_path)
            if audio_output.get("sha256") != audio_sha256:
                raise ValueError(
                    f"music runtime hash does not match CRI manifest: {audio_path}"
                )
        elif declare:
            # Declared audio output: its sha256 was validated against the base
            # release manifest when the record was adopted.
            audio_sha256 = str(audio_output.get("sha256"))
        else:
            raise FileNotFoundError(f"music runtime output is missing: {audio_path}")

        for video_id in sorted(video_ids):
            video = videos.get(video_id)
            if not video:
                raise ValueError(
                    f"MasterLiveMusic {music_id} references missing MasterVideo {video_id}"
                )
            asset_name = str(video.get("_assetName") or "")
            video_entry = _exact_video_entry(entries, asset_name)
            if video_entry is None:
                sys.stderr.write(
                    f"warning: skipping music {music_id} video {video_id}; USM not available: {asset_name!r}\n"
                )
                continue
            video_output = _single_output(
                video_entry, {".webm", ".mp4"}, f"video USM {asset_name}"
            )
            video_path = _runtime_file(build_root, video_output)
            output_key = str(video_output["path"])
            prior_claim = claimed_outputs.get(output_key)
            claim = (sound_id, cue_sheet_id)
            if prior_claim and prior_claim != claim:
                raise ValueError(
                    f"CRI video output is bound to conflicting music audio: {output_key}"
                )
            claimed_outputs[output_key] = claim
            binding_core = {
                "masterLiveMusicId": music_id,
                "masterVideoId": video_id,
                "masterVideoAssetName": asset_name,
                "videoRuntimePath": video_entry["runtimePath"],
                "masterSoundId": sound_id,
                "masterSoundCueSheetId": cue_sheet_id,
                "cueSheetName": cue_sheet_name,
                "audioRuntimePath": audio_entry["runtimePath"],
                "audioOutputPath": audio_output["path"],
                "audioSourceSha256": audio_sha256,
                "audioBitrate": 256000,
            }
            prior_binding = video_output.get("musicVideoAudioBinding")
            current_sha256 = sha256_file(video_path) if video_path.is_file() else None
            already_current = (
                current_sha256 is not None
                and prior_binding == binding_core
                and video_output.get("sha256") == current_sha256
                and _probe_streams(video_path).get("audioCount") == 1
            )
            if not already_current and current_sha256 is None and declare:
                # Declared video output: adopt the base binding when the
                # recomputed binding core and the output digest both match.
                base_binding = base_bindings_by_video.get(output_key)
                if (
                    prior_binding == binding_core
                    and isinstance(base_binding, dict)
                    and str(base_binding.get("outputSha256") or "")
                    == str(video_output.get("sha256"))
                    and isinstance(base_binding.get("hasAudio"), bool)
                ):
                    probe = {
                        "audioCodec": base_binding.get("audioCodec"),
                        "audioCount": 1 if base_binding["hasAudio"] else 0,
                    }
                    bindings.append(
                        {
                            **binding_core,
                            "videoOutputPath": output_key,
                            "outputSha256": video_output.get("sha256"),
                            "audioCodec": probe.get("audioCodec"),
                            "hasAudio": probe.get("audioCount") == 1,
                        }
                    )
                    continue
                # The binding changed without new media (e.g. a Master update):
                # restore the declared outputs and run the exact mux below.
                if restore_output is None or delta is None:
                    raise FileNotFoundError(
                        f"declared CRI video output needs re-muxing but cannot be restored: {output_key}"
                    )
                delta.fetch_release_path(output_key, video_path)
                current_sha256 = sha256_file(video_path)
            if already_current:
                probe = _probe_streams(video_path)
            else:
                if video_output.get("sha256") != current_sha256:
                    raise ValueError(
                        f"video runtime hash does not match CRI manifest: {video_path}"
                    )
                # A fresh/local video can still depend on an adopted audio
                # output that exists only in the pinned base release. Restore
                # that dependency for every remux, then verify its identity.
                if not audio_path.is_file():
                    if not declare or delta is None:
                        raise FileNotFoundError(
                            f"music runtime output needs restoring before mux: {audio_path}"
                        )
                    delta.fetch_release_path(str(audio_output["path"]), audio_path)
                if (
                    audio_path.stat().st_size != audio_output.get("bytes")
                    or sha256_file(audio_path) != audio_sha256
                ):
                    raise ValueError(
                        f"music runtime identity does not match CRI manifest before mux: {audio_path}"
                    )
                probe = _mux_exact_music_audio(video_path, audio_path)
                current_sha256 = sha256_file(video_path)
                video_output.update(
                    bytes=video_path.stat().st_size,
                    sha256=current_sha256,
                    musicVideoAudioBinding=binding_core,
                )
            bindings.append(
                {
                    **binding_core,
                    "videoOutputPath": output_key,
                    "outputSha256": current_sha256,
                    "audioCodec": probe.get("audioCodec"),
                    "hasAudio": probe.get("audioCount") == 1,
                }
            )

    _annotate_video_outputs(build_root, entries, delta=delta)
    if any(not binding["hasAudio"] for binding in bindings):
        raise RuntimeError(
            "one or more exact Master music-video bindings lack an audio stream"
        )
    manifest["schema"] = CRI_SCHEMA
    manifest["musicVideoMux"] = {
        "declaredCount": len(bindings),
        "resolvedCount": len(bindings),
        "hasAudioCount": sum(bool(binding["hasAudio"]) for binding in bindings),
        "musicAudioOutputCount": len(bindings),
        "videoStreamCopyCount": len(bindings),
        "bindings": bindings,
        "evidence": {
            "masterBinding": (
                "MasterLiveMusic._musicVideoIDs -> MasterVideo._assetName -> exact normalized "
                "CRI USM runtimePath; MasterLiveMusic._musicSoundID -> MasterSound._soundCueSheetID "
                "-> MasterSoundCueSheet._cueSheetName -> exact MusicScore CRI ACB runtimePath."
            ),
            "runtimeBinding": (
                "Video matching uses exact normalized path-component suffix equality; music audio "
                "uses cri/sound/musicscore/<cueSheetName> equality. No filename substring search is used."
            ),
        },
    }
    manifest["outputCount"] = sum(len(entry.get("outputs", [])) for entry in entries)
    return manifest


def remux_music_videos(build_root: Path) -> dict[str, Any]:
    """Targeted, repeatable MV audio pass for an already prepared build."""
    manifest_path = build_root / "metadata" / "cri.json"
    manifest = _apply_music_video_audio(build_root, read_json(manifest_path))
    write_json(manifest_path, manifest, pretty=True)
    return manifest


def extract_cri(
    config: ServerConfig,
    source_id: str,
    build_id: str,
    concurrency: int = 2,
    reuse_manifest: dict[str, Any] | None = None,
    restore_output: RestoreOutput | None = None,
    reuse_concurrency: int = 32,
    delta: Any = None,
) -> dict[str, Any]:
    """Decode original and embedded CRI payloads into runtime media.

    Delta mode (``delta`` provided) declares reusable sources from the base
    release's CRI document without restoring their output bytes: task
    identities are recomputed from source metadata and matched against the
    base document, and adopted outputs must already be declared by the base
    release manifest.  Fresh decodes write real files as always.
    """

    source = source_layout(config.id, source_id)
    build = build_layout(config.id, build_id)
    source_manifest = read_json(source.manifest)
    source_index = read_json(build.metadata / "source-index.json")
    shutil.rmtree(build.runtime / "cri", ignore_errors=True)
    shutil.rmtree(build.runtime / "note-se", ignore_errors=True)
    staging = build.root / ".cri-staging"
    shutil.rmtree(staging, ignore_errors=True)
    transform_id = _cri_transform_id(config)
    declare = delta is not None

    tasks: list[dict[str, Any]] = []
    for artifact in sorted(
        source_manifest.get("files", []), key=lambda item: item["path"]
    ):
        if artifact.get("role") != "cri-payload":
            continue
        payload = source.root / artifact["path"]
        source_identity = {
            "artifactSha256": artifact["sha256"],
            "originalFilename": artifact["originalFilename"],
        }
        metadata_encodings = _usm_metadata_encodings(
            (artifact.get("addressables") or {}).get("locales")
        )
        if payload.is_file():
            kind = _kind(payload)
            if not kind:
                raise ValueError(
                    f"unknown CRI payload format: {artifact['originalFilename']}"
                )
            tasks.append(
                {
                    "label": artifact["originalFilename"],
                    "source": source_identity,
                    "kind": kind,
                    "relative": _remote_runtime_path(artifact),
                    "payload": payload,
                    "metadataEncodings": metadata_encodings,
                }
            )
            continue
        if not declare:
            raise FileNotFoundError(
                f"required CRI payload is not available locally: {payload}"
            )
        cached_by_source = _cached_by_source(
            reuse_manifest, transform_id, "artifactSha256"
        )
        cached_source = cached_by_source.get(str(artifact["sha256"])) or {}
        record = _declare_cached_record(
            cached_by_source=cached_by_source,
            source=source_identity,
            runtime_path=_remote_runtime_path(artifact),
            semantic_decode_profile=(
                USM_DECODE_PROFILE if cached_source.get("kind") == "usm" else ""
            ),
        )
        if record is None:
            # Adoptable in principle but rejected by validation: restore the
            # payload from the source CAS and decode it fresh.
            delta.fetch_original_bundle(artifact["sha256"], payload)
            kind = _kind(payload)
            if not kind:
                raise ValueError(
                    f"unknown CRI payload format: {artifact['originalFilename']}"
                )
            tasks.append(
                {
                    "label": artifact["originalFilename"],
                    "source": source_identity,
                    "kind": kind,
                    "relative": _remote_runtime_path(artifact),
                    "payload": payload,
                    "metadataEncodings": metadata_encodings,
                }
            )
            continue
        tasks.append(
            {
                "label": artifact["originalFilename"],
                "source": source_identity,
                "kind": str(record["kind"]),
                "relative": PurePosixPath(str(record["runtimePath"])),
                "payload": None,
                "metadataEncodings": metadata_encodings,
                "artifactPath": str(artifact["path"]),
            }
        )

    for source_path, payload, relative in _embedded_payloads(
        build, source_index, delta
    ):
        task = {
            "label": source_path,
            "source": {
                "unitySourcePath": source_path,
                "payloadSha256": sha256_bytes(payload),
            },
            "kind": "acb",
            "relative": relative,
            "bytes": payload,
            "preferred": PurePosixPath(source_path).stem
            if relative == PurePosixPath("note-se")
            else "",
        }
        if relative == PurePosixPath("note-se"):
            task["semanticDecodeProfile"] = NOTE_SE_DECODE_PROFILE
        tasks.append(task)
    for task in tasks:
        if task["kind"] == "usm":
            task["semanticDecodeProfile"] = USM_DECODE_PROFILE
        task["taskId"] = _cri_task_id(task, transform_id)

    try:
        staging.mkdir(parents=True, exist_ok=True)
        cache_manifest_accepted = False
        try:
            previous_transform = str((reuse_manifest or {}).get("transformId") or "")
            compatible_key = (
                sha256_bytes(config.cri_hca_key) == config.cri_compatibility_key_sha256
            )
            cached = (
                _cached_records(reuse_manifest, transform_id)
                if previous_transform == transform_id or compatible_key
                else {}
            )
            if cached and previous_transform != transform_id:

                def legacy_id(task: dict[str, Any]) -> str | None:
                    for schema in TASK_ID_SCHEMAS:
                        legacy = _cri_task_id(task, previous_transform, schema)
                        if legacy in cached:
                            return legacy
                    return None

                remapped = {}
                for task in tasks:
                    legacy = legacy_id(task)
                    if legacy is None:
                        continue
                    remapped[task["taskId"]] = {
                        **cached[legacy],
                        "taskId": task["taskId"],
                    }
                if len(remapped) < len(cached):
                    sys.stderr.write(
                        f"warning: CRI cache remap matched {len(remapped)} of {len(cached)} "
                        f"base records (transform {previous_transform[:12]})\n"
                    )
                cached = remapped
            cache_manifest_accepted = bool(cached)
        except ValueError as error:
            sys.stderr.write(f"warning: CRI cache manifest rejected: {error}\n")
            cached = {}
        reused, reuse = _restore_cached_records(
            tasks,
            cached,
            build.root,
            restore_output,
            reuse_concurrency,
            declare=declare,
            delta=delta,
        )
        records: list[dict[str, Any] | None] = [None] * len(tasks)
        for index, record in reused.items():
            records[index] = record
        pending = [
            (index, task) for index, task in enumerate(tasks) if records[index] is None
        ]
        # Declare tasks whose adoption was rejected still need their original
        # payload to decode; restore it from the source CAS on demand.
        for index, task in pending:
            if task.get("payload") is None and "bytes" not in task:
                digest = str(task["source"]["artifactSha256"])
                target = source.root / str(task["artifactPath"])
                delta.fetch_original_bundle(digest, target)
                kind = _kind(target)
                if kind != task["kind"]:
                    raise ValueError(
                        f"restored CRI payload kind differs from its base record: {task['label']}"
                    )
                task["payload"] = target
        workers = max(1, min(int(concurrency), len(pending) or 1))

        def decode(indexed: tuple[int, dict[str, Any]]) -> dict[str, Any] | None:
            index, task = indexed
            try:
                return _decode_task(task, config, staging / f"{index:04d}")
            except Exception as error:
                if task["kind"] == "usm" and task["relative"] == PurePosixPath(
                    "cri/video/test/movie"
                ):
                    sys.stderr.write(
                        f"warning: test-only CRI movie has no decodable video stream: {task.get('label')}; skipping\n"
                    )
                    return None
                raise RuntimeError(
                    f"required CRI source failed to decode: {task.get('label')}"
                ) from error

        with ThreadPoolExecutor(max_workers=workers) as executor:
            decoded = list(executor.map(decode, pending))
        for (index, _), record in zip(pending, decoded, strict=True):
            records[index] = record
            if record is None:
                continue
            for output in record["outputs"]:
                staged = output.pop("_staged")
                hardlink_or_copy(
                    staged, build.root.joinpath(*PurePosixPath(output["path"]).parts)
                )
        if any(record is None for record in records):
            skipped = sum(1 for record in records if record is None)
            sys.stderr.write(
                f"warning: {skipped} CRI source(s) failed to decode and were skipped\n"
            )
        complete = [record for record in records if isinstance(record, dict)]
        manifest = {
            "schema": CRI_SCHEMA,
            "server": config.id,
            "sourceId": source_id,
            "transformId": transform_id,
            "sourceCount": len(complete),
            "outputCount": sum(len(record["outputs"]) for record in complete),
            "entries": complete,
        }
        base_bindings = (
            (reuse_manifest or {}).get("musicVideoMux", {}).get("bindings")
            if isinstance((reuse_manifest or {}).get("musicVideoMux"), dict)
            else None
        )
        manifest = _apply_music_video_audio(
            build.root,
            manifest,
            declare=declare,
            delta=delta,
            restore_output=restore_output,
            base_bindings=base_bindings,
        )
        write_json(build.metadata / "cri.json", manifest, pretty=True)
        return {
            **manifest,
            "reuse": {
                "cacheManifestAccepted": cache_manifest_accepted,
                **reuse,
                "decodedSourceCount": len(pending),
            },
        }
    finally:
        shutil.rmtree(staging, ignore_errors=True)
