# L3 — GEB
# Input: JSON 值、文件路径和待写字节／文本。
# Output: 稳定序列化、原子写入和 JSON 读取接口。
# Pos: [Map](L2-2.md)；流水线清单 I/O 基础。
# Effects/Dependencies: 创建目录、临时文件替换及文件读写；原子性限于单次文件替换。
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def stable_json(value: Any, pretty: bool = False) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    ) + "\n"


def atomic_write(file: Path, value: bytes | str) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(f".{file.name}.{os.getpid()}.tmp")
    if isinstance(value, str):
        temporary.write_text(value, "utf-8")
    else:
        temporary.write_bytes(value)
    os.replace(temporary, file)


def write_json(file: Path, value: Any, pretty: bool = False) -> None:
    atomic_write(file, stable_json(value, pretty))


def read_json(file: Path) -> Any:
    return json.loads(file.read_text("utf-8"))
