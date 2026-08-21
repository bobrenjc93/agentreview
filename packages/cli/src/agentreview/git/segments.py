from __future__ import annotations

import json

from ..payload.types import AgentReviewSegment
from ..vcs import Repository, normalize_revision, run_command
from .diff import get_diff
from .files import get_file_contents_for_revisions

EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


def _git(repo: Repository, args: list[str]) -> str:
    return run_command("git", repo, args, check=True).stdout


def _git_commit_message(repo: Repository, commit_hash: str) -> str:
    return _git(repo, ["show", "-s", "--format=%B", commit_hash]).rstrip("\n")


def _sl(repo: Repository, args: list[str]) -> str:
    return run_command("sl", repo, args, check=True).stdout


def _get_sl_commit_segments(repo: Repository, base_ref: str) -> list[AgentReviewSegment]:
    base_revision = normalize_revision(repo, base_ref)
    base_node = _sl(repo, ["log", "-r", base_revision, "--template", "{node}"]).strip()
    revset = f"sort(only(., {base_node}), rev)"
    log_output = _sl(repo, ["log", "-r", revset, "-Tjson"])
    commits = json.loads(log_output)
    segments: list[AgentReviewSegment] = []

    for commit in commits:
        commit_hash = commit["node"]
        parents = commit.get("parents") or []
        parent_hash = parents[0] if parents else "null"
        raw_diff = _sl(repo, ["diff", "--git", "-c", commit_hash])
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

        commit_message = str(commit.get("desc") or "").rstrip("\n")
        segments.append(
            AgentReviewSegment(
                id=f"commit:{commit_hash}",
                label=commit_hash[:12],
                kind="commit",
                commit_hash=commit_hash[:12],
                commit_message=commit_message or None,
                files=files,
            )
        )

    return segments


def get_review_segments(
    repo: Repository,
    diff_mode: str,
    base_ref: str,
    *,
    include_uncommitted: bool = False,
) -> list[AgentReviewSegment]:
    if diff_mode != "commit":
        return []

    if repo.kind == "sl":
        segments = _get_sl_commit_segments(repo, base_ref)
    else:
        segments = []
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
                old_revision="HEAD" if repo.kind == "git" else ".",
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
