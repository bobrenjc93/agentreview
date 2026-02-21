from __future__ import annotations

import sys

import click

from .git.diff import get_diff
from .git.files import get_file_contents
from .git.metadata import get_metadata
from .payload.encode import encode_payload
from .payload.types import AgentReviewPayload


@click.command()
@click.option("--staged", is_flag=True, help="Only include staged changes (git diff --cached)")
@click.option("--branch", "base_branch", default=None, metavar="BASE",
              help="Compare current branch against BASE (default: main)")
def main(staged: bool, base_branch: str | None) -> None:
    """Generate an LLM-friendly code review payload from git diffs."""
    if base_branch is not None:
        diff_mode = "branch"
        base = base_branch or "main"
    elif staged:
        diff_mode = "staged"
        base = "main"
    else:
        diff_mode = "default"
        base = "main"

    try:
        diff = get_diff(diff_mode, base)
    except Exception as exc:
        click.echo(f"Error running git diff: {exc}", err=True)
        sys.exit(1)

    if not diff.strip():
        click.echo("No changes detected.", err=True)
        sys.exit(1)

    meta = get_metadata(diff_mode, base)
    files = get_file_contents(diff)

    payload = AgentReviewPayload(meta=meta, files=files)
    encoded = encode_payload(payload)
    click.echo(encoded)
