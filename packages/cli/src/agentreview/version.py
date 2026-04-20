from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version as distribution_version
from pathlib import Path
import re

_PYPROJECT_VERSION_PATTERN = re.compile(r'(?m)^version\s*=\s*"([^"]+)"\s*$')


def _get_pyproject_version() -> str:
    for parent in Path(__file__).resolve().parents:
        pyproject = parent / "pyproject.toml"
        if not pyproject.is_file():
            continue

        match = _PYPROJECT_VERSION_PATTERN.search(
            pyproject.read_text(encoding="utf-8")
        )
        if match:
            return match.group(1)

    return "0.0.0+unknown"


def get_cli_version() -> str:
    try:
        installed_version = distribution_version("agentreview")
    except PackageNotFoundError:
        installed_version = None

    if isinstance(installed_version, str) and installed_version.strip():
        return installed_version

    return _get_pyproject_version()
