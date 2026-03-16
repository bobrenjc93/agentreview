from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from typing import Literal

VCSKind = Literal["git", "hg"]


@dataclass(frozen=True)
class Repository:
    kind: VCSKind
    root: str


def _probe_repository(binary: str, args: list[str], *, cwd: str | None = None) -> str | None:
    if shutil.which(binary) is None:
        return None

    result = subprocess.run(
        [binary, *args],
        capture_output=True,
        text=True,
        cwd=cwd,
        check=False,
    )
    if result.returncode != 0:
        return None

    root = result.stdout.strip()
    return root or None


def detect_repository(cwd: str | None = None) -> Repository:
    git_root = _probe_repository("git", ["rev-parse", "--show-toplevel"], cwd=cwd)
    if git_root is not None:
        return Repository(kind="git", root=git_root)

    hg_root = _probe_repository("hg", ["root"], cwd=cwd)
    if hg_root is not None:
        return Repository(kind="hg", root=hg_root)

    if shutil.which("git") or shutil.which("hg"):
        raise RuntimeError(
            "Current directory is not inside a supported repository. "
            "agentreview supports git and hg repositories."
        )

    raise RuntimeError("Neither git nor hg is installed. agentreview supports git and hg repositories.")
