from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass
class AgentReviewFile:
    path: str
    status: Literal["added", "modified", "deleted", "renamed"]
    diff: str
    source: str | None = None
    language: str | None = None

    def to_dict(self) -> dict:
        d: dict = {"path": self.path, "status": self.status, "diff": self.diff}
        if self.source is not None:
            d["source"] = self.source
        if self.language is not None:
            d["language"] = self.language
        return d


@dataclass
class PayloadMeta:
    repo: str
    branch: str
    commit_hash: str
    commit_message: str
    timestamp: str
    diff_mode: Literal["default", "staged", "branch"]
    base_branch: str | None = None

    def to_dict(self) -> dict:
        d: dict = {
            "repo": self.repo,
            "branch": self.branch,
            "commitHash": self.commit_hash,
            "commitMessage": self.commit_message,
            "timestamp": self.timestamp,
            "diffMode": self.diff_mode,
        }
        if self.base_branch is not None:
            d["baseBranch"] = self.base_branch
        return d


@dataclass
class AgentReviewPayload:
    version: int = 1
    meta: PayloadMeta | None = None
    files: list[AgentReviewFile] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "meta": self.meta.to_dict() if self.meta else {},
            "files": [f.to_dict() for f in self.files],
        }
