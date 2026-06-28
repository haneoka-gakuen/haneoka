"""Decode CRI source payloads into deterministic playable runtime media."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
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
CRI_TRANSFORM_SCHEMA = "haneoka-cri-transform-v1"
RestoreOutput = Callable[[dict[str, Any], Path], None]


def _cri_transform_id(config: ServerConfig) -> str:
    identity = {
        "schema": CRI_TRANSFORM_SCHEMA,
        "extractorSha256": sha256_file(Path(__file__)),
        "hcaKeySha256": sha256_bytes(config.cri_hca_key),
    }
    return sha256_bytes(stable_json(identity))


def _cri_task_id(task: dict[str, Any], transform_id: str) -> str:
    identity = {
        "schema": CRI_TRANSFORM_SCHEMA,
        "transformId": transform_id,
        "source": task["source"],
        "kind": task["kind"],
        "runtimePath": task["relative"].as_posix(),
        "preferredStem": str(task.get("preferred") or ""),
    }
    return sha256_bytes(stable_json(identity))


def _tool(name: str) -> str:
    value = shutil.which(name)
    if not value:
        raise RuntimeError(f"required CRI tool is not installed: {name}")
    return value


def _run(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()[:1000]
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{detail}")
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


def _vgmstream_json_lines(result: subprocess.CompletedProcess[str], source: Path) -> list[dict[str, Any]]:
    values = []
    for line in result.stdout.splitlines():
        text = line.strip()
        if not text.startswith("{"):
            continue
        try:
            value = json.loads(text)
        except json.JSONDecodeError as error:
            raise ValueError(f"vgmstream returned invalid JSON metadata for {source}") from error
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
        stream = info.get("streamInfo") if isinstance(info.get("streamInfo"), dict) else {}
        index = int(stream.get("index") or 0)
        total = int(stream.get("total") or len(infos))
        sample_rate = int(info.get("sampleRate") or 0)
        total_samples = int(info.get("numberOfSamples") or 0)
        if index <= 0 or index in output:
            raise ValueError(f"vgmstream returned an invalid stream index for {source}: {index}")
        if total != len(infos) or sample_rate <= 0 or total_samples <= 0:
            raise ValueError(f"vgmstream returned incomplete stream metadata for {source}#{index}")
        loop = info.get("loopingInfo") if isinstance(info.get("loopingInfo"), dict) else None
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
                "loopStartMs": round(loop_start / sample_rate * 1000) if has_loop else None,
                "loopEndMs": round(loop_end / sample_rate * 1000) if has_loop else None,
            },
        }
    return output


def _decoded_stream_index(path: Path) -> int:
    match = re.match(r"^(\d+)_", path.stem)
    if not match:
        raise ValueError(f"vgmstream output has no stream index: {path.name}")
    return int(match.group(1))


def _decode_acb(payload: Path, output: Path, hca_key: str, preferred_stem: str = "") -> list[dict[str, Any]]:
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="haneoka-acb-") as directory:
        scratch = Path(directory)
        source = scratch / "source.acb"
        shutil.copy2(payload, source)
        (scratch / ".hcakey").write_text(hca_key, "ascii")
        metadata = _acb_stream_metadata(source, scratch)
        _run([_tool("vgmstream-cli"), "-S", "0", "-o", "?s_?n.wav", source.name], cwd=scratch)
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
                raise RuntimeError(f"vgmstream output has no matching metadata: {payload}#{stream_index}")
            stem = _safe_name(
                f"{preferred_stem}_{index + 1}" if preferred_stem and len(wavs) > 1 else preferred_stem or wav.stem,
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


def _decode_usm(payload: Path, output: Path, key: str) -> list[dict[str, Any]]:
    from wannacri.usm import Usm
    from wannacri.usm.types import OpMode

    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="haneoka-usm-") as directory:
        scratch = Path(directory)
        usm = Usm.open(str(payload), key=int(key))
        video_files = []
        for index, stream in enumerate(usm.videos):
            target = scratch / f"video-{index}.ivf"
            with target.open("wb") as file:
                for packet in stream.stream(OpMode.DECRYPT, usm.video_key):
                    file.write(packet[0] if isinstance(packet, tuple) else packet)
            video_files.append(target)
        audio = None
        for index, stream in enumerate(usm.audios[:1]):
            raw_audio = scratch / f"audio-{index}.bin"
            with raw_audio.open("wb") as file:
                for packet in stream.stream(OpMode.DECRYPT, usm.audio_key):
                    file.write(packet[0] if isinstance(packet, tuple) else packet)
            compressed = raw_audio.with_suffix(_cri_audio_extension(raw_audio.read_bytes()[:4]))
            os.replace(raw_audio, compressed)
            audio = scratch / "audio.wav"
            if compressed.suffix == ".hca":
                (scratch / ".hcakey").write_text(key, "ascii")
            _run([_tool("vgmstream-cli"), "-o", str(audio), str(compressed)], cwd=scratch)
        if not video_files:
            raise RuntimeError(f"USM contains no video stream: {payload}")
        records = []
        for index, video in enumerate(video_files):
            suffix, video_codec, audio_codec = _video_output_profile(video.read_bytes()[:12])
            name = f"video{suffix}" if len(video_files) == 1 else f"video-{index + 1}{suffix}"
            target = output / name
            temporary = target.with_name(f".{target.stem}.{os.getpid()}.tmp{suffix}")
            command = [
                _tool("ffmpeg"),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(video),
            ]
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
            records.append({"path": target.as_posix(), "bytes": target.stat().st_size, "sha256": sha256_file(target)})
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
    namespace = str(parts[1] if len(parts) > 1 else "cri_assets_cri/unknown")
    if namespace.startswith("cri_assets_"):
        namespace = namespace.removeprefix("cri_assets_")
    namespace_parts = PurePosixPath(namespace).parts
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


def _embedded_payloads(build: Any, source_index: dict[str, Any]) -> list[tuple[str, bytes, PurePosixPath]]:
    values = []
    prefix = PurePosixPath("Assets/AddressableResources/Cri")
    store = UnityObjectStore(build, source_index)
    for source_path, record in sorted((source_index.get("sources") or {}).items()):
        source = PurePosixPath(source_path)
        try:
            tail = source.relative_to(prefix)
        except ValueError:
            continue
        raw = _serialized_cri_payload(store.source_data(source_path))
        if raw is None:
            chunks = []
            for output in record.get("outputs", []):
                match = CHUNK_SUFFIX.search(output["path"])
                if match:
                    chunks.append((int(match.group(1)), build.root / output["path"]))
            if not chunks:
                continue
            raw = b"".join(bytes(value ^ 0x5A for value in file.read_bytes()) for _, file in sorted(chunks))
        if raw[:4] != b"@UTF":
            continue
        if len(raw) >= 8:
            expected = int.from_bytes(raw[4:8], "big") + 8
            if 8 <= expected <= len(raw):
                raw = raw[:expected]
        if any(part.casefold().startswith("notese_") for part in tail.parts):
            relative = PurePosixPath("note-se")
        else:
            relative = PurePosixPath("cri", *[part.casefold() for part in tail.parts[:-1]], source.stem)
        values.append((source_path, raw, relative))
    return values


def _metadata_from_acb_payload(payload: Path | bytes, hca_key: str) -> dict[int, dict[str, Any]]:
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
    raise ValueError(f"CRI output cannot be bound to exact vgmstream metadata: {output.get('path')}")


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
            raise ValueError(f"CRI source manifest has a missing or duplicate original filename: {name!r}")
        artifacts[name] = source.root / str(artifact.get("path") or "")
    embedded = {
        source_path: payload
        for source_path, payload, _ in _embedded_payloads(build, source_index)
    }

    entries = [entry for entry in manifest.get("entries", []) if entry.get("kind") == "acb"]
    tasks: list[tuple[dict[str, Any], Path | bytes]] = []
    for entry in entries:
        source_record = entry.get("source") if isinstance(entry.get("source"), dict) else {}
        original = str(source_record.get("originalFilename") or "")
        unity_source = str(source_record.get("unitySourcePath") or "")
        payload: Path | bytes | None = artifacts.get(original) if original else embedded.get(unity_source)
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
                raise ValueError(f"CRI stream metadata is reused: {entry.get('runtimePath')}#{index}")
            used.add(index)
            output.update(metadata[index])
            output_count += 1
        if used != set(metadata):
            raise ValueError(f"CRI stream metadata is incomplete: {entry.get('runtimePath')}")

    write_json(manifest_path, manifest, pretty=True)
    return {
        "schema": manifest.get("schema"),
        "server": config.id,
        "sourceId": source_id,
        "buildId": build_id,
        "acbCount": len(entries),
        "audioOutputCount": output_count,
    }


def _decode_task(task: dict[str, Any], config: ServerConfig, root: Path) -> dict[str, Any]:
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
            _decode_acb(payload, output, config.cri_hca_key, task.get("preferred", ""))
            if task["kind"] == "acb"
            else _decode_usm(payload, output, config.cri_hca_key)
        )
    except Exception as error:
        raise RuntimeError(f"failed to decode CRI source {task['label']}: {error}") from error
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

    outputs = []
    for file in files:
        staged = Path(file["path"])
        outputs.append(
            {
                "path": f"runtime/{staged.relative_to(root).as_posix()}",
                "bytes": file["bytes"],
                "sha256": file["sha256"],
                **{
                    key: value
                    for key, value in file.items()
                    if key not in {"path", "bytes", "sha256"}
                },
                "_staged": staged,
            }
        )
    return {
        "source": task["source"],
        "kind": task["kind"],
        "runtimePath": task["relative"].as_posix(),
        "taskId": task["taskId"],
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


def _cached_records(manifest: dict[str, Any] | None, transform_id: str) -> dict[str, dict[str, Any]]:
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
            raise ValueError("current CRI cache manifest contains an invalid or repeated task")
        for output in outputs:
            if not isinstance(output, dict):
                raise ValueError("current CRI cache manifest contains a non-object output")
            path = _cached_output_relative(output).as_posix()
            if path in paths:
                raise ValueError(f"current CRI cache manifest repeats an output path: {path}")
            paths.add(path)
        records[task_id] = record
    return records


def _restore_cached_records(
    tasks: list[dict[str, Any]],
    records: dict[str, dict[str, Any]],
    build_root: Path,
    restore_output: RestoreOutput | None,
    concurrency: int,
) -> tuple[dict[int, dict[str, Any]], dict[str, int]]:
    if not records or restore_output is None:
        return {}, {
            "candidateSourceCount": 0,
            "reusedSourceCount": 0,
            "reusedOutputCount": 0,
            "reusedBytes": 0,
            "restoreFailureCount": 0,
        }

    candidates: dict[int, dict[str, Any]] = {}
    jobs: list[tuple[int, dict[str, Any], Path]] = []
    for index, task in enumerate(tasks):
        record = records.get(task["taskId"])
        if not isinstance(record, dict):
            continue
        if (
            record.get("source") != task["source"]
            or record.get("kind") != task["kind"]
            or record.get("runtimePath") != task["relative"].as_posix()
        ):
            continue
        cached = deepcopy(record)
        candidates[index] = cached
        for output in cached["outputs"]:
            relative = _cached_output_relative(output)
            jobs.append((index, output, build_root.joinpath(*relative.parts)))

    def restore(job: tuple[int, dict[str, Any], Path]) -> tuple[int, bool]:
        index, output, target = job
        try:
            restore_output(output, target)
            if target.stat().st_size != output["bytes"] or sha256_file(target) != output["sha256"]:
                raise ValueError(f"restored CRI output does not match its cache identity: {output['path']}")
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
    reused = {index: record for index, record in candidates.items() if index not in failed}
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
    relative = PurePosixPath(str(output.get("path") or ""))
    if relative.parts[:1] != ("runtime",) or ".." in relative.parts:
        raise ValueError(f"invalid CRI runtime output path: {relative}")
    path = build_root.joinpath(*relative.parts)
    if not path.is_file():
        raise FileNotFoundError(f"CRI runtime output is missing: {path}")
    return path


def _probe_streams(path: Path) -> dict[str, Any]:
    result = _run(
        [
            _tool("ffprobe"),
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name",
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
        "audioCount": len(audios),
        "audioCodec": audios[0].get("codec_name") if len(audios) == 1 else None,
    }


def _exact_video_entry(entries: list[dict[str, Any]], asset_name: str) -> dict[str, Any]:
    """Resolve MasterVideo._assetName by exact normalized runtime path components."""
    asset_parts = tuple(part.casefold() for part in PurePosixPath(asset_name).parts)
    if not asset_parts or any(part in {"", ".", ".."} for part in asset_parts):
        raise ValueError(f"invalid MasterVideo._assetName: {asset_name!r}")
    matches = []
    for entry in entries:
        if entry.get("kind") != "usm":
            continue
        runtime_parts = tuple(
            part.casefold() for part in PurePosixPath(str(entry.get("runtimePath") or "")).parts
        )
        if len(runtime_parts) >= len(asset_parts) and runtime_parts[-len(asset_parts):] == asset_parts:
            matches.append(entry)
    if len(matches) != 1:
        raise ValueError(
            "MasterVideo._assetName must resolve to exactly one CRI USM runtimePath: "
            f"{asset_name!r} resolved to {len(matches)} entries"
        )
    return matches[0]


def _exact_music_audio_entry(
    entries_by_runtime: dict[str, list[dict[str, Any]]], cue_sheet_name: str
) -> dict[str, Any]:
    # _embedded_payloads derives this path directly from
    # Assets/AddressableResources/Cri/Sound/MusicScore/<cue sheet>.asset.
    runtime_path = PurePosixPath("cri", "sound", "musicscore", cue_sheet_name).as_posix()
    matches = [
        entry
        for entry in entries_by_runtime.get(runtime_path, [])
        if entry.get("kind") == "acb"
    ]
    if len(matches) != 1:
        raise ValueError(
            "MasterSoundCueSheet._cueSheetName must resolve to exactly one MusicScore ACB "
            f"runtimePath: {cue_sheet_name!r} -> {runtime_path!r} resolved to {len(matches)} entries"
        )
    return matches[0]


def _single_output(
    entry: dict[str, Any], suffixes: set[str], description: str
) -> dict[str, Any]:
    outputs = [
        output
        for output in entry.get("outputs", [])
        if PurePosixPath(str(output.get("path") or "")).suffix.casefold() in suffixes
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


def _annotate_video_outputs(build_root: Path, entries: list[dict[str, Any]]) -> None:
    """Record actual output streams; never copy MasterVideo._hasAudio into the manifest."""
    for entry in entries:
        if entry.get("kind") != "usm":
            continue
        for output in entry.get("outputs", []):
            if PurePosixPath(str(output.get("path") or "")).suffix.casefold() not in {".webm", ".mp4"}:
                continue
            path = _runtime_file(build_root, output)
            probe = _probe_streams(path)
            if probe["videoCount"] != 1:
                raise RuntimeError(f"CRI video output has unexpected video stream count: {path}: {probe}")
            output["hasAudio"] = probe["audioCount"] > 0
            output["videoCodec"] = probe["videoCodec"]
            if probe["audioCount"]:
                output["audioCodec"] = probe["audioCodec"]
            else:
                output.pop("audioCodec", None)


def _apply_music_video_audio(build_root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise ValueError("invalid CRI manifest: entries must be a list")
    entries_by_runtime: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        runtime_path = str(entry.get("runtimePath") or "")
        if not runtime_path:
            raise ValueError("CRI runtimePath must be non-empty")
        entries_by_runtime.setdefault(runtime_path, []).append(entry)

    live_music = _master_rows(build_root, "MasterLiveMusic")
    videos = {int(row.get("_id") or 0): row for row in _master_rows(build_root, "MasterVideo")}
    sounds = {int(row.get("_id") or 0): row for row in _master_rows(build_root, "MasterSound")}
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
            raise ValueError(f"MasterLiveMusic {music_id} references missing MasterSound {sound_id}")
        cue_sheet_id = int(sound.get("_soundCueSheetID") or 0)
        cue_sheet = cue_sheets.get(cue_sheet_id)
        if not cue_sheet:
            raise ValueError(
                f"MasterSound {sound_id} references missing MasterSoundCueSheet {cue_sheet_id}"
            )
        cue_sheet_name = str(cue_sheet.get("_cueSheetName") or "")
        audio_entry = _exact_music_audio_entry(entries_by_runtime, cue_sheet_name)
        audio_output = _single_output(audio_entry, {".mp3"}, f"music ACB {cue_sheet_name}")
        audio_path = _runtime_file(build_root, audio_output)
        audio_sha256 = sha256_file(audio_path)
        if audio_output.get("sha256") != audio_sha256:
            raise ValueError(f"music runtime hash does not match CRI manifest: {audio_path}")

        for video_id in sorted(video_ids):
            video = videos.get(video_id)
            if not video:
                raise ValueError(
                    f"MasterLiveMusic {music_id} references missing MasterVideo {video_id}"
                )
            asset_name = str(video.get("_assetName") or "")
            video_entry = _exact_video_entry(entries, asset_name)
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
            current_sha256 = sha256_file(video_path)
            already_current = (
                prior_binding == binding_core
                and video_output.get("sha256") == current_sha256
                and _probe_streams(video_path).get("audioCount") == 1
            )
            if already_current:
                probe = _probe_streams(video_path)
            else:
                if video_output.get("sha256") != current_sha256:
                    raise ValueError(f"video runtime hash does not match CRI manifest: {video_path}")
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

    _annotate_video_outputs(build_root, entries)
    if any(not binding["hasAudio"] for binding in bindings):
        raise RuntimeError("one or more exact Master music-video bindings lack an audio stream")
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
) -> dict[str, Any]:
    source = source_layout(config.id, source_id)
    build = build_layout(config.id, build_id)
    source_manifest = read_json(source.manifest)
    source_index = read_json(build.metadata / "source-index.json")
    shutil.rmtree(build.runtime / "cri", ignore_errors=True)
    shutil.rmtree(build.runtime / "note-se", ignore_errors=True)
    staging = build.root / ".cri-staging"
    shutil.rmtree(staging, ignore_errors=True)
    transform_id = _cri_transform_id(config)
    tasks: list[dict[str, Any]] = []
    for artifact in sorted(source_manifest.get("files", []), key=lambda item: item["path"]):
        if artifact.get("role") != "cri-payload":
            continue
        payload = source.root / artifact["path"]
        kind = _kind(payload)
        if not kind:
            raise ValueError(f"unknown CRI payload format: {artifact['originalFilename']}")
        relative = _remote_runtime_path(artifact)
        tasks.append(
            {
                "label": artifact["originalFilename"],
                "source": {"artifactSha256": artifact["sha256"], "originalFilename": artifact["originalFilename"]},
                "kind": kind,
                "relative": relative,
                "payload": payload,
            }
        )

    for source_path, payload, relative in _embedded_payloads(build, source_index):
        tasks.append(
            {
                "label": source_path,
                "source": {
                    "unitySourcePath": source_path,
                    "payloadSha256": sha256_bytes(payload),
                },
                "kind": "acb",
                "relative": relative,
                "bytes": payload,
                "preferred": PurePosixPath(source_path).stem if relative == PurePosixPath("note-se") else "",
            }
        )
    for task in tasks:
        task["taskId"] = _cri_task_id(task, transform_id)

    try:
        staging.mkdir(parents=True, exist_ok=True)
        cache_manifest_accepted = False
        try:
            cached = _cached_records(reuse_manifest, transform_id)
            cache_manifest_accepted = bool(cached)
        except ValueError:
            cached = {}
        reused, reuse = _restore_cached_records(
            tasks,
            cached,
            build.root,
            restore_output,
            reuse_concurrency,
        )
        records: list[dict[str, Any] | None] = [None] * len(tasks)
        for index, record in reused.items():
            records[index] = record
        pending = [(index, task) for index, task in enumerate(tasks) if records[index] is None]
        workers = max(1, min(int(concurrency), len(pending) or 1))

        def decode(indexed: tuple[int, dict[str, Any]]) -> dict[str, Any]:
            index, task = indexed
            return _decode_task(task, config, staging / f"{index:04d}")

        with ThreadPoolExecutor(max_workers=workers) as executor:
            decoded = list(executor.map(decode, pending))
        for (index, _), record in zip(pending, decoded, strict=True):
            records[index] = record
            for output in record["outputs"]:
                staged = output.pop("_staged")
                hardlink_or_copy(staged, build.root.joinpath(*PurePosixPath(output["path"]).parts))
        if any(record is None for record in records):
            raise RuntimeError("one or more CRI tasks produced no record")
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
        manifest = _apply_music_video_audio(build.root, manifest)
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
