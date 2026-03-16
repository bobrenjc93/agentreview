from __future__ import annotations

import os
import re
import subprocess
from typing import Literal

from ..payload.types import PayloadMeta
from ..vcs import Repository


def _git(repo: Repository, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], capture_output=True, text=True, cwd=repo.root, check=True
    )
    return result.stdout.strip()


def _hg(repo: Repository, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["hg", *args], capture_output=True, text=True, cwd=repo.root, check=check
    )
    return result.stdout.strip()


def _repo_name(remote_url: str, root: str) -> str:
    if remote_url:
        normalized = remote_url.rstrip("/").removesuffix(".git").removesuffix(".hg")
        return re.split(r"[:/]", normalized)[-1]

    return os.path.basename(root)


def get_metadata(
    repo: Repository, diff_mode: Literal["default", "staged", "branch", "commit"], base_ref: str
) -> PayloadMeta:
    if repo.kind == "git":
        try:
            remote_url = _git(repo, "remote", "get-url", "origin")
        except subprocess.CalledProcessError:
            remote_url = ""

        branch = _git(repo, "rev-parse", "--abbrev-ref", "HEAD")
        commit_hash = _git(repo, "rev-parse", "--short", "HEAD")
        commit_message = _git(repo, "log", "-1", "--format=%s")
    else:
        try:
            remote_url = _hg(repo, "config", "paths.default")
        except subprocess.CalledProcessError:
            remote_url = ""

        bookmark = _hg(repo, "id", "-B", check=False)
        branch = bookmark or _hg(repo, "branch")
        commit_hash = _hg(repo, "id", "-i").rstrip("+")
        commit_message = _hg(repo, "log", "-r", ".", "--template", "{desc|firstline}")

    from datetime import datetime, timezone

    return PayloadMeta(
        repo=_repo_name(remote_url, repo.root),
        branch=branch,
        commit_hash=commit_hash,
        commit_message=commit_message,
        timestamp=datetime.now(timezone.utc).isoformat(),
        diff_mode=diff_mode,
        base_branch=base_ref if diff_mode == "branch" else None,
        base_commit=base_ref if diff_mode == "commit" else None,
    )
