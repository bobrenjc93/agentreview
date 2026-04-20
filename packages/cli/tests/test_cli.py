from __future__ import annotations

import errno
from io import StringIO
import json
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from click.testing import CliRunner

from agentreview.cli import main
from agentreview.git.diff import get_diff
from agentreview.git.files import get_file_contents, get_file_contents_for_revisions
from agentreview.git.metadata import get_metadata
from agentreview.git.segments import get_review_segments
from agentreview.local_ui import (
    LOCAL_FALLBACK_SEGMENT_ID,
    LOCAL_UI_BASE_URL_ENV,
    LOCAL_SERVER_START_PORT,
    LocalUiError,
    _LocalReviewSessionState,
    _build_local_payload_manifest,
    _build_local_payload_response,
    _get_listening_process_ports,
    _get_local_review_url,
    _has_listening_process_on_port,
    _resolve_static_request_path,
    _start_http_server,
)
from agentreview.payload.encode import encode_payload, write_payload
from agentreview.payload.types import AgentReviewFile, AgentReviewPayload, AgentReviewSegment, PayloadMeta
from agentreview.vcs import Repository, detect_repository, run_command
from agentreview.version import get_cli_version


def _completed(stdout: str, *, args: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=args or ["git"], returncode=0, stdout=stdout, stderr="")


