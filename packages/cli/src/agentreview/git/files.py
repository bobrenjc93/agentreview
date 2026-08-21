from __future__ import annotations

import os
import re
from tempfile import TemporaryDirectory
from typing import Literal

from ..payload.types import AgentReviewFile
from ..vcs import Repository, normalize_revision, run_command

DiffMode = Literal["default", "staged", "branch", "commit"]
NewSourceMode = Literal["worktree", "index", "revision"]

EXT_TO_LANG: dict[str, str] = {
    "ts": "typescript",
    "tsx": "tsx",
    "js": "javascript",
    "jsx": "jsx",
    "py": "python",
    "rb": "ruby",
    "go": "go",
    "rs": "rust",
    "java": "java",
    "kt": "kotlin",
    "swift": "swift",
    "c": "c",
    "cpp": "cpp",
    "h": "c",
    "hpp": "cpp",
    "cs": "csharp",
    "css": "css",
    "scss": "scss",
    "html": "html",
    "json": "json",
    "yaml": "yaml",
    "yml": "yaml",
    "md": "markdown",
    "sql": "sql",
    "sh": "bash",
    "bash": "bash",
    "zsh": "bash",
    "toml": "toml",
    "xml": "xml",
    "vue": "vue",
    "svelte": "svelte",
}


def _detect_language(path: str) -> str | None:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return EXT_TO_LANG.get(ext)


def _parse_diff_into_files(raw_diff: str) -> list[dict[str, str]]:
    chunks = re.split(r"^(?=diff --git )", raw_diff, flags=re.MULTILINE)
    entries = []

    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue

        header = chunk.splitlines()[0]
        header_match = re.match(r"diff --git a/(.+) b/(.+)", header)
        if not header_match:
            continue
        old_path = header_match.group(1)
        path = header_match.group(2)

        rename_from_match = re.search(r"^rename from (.+)$", chunk, flags=re.MULTILINE)
        if rename_from_match:
            old_path = rename_from_match.group(1)

        rename_to_match = re.search(r"^rename to (.+)$", chunk, flags=re.MULTILINE)
        if rename_to_match:
            path = rename_to_match.group(1)

        if "new file mode" in chunk:
            status = "added"
            old_path = ""
        elif "deleted file mode" in chunk:
            status = "deleted"
            path = old_path
        elif "rename from" in chunk:
            status = "renamed"
        else:
            status = "modified"

        entries.append(
            {
                "path": path,
                "old_path": old_path,
                "status": status,
                "diff": chunk,
            }
        )

    return entries


def _run_git(repo: Repository, args: list[str], *, check: bool = True) -> str | None:
    result = run_command("git", repo, args, check=check)
    return result.stdout if result.returncode == 0 else None


def _run_sl(repo: Repository, args: list[str], *, check: bool = True) -> str | None:
    result = run_command("sl", repo, args, check=check)
    return result.stdout if result.returncode == 0 else None


def _read_worktree_file(repo: Repository, path: str) -> str | None:
    filepath = os.path.join(repo.root, path)
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def _git_base_revision(repo: Repository, diff_mode: DiffMode, base_ref: str) -> str:
    if diff_mode == "branch":
        merge_base = _run_git(repo, ["merge-base", base_ref, "HEAD"])
        return (merge_base or "").strip()
    if diff_mode == "commit":
        return base_ref
    return "HEAD"


def _sl_resolve_node(repo: Repository, revision: str) -> str:
    node = _run_sl(repo, ["log", "-r", revision, "--template", "{node}"])
    return (node or "").strip()


def _sl_base_revision(repo: Repository, diff_mode: DiffMode, base_ref: str) -> str:
    base_ref = normalize_revision(repo, base_ref)
    if diff_mode == "branch":
        base_node = _sl_resolve_node(repo, base_ref)
        return _sl_resolve_node(repo, f"ancestor(., {base_node})")
    if diff_mode == "commit":
        return base_ref
    return "."


def _current_revision(repo: Repository) -> str:
    return "HEAD" if repo.kind == "git" else "."


def _read_git_revision_file(repo: Repository, revision: str, path: str) -> str | None:
    if not revision or not path:
        return None
    return _run_git(repo, ["show", f"{revision}:{path}"], check=False)


def _read_git_index_file(repo: Repository, path: str) -> str | None:
    if not path:
        return None
    return _run_git(repo, ["show", f":{path}"], check=False)


def _read_sl_revision_file(repo: Repository, revision: str, path: str) -> str | None:
    if not revision or not path:
        return None
    return _run_sl(repo, ["cat", "-r", revision, path], check=False)


