from __future__ import annotations

import os
import re
import subprocess

from ..payload.types import AgentReviewFile

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


def _repo_root() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _parse_diff_into_files(raw_diff: str) -> list[dict]:
    chunks = re.split(r"^(?=diff --git )", raw_diff, flags=re.MULTILINE)
    entries = []

    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue

        # Extract b-side path
        header_match = re.match(r"diff --git a/.+ b/(.+)", chunk)
        if not header_match:
            continue
        path = header_match.group(1)

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


def get_file_contents(raw_diff: str) -> list[AgentReviewFile]:
    root = _repo_root()
    entries = _parse_diff_into_files(raw_diff)
    results: list[AgentReviewFile] = []

    for entry in entries:
        source: str | None = None

        if entry["status"] != "deleted":
            filepath = os.path.join(root, entry["path"])
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