def _failed(
    stderr: str,
    *,
    args: list[str] | None = None,
    returncode: int = 255,
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=args or ["sl"],
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
    def test_branch_mode_excludes_uncommitted_and_untracked_by_default(self, run_git, get_untracked) -> None:
        repo = Repository(kind="git", root="/repo")
        run_git.side_effect = [
            _completed("abc123\n"),
            _completed("diff --git a/app.py b/app.py\n"),
        ]

        diff = get_diff(repo, "branch", "main")

        self.assertEqual(diff, "diff --git a/app.py b/app.py\n")
        self.assertEqual(
            run_git.call_args_list,
            [
                unittest.mock.call(repo, ["merge-base", "main", "HEAD"]),
                unittest.mock.call(repo, ["diff", "abc123", "HEAD"]),
            ],
        )
        get_untracked.assert_not_called()

    @patch(
        "agentreview.git.diff._get_untracked_files_diff",
        return_value="diff --git a/new.txt b/new.txt",
    )
    @patch("agentreview.git.diff._run_git")
    def test_branch_mode_includes_uncommitted_and_untracked_with_flag(self, run_git, get_untracked) -> None:
        repo = Repository(kind="git", root="/repo")
        run_git.side_effect = [
            _completed("abc123\n"),
            _completed("diff --git a/app.py b/app.py\n"),
        ]

        diff = get_diff(repo, "branch", "main", include_uncommitted=True)

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
    def test_commit_mode_excludes_uncommitted_and_untracked_by_default(self, run_git, get_untracked) -> None:
        repo = Repository(kind="git", root="/repo")
        run_git.return_value = _completed("diff --git a/app.py b/app.py\n")

        diff = get_diff(repo, "commit", "abc123")

        self.assertEqual(diff, "diff --git a/app.py b/app.py\n")
        run_git.assert_called_once_with(repo, ["diff", "abc123", "HEAD"])
        get_untracked.assert_not_called()

    @patch(
        "agentreview.git.diff._get_untracked_files_diff",
        return_value="diff --git a/new.txt b/new.txt",
    )
    @patch("agentreview.git.diff._run_git")
    def test_commit_mode_includes_uncommitted_and_untracked_with_flag(self, run_git, get_untracked) -> None:
        repo = Repository(kind="git", root="/repo")
        run_git.return_value = _completed("diff --git a/app.py b/app.py\n")

        diff = get_diff(repo, "commit", "abc123", include_uncommitted=True)

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
    @patch("agentreview.git.diff._run_sl")
    def test_sl_branch_mode_excludes_uncommitted_and_untracked_by_default(self, run_sl, get_untracked) -> None:
        repo = Repository(kind="sl", root="/repo")
        run_sl.side_effect = [
            _completed("1234567890abcdef\n", args=["sl"]),
            _completed("abcdef1234567890\n", args=["sl"]),
            _completed("diff --git a/app.py b/app.py\n", args=["sl"]),
        ]

        diff = get_diff(repo, "branch", "default")

        self.assertEqual(diff, "diff --git a/app.py b/app.py\n")
        self.assertEqual(
            run_sl.call_args_list,
            [
                unittest.mock.call(repo, ["log", "-r", "default", "--template", "{node}"]),
                unittest.mock.call(repo, ["log", "-r", "ancestor(., 1234567890abcdef)", "--template", "{node}"]),
                unittest.mock.call(repo, ["diff", "--git", "-r", "abcdef1234567890:."]),
            ],
        )
        get_untracked.assert_not_called()

    @patch(
        "agentreview.git.diff._get_untracked_files_diff",
        return_value="diff --git a/new.txt b/new.txt",
    )
    @patch("agentreview.git.diff._run_sl")
    def test_sl_branch_mode_includes_uncommitted_and_untracked_with_flag(self, run_sl, get_untracked) -> None:
        repo = Repository(kind="sl", root="/repo")
        run_sl.side_effect = [
            _completed("1234567890abcdef\n", args=["sl"]),
            _completed("abcdef1234567890\n", args=["sl"]),
            _completed("diff --git a/app.py b/app.py\n", args=["sl"]),
        ]

        diff = get_diff(repo, "branch", "default", include_uncommitted=True)

        self.assertEqual(
            diff,
            "diff --git a/app.py b/app.py\n\n"
            "diff --git a/new.txt b/new.txt\n",
        )
        self.assertEqual(
            run_sl.call_args_list,
            [
                unittest.mock.call(repo, ["log", "-r", "default", "--template", "{node}"]),
                unittest.mock.call(repo, ["log", "-r", "ancestor(., 1234567890abcdef)", "--template", "{node}"]),
                unittest.mock.call(repo, ["diff", "--git", "-r", "abcdef1234567890"]),
            ],
        )
        get_untracked.assert_called_once_with(repo)

    @patch(
        "agentreview.git.diff._get_untracked_files_diff",
        return_value="diff --git a/new.txt b/new.txt",
    )
    @patch("agentreview.git.diff._run_sl")
    def test_sl_commit_mode_excludes_uncommitted_and_untracked_by_default(self, run_sl, get_untracked) -> None:
        repo = Repository(kind="sl", root="/repo")
        run_sl.return_value = _completed("diff --git a/app.py b/app.py\n", args=["sl"])

        diff = get_diff(repo, "commit", "abc123")

        self.assertEqual(diff, "diff --git a/app.py b/app.py\n")
        run_sl.assert_called_once_with(repo, ["diff", "--git", "-r", "abc123:."])
        get_untracked.assert_not_called()

    @patch(
        "agentreview.git.diff._get_untracked_files_diff",
        return_value="diff --git a/new.txt b/new.txt",
    )
    @patch("agentreview.git.diff._run_sl")
    def test_sl_commit_mode_uses_rev_flag_with_uncommitted(self, run_sl, get_untracked) -> None:
        repo = Repository(kind="sl", root="/repo")
        run_sl.return_value = _completed("diff --git a/app.py b/app.py\n", args=["sl"])

        diff = get_diff(repo, "commit", "abc123", include_uncommitted=True)

        self.assertEqual(
            diff,
            "diff --git a/app.py b/app.py\n\n"
            "diff --git a/new.txt b/new.txt\n",
        )
        run_sl.assert_called_once_with(repo, ["diff", "--git", "-r", "abc123"])
        get_untracked.assert_called_once_with(repo)


class HelpTextTests(unittest.TestCase):
    def test_help_includes_examples_and_common_use_cases(self) -> None:
        result = CliRunner().invoke(main, ["--help"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Examples:", result.output)
        self.assertIn("agentreview --version", result.output)
        self.assertIn("agentreview --local", result.output)
        self.assertIn(
            "BASE_URL=http://devgpu009.cco5.fbinfra.net agentreview --local",
            result.output,
        )
        self.assertIn("agentreview --branch main", result.output)
        self.assertIn("agentreview --branch main --uncommitted", result.output)
        self.assertIn("agentreview --commit HEAD~3", result.output)
        self.assertIn("Common use cases:", result.output)
        self.assertIn("git add -p && agentreview --staged", result.output)
        self.assertIn("--uncommitted", result.output)
        self.assertIn("--verbose", result.output)
        self.assertIn("--staged is only available in Git repositories.", result.output)
        self.assertIn("--local serves the bundled web UI locally", result.output)
        self.assertIn("Set BASE_URL to rewrite the printed/opened --local URL", result.output)
        self.assertIn("--uncommitted only affects --branch and --commit.", result.output)
        self.assertIn("Use only one of --staged, --branch, or --commit.", result.output)
        self.assertIn("COMMIT can be any git commit-ish or Sapling revision identifier.", result.output)
        self.assertIn("https://agentreview-web.vercel.app/", result.output)


class PayloadEncodingTests(unittest.TestCase):
    def test_write_payload_matches_encode_payload(self) -> None:
        meta = PayloadMeta(
            repo="agentreview",
            branch="main",
            commit_hash="abc123",
            commit_message="Test commit",
            timestamp="2026-03-16T00:00:00+00:00",
            diff_mode="commit",
            base_commit="abc123",
        )

        payload = AgentReviewPayload(
            meta=meta,
            files=[
                AgentReviewFile(
                    path="app.py",
                    status="modified",
                    diff="diff --git a/app.py b/app.py\n",
                    source="print('hello')\n",
                    language="python",
                )
            ],
            segments=[
                AgentReviewSegment(
                    id="commit:abc123",
                    label="abc123",
                    kind="commit",
                    commit_hash="abc123",
                    commit_message="Test commit",
                    files=[
                        AgentReviewFile(
                            path="app.py",
                            status="modified",
                            diff="diff --git a/app.py b/app.py\n",
                            source="print('hello')\n",
                            old_source="print('old')\n",
                            language="python",
                        )
                    ],
                )
            ],
        )

        output = StringIO()
        write_payload(payload, output)

        self.assertEqual(output.getvalue(), encode_payload(payload))


class GetFileContentsTests(unittest.TestCase):
    @patch("agentreview.git.files.run_command")
    def test_default_mode_reads_old_source_from_head_and_new_source_from_worktree(self, run_command) -> None:
        with TemporaryDirectory() as tmpdir:
            Path(tmpdir, "app.py").write_text("new from worktree\n", encoding="utf-8")
            repo = Repository(kind="git", root=tmpdir)

            run_command.return_value = _completed("old from head\n")

            files = get_file_contents(
                repo,
                "diff --git a/app.py b/app.py\n"
                "--- a/app.py\n"
                "+++ b/app.py\n",
                "default",
                "main",
            )

        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].source, "new from worktree\n")
        self.assertEqual(files[0].old_source, "old from head\n")
        run_command.assert_called_once_with(
            "git",
            repo,
            ["show", "HEAD:app.py"],
            check=False,
        )

    @patch("agentreview.git.files.run_command")
    def test_staged_mode_reads_new_source_from_index(self, run_command) -> None:
        with TemporaryDirectory() as tmpdir:
            Path(tmpdir, "app.py").write_text("unstaged worktree\n", encoding="utf-8")
            repo = Repository(kind="git", root=tmpdir)

            def fake_run_command(binary, repo_arg, args, *, check=True):
                self.assertEqual(binary, "git")
                self.assertEqual(repo_arg, repo)
                if args == ["show", ":app.py"]:
                    return _completed("staged index\n")
                if args == ["show", "HEAD:app.py"]:
                    return _completed("old head\n")
                self.fail(f"Unexpected command: {args}")

            run_command.side_effect = fake_run_command

            files = get_file_contents(
                repo,
                "diff --git a/app.py b/app.py\n"
                "--- a/app.py\n"
                "+++ b/app.py\n",
                "staged",
                "main",
            )

        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].source, "staged index\n")
        self.assertEqual(files[0].old_source, "old head\n")

    @patch("agentreview.git.files.run_command")
    def test_revision_mode_reads_new_source_from_requested_revision(self, run_command) -> None:
        repo = Repository(kind="git", root="/repo")

        def fake_run_command(binary, repo_arg, args, *, check=True):
            self.assertEqual(binary, "git")
            self.assertEqual(repo_arg, repo)
            if args == ["show", "parent123:old.py"]:
                return _completed("old path contents\n")
            if args == ["show", "commit456:new.py"]:
                return _completed("new path contents\n")
            self.fail(f"Unexpected command: {args}")

        run_command.side_effect = fake_run_command

        files = get_file_contents_for_revisions(
            repo,
            "diff --git a/old.py b/new.py\n"
            "similarity index 100%\n"
            "rename from old.py\n"
            "rename to new.py\n",
            old_revision="parent123",
            new_source_mode="revision",
            new_revision="commit456",
        )

        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].status, "renamed")
        self.assertEqual(files[0].path, "new.py")
        self.assertEqual(files[0].source, "new path contents\n")
        self.assertEqual(files[0].old_source, "old path contents\n")

    @patch("agentreview.git.files.run_command")
    def test_branch_mode_uses_merge_base_and_rename_from_path_for_old_source(self, run_command) -> None:
        with TemporaryDirectory() as tmpdir:
            Path(tmpdir, "new.py").write_text("new path contents\n", encoding="utf-8")
            repo = Repository(kind="git", root=tmpdir)

            def fake_run_command(binary, repo_arg, args, *, check=True):
                self.assertEqual(binary, "git")
                self.assertEqual(repo_arg, repo)
                if args == ["merge-base", "main", "HEAD"]:
                    return _completed("base123\n")
                if args == ["show", "base123:old.py"]:
                    return _completed("old path contents\n")
                self.fail(f"Unexpected command: {args}")

            run_command.side_effect = fake_run_command

            files = get_file_contents(
                repo,
                "diff --git a/old.py b/new.py\n"
                "similarity index 100%\n"
                "rename from old.py\n"
                "rename to new.py\n",
                "branch",
                "main",
            )

        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].status, "renamed")
        self.assertEqual(files[0].path, "new.py")
        self.assertEqual(files[0].source, "new path contents\n")
        self.assertEqual(files[0].old_source, "old path contents\n")

    @patch("agentreview.git.files.run_command")
    def test_branch_mode_reads_new_source_from_head_when_uncommitted_are_excluded(self, run_command) -> None:
        with TemporaryDirectory() as tmpdir:
            Path(tmpdir, "app.py").write_text("dirty worktree\n", encoding="utf-8")
            repo = Repository(kind="git", root=tmpdir)

            def fake_run_command(binary, repo_arg, args, *, check=True):
                self.assertEqual(binary, "git")
                self.assertEqual(repo_arg, repo)
                if args == ["merge-base", "main", "HEAD"]:
                    return _completed("base123\n")
                if args == ["show", "base123:app.py"]:
                    return _completed("old from base\n")
                if args == ["show", "HEAD:app.py"]:
                    return _completed("clean head\n")
                self.fail(f"Unexpected command: {args}")

            run_command.side_effect = fake_run_command

            files = get_file_contents(
                repo,
                "diff --git a/app.py b/app.py\n"
                "--- a/app.py\n"
                "+++ b/app.py\n",
                "branch",
                "main",
                include_uncommitted=False,
            )

        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].source, "clean head\n")
        self.assertEqual(files[0].old_source, "old from base\n")


