from __future__ import annotations

import difflib
import os
import subprocess
from typing import Literal

from ..vcs import Repository


def _run_git(
    repo: Repository, args: list[str], *, check: bool = True
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        capture_output=True,
        text=True,
        cwd=repo.root,
        check=check,
    )


def _run_hg(
    repo: Repository, args: list[str], *, check: bool = True
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["hg", *args],
        capture_output=True,
        text=True,
        cwd=repo.root,
        check=check,
    )


def _raise_command_error(result: subprocess.CompletedProcess[str]) -> None:
    raise subprocess.CalledProcessError(
        result.returncode,
        result.args,
        output=result.stdout,
        stderr=result.stderr,
    )


def _supports_modern_hg_diff(stderr: str) -> bool:
    normalized = stderr.lower()
    unsupported_markers = ("unknown option", "not recognized", "no such option")
    return "--from" not in normalized or not any(marker in normalized for marker in unsupported_markers)


def _run_hg_diff_against_working_copy(repo: Repository, revision: str) -> str:
    modern = _run_hg(repo, ["diff", "--git", "--from", revision], check=False)
    if modern.returncode == 0:
        return modern.stdout
    if _supports_modern_hg_diff(modern.stderr):
        _raise_command_error(modern)

    legacy = _run_hg(repo, ["diff", "--git", "-r", revision], check=False)
    if legacy.returncode == 0:
        return legacy.stdout
    _raise_command_error(legacy)


def _new_file_mode(path: str) -> str:
    return "100755" if os.access(path, os.X_OK) else "100644"


def _build_untracked_file_diff(repo: Repository, path: str) -> str:
    filepath = os.path.join(repo.root, path)
    if not os.path.isfile(filepath):
        return ""

    try:
        with open(filepath, "r", encoding="utf-8", errors="replace", newline="") as f:
            lines = f.readlines()
    except OSError:
        return ""

    patch_lines = [
        f"diff --git a/{path} b/{path}",
        f"new file mode {_new_file_mode(filepath)}",
    ]
    unified_diff = list(
        difflib.unified_diff(
            [],
            lines,
            fromfile="/dev/null",
            tofile=f"b/{path}",
            lineterm="",
        )
    )

    if unified_diff:
        patch_lines.extend(unified_diff)
    else:
        patch_lines.extend(["--- /dev/null", f"+++ b/{path}"])

    return "\n".join(patch_lines)


def _get_untracked_files_diff(repo: Repository) -> str:
    if repo.kind == "git":
        untracked = _run_git(repo, ["ls-files", "--others", "--exclude-standard"]).stdout.splitlines()
    else:
        untracked = _run_hg(repo, ["status", "-un"]).stdout.splitlines()

    diffs: list[str] = []

    for path in untracked:
        if repo.kind == "git":
            result = _run_git(repo, ["diff", "--no-index", "--", "/dev/null", path], check=False)
            if result.returncode not in (0, 1):
                raise subprocess.CalledProcessError(
                    result.returncode, result.args, output=result.stdout, stderr=result.stderr
                )
            if result.stdout:
                diffs.append(result.stdout.rstrip("\n"))
            continue

        diff = _build_untracked_file_diff(repo, path)
        if diff:
            diffs.append(diff)

    return "\n\n".join(diffs)


def _combine_with_untracked(repo: Repository, tracked_diff: str) -> str:
    untracked_diff = _get_untracked_files_diff(repo)
    if not untracked_diff:
        return tracked_diff
    if not tracked_diff:
        return f"{untracked_diff}\n"
    return f"{tracked_diff.rstrip()}\n\n{untracked_diff}\n"


def _get_git_diff(repo: Repository, mode: Literal["default", "staged", "branch", "commit"], base_ref: str) -> str:
    match mode:
        case "staged":
            return _run_git(repo, ["diff", "--cached"]).stdout
        case "branch":
            merge_base = _run_git(repo, ["merge-base", base_ref, "HEAD"]).stdout.strip()
            tracked_diff = _run_git(repo, ["diff", merge_base]).stdout
            return _combine_with_untracked(repo, tracked_diff)
        case "commit":
            tracked_diff = _run_git(repo, ["diff", base_ref]).stdout
            return _combine_with_untracked(repo, tracked_diff)
        case _:
            tracked_diff = _run_git(repo, ["diff", "HEAD"]).stdout
            return _combine_with_untracked(repo, tracked_diff)


def _resolve_hg_node(repo: Repository, revision: str) -> str:
    return _run_hg(repo, ["log", "-r", revision, "--template", "{node}"]).stdout.strip()


def _get_hg_diff(repo: Repository, mode: Literal["default", "staged", "branch", "commit"], base_ref: str) -> str:
    match mode:
        case "staged":
            raise ValueError("--staged is only available in Git repositories.")
        case "branch":
            base_node = _resolve_hg_node(repo, base_ref)
            ancestor = _resolve_hg_node(repo, f"ancestor(., {base_node})")
            tracked_diff = _run_hg_diff_against_working_copy(repo, ancestor)
            return _combine_with_untracked(repo, tracked_diff)
        case "commit":
            tracked_diff = _run_hg_diff_against_working_copy(repo, base_ref)
            return _combine_with_untracked(repo, tracked_diff)
        case _:
            tracked_diff = _run_hg(repo, ["diff", "--git"]).stdout
            return _combine_with_untracked(repo, tracked_diff)


def get_diff(
    repo: Repository, mode: Literal["default", "staged", "branch", "commit"], base_ref: str
) -> str:
    if repo.kind == "git":
        return _get_git_diff(repo, mode, base_ref)
    return _get_hg_diff(repo, mode, base_ref)
