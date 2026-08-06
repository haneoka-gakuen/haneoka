#!/usr/bin/env python3
"""Reconstruct a fully-plaintext ``libil2cpp.so`` from a partially-XOR-encrypted one.

Targeted at the protection used by the "Our Notes" / *Sirius* builds
(``com.bushiroad.siriusstaging`` jp-cbt and ``com.bilibili.sirius`` gl-cbt, and
expected to apply to future versions of the same family):

* The ELF is otherwise normal — section headers, ``.dynsym`` (``il2cpp_*``
  exports) and ``.plt`` are intact and plaintext.
* Roughly a quarter of the **executable** sections (``.text`` plus the custom
  ``il2cpp`` section that holds the compiled method bodies) is encrypted in
  **contiguous, per-method spans** with a **single-byte XOR key**.
* The key **differs per build** (jp-cbt = ``0x39``, gl-cbt = ``0xcc``). The rest
  of the code section is plaintext, so naively XORing the whole region
  (the old ``fullydecrypted`` / ``xor39-*`` variants) corrupts the plaintext
  spans — which is why those variants are unusable.

This script recovers the complete plaintext by, per instruction:

1. disassembling the original and the ``original ^ key`` form with ``objdump``;
2. marking each instruction *strong-encrypted* (invalid in original, valid after
   ``^key``) or *strong-plaintext* (valid in original, invalid after ``^key``);
3. assigning every ambiguous/data instruction to its **nearest** strong marker
   (this respects method boundaries, unlike a sliding-window vote which bleeds
   across them);
4. XORing every instruction that lands in an encrypted span.

The result is verified by counting ``<unknown>`` opcodes, which should collapse
from millions to a few thousand (the residual is legitimate data-in-code —
literal pools, jump tables — not encryption).

.. note::
   The top-6-bit opcode histogram is **XOR-invariant** (XOR-by-K only rotates
   the histogram bins, leaving the maximum unchanged), so it *cannot* detect the
   key or even tell encrypted from plaintext code. Use a real decoder (this
   script's ``objdump`` path) or exact common-instruction word matches instead.

Usage::

    python scripts/reconstruct_il2cpp_so.py path/to/libil2cpp.so
    python scripts/reconstruct_il2cpp_so.py path/to/libil2cpp.so -o out.so --key 0x39
    python scripts/reconstruct_il2cpp_so.py path/to/libil2cpp.so --detect-only

Requires: numpy, and ``objdump`` (llvm-objdump on macOS via Xcode, GNU binutils
elsewhere) on ``PATH`` (override with ``--objdump``).
"""

from __future__ import annotations

import argparse
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SHF_ALLOC = 0x2
SHF_EXECINSTR = 0x4
BLOCK_BYTES = 128  # 32 instructions — granularity for the key-detection heuristic


@dataclass(frozen=True)
class Section:
    name: str
    offset: int
    size: int
    addr: int
    flags: int


def read_elf_sections(path: Path) -> list[Section]:
    """Parse the ELF64 little-endian section header table."""
    data = path.read_bytes()
    if data[:4] != b"\x7fELF":
        raise ValueError(f"not an ELF file: {path}")
    if data[4] != 2 or data[5] != 1:
        raise ValueError(f"{path}: only ELF64 little-endian is supported")
    section_header_offset = struct.unpack_from("<Q", data, 0x28)[0]
    section_header_size = struct.unpack_from("<H", data, 0x3A)[0]
    section_count = struct.unpack_from("<H", data, 0x3C)[0]
    string_table_index = struct.unpack_from("<H", data, 0x3E)[0]
    string_table_offset = struct.unpack_from(
        "<Q", data, section_header_offset + string_table_index * section_header_size + 0x18
    )[0]
    sections: list[Section] = []
    for index in range(section_count):
        base = section_header_offset + index * section_header_size
        name_offset = struct.unpack_from("<I", data, base)[0]
        flags = struct.unpack_from("<Q", data, base + 0x08)[0]
        addr = struct.unpack_from("<Q", data, base + 0x10)[0]
        offset = struct.unpack_from("<Q", data, base + 0x18)[0]
        size = struct.unpack_from("<Q", data, base + 0x20)[0]
        end = data.index(b"\x00", string_table_offset + name_offset)
        name = data[string_table_offset + name_offset : end].decode("utf-8", "replace")
        sections.append(Section(name, offset, size, addr, flags))
    return sections


@dataclass(frozen=True)
class CodeRegion:
    file_start: int
    file_end: int
    vma_start: int
    vma_end: int
    bias: int  # vma - file_offset (uniform across the region)


