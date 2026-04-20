from __future__ import annotations

from contextlib import contextmanager
import shlex
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from datetime import datetime
from time import monotonic
from typing import Literal

VCSKind = Literal["git", "sl"]
VERBOSE_PROGRESS_INTERVAL_SECONDS = 5.0
COMMAND_OUTPUT_ENCODING = "utf-8"
COMMAND_OUTPUT_ERRORS = "replace"


@dataclass(frozen=True)
class Repository:
    kind: VCSKind
    root: str
    verbose: bool = False


def emit_verbose(enabled: bool, message: str) -> None:
    if enabled:
        timestamp = datetime.now().astimezone().isoformat(timespec="milliseconds")
        print(f"[agentreview {timestamp}] {message}", file=sys.stderr, flush=True)


@contextmanager
def verbose_activity(enabled: bool, label: str):
    start = monotonic()
    stop = threading.Event()
    thread: threading.Thread | None = None

    def tick() -> None:
        while not stop.wait(VERBOSE_PROGRESS_INTERVAL_SECONDS):
            emit_verbose(enabled, f"{label} still running ({monotonic() - start:.1f}s elapsed)")

    if enabled:
        thread = threading.Thread(target=tick, daemon=True)
        thread.start()

    try:
        yield
    finally:
        if thread is not None:
            stop.set()
            thread.join()


def _format_command(binary: str, args: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in [binary, *args])


def run_command(
    binary: str,
    repo: Repository,
    args: list[str],
    *,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    command = _format_command(binary, args)
    emit_verbose(repo.verbose, f"$ {command}")
    start = monotonic()
    with verbose_activity(repo.verbose, command):
        result = subprocess.run(
            [binary, *args],
            capture_output=True,
            text=True,
            encoding=COMMAND_OUTPUT_ENCODING,
            errors=COMMAND_OUTPUT_ERRORS,
            cwd=repo.root,
            check=False,
        )
    emit_verbose(repo.verbose, f"{binary} exit={result.returncode} elapsed={monotonic() - start:.3f}s")

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

    command = _format_command(binary, args)
    emit_verbose(verbose, f"$ {command}")
    start = monotonic()
    with verbose_activity(verbose, command):
        result = subprocess.run(
            [binary, *args],
            capture_output=True,
            text=True,
            encoding=COMMAND_OUTPUT_ENCODING,
            errors=COMMAND_OUTPUT_ERRORS,
            cwd=cwd,
            check=False,
        )
    emit_verbose(verbose, f"{binary} probe exit={result.returncode} elapsed={monotonic() - start:.3f}s")
    if result.returncode != 0:
        return None

    root = result.stdout.strip()
    return root or None


def detect_repository(cwd: str | None = None, *, verbose: bool = False) -> Repository:
    git_root = _probe_repository("git", ["rev-parse", "--show-toplevel"], cwd=cwd, verbose=verbose)
    if git_root is not None:
        emit_verbose(verbose, f"detected git repository at {git_root}")
        return Repository(kind="git", root=git_root, verbose=verbose)

    sl_root = _probe_repository("sl", ["root"], cwd=cwd, verbose=verbose)
    if sl_root is not None:
        emit_verbose(verbose, f"detected sl repository at {sl_root}")
        return Repository(kind="sl", root=sl_root, verbose=verbose)

    if shutil.which("git") or shutil.which("sl"):
        raise RuntimeError(
            "Current directory is not inside a supported repository. "
            "agentreview supports git and sl repositories."
        )

    raise RuntimeError("Neither git nor sl is installed. agentreview supports git and sl repositories.")
