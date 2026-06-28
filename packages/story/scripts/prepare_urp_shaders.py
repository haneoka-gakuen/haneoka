#!/usr/bin/env python3
"""Prepare GLES3 URP post-program references and their pass/blob mapping.

This is a research helper, not a runtime dependency. It expects UnityPy and the
operator-provided Unity data file selected for the compatibility study.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import UnityPy
from UnityPy.export.ShaderConverter import ShaderProgram
from UnityPy.helpers import CompressionHelper
from UnityPy.streams import EndianBinaryReader


UNITY_VERSION = (6000, 3, 12, 1)
GLES3_PLATFORM = 9
GLES3_PROGRAM = 4
TARGET_NAMES = {
    "Hidden/Universal Render Pipeline/Bloom",
    "Hidden/Universal Render Pipeline/BokehDepthOfField",
    "Hidden/Universal Render Pipeline/CameraMotionBlur",
    "Hidden/Universal Render Pipeline/CameraMotionVectors",
    "Hidden/Universal Render Pipeline/FinalPost",
    "Hidden/Universal Render Pipeline/GaussianDepthOfField",
    "Hidden/Universal Render Pipeline/LutBuilderHdr",
    "Hidden/Universal Render Pipeline/LutBuilderLdr",
    "Hidden/Universal Render Pipeline/PaniniProjection",
    "Hidden/Universal Render Pipeline/UberPost",
}


def flatten_entry(value: int | list[int]) -> int:
    return value[0] if isinstance(value, list) else value


def iter_passes(shader: Any) -> Iterator[tuple[int, int, Any]]:
    for subshader_index, subshader in enumerate(shader.m_ParsedForm.m_SubShaders):
        for pass_index, shader_pass in enumerate(subshader.m_Passes):
            yield subshader_index, pass_index, shader_pass


def prepare(unity_data: Path, output: Path) -> None:
    environment = UnityPy.load(str(unity_data))
    output.mkdir(parents=True, exist_ok=True)
    index: list[str] = []

    for obj in environment.objects:
        if obj.assets_file.name != "globalgamemanagers.assets" or obj.type.name != "Shader":
            continue
        shader = obj.read()
        parsed_name = shader.m_ParsedForm.m_Name if shader.m_ParsedForm else shader.m_Name
        if parsed_name not in TARGET_NAMES:
            continue

        platform_index = shader.platforms.index(GLES3_PLATFORM)
        offset = flatten_entry(shader.offsets[platform_index])
        compressed_length = flatten_entry(shader.compressedLengths[platform_index])
        decompressed_length = flatten_entry(shader.decompressedLengths[platform_index])
        compressed = bytes(shader.compressedBlob)[offset : offset + compressed_length]
        decompressed = CompressionHelper.decompress_lz4(compressed, decompressed_length)
        program = ShaderProgram(EndianBinaryReader(decompressed, endian="<"), UNITY_VERSION)
        keyword_names = shader.m_ParsedForm.m_KeywordNames
        stem = parsed_name.rsplit("/", 1)[-1].lower()

        index.append(
            f"TARGET {parsed_name} path={obj.path_id} asset={obj.assets_file.name} "
            f"programs={len(program.m_SubPrograms)}"
        )
        index.append(f"KEYWORDS {list(enumerate(keyword_names))}")
        for subshader_index, pass_index, shader_pass in iter_passes(shader):
            index.append(
                f"PASS sub={subshader_index} pass={pass_index} "
                f"name={shader_pass.m_Name!r} mask={shader_pass.m_ProgramMask}"
            )
            for stage_name in ("progVertex", "progFragment"):
                stage = getattr(shader_pass, stage_name)
                for tier_index, tier in enumerate(stage.m_PlayerSubPrograms):
                    for descriptor in tier:
                        if descriptor.m_GpuProgramType != GLES3_PROGRAM:
                            continue
                        keywords = [keyword_names[index] for index in descriptor.m_KeywordIndices]
                        index.append(
                            f"  {stage_name} tier={tier_index} blob={descriptor.m_BlobIndex} "
                            f"requirements={descriptor.m_ShaderRequirements} keywords={keywords}"
                        )
                        subprogram = program.m_SubPrograms[descriptor.m_BlobIndex]
                        code = bytes(subprogram.m_ProgramCode).decode("utf-8")
                        keyword_stem = "_".join(word.strip("_") for word in keywords) or "NONE"
                        filename = (
                            f"{stem}_s{subshader_index}_p{pass_index}_{stage_name}_"
                            f"{descriptor.m_BlobIndex}_{keyword_stem}.glsl"
                        )
                        (output / filename).write_text(code, encoding="utf-8")

    (output / "index.txt").write_text("\n".join(index) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("unity_data", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    prepare(args.unity_data, args.output)


if __name__ == "__main__":
    main()
