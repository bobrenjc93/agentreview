from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from click.testing import CliRunner

from agentreview.cli import main
from agentreview.git.diff import get_diff


def _completed(stdout: str) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["git"], returncode=0, stdout=stdout, stderr="")


class GetDiffTests(unittest.TestCase):
    @patch("agentreview.git.diff._get_untracked_files_diff", return_value="diff --git a/new.txt b/new.txt")
    @patch("agentreview.git.diff._run_git")
    def test_branch_mode_includes_uncommitted_and_untracked_changes(self, run_git, get_untracked) -> None:
        run_git.side_effect = [
            _completed("abc123\n"),
            _completed("diff --git a/app.py b/app.py\n"),
        ]

        diff = get_diff("branch", "main")

        self.assertEqual(
            diff,
            "diff --git a/app.py b/app.py\n\n"
            "diff --git a/new.txt b/new.txt\n",
        )
        self.assertEqual(
            run_git.call_args_list,
            [
                unittest.mock.call(["merge-base", "main", "HEAD"]),
                unittest.mock.call(["diff", "abc123"]),
            ],
        )
        get_untracked.assert_called_once_with()


class HelpTextTests(unittest.TestCase):
    def test_help_includes_examples_and_common_use_cases(self) -> None:
        result = CliRunner().invoke(main, ["--help"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Examples:", result.output)
        self.assertIn("agentreview --branch main", result.output)
        self.assertIn("Common use cases:", result.output)
        self.assertIn("git add -p && agentreview --staged", result.output)
