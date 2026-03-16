from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from click.testing import CliRunner

from agentreview.cli import main
from agentreview.git.diff import get_diff
from agentreview.git.metadata import get_metadata
from agentreview.vcs import Repository


def _completed(stdout: str, *, args: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=args or ["git"], returncode=0, stdout=stdout, stderr="")


def _failed(
    stderr: str,
    *,
    args: list[str] | None = None,
    returncode: int = 255,
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=args or ["hg"],
        returncode=returncode,
        stdout="",
        stderr=stderr,
    )


class GetDiffTests(unittest.TestCase):
    @patch(
        "agentreview.git.diff._get_untracked_files_diff",
        return_value="diff --git a/new.txt b/new.txt",
    )
    @patch("agentreview.git.diff._run_git")
    def test_branch_mode_includes_uncommitted_and_untracked_changes(self, run_git, get_untracked) -> None:
        repo = Repository(kind="git", root="/repo")
        run_git.side_effect = [
            _completed("abc123\n"),
            _completed("diff --git a/app.py b/app.py\n"),
        ]

        diff = get_diff(repo, "branch", "main")

        self.assertEqual(
            diff,
            "diff --git a/app.py b/app.py\n\n"
            "diff --git a/new.txt b/new.txt\n",
        )
        self.assertEqual(
            run_git.call_args_list,
            [
                unittest.mock.call(repo, ["merge-base", "main", "HEAD"]),
                unittest.mock.call(repo, ["diff", "abc123"]),
            ],
        )
        get_untracked.assert_called_once_with(repo)

    @patch(
        "agentreview.git.diff._get_untracked_files_diff",
        return_value="diff --git a/new.txt b/new.txt",
    )
    @patch("agentreview.git.diff._run_git")
    def test_commit_mode_includes_uncommitted_and_untracked_changes(self, run_git, get_untracked) -> None:
        repo = Repository(kind="git", root="/repo")
        run_git.return_value = _completed("diff --git a/app.py b/app.py\n")

        diff = get_diff(repo, "commit", "abc123")

        self.assertEqual(
            diff,
            "diff --git a/app.py b/app.py\n\n"
            "diff --git a/new.txt b/new.txt\n",
        )
        run_git.assert_called_once_with(repo, ["diff", "abc123"])
        get_untracked.assert_called_once_with(repo)

    @patch(
        "agentreview.git.diff._get_untracked_files_diff",
        return_value="diff --git a/new.txt b/new.txt",
    )
    @patch("agentreview.git.diff._run_hg")
    def test_hg_branch_mode_includes_uncommitted_and_untracked_changes(self, run_hg, get_untracked) -> None:
        repo = Repository(kind="hg", root="/repo")
        run_hg.side_effect = [
            _completed("1234567890abcdef\n", args=["hg"]),
            _completed("abcdef1234567890\n", args=["hg"]),
            _completed("diff --git a/app.py b/app.py\n", args=["hg"]),
        ]

        diff = get_diff(repo, "branch", "default")

        self.assertEqual(
            diff,
            "diff --git a/app.py b/app.py\n\n"
            "diff --git a/new.txt b/new.txt\n",
        )
        self.assertEqual(
            run_hg.call_args_list,
            [
                unittest.mock.call(repo, ["log", "-r", "default", "--template", "{node}"]),
                unittest.mock.call(repo, ["log", "-r", "ancestor(., 1234567890abcdef)", "--template", "{node}"]),
                unittest.mock.call(repo, ["diff", "--git", "--from", "abcdef1234567890"], check=False),
            ],
        )
        get_untracked.assert_called_once_with(repo)

    @patch(
        "agentreview.git.diff._get_untracked_files_diff",
        return_value="diff --git a/new.txt b/new.txt",
    )
    @patch("agentreview.git.diff._run_hg")
    def test_hg_commit_mode_falls_back_to_legacy_rev_flag(self, run_hg, get_untracked) -> None:
        repo = Repository(kind="hg", root="/repo")
        run_hg.side_effect = [
            _failed("hg diff: option --from not recognized\n", args=["hg"]),
            _completed("diff --git a/app.py b/app.py\n", args=["hg"]),
        ]

        diff = get_diff(repo, "commit", "abc123")

        self.assertEqual(
            diff,
            "diff --git a/app.py b/app.py\n\n"
            "diff --git a/new.txt b/new.txt\n",
        )
        self.assertEqual(
            run_hg.call_args_list,
            [
                unittest.mock.call(repo, ["diff", "--git", "--from", "abc123"], check=False),
                unittest.mock.call(repo, ["diff", "--git", "-r", "abc123"], check=False),
            ],
        )
        get_untracked.assert_called_once_with(repo)


class HelpTextTests(unittest.TestCase):
    def test_help_includes_examples_and_common_use_cases(self) -> None:
        result = CliRunner().invoke(main, ["--help"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Examples:", result.output)
        self.assertIn("agentreview --branch main", result.output)
        self.assertIn("agentreview --commit HEAD~3", result.output)
        self.assertIn("Common use cases:", result.output)
        self.assertIn("git add -p && agentreview --staged", result.output)
        self.assertIn("--staged is only available in Git repositories.", result.output)
        self.assertIn("Use only one of --staged, --branch, or --commit.", result.output)
        self.assertIn("COMMIT can be any git commit-ish or Mercurial revision identifier.", result.output)
        self.assertIn("https://agentreview-web.vercel.app/", result.output)


class CliModeValidationTests(unittest.TestCase):
    def test_rejects_multiple_diff_modes(self) -> None:
        result = CliRunner().invoke(main, ["--branch", "main", "--commit", "abc123"])

        self.assertEqual(result.exit_code, 2)
        self.assertIn("Choose only one of --staged, --branch, or --commit.", result.output)

    @patch("agentreview.cli.detect_repository", return_value=Repository(kind="hg", root="/repo"))
    def test_rejects_staged_mode_for_hg_repositories(self, detect_repository) -> None:
        result = CliRunner().invoke(main, ["--staged"])

        self.assertEqual(result.exit_code, 2)
        self.assertIn("--staged is only available in Git repositories.", result.output)
        detect_repository.assert_called_once_with()

    @patch("agentreview.cli.get_diff")
    @patch("agentreview.cli.detect_repository", return_value=Repository(kind="hg", root="/repo"))
    def test_surfaces_hg_stderr_when_diff_fails(self, detect_repository, get_diff_mock) -> None:
        get_diff_mock.side_effect = subprocess.CalledProcessError(
            255,
            ["hg", "diff"],
            stderr="abort: unknown revision 'abc123'",
        )

        result = CliRunner().invoke(main, ["--commit", "abc123"])

        self.assertEqual(result.exit_code, 1)
        self.assertIn("Error running hg diff: abort: unknown revision 'abc123'", result.output)
        detect_repository.assert_called_once_with()


class MetadataTests(unittest.TestCase):
    @patch("agentreview.git.metadata._hg")
    def test_hg_metadata_uses_bookmark_and_remote_name(self, hg) -> None:
        repo = Repository(kind="hg", root="/repo/project")
        hg.side_effect = [
            "ssh://hg@example.com/team/project",
            "feature-bookmark",
            "abc123+",
            "Add hg support",
        ]

        meta = get_metadata(repo, "branch", "default")

        self.assertEqual(meta.repo, "project")
        self.assertEqual(meta.branch, "feature-bookmark")
        self.assertEqual(meta.commit_hash, "abc123")
        self.assertEqual(meta.commit_message, "Add hg support")
