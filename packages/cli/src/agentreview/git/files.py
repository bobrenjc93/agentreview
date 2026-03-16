from __future__ import annotations

import os
import re

from ..payload.types import AgentReviewFile
from ..vcs import Repository

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
        path = header_match.group(2)

        if "new file mode" in chunk:
            status = "added"
        elif "deleted file mode" in chunk:
            status = "deleted"
        elif "rename from" in chunk:
            status = "renamed"
        else:
            status = "modified"

        entries.append({"path": path, "status": status, "diff": chunk})

    return entries


def get_file_contents(repo: Repository, raw_diff: str) -> list[AgentReviewFile]:
    entries = _parse_diff_into_files(raw_diff)
    results: list[AgentReviewFile] = []

    for entry in entries:
        source: str | None = None

        if entry["status"] != "deleted":
            filepath = os.path.join(repo.root, entry["path"])
            try:
                with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                    source = f.read()
            except OSError:
                pass

        results.append(
            AgentReviewFile(
                path=entry["path"],
                status=entry["status"],
                diff=entry["diff"],
                source=source,
                language=_detect_language(entry["path"]),
            )
        )

    return results
