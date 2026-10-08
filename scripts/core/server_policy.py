"""Operational policy for incomplete test-server datasets."""
from __future__ import annotations

import sys


def is_test_server(server: str) -> bool:
    return "-test" in server


def project_catalog(server: str, name: str, build, *args, fallback=None):
    try:
        return build(*args)
    except (ValueError, FileNotFoundError, KeyError, TypeError) as error:
        if not is_test_server(server):
            raise
        print(f"warning: test-server projection {name} unavailable: {error}", file=sys.stderr)
        return {} if fallback is None else fallback