class RunCommandTests(unittest.TestCase):
    def test_run_command_replaces_invalid_utf8_output(self) -> None:
        with TemporaryDirectory() as tmpdir:
            repo = Repository(kind="git", root=tmpdir)
            result = run_command(
                sys.executable,
                repo,
                [
                    "-c",
                    "import sys; sys.stdout.buffer.write(b'\\x89PNG\\r\\n')",
                ],
                check=False,
            )

        self.assertEqual(result.stdout, "\ufffdPNG\n")


class ReviewSegmentsTests(unittest.TestCase):
    @patch("agentreview.git.segments.get_file_contents_for_revisions")
    @patch("agentreview.git.segments.get_diff", return_value="diff --git a/wip.py b/wip.py\n")
    @patch("agentreview.git.segments.run_command")
    def test_commit_mode_builds_commit_and_uncommitted_segments_when_requested(
        self,
        run_command,
        get_diff_mock,
        get_file_contents_mock,
    ) -> None:
        repo = Repository(kind="git", root="/repo")
        first_commit = "1111111111111111111111111111111111111111"
        second_parent = "11111111111111111111111111111111111111"
        second_commit = "2222222222222222222222222222222222222222"
        first_message = "First commit\n\nBody line one\nBody line two"
        second_message = "Second commit\n\nFollow-up detail"
        run_command.side_effect = [
            _completed(
                f"{first_commit}\x001111111\x00base123\n"
                f"{second_commit}\x002222222\x00{second_parent}\n"
            ),
            _completed(f"{first_message}\n"),
            _completed("diff --git a/a.py b/a.py\n"),
            _completed(f"{second_message}\n"),
            _completed("diff --git a/b.py b/b.py\n"),
        ]
        get_file_contents_mock.side_effect = [
            [AgentReviewFile(path="a.py", status="modified", diff="diff --git a/a.py b/a.py\n")],
            [AgentReviewFile(path="b.py", status="modified", diff="diff --git a/b.py b/b.py\n")],
            [AgentReviewFile(path="wip.py", status="modified", diff="diff --git a/wip.py b/wip.py\n")],
        ]

        segments = get_review_segments(repo, "commit", "HEAD~2", include_uncommitted=True)

        self.assertEqual([segment.id for segment in segments], [
            f"commit:{first_commit}",
            f"commit:{second_commit}",
            "uncommitted",
        ])
        self.assertEqual(segments[0].commit_hash, "1111111")
        self.assertEqual(segments[0].commit_message, first_message)
        self.assertEqual(segments[1].commit_hash, "2222222")
        self.assertEqual(segments[1].commit_message, second_message)
        self.assertEqual(segments[2].label, "Uncommitted changes")
        self.assertEqual(
            [segment.kind for segment in segments],
            ["commit", "commit", "uncommitted"],
        )
        self.assertEqual(run_command.call_args_list, [
            unittest.mock.call(
                "git",
                repo,
                ["log", "--reverse", "--format=%H%x00%h%x00%P", "HEAD~2..HEAD"],
                check=True,
            ),
            unittest.mock.call(
                "git",
                repo,
                ["show", "-s", "--format=%B", first_commit],
                check=True,
            ),
            unittest.mock.call(
                "git",
                repo,
                ["diff", "base123", first_commit],
                check=True,
            ),
            unittest.mock.call(
                "git",
                repo,
                ["show", "-s", "--format=%B", second_commit],
                check=True,
            ),
            unittest.mock.call(
                "git",
                repo,
                [
                    "diff",
                    second_parent,
                    second_commit,
                ],
                check=True,
            ),
        ])
        self.assertEqual(
            get_file_contents_mock.call_args_list,
            [
                unittest.mock.call(
                    repo,
                    "diff --git a/a.py b/a.py\n",
                    old_revision="base123",
                    new_source_mode="revision",
                    new_revision=first_commit,
                ),
                unittest.mock.call(
                    repo,
                    "diff --git a/b.py b/b.py\n",
                    old_revision=second_parent,
                    new_source_mode="revision",
                    new_revision=second_commit,
                ),
                unittest.mock.call(
                    repo,
                    "diff --git a/wip.py b/wip.py\n",
                    old_revision="HEAD",
                    new_source_mode="worktree",
                ),
            ],
        )
        get_diff_mock.assert_called_once_with(repo, "default", "main", include_uncommitted=True)

    @patch("agentreview.git.segments.get_diff")
    @patch("agentreview.git.segments.get_file_contents_for_revisions")
    @patch("agentreview.git.segments.run_command")
    def test_commit_mode_skips_uncommitted_segment_by_default(
        self,
        run_command,
        get_file_contents_mock,
        get_diff_mock,
    ) -> None:
        repo = Repository(kind="git", root="/repo")
        commit_hash = "1111111111111111111111111111111111111111"
        run_command.side_effect = [
            _completed(f"{commit_hash}\x001111111\x00base123\n"),
            _completed("First commit\n"),
            _completed("diff --git a/a.py b/a.py\n"),
        ]
        get_file_contents_mock.return_value = [
            AgentReviewFile(path="a.py", status="modified", diff="diff --git a/a.py b/a.py\n")
        ]

        segments = get_review_segments(repo, "commit", "HEAD~1")

        self.assertEqual([segment.id for segment in segments], [f"commit:{commit_hash}"])
        get_diff_mock.assert_not_called()

    @patch("agentreview.git.segments.run_command")
    def test_non_commit_modes_skip_review_segments(self, run_command) -> None:
        repo = Repository(kind="git", root="/repo")

        self.assertEqual(get_review_segments(repo, "default", "main"), [])
        run_command.assert_not_called()


