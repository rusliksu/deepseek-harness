"""Keyless coverage for the optional ripgrep distribution."""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

SOURCE = (
    Path(__file__).resolve().parents[2]
    / "sdk-search"
    / "src"
    / "deepseek_harness_search"
    / "__init__.py"
)


def _install_module(root: Path, *, binary: bool) -> Path:
    package = root / "deepseek_harness_search"
    package.mkdir()
    module = package / "__init__.py"
    shutil.copy2(SOURCE, module)
    if binary:
        (package / "bin").mkdir()
        (package / "bin" / ("rg.exe" if sys.platform == "win32" else "rg")).write_text("")
    return module


def _load(module_path: Path):
    spec = importlib.util.spec_from_file_location("deepseek_harness_search", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_ripgrep_path_returns_the_packaged_binary(tmp_path: Path) -> None:
    module = _load(_install_module(tmp_path, binary=True))
    expected = module.__file__ and Path(module.__file__).with_name("bin") / (
        "rg.exe" if sys.platform == "win32" else "rg"
    )
    assert module.ripgrep_path() == expected


def test_ripgrep_path_reports_a_missing_payload(tmp_path: Path) -> None:
    module = _load(_install_module(tmp_path, binary=False))
    with pytest.raises(FileNotFoundError, match="missing its ripgrep binary"):
        module.ripgrep_path()