def code_region(sections: list[Section]) -> CodeRegion:
    """Range covering every allocated executable section (`.text`, `il2cpp`, `.plt`)."""
    code = [s for s in sections if (s.flags & SHF_EXECINSTR) and (s.flags & SHF_ALLOC) and s.size]
    if not code:
        text = next((s for s in sections if s.name == ".text"), None)
        if text is None:
            raise ValueError("no executable sections and no .text section found")
        code = [text]
    file_start = min(s.offset for s in code)
    file_end = max(s.offset + s.size for s in code)
    vma_start = min(s.addr for s in code)
    vma_end = max(s.addr + s.size for s in code)
    bias = vma_start - file_start
    # The mapping vma -> vma - bias is only valid if every code section shares it.
    for s in code:
        if s.addr - s.offset != bias:
            raise ValueError(
                f"non-uniform VMA bias across executable sections (section {s.name!r} "
                f"differs); per-section mapping is not implemented"
            )
    return CodeRegion(file_start, file_end, vma_start, vma_end, bias)


def objdump_invalid_vmas(path: Path, vma_start: int, vma_end: int, objdump: str) -> set[int]:
    """VMA of every instruction objdump renders as `<unknown>` over [vma_start, vma_end)."""
    command = (
        f"{objdump} -d --start-address={vma_start:#x} --stop-address={vma_end:#x} {path} "
        f"| grep '<unknown>' | sed 's/^ *//'"
    )
    result = subprocess.run(command, shell=True, capture_output=True, text=True)
    invalid: set[int] = set()
    for line in result.stdout.splitlines():
        head = line.split(":", 1)[0]
        try:
            invalid.add(int(head, 16))
        except ValueError:
            continue
    return invalid


def common_instruction_set(data: np.ndarray, start: int, byte_count: int, min_freq: int = 4) -> np.ndarray:
    """Frequent 32-bit instruction words in a (assumed-plaintext) prefix of the code region."""
    prefix = np.ascontiguousarray(data[start : start + byte_count]).view("<u4").astype(np.uint64)
    values, counts = np.unique(prefix, return_counts=True)
    return np.array(sorted(int(v) for v, c in zip(values, counts) if c >= min_freq), dtype=np.uint64)


def detect_xor_key(
    data: np.ndarray, region: CodeRegion, input_path: Path, objdump: str, key_hint: int | None
) -> int:
    """Detect the single-byte XOR key (or return an explicit hint).

    Builds a set of common (frequent) 32-bit instruction words from a plaintext
    prefix of the code region, then picks the key that turns the hardest-to-decode
    blocks into the most real instructions. Relies on the final whole-region
    ``<unknown>`` drop (see :func:`main`) to reject a wrong key — an early
    per-window objdump confirmation proved unreliable because the encrypted spans
    are scattered and easily missed by sampling.
    """
    del input_path, objdump  # reserved for a future pre-confirmation step
    if key_hint is not None:
        return key_hint
    common = common_instruction_set(data, region.file_start, 131072)
    region_bytes = data[region.file_start : region.file_end]
    block_count = len(region_bytes) // BLOCK_BYTES
    blocks = (
        np.ascontiguousarray(region_bytes[: block_count * BLOCK_BYTES])
        .view("<u4")
        .reshape(block_count, 32)
        .astype(np.uint64)
    )
    scores = np.isin(blocks, common).sum(axis=1)
    sample = blocks[np.argsort(scores)[: min(8000, block_count)]]
    baseline = int(np.isin(sample, common).sum())  # how code-like the raw form already is
    best_key, best_score = 0, -1
    for key in range(1, 256):
        score = int(np.isin(sample ^ (key * 0x01010101), common).sum())
        if score > best_score:
            best_key, best_score = key, score
    if best_key == 0 or best_score <= baseline:
        raise ValueError(
            "no XOR key detected — the binary may already be fully plaintext, "
            "or use a different protection scheme (pass --key explicitly)"
        )
    return best_key


def nearest_distance(mask: np.ndarray, n: int) -> np.ndarray:
    """Distance (in instructions) from every index to the nearest True in `mask`."""
    indices = np.flatnonzero(mask)
    if indices.size == 0:
        return np.full(n, n + 1, dtype=np.int64)
    positions = np.arange(n)
    left_pos = np.searchsorted(indices, positions, "right") - 1
    left = np.full(n, n + 1, dtype=np.int64)
    valid = left_pos >= 0
    left[valid] = positions[valid] - indices[left_pos[valid]]
    right_pos = np.searchsorted(indices, positions, "left")
    right = np.full(n, n + 1, dtype=np.int64)
    valid_right = right_pos < indices.size
    right[valid_right] = indices[right_pos[valid_right]] - positions[valid_right]
    return np.minimum(left, right)