class CliModeValidationTests(unittest.TestCase):
    def test_version_flag_prints_cli_version(self) -> None:
        result = CliRunner().invoke(main, ["--version"])

        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.output, f"agentreview {get_cli_version()}\n")

    @patch("agentreview.version.distribution_version", return_value=None)
    def test_get_cli_version_falls_back_to_pyproject_when_installed_metadata_is_blank(
        self,
        distribution_version_mock,
    ) -> None:
        pyproject = Path("/Users/bobren/projects/agentreview/packages/cli/pyproject.toml")
        self.assertIn('version = "', pyproject.read_text(encoding="utf-8"))
        expected_version = pyproject.read_text(encoding="utf-8").split('version = "', 1)[1].split(
            '"',
            1,
        )[0]
        self.assertEqual(get_cli_version(), expected_version)
        distribution_version_mock.assert_called_once_with("agentreview")

    def test_rejects_multiple_diff_modes(self) -> None:
        result = CliRunner().invoke(main, ["--branch", "main", "--commit", "abc123"])

        self.assertEqual(result.exit_code, 2)
        self.assertIn("Choose only one of --staged, --branch, or --commit.", result.output)

    @patch("agentreview.cli.detect_repository", return_value=Repository(kind="sl", root="/repo"))
    def test_rejects_staged_mode_for_sl_repositories(self, detect_repository) -> None:
        result = CliRunner().invoke(main, ["--staged"])

        self.assertEqual(result.exit_code, 2)
        self.assertIn("--staged is only available in Git repositories.", result.output)
        detect_repository.assert_called_once_with(verbose=False)

    @patch("agentreview.cli.get_diff")
    @patch("agentreview.cli.detect_repository", return_value=Repository(kind="sl", root="/repo"))
    def test_surfaces_sl_stderr_when_diff_fails(self, detect_repository, get_diff_mock) -> None:
        get_diff_mock.side_effect = subprocess.CalledProcessError(
            255,
            ["sl", "diff"],
            stderr="abort: unknown revision 'abc123'",
        )

        result = CliRunner().invoke(main, ["--commit", "abc123"])

        self.assertEqual(result.exit_code, 1)
        self.assertIn("Error running sl diff: abort: unknown revision 'abc123'", result.output)
        detect_repository.assert_called_once_with(verbose=False)


class DetectRepositoryTests(unittest.TestCase):
    @patch("agentreview.vcs._probe_repository")
    def test_detect_repository_prefers_git_without_probingsl(self, probe_repository) -> None:
        probe_repository.return_value = "/repo"

        repo = detect_repository(verbose=True)

        self.assertEqual(repo, Repository(kind="git", root="/repo", verbose=True))
        probe_repository.assert_called_once_with(
            "git",
            ["rev-parse", "--show-toplevel"],
            cwd=None,
            verbose=True,
        )

    @patch("agentreview.vcs._probe_repository")
    def test_detect_repository_falls_back_to_sl_when_git_probe_fails(self, probe_repository) -> None:
        probe_repository.side_effect = [None, "/repo"]

        repo = detect_repository()

        self.assertEqual(repo, Repository(kind="sl", root="/repo", verbose=False))
        self.assertEqual(
            probe_repository.call_args_list,
            [
                unittest.mock.call(
                    "git",
                    ["rev-parse", "--show-toplevel"],
                    cwd=None,
                    verbose=False,
                ),
                unittest.mock.call("sl", ["root"], cwd=None, verbose=False),
            ],
        )


