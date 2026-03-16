from __future__ import annotations

import subprocess
import sys

import click

from .git.diff import get_diff
from .git.files import get_file_contents
from .git.metadata import get_metadata
from .payload.encode import encode_payload
from .payload.types import AgentReviewPayload
from .vcs import detect_repository


HELP_EPILOG = """
\b
Examples:
  agentreview
    Review all staged, unstaged, and untracked changes in your working tree.
  agentreview --staged
    Review only what is staged for the next commit in Git.
  agentreview --branch main
    Review everything on your branch relative to main, including local uncommitted changes.
  agentreview --commit HEAD~3
    Review everything since a specific commit or revision, including local uncommitted changes.
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
  COMMIT can be any git commit-ish or Mercurial revision identifier.

\b
Web UI:
  https://agentreview-web.vercel.app/
"""


@click.command(epilog=HELP_EPILOG)
@click.option("--staged", is_flag=True, help="Only include staged changes (Git only; uses git diff --cached).")
@click.option(
    "--branch",
    "base_branch",
    default=None,
    metavar="BASE",
    help=(
        "Compare your current worktree against the common ancestor with BASE. "
        "In Mercurial repos, BASE can be a branch, bookmark, or revision."
    ),
)
@click.option(
    "--commit",
    "base_commit",
    default=None,
    metavar="COMMIT",
    help=(
        "Compare your current worktree against COMMIT or another revision identifier. "
        "Includes committed changes since COMMIT plus local uncommitted changes."
    ),
)
def main(staged: bool, base_branch: str | None, base_commit: str | None) -> None:
    """Generate an LLM-friendly code review payload from git or hg changes.

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

    try:
        repository = detect_repository()
    except Exception as exc:
        click.echo(f"Error detecting repository: {exc}", err=True)
        sys.exit(1)

    if staged and repository.kind != "git":
        raise click.UsageError("--staged is only available in Git repositories.")

    try:
        diff = get_diff(repository, diff_mode, base_ref)
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
        click.echo(f"Error running {repository.kind} diff: {detail}", err=True)
        sys.exit(1)
    except Exception as exc:
        click.echo(f"Error running {repository.kind} diff: {exc}", err=True)
        sys.exit(1)

    if not diff.strip():
        click.echo("No changes detected.", err=True)
        sys.exit(1)

    meta = get_metadata(repository, diff_mode, base_ref)
    files = get_file_contents(repository, diff)

    payload = AgentReviewPayload(meta=meta, files=files)
    encoded = encode_payload(payload)
    click.echo(encoded)
