from __future__ import annotations

from datetime import datetime
import subprocess
import sys
from time import monotonic
from typing import Callable

import click

from .git.diff import get_diff
from .git.files import get_file_contents
from .git.metadata import get_metadata
from .git.segments import get_review_segments
from .local_ui import LocalUiError, serve_local_review
from .payload.encode import encode_payload, write_payload
from .payload.types import AgentReviewPayload
from .vcs import detect_repository, emit_verbose, verbose_activity
from .version import get_cli_version

TERMINAL_OUTPUT_WARNING_BYTES = 10 * 1024 * 1024
ProgressReporter = Callable[[str], None]


HELP_EPILOG = """
\b
Examples:
  agentreview --version
    Print the installed CLI version.
  agentreview
    Review all staged, unstaged, and untracked changes in your working tree.
  agentreview --local
    Start the local review UI and load the current review directly from disk.
  BASE_URL=http://devgpu009.cco5.fbinfra.net agentreview --local
    Print and open the local review UI with a proxy hostname instead of localhost.
  agentreview --staged
    Review only what is staged for the next commit in Git.
  agentreview --branch main
    Review committed changes on your branch relative to main.
  agentreview --branch main --uncommitted
    Review committed branch changes plus local working tree and untracked changes.
  agentreview --commit HEAD~3
    Review committed changes since a specific commit or revision.
  agentreview --commit HEAD~3 --uncommitted
    Review committed changes since a revision plus local working tree and untracked changes.
  agentreview --branch origin/main
    Compare against the remote-tracking branch instead of a local branch ref.

\b
Common use cases:
  agentreview | pbcopy
    Copy the payload so you can paste it into ChatGPT, Codex, Claude, or another LLM.
  agentreview --branch main > review.txt
    Save a feature-branch review payload to a file for later use.
  git add -p && agentreview --staged
    Review only the Git hunks you intentionally staged.

\b
Notes:
  Use only one of --staged, --branch, or --commit.
  --staged is only available in Git repositories.
  --local serves the bundled web UI locally instead of printing a payload blob.
  Set BASE_URL to rewrite the printed/opened --local URL for proxied dev environments.
  --uncommitted only affects --branch and --commit. Plain agentreview still reviews your working tree.
  COMMIT can be any git commit-ish or Sapling revision identifier.

\b
Web UI:
  https://agentreview-web.vercel.app/
"""


def emit_local_progress(enabled: bool, message: str, *, start_time: float | None = None) -> None:
    if enabled:
        prefix = "[agentreview]"
        if start_time is not None:
            timestamp = datetime.now().astimezone().isoformat(timespec="milliseconds")
            elapsed = monotonic() - start_time
            prefix = f"[agentreview {timestamp} +{elapsed:.3f}s]"
        click.echo(f"{prefix} {message}", err=True)


class ReviewBuildError(RuntimeError):
    pass


def build_review_payload(
    *,
    diff_mode: str,
    base_ref: str,
    include_uncommitted: bool,
    local_mode: bool,
    verbose: bool,
    progress: ProgressReporter | None = None,
) -> AgentReviewPayload:
    def report(message: str) -> None:
        if progress is not None:
            progress(message)

    report("Detecting repository.")
    try:
        repository = detect_repository(verbose=verbose)
    except Exception as exc:
        raise ReviewBuildError(f"Error detecting repository: {exc}") from exc

    emit_verbose(verbose, f"mode={diff_mode} base={base_ref}")
    report(f"Detected {repository.kind} repository at {repository.root}.")

    if diff_mode == "staged" and repository.kind != "git":
        raise click.UsageError("--staged is only available in Git repositories.")

    use_local_git_commit_fast_path = local_mode and repository.kind == "git" and diff_mode == "commit"
    files = []
    segments = []
    diff_bytes = 0

    if use_local_git_commit_fast_path:
        report("Reading repository metadata.")
        emit_verbose(verbose, "collecting metadata")
        meta = get_metadata(repository, diff_mode, base_ref)
        emit_verbose(
            verbose,
            f"metadata repo={meta.repo} branch={meta.branch} commit={meta.commit_hash}",
        )
        emit_verbose(
            verbose,
            "using git commit local-mode fast path (skipping aggregate payload extraction)",
        )
        report("Collecting commit review segments.")
        try:
            emit_verbose(verbose, "collecting review segments")
            with verbose_activity(verbose, "collecting review segments"):
                segments = get_review_segments(
                    repository,
                    diff_mode,
                    base_ref,
                    include_uncommitted=include_uncommitted,
                )
            emit_verbose(verbose, f"segments={len(segments)}")
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
            raise ReviewBuildError(f"Error collecting commit provenance: {detail}") from exc
        except Exception as exc:
            raise ReviewBuildError(f"Error collecting commit provenance: {exc}") from exc
        if not segments:
            raise ReviewBuildError("No changes detected.")
    else:
        report(f"Collecting the {repository.kind} diff.")
        try:
            diff = get_diff(
                repository,
                diff_mode,
                base_ref,
                include_uncommitted=include_uncommitted,
            )
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
            raise ReviewBuildError(f"Error running {repository.kind} diff: {detail}") from exc
        except Exception as exc:
            raise ReviewBuildError(f"Error running {repository.kind} diff: {exc}") from exc

        if not diff.strip():
            raise ReviewBuildError("No changes detected.")

        diff_bytes = len(diff.encode("utf-8"))
        emit_verbose(verbose, f"diff bytes={diff_bytes}")
        report(f"Collected {diff_bytes} diff bytes.")
        report("Reading repository metadata.")
        emit_verbose(verbose, "collecting metadata")
        meta = get_metadata(repository, diff_mode, base_ref)
        emit_verbose(
            verbose,
            f"metadata repo={meta.repo} branch={meta.branch} commit={meta.commit_hash}",
        )
        report("Loading full file contents for the review.")
        emit_verbose(verbose, "extracting file contents")
        with verbose_activity(verbose, "extracting file contents"):
            files = get_file_contents(
                repository,
                diff,
                diff_mode,
                base_ref,
                include_uncommitted=include_uncommitted,
            )
        emit_verbose(verbose, f"files={len(files)}")
        report(f"Prepared {len(files)} file entries.")
        if diff_mode == "commit":
            report("Collecting commit review segments.")
            try:
                emit_verbose(verbose, "collecting review segments")
                with verbose_activity(verbose, "collecting review segments"):
                    segments = get_review_segments(
                        repository,
                        diff_mode,
                        base_ref,
                        include_uncommitted=include_uncommitted,
                    )
                emit_verbose(verbose, f"segments={len(segments)}")
            except subprocess.CalledProcessError as exc:
                detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
                raise ReviewBuildError(f"Error collecting commit provenance: {detail}") from exc
            except Exception as exc:
                raise ReviewBuildError(f"Error collecting commit provenance: {exc}") from exc

    return AgentReviewPayload(meta=meta, files=files, segments=segments)