class CliExecutionTests(unittest.TestCase):

    @patch("agentreview.cli.get_review_segments", return_value=[])
    @patch("agentreview.cli.get_file_contents", return_value=[])
    @patch(
        "agentreview.cli.get_metadata",
        return_value=PayloadMeta(
            repo="agentreview",
            branch="main",
            commit_hash="abc123",
            commit_message="Test commit",
            timestamp="2026-03-16T00:00:00+00:00",
            diff_mode="commit",
            base_commit="abc123",
        ),
    )
    @patch("agentreview.cli.get_diff", return_value="diff --git a/app.py b/app.py\n")
    @patch(
        "agentreview.cli.detect_repository",
        return_value=Repository(kind="git", root="/repo", verbose=True),
    )
    def test_verbose_flag_emits_progress_messages(
        self,
        detect_repository,
        get_diff_mock,
        get_metadata_mock,
        get_file_contents_mock,
        get_review_segments_mock,
    ) -> None:
        result = CliRunner().invoke(main, ["-v", "--commit", "abc123"])

        self.assertEqual(result.exit_code, 0)
        self.assertRegex(
            result.output,
            re.compile(r"\[agentreview [^\]]+\] mode=commit base=abc123"),
        )
        self.assertRegex(
            result.output,
            re.compile(r"\[agentreview [^\]]+\] diff bytes="),
        )
        self.assertRegex(
            result.output,
            re.compile(r"\[agentreview [^\]]+\] collecting metadata"),
        )
        self.assertRegex(
            result.output,
            re.compile(r"\[agentreview [^\]]+\] metadata repo=agentreview branch=main commit=abc123"),
        )
        self.assertRegex(
            result.output,
            re.compile(r"\[agentreview [^\]]+\] extracting file contents"),
        )
        self.assertRegex(
            result.output,
            re.compile(r"\[agentreview [^\]]+\] files=0"),
        )
        self.assertRegex(
            result.output,
            re.compile(r"\[agentreview [^\]]+\] collecting review segments"),
        )
        self.assertRegex(
            result.output,
            re.compile(r"\[agentreview [^\]]+\] segments=0"),
        )
        self.assertRegex(
            result.output,
            re.compile(r"\[agentreview [^\]]+\] writing payload"),
        )
        detect_repository.assert_called_once_with(verbose=True)
        get_diff_mock.assert_called_once()
        get_metadata_mock.assert_called_once()
        get_file_contents_mock.assert_called_once()
        get_review_segments_mock.assert_called_once_with(
            Repository(kind="git", root="/repo", verbose=True),
            "commit",
            "abc123",
            include_uncommitted=False,
        )

    @patch("agentreview.cli.serve_local_review")
    @patch("agentreview.cli.get_file_contents", return_value=[])
    @patch(
        "agentreview.cli.get_metadata",
        return_value=PayloadMeta(
            repo="agentreview",
            branch="main",
            commit_hash="abc123",
            commit_message="Test commit",
            timestamp="2026-03-16T00:00:00+00:00",
            diff_mode="default",
        ),
    )
    @patch("agentreview.cli.get_diff", return_value="diff --git a/app.py b/app.py\n")
    @patch(
        "agentreview.cli.detect_repository",
        return_value=Repository(kind="git", root="/repo"),
    )
    def test_local_mode_launches_web_ui_instead_of_writing_payload(
        self,
        detect_repository,
        get_diff_mock,
        get_metadata_mock,
        get_file_contents_mock,
        serve_local_review_mock,
    ) -> None:
        result = CliRunner().invoke(main, ["--local"])

        self.assertEqual(result.exit_code, 0)
        self.assertRegex(
            result.output,
            r"\[agentreview [^\]]+\] Detecting repository\.",
        )
        self.assertIn("Detected git repository at /repo.", result.output)
        self.assertIn("Collecting the git diff.", result.output)
        self.assertIn("Reading repository metadata.", result.output)
        self.assertIn("Loading full file contents for the review.", result.output)
        self.assertIn("Starting the local review UI.", result.output)
        detect_repository.assert_called_once_with(verbose=False)
        get_diff_mock.assert_called_once()
        get_metadata_mock.assert_called_once()
        get_file_contents_mock.assert_called_once()
        serve_local_review_mock.assert_called_once()

        payload = serve_local_review_mock.call_args.args[0]
        self.assertIsInstance(payload, AgentReviewPayload)
        self.assertEqual(payload.meta.repo, "agentreview")
        self.assertEqual(payload.files, [])
        self.assertTrue(callable(serve_local_review_mock.call_args.kwargs["progress"]))
        self.assertTrue(callable(serve_local_review_mock.call_args.kwargs["refresh_payload"]))

    @patch(
        "agentreview.cli.get_review_segments",
        return_value=[
            AgentReviewSegment(
                id="commit:abc123",
                label="abc123",
                kind="commit",
                commit_hash="abc123",
                files=[
                    AgentReviewFile(
                        path="app.py",
                        status="modified",
                        diff="diff --git a/app.py b/app.py",
                    )
                ],
            )
        ],
    )
    @patch("agentreview.cli.get_file_contents")
    @patch(
        "agentreview.cli.get_metadata",
        return_value=PayloadMeta(
            repo="agentreview",
            branch="main",
            commit_hash="abc123",
            commit_message="Test commit",
            timestamp="2026-03-16T00:00:00+00:00",
            diff_mode="commit",
            base_commit="HEAD~1",
        ),
    )
    @patch("agentreview.cli.get_diff")
    @patch(
        "agentreview.cli.detect_repository",
        return_value=Repository(kind="git", root="/repo"),
    )
    @patch("agentreview.cli.serve_local_review")
    def test_local_git_commit_mode_skips_aggregate_diff_and_file_extraction(
        self,
        serve_local_review_mock,
        detect_repository,
        get_diff_mock,
        get_metadata_mock,
        get_file_contents_mock,
        get_review_segments_mock,
    ) -> None:
        result = CliRunner().invoke(main, ["--commit", "HEAD~1", "--local"])

        self.assertEqual(result.exit_code, 0)
        detect_repository.assert_called_once_with(verbose=False)
        get_diff_mock.assert_not_called()
        get_metadata_mock.assert_called_once_with(
            Repository(kind="git", root="/repo"),
            "commit",
            "HEAD~1",
        )
        get_file_contents_mock.assert_not_called()
        get_review_segments_mock.assert_called_once_with(
            Repository(kind="git", root="/repo"),
            "commit",
            "HEAD~1",
            include_uncommitted=False,
        )
        serve_local_review_mock.assert_called_once()

        payload = serve_local_review_mock.call_args.args[0]
        self.assertEqual(payload.files, [])
        self.assertEqual(len(payload.segments), 1)
        self.assertTrue(callable(serve_local_review_mock.call_args.kwargs["refresh_payload"]))

    @patch("agentreview.cli.get_review_segments", return_value=[])
    @patch("agentreview.cli.get_file_contents", return_value=[])
    @patch(
        "agentreview.cli.get_metadata",
        return_value=PayloadMeta(
            repo="agentreview",
            branch="main",
            commit_hash="abc123",
            commit_message="Test commit",
            timestamp="2026-03-16T00:00:00+00:00",
            diff_mode="commit",
            base_commit="abc123",
        ),
    )
    @patch("agentreview.cli.get_diff", return_value="diff --git a/app.py b/app.py\n")
    @patch(
        "agentreview.cli.detect_repository",
        return_value=Repository(kind="git", root="/repo"),
    )
    def test_uncommitted_flag_is_forwarded_to_diff_file_and_segment_collection(
        self,
        detect_repository,
        get_diff_mock,
        get_metadata_mock,
        get_file_contents_mock,
        get_review_segments_mock,
    ) -> None:
        result = CliRunner().invoke(main, ["--commit", "abc123", "--uncommitted"])

        self.assertEqual(result.exit_code, 0)
        detect_repository.assert_called_once_with(verbose=False)
        get_diff_mock.assert_called_once_with(
            Repository(kind="git", root="/repo"),
            "commit",
            "abc123",
            include_uncommitted=True,
        )
        get_file_contents_mock.assert_called_once_with(
            Repository(kind="git", root="/repo"),
            "diff --git a/app.py b/app.py\n",
            "commit",
            "abc123",
            include_uncommitted=True,
        )
        get_review_segments_mock.assert_called_once_with(
            Repository(kind="git", root="/repo"),
            "commit",
            "abc123",
            include_uncommitted=True,
        )