def _read_sl_revision_files(
    repo: Repository,
    revision: str,
    paths: list[str],
) -> dict[str, str]:
    unique_paths = list(dict.fromkeys(path for path in paths if path))
    if not revision or not unique_paths:
        return {}

    with TemporaryDirectory(prefix="agentreview-sl-cat-") as temp_dir:
        output_pattern = os.path.join(temp_dir, "%p")
        _run_sl(
            repo,
            ["cat", "-r", revision, "-o", output_pattern, "--", *unique_paths],
            check=False,
        )

        contents: dict[str, str] = {}
        output_root = os.path.realpath(temp_dir)
        for path in unique_paths:
            output_path = os.path.realpath(os.path.join(output_root, path))
            try:
                if os.path.commonpath([output_root, output_path]) != output_root:
                    continue
                with open(output_path, "r", encoding="utf-8", errors="replace") as f:
                    contents[path] = f.read()
            except (OSError, ValueError):
                continue
        return contents


def _read_revision_file(repo: Repository, revision: str, path: str) -> str | None:
    if repo.kind == "git":
        return _read_git_revision_file(repo, revision, path)
    return _read_sl_revision_file(repo, revision, path)


def _read_new_source(
    repo: Repository,
    path: str,
    *,
    new_source_mode: NewSourceMode,
    new_revision: str | None = None,
) -> str | None:
    if new_source_mode == "index":
        if repo.kind != "git":
            raise ValueError("Index-backed file reads are only available in Git repositories.")
        return _read_git_index_file(repo, path)
    if new_source_mode == "revision":
        if new_revision is None:
            raise ValueError("new_revision is required when new_source_mode='revision'.")
        return _read_revision_file(repo, new_revision, path)
    return _read_worktree_file(repo, path)


def get_file_contents_for_revisions(
    repo: Repository,
    raw_diff: str,
    *,
    old_revision: str,
    new_source_mode: NewSourceMode = "worktree",
    new_revision: str | None = None,
) -> list[AgentReviewFile]:
    entries = _parse_diff_into_files(raw_diff)
    results: list[AgentReviewFile] = []
    sl_old_sources: dict[str, str] = {}
    sl_new_sources: dict[str, str] = {}

    if repo.kind == "sl":
        old_paths = [
            entry["old_path"] or entry["path"]
            for entry in entries
            if entry["status"] != "added"
        ]
        sl_old_sources = _read_sl_revision_files(repo, old_revision, old_paths)
        if new_source_mode == "revision" and new_revision is not None:
            new_paths = [entry["path"] for entry in entries if entry["status"] != "deleted"]
            sl_new_sources = _read_sl_revision_files(repo, new_revision, new_paths)

    for entry in entries:
        source: str | None = None
        old_source: str | None = None

        if entry["status"] != "deleted":
            if repo.kind == "sl" and new_source_mode == "revision":
                source = sl_new_sources.get(entry["path"])
            else:
                source = _read_new_source(
                    repo,
                    entry["path"],
                    new_source_mode=new_source_mode,
                    new_revision=new_revision,
                )

        if entry["status"] != "added":
            old_path = entry["old_path"] or entry["path"]
            if repo.kind == "sl":
                old_source = sl_old_sources.get(old_path)
            else:
                old_source = _read_revision_file(repo, old_revision, old_path)

        results.append(
            AgentReviewFile(
                path=entry["path"],
                status=entry["status"],
                diff=entry["diff"],
                source=source,
                old_source=old_source,
                language=_detect_language(entry["path"]),
            )
        )

    return results


def get_file_contents(
    repo: Repository,
    raw_diff: str,
    diff_mode: DiffMode = "default",
    base_ref: str = "main",
    *,
    include_uncommitted: bool = True,
) -> list[AgentReviewFile]:
    base_revision = (
        _git_base_revision(repo, diff_mode, base_ref)
        if repo.kind == "git"
        else _sl_base_revision(repo, diff_mode, base_ref)
    )
    new_source_mode: NewSourceMode
    new_revision: str | None = None

    if repo.kind == "git" and diff_mode == "staged":
        new_source_mode = "index"
    elif diff_mode in ("branch", "commit") and not include_uncommitted:
        new_source_mode = "revision"
        new_revision = _current_revision(repo)
    else:
        new_source_mode = "worktree"

    return get_file_contents_for_revisions(
        repo,
        raw_diff,
        old_revision=base_revision,
        new_source_mode=new_source_mode,
        new_revision=new_revision,
    )
