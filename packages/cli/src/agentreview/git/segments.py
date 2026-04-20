from __future__ import annotations

from ..payload.types import AgentReviewSegment
from ..vcs import Repository, run_command
from .diff import get_diff
from .files import get_file_contents_for_revisions

EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


def _git(repo: Repository, args: list[str]) -> str:
    return run_command("git", repo, args, check=True).stdout


def _git_commit_message(repo: Repository, commit_hash: str) -> str:
    return _git(repo, ["show", "-s", "--format=%B", commit_hash]).rstrip("\n")


def get_review_segments(
    repo: Repository,
    diff_mode: str,
    base_ref: str,
    *,
    include_uncommitted: bool = False,
) -> list[AgentReviewSegment]:
    if repo.kind != "git" or diff_mode != "commit":
        return []

    segments: list[AgentReviewSegment] = []
    log_output = _git(
        repo,
        ["log", "--reverse", "--format=%H%x00%h%x00%P", f"{base_ref}..HEAD"],
    )

    for line in log_output.splitlines():
        if not line:
            continue

        commit_hash, short_hash, parents = line.split("\0", 2)
        commit_message = _git_commit_message(repo, commit_hash)
        parent_hash = parents.split()[0] if parents else EMPTY_TREE_HASH
        raw_diff = _git(repo, ["diff", parent_hash, commit_hash])
        if not raw_diff.strip():
            continue

        files = get_file_contents_for_revisions(
            repo,
            raw_diff,
            old_revision=parent_hash,
            new_source_mode="revision",
            new_revision=commit_hash,
        )
        if not files:
            continue

        segments.append(
            AgentReviewSegment(
                id=f"commit:{commit_hash}",
                label=short_hash,
                kind="commit",
                commit_hash=short_hash,
                commit_message=commit_message or None,
                files=files,
            )
        )

    if include_uncommitted:
        raw_diff = get_diff(repo, "default", "main", include_uncommitted=True)
        if raw_diff.strip():
            files = get_file_contents_for_revisions(
                repo,
                raw_diff,
                old_revision="HEAD",
                new_source_mode="worktree",
            )
            if files:
                segments.append(
                    AgentReviewSegment(
                        id="uncommitted",
                        label="Uncommitted changes",
                        kind="uncommitted",
                        files=files,
                    )
                )

    return segments