def reconstruct(input_path: Path, output_path: Path, key: int, objdump: str) -> dict:
    """Reconstruct the plaintext .so. Returns a stats dict."""
    data = np.fromfile(input_path, dtype=np.uint8)
    sections = read_elf_sections(input_path)
    region = code_region(sections)
    instruction_count = (region.file_end - region.file_start) // 4

    xored = data.copy()
    xored[region.file_start : region.file_end] ^= key
    with tempfile.NamedTemporaryFile(prefix="il2cpp-xor-", suffix=".so", delete=False) as tmp:
        tmp.write(xored.tobytes())
        xored_path = Path(tmp.name)
    try:
        original_invalid = objdump_invalid_vmas(input_path, region.vma_start, region.vma_end, objdump)
        xored_invalid = objdump_invalid_vmas(xored_path, region.vma_start, region.vma_end, objdump)
    finally:
        xored_path.unlink(missing_ok=True)

    encrypted = np.zeros(instruction_count, dtype=bool)   # invalid in original, valid under ^key
    plaintext = np.zeros(instruction_count, dtype=bool)   # valid in original, invalid under ^key
    for vma in original_invalid:
        if vma not in xored_invalid:
            encrypted[(vma - region.vma_start) // 4] = True
    for vma in xored_invalid:
        if vma not in original_invalid:
            plaintext[(vma - region.vma_start) // 4] = True

    encrypted_distance = nearest_distance(encrypted, instruction_count)
    plaintext_distance = nearest_distance(plaintext, instruction_count)
    encrypted_region = encrypted_distance < plaintext_distance  # nearer to encrypted than plaintext
    apply_xor = encrypted | (encrypted_region & ~plaintext)

    indices = np.flatnonzero(apply_xor)
    byte_mask = np.zeros(region.file_end - region.file_start, dtype=np.uint8)
    byte_starts = indices * 4
    byte_mask[byte_starts] = key
    byte_mask[byte_starts + 1] = key
    byte_mask[byte_starts + 2] = key
    byte_mask[byte_starts + 3] = key
    data[region.file_start : region.file_end] ^= byte_mask
    data.tofile(output_path)

    return {
        "key": key,
        "instructions": instruction_count,
        "xor_instructions": int(apply_xor.sum()),
        "encrypted_strong": int(encrypted.sum()),
        "plaintext_strong": int(plaintext.sum()),
        "original_invalid": len(original_invalid),
    }


def count_unknown(path: Path, region: CodeRegion, objdump: str) -> int:
    return len(objdump_invalid_vmas(path, region.vma_start, region.vma_end, objdump))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path, help="encrypted libil2cpp.so")
    parser.add_argument("-o", "--output", type=Path, help="output path (default: <input>.plaintext.so)")
    parser.add_argument("--key", type=lambda v: int(v, 0), help="XOR key as hex (e.g. 0x39); auto-detect if omitted")
    parser.add_argument("--objdump", default=shutil.which("objdump") or "objdump", help="objdump binary")
    parser.add_argument("--detect-only", action="store_true", help="report the detected key and exit")
    parser.add_argument("--no-verify", action="store_true", help="skip the post-reconstruction <unknown> check")
    args = parser.parse_args(argv)

    if not args.input.is_file():
        parser.error(f"input not found: {args.input}")
    output = args.output or args.input.with_suffix(".plaintext.so")

    data = np.fromfile(args.input, dtype=np.uint8)
    sections = read_elf_sections(args.input)
    region = code_region(sections)
    print(f"code region: {region.file_start:#x}..{region.file_end:#x} "
          f"({(region.file_end - region.file_start) // 1048576} MiB), bias {region.bias:#x}")

    key = detect_xor_key(data, region, args.input, args.objdump, args.key)
    print(f"XOR key: 0x{key:02x}")

    if args.detect_only:
        return 0

    stats = reconstruct(args.input, output, key, args.objdump)
    pct = 100 * stats["xor_instructions"] / stats["instructions"]
    print(f"decrypted {stats['xor_instructions']:,} / {stats['instructions']:,} instructions "
          f"({pct:.1f}% of code) [strong-encrypted={stats['encrypted_strong']:,}]")
    print(f"wrote {output}")

    if not args.no_verify:
        original_unknown = stats["original_invalid"]
        output_unknown = count_unknown(output, region, args.objdump)
        print(f"verify: <unknown> {original_unknown:,} -> {output_unknown:,}")
        if output_unknown >= original_unknown // 2:
            print("warning: <unknown> did not drop as expected — key or scheme may be wrong",
                  file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
