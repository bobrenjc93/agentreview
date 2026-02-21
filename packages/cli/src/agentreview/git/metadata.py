from __future__ import annotations

import subprocess
from typing import Literal

from ..payload.types import PayloadMeta


def _git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args], capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def get_metadata(
    diff_mode: Literal["default", "staged", "branch"], base_branch: str
) -> PayloadMeta:
    try:
        remote_url = _git("remote", "get-url", "origin")
    except subprocess.CalledProcessError:
        remote_url = ""

    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    commit_hash = _git("rev-parse", "--short", "HEAD")
    commit_message = _git("log", "-1", "--format=%s")

    if remote_url:
        repo = remote_url.rstrip("/").removesuffix(".git").rsplit("/", 1)[-1]
    else:
        toplevel = _git("rev-parse", "--show-toplevel")
        repo = toplevel.rsplit("/", 1)[-1]

    from datetime import datetime, timezone

    return PayloadMeta(
        repo=repo,
        branch=branch,
        commit_hash=commit_hash,
        commit_message=commit_message,
        timestamp=datetime.now(timezone.utc).isoformat(),
        diff_mode=diff_mode,
        base_branch=base_branch if diff_mode == "branch" else None,
    )