class LocalUiTests(unittest.TestCase):
    @patch.dict("agentreview.local_ui.os.environ", {}, clear=True)
    def test_get_local_review_url_defaults_to_localhost(self) -> None:
        self.assertEqual(
            _get_local_review_url(LOCAL_SERVER_START_PORT),
            f"http://127.0.0.1:{LOCAL_SERVER_START_PORT}/review/local",
        )

    def test_get_local_review_url_appends_cache_buster_query(self) -> None:
        self.assertEqual(
            _get_local_review_url(LOCAL_SERVER_START_PORT, cache_buster="local-session"),
            f"http://127.0.0.1:{LOCAL_SERVER_START_PORT}/review/local?agentreviewSession=local-session",
        )

    @patch.dict(
        "agentreview.local_ui.os.environ",
        {LOCAL_UI_BASE_URL_ENV: "https://proxy.example.com/reviewer?via=ssh"},
        clear=True,
    )
    def test_get_local_review_url_preserves_existing_query_when_adding_cache_buster(self) -> None:
        self.assertEqual(
            _get_local_review_url(LOCAL_SERVER_START_PORT, cache_buster="local-session"),
            (
                f"https://proxy.example.com:{LOCAL_SERVER_START_PORT}"
                "/reviewer/review/local?via=ssh&agentreviewSession=local-session"
            ),
        )

    @patch.dict(
        "agentreview.local_ui.os.environ",
        {LOCAL_UI_BASE_URL_ENV: "http://devgpu009.cco5.fbinfra.net"},
        clear=True,
    )
    def test_get_local_review_url_uses_base_url_host_and_runtime_port(self) -> None:
        self.assertEqual(
            _get_local_review_url(LOCAL_SERVER_START_PORT + 3),
            f"http://devgpu009.cco5.fbinfra.net:{LOCAL_SERVER_START_PORT + 3}/review/local",
        )

    @patch.dict(
        "agentreview.local_ui.os.environ",
        {LOCAL_UI_BASE_URL_ENV: "https://proxy.example.com:8443/reviewer?via=ssh"},
        clear=True,
    )
    def test_get_local_review_url_replaces_base_url_port_with_runtime_port(self) -> None:
        self.assertEqual(
            _get_local_review_url(LOCAL_SERVER_START_PORT + 5, cache_buster="local-session"),
            (
                f"https://proxy.example.com:{LOCAL_SERVER_START_PORT + 5}"
                "/reviewer/review/local?via=ssh&agentreviewSession=local-session"
            ),
        )

    @patch.dict(
        "agentreview.local_ui.os.environ",
        {LOCAL_UI_BASE_URL_ENV: "https://proxy.example.com/reviewer"},
        clear=True,
    )
    def test_get_local_review_url_preserves_base_path_prefix(self) -> None:
        self.assertEqual(
            _get_local_review_url(LOCAL_SERVER_START_PORT),
            f"https://proxy.example.com:{LOCAL_SERVER_START_PORT}/reviewer/review/local",
        )

    @patch.dict(
        "agentreview.local_ui.os.environ",
        {LOCAL_UI_BASE_URL_ENV: "devgpu009.cco5.fbinfra.net"},
        clear=True,
    )
    def test_get_local_review_url_rejects_invalid_base_url(self) -> None:
        with self.assertRaises(LocalUiError):
            _get_local_review_url(LOCAL_SERVER_START_PORT)

    @patch("agentreview.local_ui.ThreadingHTTPServer")
    def test_start_http_server_prefers_default_port(self, server_cls) -> None:
        expected_server = object()
        server_cls.return_value = expected_server
        handler = object()

        server = _start_http_server(handler)

        self.assertIs(server, expected_server)
        server_cls.assert_called_once_with(("127.0.0.1", LOCAL_SERVER_START_PORT), handler)

    @patch("agentreview.local_ui.ThreadingHTTPServer")
    def test_start_http_server_increments_until_an_open_port(self, server_cls) -> None:
        expected_server = object()
        server_cls.side_effect = [
            OSError(errno.EADDRINUSE, "Address already in use"),
            OSError(errno.EADDRINUSE, "Address already in use"),
            expected_server,
        ]

        handler = object()
        server = _start_http_server(handler)

        self.assertIs(server, expected_server)
        self.assertEqual(
            server_cls.call_args_list,
            [
                unittest.mock.call(("127.0.0.1", LOCAL_SERVER_START_PORT), handler),
                unittest.mock.call(("127.0.0.1", LOCAL_SERVER_START_PORT + 1), handler),
                unittest.mock.call(("127.0.0.1", LOCAL_SERVER_START_PORT + 2), handler),
            ],
        )

    @patch.dict(
        "agentreview.local_ui.os.environ",
        {LOCAL_UI_BASE_URL_ENV: "http://devgpu009.cco5.fbinfra.net"},
        clear=True,
    )
    @patch("agentreview.local_ui._get_listening_process_ports")
    @patch("agentreview.local_ui.ThreadingHTTPServer")
    def test_start_http_server_skips_ports_with_existing_listeners(
        self,
        server_cls,
        get_listening_ports,
    ) -> None:
        expected_server = object()
        server_cls.return_value = expected_server
        get_listening_ports.return_value = {
            LOCAL_SERVER_START_PORT,
            LOCAL_SERVER_START_PORT + 1,
        }

        handler = object()
        server = _start_http_server(handler)

        self.assertIs(server, expected_server)
        get_listening_ports.assert_called_once_with()
        server_cls.assert_called_once_with(("127.0.0.1", LOCAL_SERVER_START_PORT + 2), handler)

    @patch("agentreview.local_ui.subprocess.run")
    @patch("agentreview.local_ui.shutil.which")
    def test_get_listening_process_ports_uses_ss_when_available(
        self,
        which_mock,
        run_mock,
    ) -> None:
        which_mock.side_effect = ["/usr/bin/ss"]
        run_mock.return_value = subprocess.CompletedProcess(
            args=["ss"],
            returncode=0,
            stdout=(
                "LISTEN 0 128 127.0.0.1:44102 0.0.0.0:*\n"
                "LISTEN 0 128 [::]:44103 [::]:*\n"
            ),
            stderr="",
        )

        self.assertEqual(_get_listening_process_ports(), {44102, 44103})
        run_mock.assert_called_once_with(
            ["ss", "-ltnH"],
            check=False,
            capture_output=True,
            text=True,
        )

    @patch("agentreview.local_ui.subprocess.run")
    @patch("agentreview.local_ui.shutil.which")
    def test_get_listening_process_ports_falls_back_to_lsof(
        self,
        which_mock,
        run_mock,
    ) -> None:
        which_mock.side_effect = [None, "/usr/sbin/lsof"]
        run_mock.return_value = subprocess.CompletedProcess(
            args=["lsof"],
            returncode=0,
            stdout="n*:44102\nn127.0.0.1:44103\n",
            stderr="",
        )

        self.assertEqual(_get_listening_process_ports(), {44102, 44103})
        run_mock.assert_called_once_with(
            ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "n"],
            check=False,
            capture_output=True,
            text=True,
        )

    @patch("agentreview.local_ui._get_listening_process_ports")
    def test_has_listening_process_on_port_uses_scanned_listener_set(
        self,
        get_listening_ports,
    ) -> None:
        get_listening_ports.return_value = {44102}

        self.assertTrue(_has_listening_process_on_port(44102))
        self.assertFalse(_has_listening_process_on_port(44103))

    @patch("agentreview.local_ui.subprocess.run")
    @patch("agentreview.local_ui.shutil.which")
    def test_get_listening_process_ports_returns_empty_set_when_ss_finds_nothing(
        self,
        which_mock,
        run_mock,
    ) -> None:
        which_mock.side_effect = ["/usr/bin/ss"]
        run_mock.return_value = subprocess.CompletedProcess(
            args=["ss"],
            returncode=0,
            stdout="",
            stderr="",
        )

        self.assertEqual(_get_listening_process_ports(), set())

    @patch("agentreview.local_ui.LOCAL_SERVER_START_PORT", 65535)
    @patch("agentreview.local_ui.ThreadingHTTPServer")
    def test_start_http_server_raises_after_exhausting_ports(self, server_cls) -> None:
        server_cls.side_effect = OSError(errno.EADDRINUSE, "Address already in use")

        with self.assertRaises(LocalUiError):
            _start_http_server(object())

    def test_resolve_static_request_path_prefers_flight_data_for_rsc_requests(self) -> None:
        with TemporaryDirectory() as tmpdir:
            site_dir = Path(tmpdir)
            (site_dir / "review").mkdir()
            (site_dir / "review" / "local.html").write_text("html", encoding="utf-8")
            (site_dir / "review" / "local.txt").write_text("flight", encoding="utf-8")

            resolved = _resolve_static_request_path(
                site_dir,
                "/review/local",
                prefer_flight_data=True,
            )

        self.assertEqual(resolved, "review/local.txt")

    def test_resolve_static_request_path_uses_index_txt_for_root_rsc_requests(self) -> None:
        with TemporaryDirectory() as tmpdir:
            site_dir = Path(tmpdir)
            (site_dir / "index.html").write_text("html", encoding="utf-8")
            (site_dir / "index.txt").write_text("flight", encoding="utf-8")

            resolved = _resolve_static_request_path(
                site_dir,
                "/",
                prefer_flight_data=True,
            )

        self.assertEqual(resolved, "index.txt")

    def test_build_local_payload_manifest_strips_root_file_contents_without_segments(self) -> None:
        payload = AgentReviewPayload(
            meta=PayloadMeta(
                repo="agentreview",
                branch="main",
                commit_hash="abc123",
                commit_message="Test commit",
                timestamp="2026-03-31T00:00:00+00:00",
                diff_mode="default",
            ),
            files=[
                AgentReviewFile(
                    path="app.py",
                    status="modified",
                    diff="diff --git a/app.py b/app.py",
                    source="print('new')\n",
                    old_source="print('old')\n",
                    language="python",
                )
            ],
        )

        manifest, file_by_key = _build_local_payload_manifest(payload)

        self.assertEqual(len(manifest["files"]), 1)
        self.assertNotIn("source", manifest["files"][0])
        self.assertNotIn("oldSource", manifest["files"][0])
        self.assertEqual(
            file_by_key[(LOCAL_FALLBACK_SEGMENT_ID, "app.py")].source,
            "print('new')\n",
        )
        self.assertEqual(
            file_by_key[(LOCAL_FALLBACK_SEGMENT_ID, "app.py")].old_source,
            "print('old')\n",
        )

    def test_build_local_payload_manifest_drops_duplicate_root_files_when_segments_exist(self) -> None:
        payload = AgentReviewPayload(
            meta=PayloadMeta(
                repo="agentreview",
                branch="main",
                commit_hash="abc123",
                commit_message="Test commit",
                timestamp="2026-03-31T00:00:00+00:00",
                diff_mode="commit",
                base_commit="HEAD~1",
            ),
            files=[
                AgentReviewFile(
                    path="app.py",
                    status="modified",
                    diff="diff --git a/app.py b/app.py",
                    source="print('new')\n",
                    old_source="print('old')\n",
                    language="python",
                )
            ],
            segments=[
                AgentReviewSegment(
                    id="commit:abc123",
                    label="abc123",
                    kind="commit",
                    commit_hash="abc123",
                    commit_message="Test commit",
                    files=[
                        AgentReviewFile(
                            path="app.py",
                            status="modified",
                            diff="diff --git a/app.py b/app.py",
                            source="print('new')\n",
                            old_source="print('old')\n",
                            language="python",
                        )
                    ],
                )
            ],
        )

        manifest, file_by_key = _build_local_payload_manifest(payload)

        self.assertEqual(manifest["files"], [])
        self.assertEqual(len(manifest["segments"]), 1)
        self.assertNotIn("source", manifest["segments"][0]["files"][0])
        self.assertNotIn("oldSource", manifest["segments"][0]["files"][0])
        self.assertIn(("commit:abc123", "app.py"), file_by_key)

    def test_local_review_session_state_refresh_replaces_payload_and_session(self) -> None:
        initial_payload = AgentReviewPayload(
            meta=PayloadMeta(
                repo="agentreview",
                branch="main",
                commit_hash="abc123",
                commit_message="Initial commit",
                timestamp="2026-03-31T00:00:00+00:00",
                diff_mode="default",
            ),
            files=[
                AgentReviewFile(
                    path="before.py",
                    status="modified",
                    diff="diff --git a/before.py b/before.py",
                    source="print('before')\n",
                )
            ],
        )
        refreshed_payload = AgentReviewPayload(
            meta=PayloadMeta(
                repo="agentreview",
                branch="main",
                commit_hash="def456",
                commit_message="Refreshed commit",
                timestamp="2026-03-31T00:05:00+00:00",
                diff_mode="default",
            ),
            files=[
                AgentReviewFile(
                    path="after.py",
                    status="modified",
                    diff="diff --git a/after.py b/after.py",
                    source="print('after')\n",
                )
            ],
        )
        payload_response, file_by_key = _build_local_payload_response(
            initial_payload,
            session_id="local-initial",
        )
        session_state = _LocalReviewSessionState(
            session_id="local-initial",
            payload_response=payload_response,
            file_by_key=file_by_key,
            refresh_payload=lambda progress=None: refreshed_payload,
        )

        next_session_id, next_payload_response = session_state.refresh()
        current_session_id, current_payload_response, current_file_by_key = (
            session_state.get_snapshot()
        )

        self.assertNotEqual(next_session_id, "local-initial")
        self.assertEqual(current_session_id, next_session_id)
        self.assertEqual(current_payload_response, next_payload_response)
        self.assertEqual(
            json.loads(next_payload_response.decode("utf-8"))["payload"]["meta"]["commitHash"],
            "def456",
        )
        self.assertIn((LOCAL_FALLBACK_SEGMENT_ID, "after.py"), current_file_by_key)


