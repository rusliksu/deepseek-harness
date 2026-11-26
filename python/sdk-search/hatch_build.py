"""Assign the native wheel tag and validate the packaged ripgrep binary."""

from __future__ import annotations

import os
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

# Windows wheels ship the .exe suffix; every other tag ships the bare name.
BINARY_NAMES = {"win_amd64": "rg.exe"}


def expected_binary(tag: str) -> str:
    """Return the ripgrep file name one wheel tag ships."""
    return BINARY_NAMES.get(tag, "rg")


class SearchBuildHook(BuildHookInterface):
    """Tag the wheel for one platform and reject a wrong or missing binary."""

    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        if version == "editable":
            return
        if self.target_name == "sdist":
            raise RuntimeError(
                "deepseek-harness-search-bin is wheel-only; build and publish platform wheels only."
            )
        tag = os.environ.get("DSH_RUNTIME_PLATFORM_TAG")
        if not tag:
            raise RuntimeError(
                "deepseek-harness-search-bin builds require DSH_RUNTIME_PLATFORM_TAG, "
                "the same variable the runtime wheel uses"
            )
        binary = Path(self.root) / "src" / "deepseek_harness_search" / "bin" / expected_binary(tag)
        if not binary.is_file():
            raise RuntimeError(f"deepseek-harness-search-bin requires {binary} for tag {tag}")
        build_data["tag"] = f"py3-none-{tag}"
        build_data["pure_python"] = False
