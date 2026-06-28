from __future__ import annotations

from pathlib import Path


ACTIVE_CONTENT_SUFFIXES = frozenset(
    {".css", ".htm", ".html", ".js", ".mjs", ".svg", ".svgz", ".xht", ".xhtml", ".xml", ".xsl", ".xslt"}
)
EXPLICIT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/x-ndjson; charset=utf-8",
    ".gz": "application/gzip",
    ".atlas": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".ktx2": "image/ktx2",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".glb": "model/gltf-binary",
    ".sqlite": "application/vnd.sqlite3",
}


def media_type(file: Path) -> str:
    return EXPLICIT.get(file.suffix.lower(), "application/octet-stream")
