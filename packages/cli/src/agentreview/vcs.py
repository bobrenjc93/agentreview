from __future__ import annotations

import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Literal

VCSKind = Literal["git", "hg"]


@dataclass(frozen=True)
class Repository:
    kind: VCSKind
    root: str
    verbose: bool = False


def emit_verbose(enabled: bool, message: str) -> None:
    if enabled:
        print(f"[agentreview] {message}", file=sys.stderr, flush=True)


def _format_command(binary: str, args: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in [binary, *args])


def run_command(
    binary: str,
    repo: Repository,
    args: list[str],
    *,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    emit_verbose(repo.verbose, f"$ {_format_command(binary, args)}")
    result = subprocess.run(
        [binary, *args],
        capture_output=True,
        text=True,
        cwd=repo.root,
        check=False,
    )
    emit_verbose(repo.verbose, f"{binary} exit={result.returncode}")

    if check and result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode,
            result.args,
            output=result.stdout,
            stderr=result.stderr,
        )

    return result


def _probe_repository(
    binary: str,
    args: list[str],
    *,
    cwd: str | None = None,
    verbose: bool = False,
) -> str | None:
    if shutil.which(binary) is None:
        emit_verbose(verbose, f"{binary} not found in PATH")
        return None

    emit_verbose(verbose, f"$ {_format_command(binary, args)}")
    result = subprocess.run(
        [binary, *args],
        capture_output=True,
        text=True,
        cwd=cwd,
        check=False,
    )
    emit_verbose(verbose, f"{binary} probe exit={result.returncode}")
    if result.returncode != 0:
        return None

    root = result.stdout.strip()
    return root or None


def detect_repository(cwd: str | None = None, *, verbose: bool = False) -> Repository:
    git_root = _probe_repository("git", ["rev-parse", "--show-toplevel"], cwd=cwd, verbose=verbose)
    if git_root is not None:
        emit_verbose(verbose, f"detected git repository at {git_root}")
        return Repository(kind="git", root=git_root, verbose=verbose)

    hg_root = _probe_repository("hg", ["root"], cwd=cwd, verbose=verbose)
    if hg_root is not None:
        emit_verbose(verbose, f"detected hg repository at {hg_root}")
        return Repository(kind="hg", root=hg_root, verbose=verbose)

    if shutil.which("git") or shutil.which("hg"):
        raise RuntimeError(
            "Current directory is not inside a supported repository. "
            "agentreview supports git and hg repositories."
        )

    raise RuntimeError("Neither git nor hg is installed. agentreview supports git and hg repositories.")
