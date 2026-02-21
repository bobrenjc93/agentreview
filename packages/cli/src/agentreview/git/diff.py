from __future__ import annotations

import subprocess
from typing import Literal


def get_diff(mode: Literal["default", "staged", "branch"], base_branch: str) -> str:
    match mode:
        case "staged":
            args = ["git", "diff", "--cached"]
        case "branch":
            args = ["git", "diff", f"{base_branch}...HEAD"]
        case _:
            args = ["git", "diff", "HEAD"]

    result = subprocess.run(args, capture_output=True, text=True, check=True)
    return result.stdout
