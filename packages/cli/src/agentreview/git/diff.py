from __future__ import annotations

import subprocess
from typing import Literal


def _run_git(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        capture_output=True,
        text=True,
        check=check,
    )


def _get_untracked_files_diff() -> str:
    untracked = _run_git(["ls-files", "--others", "--exclude-standard"]).stdout.splitlines()
    diffs: list[str] = []

    for path in untracked:
        result = _run_git(["diff", "--no-index", "--", "/dev/null", path], check=False)
        if result.returncode not in (0, 1):
            raise subprocess.CalledProcessError(
                result.returncode, result.args, output=result.stdout, stderr=result.stderr
            )
        if result.stdout:
            diffs.append(result.stdout.rstrip("\n"))

    return "\n\n".join(diffs)


def get_diff(mode: Literal["default", "staged", "branch"], base_branch: str) -> str:
    match mode:
        case "staged":
            args = ["git", "diff", "--cached"]
        case "branch":
            args = ["git", "diff", f"{base_branch}...HEAD"]
        case _:
            args = ["git", "diff", "HEAD"]

    tracked_diff = _run_git(args[1:]).stdout

    if mode != "default":
        return tracked_diff

    untracked_diff = _get_untracked_files_diff()
    if not untracked_diff:
        return tracked_diff
    if not tracked_diff:
        return f"{untracked_diff}\n"
    return f"{tracked_diff.rstrip()}\n\n{untracked_diff}\n"
