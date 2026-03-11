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


def _combine_with_untracked(tracked_diff: str) -> str:
    untracked_diff = _get_untracked_files_diff()
    if not untracked_diff:
        return tracked_diff
    if not tracked_diff:
        return f"{untracked_diff}\n"
    return f"{tracked_diff.rstrip()}\n\n{untracked_diff}\n"


def get_diff(mode: Literal["default", "staged", "branch"], base_branch: str) -> str:
    match mode:
        case "staged":
            return _run_git(["diff", "--cached"]).stdout
        case "branch":
            merge_base = _run_git(["merge-base", base_branch, "HEAD"]).stdout.strip()
            tracked_diff = _run_git(["diff", merge_base]).stdout
            return _combine_with_untracked(tracked_diff)
        case _:
            tracked_diff = _run_git(["diff", "HEAD"]).stdout
            return _combine_with_untracked(tracked_diff)