class MetadataTests(unittest.TestCase):
    @patch("agentreview.git.metadata._git")
    def test_git_metadata_uses_full_commit_message(self, git) -> None:
        repo = Repository(kind="git", root="/repo/project")
        git.side_effect = [
            "git@github.com:example/project.git",
            "main",
            "abc123",
            "Subject line\n\nDetailed body",
        ]

        meta = get_metadata(repo, "commit", "HEAD~1")

        self.assertEqual(meta.repo, "project")
        self.assertEqual(meta.branch, "main")
        self.assertEqual(meta.commit_hash, "abc123")
        self.assertEqual(meta.commit_message, "Subject line\n\nDetailed body")

    @patch("agentreview.git.metadata._sl")
    def test_sl_metadata_uses_bookmark_and_remote_name(self, sl) -> None:
        repo = Repository(kind="sl", root="/repo/project")
        sl.side_effect = [
            "ssh://sl@example.com/team/project",
            "feature-bookmark",
            "abc123",
            "Add sl support",
        ]

        meta = get_metadata(repo, "branch", "default")

        self.assertEqual(meta.repo, "project")
        self.assertEqual(meta.branch, "feature-bookmark")
        self.assertEqual(meta.commit_hash, "abc123")
        self.assertEqual(meta.commit_message, "Add sl support")