@click.command(epilog=HELP_EPILOG)
@click.version_option(version=get_cli_version(), prog_name="agentreview", message="%(prog)s %(version)s")
@click.option("--staged", is_flag=True, help="Only include staged changes (Git only; uses git diff --cached).")
@click.option(
    "--uncommitted",
    "--uncomitted",
    "include_uncommitted",
    is_flag=True,
    help="Also include working tree and untracked changes with --branch or --commit.",
)
@click.option(
    "--local",
    "local_mode",
    is_flag=True,
    help="Launch the local web UI instead of printing the encoded payload.",
)
@click.option(
    "-v",
    "--verbose",
    is_flag=True,
    help="Print timestamped progress and underlying git/sl commands to stderr.",
)
@click.option(
    "--branch",
    "base_branch",
    default=None,
    metavar="BASE",
    help=(
        "Compare your current HEAD against the common ancestor with BASE. "
        "Add --uncommitted to also include local working tree changes."
    ),
)
@click.option(
    "--commit",
    "base_commit",
    default=None,
    metavar="COMMIT",
    help=(
        "Compare your current HEAD against COMMIT or another revision identifier. "
        "Add --uncommitted to also include local working tree changes."
    ),
)
def main(
    staged: bool,
    include_uncommitted: bool,
    local_mode: bool,
    verbose: bool,
    base_branch: str | None,
    base_commit: str | None,
) -> None:
    """Generate an LLM-friendly code review payload from git or sl changes.

    Default mode includes staged, unstaged, and untracked file changes.
    """
    selected_modes = sum(
        1 for enabled in (staged, base_branch is not None, base_commit is not None) if enabled
    )
    if selected_modes > 1:
        raise click.UsageError("Choose only one of --staged, --branch, or --commit.")

    if base_branch is not None:
        diff_mode = "branch"
        base_ref = base_branch or "main"
    elif base_commit is not None:
        diff_mode = "commit"
        base_ref = base_commit
    elif staged:
        diff_mode = "staged"
        base_ref = "main"
    else:
        diff_mode = "default"
        base_ref = "main"

    local_progress_start = monotonic() if local_mode else None

    def report_local_progress(message: str) -> None:
        emit_local_progress(local_mode, message, start_time=local_progress_start)

    try:
        payload = build_review_payload(
            diff_mode=diff_mode,
            base_ref=base_ref,
            include_uncommitted=include_uncommitted,
            local_mode=local_mode,
            verbose=verbose,
            progress=report_local_progress,
        )
    except ReviewBuildError as exc:
        click.echo(str(exc), err=True)
        sys.exit(1)

    if local_mode:
        report_local_progress("Starting the local review UI.")
        emit_verbose(verbose, "launching local review UI")
        try:
            serve_local_review(
                payload,
                progress=report_local_progress,
                refresh_payload=lambda progress=None: build_review_payload(
                    diff_mode=diff_mode,
                    base_ref=base_ref,
                    include_uncommitted=include_uncommitted,
                    local_mode=local_mode,
                    verbose=verbose,
                    progress=progress,
                ),
            )
        except LocalUiError as exc:
            click.echo(f"Error launching local review UI: {exc}", err=True)
            sys.exit(1)
        return

    payload_bytes = len(encode_payload(payload).encode("utf-8"))
    if verbose and sys.stdout.isatty() and payload_bytes >= TERMINAL_OUTPUT_WARNING_BYTES:
        emit_verbose(
            True,
            "stdout is a terminal; writing a very large payload may be slow. Pipe to pbcopy or a file to avoid terminal rendering overhead.",
        )
    emit_verbose(verbose, "writing payload")
    with verbose_activity(verbose, "writing payload"):
        write_payload(payload, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()
