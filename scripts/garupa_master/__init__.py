"""Garupa JP live-Master synchronization and projection tools.

This package is intentionally independent from ``scripts/extract/master.py``.
That module handles the repository's install-package Master format; this one
handles the encrypted protobuf Suite response served by ``api.garupa.jp``.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "1"
