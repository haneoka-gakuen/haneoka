"""Load Our Notes Android Unity bundles, decrypting their protected header.

The game encrypts only the first 16 KiB of a bundle with AES-CTR. The nonce is
derived from the exact bundle filename, including its Addressables hash. Keep
the immutable source file encrypted and use a copy-on-write mapping so the
large remainder of a bundle is never copied just to parse it.
"""

from __future__ import annotations

import hashlib
import mmap
from pathlib import Path
from typing import Iterable

import UnityPy
from Crypto.Cipher import AES

ENCRYPTED_HEADER_BYTES = 16 * 1024
KEY = bytes.fromhex("7372a4ee777db361ad896c99e408a182")
NONCE_SEED = bytes.fromhex("ee24a70238e2a0e5")
UNITY_SIGNATURE = b"UnityFS\0"


def decrypt_header(buffer: mmap.mmap, filename: str) -> None:
    """Decrypt one copy-on-write mapping in place and verify its Unity header."""
    if not filename or "/" in filename or "\\" in filename:
        raise ValueError("bundle decryption requires a plain filename")
    if buffer[: len(UNITY_SIGNATURE)] == UNITY_SIGNATURE:
        return
    nonce = hashlib.sha256(NONCE_SEED + filename.encode("utf-8")).digest()[:8]
    cipher = AES.new(KEY, AES.MODE_ECB)
    limit = min(len(buffer), ENCRYPTED_HEADER_BYTES)
    for offset in range(0, limit, 16):
        mask = cipher.encrypt(nonce + (offset // 16).to_bytes(8, "big"))
        count = min(16, limit - offset)
        buffer[offset : offset + count] = bytes(
            left ^ right for left, right in zip(buffer[offset : offset + count], mask)
        )
    if buffer[: len(UNITY_SIGNATURE)] != UNITY_SIGNATURE:
        raise ValueError(f"bundle header did not decrypt to UnityFS: {filename}")


def load_unity_bundle(file: Path, dependencies: Iterable[Path] = ()) -> UnityPy.Environment:
    """Load the main bundle and its dependencies without changing source bytes."""
    environment = UnityPy.Environment(path=str(file.parent))
    mappings: list[mmap.mmap] = []
    views: list[memoryview] = []
    try:
        for path, is_dependency in ((file, False), *((item, True) for item in dependencies)):
            with path.open("rb") as stream:
                signature = stream.read(len(UNITY_SIGNATURE))
                if signature == UNITY_SIGNATURE:
                    environment.load_file(str(path), is_dependency=is_dependency)
                    continue
                stream.seek(0)
                mapping = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_COPY)
            decrypt_header(mapping, path.name)
            view = memoryview(mapping)
            mappings.append(mapping)
            views.append(view)
            environment.load_file(view, name=str(path), is_dependency=is_dependency)
        # UnityPy readers retain the memoryviews while object data is parsed.
        environment._haneoka_mappings = (mappings, views)
        return environment
    except BaseException:
        environment.files.clear()
        environment.cabs.clear()
        for view in views:
            view.release()
        for mapping in mappings:
            mapping.close()
        raise
