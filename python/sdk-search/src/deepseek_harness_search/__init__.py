"""Locate the ripgrep binary the DeepSeek Harness runtime executes for search."""

from __future__ import annotations

import sys
from pathlib import Path

_BINARY_NAMES = {"win32": "rg.exe"}


def ripgrep_path() -> Path:
    """Return the ripgrep binary packaged in this wheel.

    The wheel is platform-specific, so the installed binary always matches the
    host. Raises FileNotFoundError when the payload is missing, which reports a
    broken installation rather than treating search as unavailable.
    """
    binary = Path(__file__).with_name("bin") / _BINARY_NAMES.get(sys.platform, "rg")
    if not binary.is_file():
        raise FileNotFoundError(
            f"deepseek-harness-search-bin is missing its ripgrep binary at {binary}; reinstall the wheel"
        )
    return binary


__all__ = ["ripgrep_path"]
