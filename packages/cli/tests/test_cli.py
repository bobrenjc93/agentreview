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
    DEFAULT_AGENT_MODEL,
    DEFAULT_CODEX_REASONING_EFFORT,
    KNOWN_CODEX_MODELS,
    LOCAL_FALLBACK_SEGMENT_ID,
    LOCAL_UI_BASE_URL_ENV,
    LOCAL_SERVER_START_PORT,
    LocalAgentError,
    LocalUiError,
    _LocalReviewSessionState,
    _parse_agent_stream,
    _parse_codex_stream,
    _run_claude_agent,
    _run_codex_agent,
    get_default_agent_backend,
    get_default_agent_model,
    get_default_codex_reasoning_effort,
    load_persisted_settings,
    save_persisted_settings,
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

    @patch(
        "agentreview.git.diff._get_untracked_files_diff",
        return_value="",
    )
    @patch("agentreview.git.diff._run_sl")
    def test_sl_commit_mode_translates_git_head_syntax(self, run_sl, get_untracked) -> None:
        repo = Repository(kind="sl", root="/repo")
        run_sl.return_value = _completed("diff --git a/app.py b/app.py\n", args=["sl"])

        diff = get_diff(repo, "commit", "HEAD~4", include_uncommitted=True)

        self.assertEqual(diff, "diff --git a/app.py b/app.py\n")
        run_sl.assert_called_once_with(repo, ["diff", "--git", "-r", ".~4"])
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

    @patch(
        "agentreview.git.files._read_sl_revision_files",
        return_value={"app.py": "old from base\n"},
    )
    def test_sl_commit_mode_translates_git_head_syntax_for_old_source(
        self,
        read_sl_revision_files,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            Path(tmpdir, "app.py").write_text("new from worktree\n", encoding="utf-8")
            repo = Repository(kind="sl", root=tmpdir)

            files = get_file_contents(
                repo,
                "diff --git a/app.py b/app.py\n"
                "--- a/app.py\n"
                "+++ b/app.py\n",
                "commit",
                "HEAD~4",
                include_uncommitted=True,
            )

        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].source, "new from worktree\n")
        self.assertEqual(files[0].old_source, "old from base\n")
        read_sl_revision_files.assert_called_once_with(
            repo,
            ".~4",
            ["app.py"],
        )

    @patch("agentreview.git.files.run_command")
    def test_sl_revision_file_reads_are_batched_by_revision(self, run_command) -> None:
        repo = Repository(kind="sl", root="/repo")

        def fake_run_command(binary, repo_arg, args, *, check=True):
            self.assertEqual(binary, "sl")
            self.assertEqual(repo_arg, repo)
            self.assertFalse(check)
            output_pattern = args[4]
            revision = args[2]
            for path in args[6:]:
                output_path = Path(output_pattern.replace("%p", path))
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_text(f"{revision}:{path}\n", encoding="utf-8")
            return _completed("", args=["sl"])

        run_command.side_effect = fake_run_command
        files = get_file_contents(
            repo,
            "diff --git a/a.py b/a.py\n"
            "--- a/a.py\n"
            "+++ b/a.py\n"
            "diff --git a/b.py b/b.py\n"
            "--- a/b.py\n"
            "+++ b/b.py\n",
            "commit",
            "HEAD~4",
            include_uncommitted=False,
        )

        self.assertEqual([file.old_source for file in files], [".~4:a.py\n", ".~4:b.py\n"])
        self.assertEqual([file.source for file in files], [".:a.py\n", ".:b.py\n"])
        self.assertEqual(len(run_command.call_args_list), 2)
        self.assertEqual(run_command.call_args_list[0].args[2][:4], ["cat", "-r", ".~4", "-o"])
        self.assertEqual(run_command.call_args_list[0].args[2][5:], ["--", "a.py", "b.py"])
        self.assertEqual(run_command.call_args_list[1].args[2][:4], ["cat", "-r", ".", "-o"])
        self.assertEqual(run_command.call_args_list[1].args[2][5:], ["--", "a.py", "b.py"])


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

    @patch("agentreview.git.segments.get_diff", return_value="diff --git a/wip.py b/wip.py\n")
    @patch("agentreview.git.segments.get_file_contents_for_revisions")
    @patch("agentreview.git.segments.run_command")
    def test_sl_commit_mode_builds_commit_and_uncommitted_segments(
        self,
        run_command,
        get_file_contents_mock,
        get_diff_mock,
    ) -> None:
        repo = Repository(kind="sl", root="/repo")
        base_commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        first_commit = "1111111111111111111111111111111111111111"
        second_commit = "2222222222222222222222222222222222222222"
        run_command.side_effect = [
            _completed(f"{base_commit}\n", args=["sl"]),
            _completed(
                json.dumps(
                    [
                        {
                            "node": first_commit,
                            "parents": [base_commit],
                            "desc": "First commit\n\nBody",
                        },
                        {
                            "node": second_commit,
                            "parents": [first_commit],
                            "desc": "Second commit",
                        },
                    ]
                ),
                args=["sl"],
            ),
            _completed("diff --git a/a.py b/a.py\n", args=["sl"]),
            _completed("diff --git a/b.py b/b.py\n", args=["sl"]),
        ]
        get_file_contents_mock.side_effect = [
            [AgentReviewFile(path="a.py", status="modified", diff="diff --git a/a.py b/a.py\n")],
            [AgentReviewFile(path="b.py", status="modified", diff="diff --git a/b.py b/b.py\n")],
            [AgentReviewFile(path="wip.py", status="modified", diff="diff --git a/wip.py b/wip.py\n")],
        ]

        segments = get_review_segments(repo, "commit", "HEAD~2", include_uncommitted=True)

        self.assertEqual(
            [segment.id for segment in segments],
            [f"commit:{first_commit}", f"commit:{second_commit}", "uncommitted"],
        )
        self.assertEqual([segment.commit_hash for segment in segments[:2]], ["111111111111", "222222222222"])
        self.assertEqual(segments[0].commit_message, "First commit\n\nBody")
        self.assertEqual(
            run_command.call_args_list,
            [
                unittest.mock.call(
                    "sl",
                    repo,
                    ["log", "-r", ".~2", "--template", "{node}"],
                    check=True,
                ),
                unittest.mock.call(
                    "sl",
                    repo,
                    [
                        "log",
                        "-r",
                        f"sort(only(., {base_commit}), rev)",
                        "-Tjson",
                    ],
                    check=True,
                ),
                unittest.mock.call(
                    "sl",
                    repo,
                    ["diff", "--git", "-c", first_commit],
                    check=True,
                ),
                unittest.mock.call(
                    "sl",
                    repo,
                    ["diff", "--git", "-c", second_commit],
                    check=True,
                ),
            ],
        )
        self.assertEqual(
            get_file_contents_mock.call_args_list,
            [
                unittest.mock.call(
                    repo,
                    "diff --git a/a.py b/a.py\n",
                    old_revision=base_commit,
                    new_source_mode="revision",
                    new_revision=first_commit,
                ),
                unittest.mock.call(
                    repo,
                    "diff --git a/b.py b/b.py\n",
                    old_revision=first_commit,
                    new_source_mode="revision",
                    new_revision=second_commit,
                ),
                unittest.mock.call(
                    repo,
                    "diff --git a/wip.py b/wip.py\n",
                    old_revision=".",
                    new_source_mode="worktree",
                ),
            ],
        )
        get_diff_mock.assert_called_once_with(repo, "default", "main", include_uncommitted=True)

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
        pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
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
        return_value=Repository(kind="sl", root="/repo"),
    )
    @patch("agentreview.cli.serve_local_review")
    def test_local_sl_commit_mode_skips_aggregate_diff_and_file_extraction(
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
            Repository(kind="sl", root="/repo"),
            "commit",
            "HEAD~1",
        )
        get_file_contents_mock.assert_not_called()
        get_review_segments_mock.assert_called_once_with(
            Repository(kind="sl", root="/repo"),
            "commit",
            "HEAD~1",
            include_uncommitted=False,
        )
        serve_local_review_mock.assert_called_once()

        payload = serve_local_review_mock.call_args.args[0]
        self.assertEqual(payload.files, [])
        self.assertEqual(len(payload.segments), 1)

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


class _FakeAgentProcess:
    def __init__(self, stdout: str, stderr: str = "", returncode: int = 0) -> None:
        self.stdout = StringIO(stdout)
        self.stderr = StringIO(stderr)
        self.returncode = returncode
        self.killed = False

    def wait(self, timeout: float | None = None) -> int:
        return self.returncode

    def poll(self) -> int:
        return self.returncode

    def kill(self) -> None:
        self.killed = True


class LocalAgentTests(unittest.TestCase):
    @patch("agentreview.local_ui.load_persisted_settings", return_value={})
    def test_default_agent_model_is_opus(self, load_settings_mock) -> None:
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("AGENTREVIEW_MODEL", None)
            self.assertEqual(get_default_agent_model(), DEFAULT_AGENT_MODEL)
            self.assertEqual(DEFAULT_AGENT_MODEL, "claude-opus-4-8")

    def test_default_agent_model_env_override(self) -> None:
        with patch.dict("os.environ", {"AGENTREVIEW_MODEL": "claude-sonnet-5"}):
            self.assertEqual(get_default_agent_model(), "claude-sonnet-5")

    @patch("agentreview.local_ui.load_persisted_settings", return_value={"model": "claude-fable-5"})
    def test_default_agent_model_reads_persisted_settings(self, load_settings_mock) -> None:
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("AGENTREVIEW_MODEL", None)
            self.assertEqual(get_default_agent_model(), "claude-fable-5")

    def test_settings_persist_round_trip_on_disk(self) -> None:
        with TemporaryDirectory() as temp_dir:
            with patch.dict("os.environ", {"XDG_CONFIG_HOME": temp_dir}):
                save_persisted_settings({"model": "claude-fable-5"})
                self.assertEqual(
                    load_persisted_settings(), {"model": "claude-fable-5"}
                )
                settings_path = Path(temp_dir) / "agentreview" / "settings.json"
                self.assertTrue(settings_path.is_file())

    def test_session_state_update_settings_changes_model_and_persists(self) -> None:
        with TemporaryDirectory() as temp_dir:
            with patch.dict("os.environ", {"XDG_CONFIG_HOME": temp_dir}):
                session_state = _LocalReviewSessionState(
                    session_id="local-test",
                    payload_response=b"{}",
                    file_by_key={},
                    agent_model="claude-opus-4-8",
                )

                settings = session_state.update_settings({"model": "claude-fable-5"})

                self.assertEqual(settings["model"], "claude-fable-5")
                self.assertEqual(settings["agent"], "claude")
                self.assertEqual(
                    session_state.get_agent_config(),
                    ("claude", "claude-fable-5", "gpt-5.5", ""),
                )
                self.assertEqual(
                    load_persisted_settings().get("model"), "claude-fable-5"
                )

    def test_session_state_update_settings_switches_to_codex(self) -> None:
        with TemporaryDirectory() as temp_dir:
            with patch.dict("os.environ", {"XDG_CONFIG_HOME": temp_dir}):
                session_state = _LocalReviewSessionState(
                    session_id="local-test",
                    payload_response=b"{}",
                    file_by_key={},
                )

                settings = session_state.update_settings(
                    {
                        "agent": "codex",
                        "model": "claude-opus-4-8",
                        "codexModel": "gpt-5.6-sol",
                        "codexReasoningEffort": "max",
                    }
                )

                self.assertEqual(settings["agent"], "codex")
                self.assertEqual(settings["codexModel"], "gpt-5.6-sol")
                self.assertEqual(settings["codexReasoningEffort"], "max")
                self.assertEqual(
                    session_state.get_agent_config(),
                    ("codex", "claude-opus-4-8", "gpt-5.6-sol", "max"),
                )
                persisted = load_persisted_settings()
                self.assertEqual(persisted.get("agent"), "codex")
                self.assertEqual(persisted.get("codexModel"), "gpt-5.6-sol")
                self.assertEqual(persisted.get("codexReasoningEffort"), "max")

    def test_session_state_update_settings_rejects_unknown_agent(self) -> None:
        session_state = _LocalReviewSessionState(
            session_id="local-test",
            payload_response=b"{}",
            file_by_key={},
        )

        with self.assertRaises(LocalUiError):
            session_state.update_settings({"agent": "gemini", "model": "x"})

    @patch("agentreview.local_ui._stream_codex_agent")
    @patch("agentreview.local_ui._stream_claude_agent")
    def test_run_agent_dispatches_to_codex_backend(
        self, stream_claude_mock, stream_codex_mock
    ) -> None:
        stream_codex_mock.return_value = iter(
            [{"type": "done", "result": {"response": "from codex"}}]
        )
        session_state = _LocalReviewSessionState(
            session_id="local-test",
            payload_response=b"{}",
            file_by_key={},
            agent_backend="codex",
            codex_model="gpt-5.6-sol",
            codex_reasoning_effort="max",
        )

        result = session_state.run_agent("hello")

        stream_codex_mock.assert_called_once()
        self.assertEqual(
            stream_codex_mock.call_args.args[:3],
            ("hello", "gpt-5.6-sol", "max"),
        )
        stream_claude_mock.assert_not_called()
        self.assertEqual(result["response"], "from codex")

    def test_parse_codex_stream_extracts_text_and_tool_segments(self) -> None:
        stream = "\n".join(
            [
                json.dumps({"type": "thread.started", "thread_id": "thread-1"}),
                json.dumps(
                    {
                        "type": "item.completed",
                        "item": {
                            "type": "command_execution",
                            "command": "git log --oneline -3",
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "item.completed",
                        "item": {"type": "agent_message", "text": "All good."},
                    }
                ),
                json.dumps({"type": "turn.completed", "usage": {}}),
            ]
        )

        segments, last_message, thread_id, completed = _parse_codex_stream(stream)

        self.assertTrue(completed)
        self.assertEqual(thread_id, "thread-1")
        self.assertEqual(last_message, "All good.")
        self.assertEqual(
            segments,
            [
                {"type": "tool", "name": "shell", "detail": "git log --oneline -3"},
                {"type": "text", "text": "All good."},
            ],
        )

    def test_parse_codex_stream_supports_legacy_msg_events(self) -> None:
        stream = "\n".join(
            [
                json.dumps(
                    {
                        "id": "0",
                        "msg": {
                            "type": "exec_command_begin",
                            "command": ["bash", "-lc", "ls"],
                        },
                    }
                ),
                json.dumps(
                    {"id": "0", "msg": {"type": "agent_message", "message": "Done."}}
                ),
                json.dumps(
                    {
                        "id": "0",
                        "msg": {"type": "task_complete", "last_agent_message": "Done."},
                    }
                ),
            ]
        )

        segments, last_message, thread_id, completed = _parse_codex_stream(stream)

        self.assertTrue(completed)
        self.assertEqual(last_message, "Done.")
        self.assertEqual(
            segments,
            [
                {"type": "tool", "name": "shell", "detail": "bash -lc ls"},
                {"type": "text", "text": "Done."},
            ],
        )

    @patch("agentreview.local_ui.subprocess.Popen")
    @patch("agentreview.local_ui.shutil.which", return_value="/usr/bin/codex")
    def test_run_codex_agent_invokes_codex_exec(self, which_mock, popen_mock) -> None:
        stream = "\n".join(
            [
                json.dumps({"type": "thread.started", "thread_id": "thread-1"}),
                json.dumps(
                    {
                        "type": "item.completed",
                        "item": {"type": "agent_message", "text": "Looks fine."},
                    }
                ),
                json.dumps({"type": "turn.completed", "usage": {}}),
            ]
        )
        popen_mock.return_value = _FakeAgentProcess(stream + "\n")

        result = _run_codex_agent("is this ok?", "gpt-5.6-sol", "max")

        command = popen_mock.call_args.args[0]
        self.assertEqual(command[1:4], ["exec", "--json", "--yolo"])
        self.assertEqual(command[command.index("--model") + 1], "gpt-5.6-sol")
        self.assertEqual(
            command[command.index("-c") + 1],
            "model_reasoning_effort=max",
        )
        self.assertEqual(command[-1], "is this ok?")
        self.assertEqual(result["response"], "Looks fine.")
        self.assertEqual(result["model"], "gpt-5.6-sol")
        self.assertEqual(result["sessionId"], "thread-1")

    @patch("agentreview.local_ui.shutil.which", return_value=None)
    def test_run_codex_agent_errors_when_codex_missing(self, which_mock) -> None:
        with self.assertRaises(LocalAgentError):
            _run_codex_agent("prompt", "")

    @patch("agentreview.local_ui.load_persisted_settings", return_value={"agent": "codex"})
    def test_default_agent_backend_reads_persisted_settings(self, load_settings_mock) -> None:
        with patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("AGENTREVIEW_AGENT", None)
            self.assertEqual(get_default_agent_backend(), "codex")

    def test_default_agent_backend_env_override(self) -> None:
        with patch.dict("os.environ", {"AGENTREVIEW_AGENT": "codex"}):
            self.assertEqual(get_default_agent_backend(), "codex")

    @patch("agentreview.local_ui._stream_claude_agent")
    def test_stream_agent_logs_carry_a_run_id_and_label(self, stream_mock) -> None:
        stream_mock.return_value = iter(
            [{"type": "done", "result": {"response": "ok"}}]
        )
        progress_lines: list[str] = []
        session_state = _LocalReviewSessionState(
            session_id="local-test",
            payload_response=b"{}",
            file_by_key={},
            progress=progress_lines.append,
        )

        list(session_state.stream_agent("hello", None, "app.py (Line 3)"))

        self.assertEqual(len(progress_lines), 2)
        run_tag_match = re.match(r"\[agent ([0-9a-f]{6})\] app\.py \(Line 3\) Running", progress_lines[0])
        self.assertIsNotNone(run_tag_match)
        run_id = run_tag_match.group(1)
        self.assertIn(f"[agent {run_id}] app.py (Line 3) The agent reply is ready (", progress_lines[1])

    @patch("agentreview.local_ui._stream_claude_agent")
    def test_stream_agent_uses_distinct_run_ids_per_run(self, stream_mock) -> None:
        stream_mock.side_effect = [
            iter([{"type": "done", "result": {"response": "ok"}}]),
            iter([{"type": "done", "result": {"response": "ok"}}]),
        ]
        progress_lines: list[str] = []
        session_state = _LocalReviewSessionState(
            session_id="local-test",
            payload_response=b"{}",
            file_by_key={},
            progress=progress_lines.append,
        )

        list(session_state.stream_agent("one"))
        list(session_state.stream_agent("two"))

        run_ids = {
            match.group(1)
            for line in progress_lines
            if (match := re.match(r"\[agent ([0-9a-f]{6})\]", line))
        }
        self.assertEqual(len(run_ids), 2)

    @patch("agentreview.local_ui._stream_claude_agent")
    def test_cancelled_run_yields_cancelled_event(self, stream_mock) -> None:
        session_state = _LocalReviewSessionState(
            session_id="local-test",
            payload_response=b"{}",
            file_by_key={},
        )

        killed = []

        class FakeProc:
            # nonexistent pid: the process-group kill fails and falls back to kill()
            pid = 2**22 + 54321

            def kill(self):
                killed.append(True)

        def fake_stream(prompt, model, resume, on_spawn):
            on_spawn(FakeProc())
            # simulate the user cancelling while the run is in flight
            self.assertTrue(session_state.cancel_agent("run-1"))
            raise LocalAgentError("The claude CLI exited with code -9.")
            yield  # pragma: no cover — makes this a generator

        stream_mock.side_effect = fake_stream

        events = list(session_state.stream_agent("hello", None, None, "run-1"))

        self.assertTrue(killed)
        self.assertEqual(events, [{"type": "cancelled"}])

    def test_cancel_agent_returns_false_for_unknown_run(self) -> None:
        session_state = _LocalReviewSessionState(
            session_id="local-test",
            payload_response=b"{}",
            file_by_key={},
        )

        self.assertFalse(session_state.cancel_agent("missing-run"))

    @patch("agentreview.local_ui.load_persisted_settings", return_value={})
    def test_default_codex_model_is_gpt_55(self, load_settings_mock) -> None:
        from agentreview.local_ui import DEFAULT_CODEX_MODEL, get_default_codex_model

        self.assertEqual(DEFAULT_CODEX_MODEL, "gpt-5.5")
        self.assertEqual(get_default_codex_model(), "gpt-5.5")
        self.assertIn("gpt-5.6-sol", KNOWN_CODEX_MODELS)

    @patch(
        "agentreview.local_ui.load_persisted_settings",
        return_value={"codexModel": "gpt-5.5-codex-mini"},
    )
    def test_default_codex_model_reads_persisted_settings(self, load_settings_mock) -> None:
        from agentreview.local_ui import get_default_codex_model

        self.assertEqual(get_default_codex_model(), "gpt-5.5-codex-mini")

    @patch(
        "agentreview.local_ui.load_persisted_settings",
        return_value={"codexReasoningEffort": "max"},
    )
    def test_default_codex_reasoning_effort_reads_persisted_settings(
        self,
        load_settings_mock,
    ) -> None:
        self.assertEqual(get_default_codex_reasoning_effort(), "max")

    @patch("agentreview.local_ui.load_persisted_settings", return_value={})
    def test_default_codex_reasoning_effort_uses_codex_default(
        self,
        load_settings_mock,
    ) -> None:
        self.assertEqual(
            get_default_codex_reasoning_effort(),
            DEFAULT_CODEX_REASONING_EFFORT,
        )

    def test_session_state_update_settings_rejects_unknown_codex_reasoning_effort(
        self,
    ) -> None:
        session_state = _LocalReviewSessionState(
            session_id="local-test",
            payload_response=b"{}",
            file_by_key={},
        )

        with self.assertRaises(LocalUiError):
            session_state.update_settings(
                {
                    "model": "claude-opus-4-8",
                    "codexReasoningEffort": "extreme",
                }
            )

    def test_session_state_update_settings_rejects_empty_model(self) -> None:
        session_state = _LocalReviewSessionState(
            session_id="local-test",
            payload_response=b"{}",
            file_by_key={},
        )

        with self.assertRaises(LocalUiError):
            session_state.update_settings({"model": "  "})

    def test_parse_agent_stream_extracts_text_and_tool_segments(self) -> None:
        stream = "\n".join(
            [
                json.dumps({"type": "system", "subtype": "init", "session_id": "sess-1"}),
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "content": [
                                {"type": "text", "text": "Let me check."},
                                {
                                    "type": "tool_use",
                                    "name": "Bash",
                                    "input": {"command": "git log --oneline -3"},
                                },
                            ]
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "content": [{"type": "text", "text": "All good — **ship it**."}]
                        },
                    }
                ),
                json.dumps({"type": "result", "is_error": False, "result": "final"}),
            ]
        )

        segments, result_event, session_id = _parse_agent_stream(stream)

        self.assertEqual(session_id, "sess-1")
        self.assertIsNotNone(result_event)
        self.assertEqual(
            segments,
            [
                {"type": "text", "text": "Let me check."},
                {"type": "tool", "name": "Bash", "detail": "git log --oneline -3"},
                {"type": "text", "text": "All good — **ship it**."},
            ],
        )

    @patch("agentreview.local_ui.subprocess.Popen")
    @patch("agentreview.local_ui.shutil.which", return_value="/usr/bin/claude")
    def test_run_claude_agent_invokes_claude_p_with_model(self, which_mock, popen_mock) -> None:
        stream = "\n".join(
            [
                json.dumps({"type": "system", "subtype": "init", "session_id": "sess-1"}),
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "content": [{"type": "text", "text": "Looks fine to me."}]
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "result",
                        "is_error": False,
                        "result": "Looks fine to me.",
                        "duration_ms": 1234,
                        "total_cost_usd": 0.05,
                        "session_id": "sess-1",
                    }
                ),
            ]
        )
        popen_mock.return_value = _FakeAgentProcess(stream + "\n")

        result = _run_claude_agent("Why is this loop O(n^2)?", "claude-opus-4-8")

        command = popen_mock.call_args.args[0]
        self.assertEqual(command[1:3], ["-p", "Why is this loop O(n^2)?"])
        self.assertIn("stream-json", command)
        self.assertIn("--dangerously-skip-permissions", command)
        self.assertEqual(command[command.index("--model") + 1], "claude-opus-4-8")
        self.assertEqual(result["response"], "Looks fine to me.")
        self.assertEqual(result["segments"][0]["type"], "text")
        self.assertEqual(result["model"], "claude-opus-4-8")
        self.assertEqual(result["durationMs"], 1234)
        self.assertEqual(result["costUsd"], 0.05)
        self.assertEqual(result["sessionId"], "sess-1")

    @patch("agentreview.local_ui.shutil.which", return_value=None)
    def test_run_claude_agent_errors_when_claude_missing(self, which_mock) -> None:
        with self.assertRaises(LocalAgentError):
            _run_claude_agent("prompt", "claude-opus-4-8")

    @patch("agentreview.local_ui.subprocess.Popen")
    @patch("agentreview.local_ui.shutil.which", return_value="/usr/bin/claude")
    def test_run_claude_agent_surfaces_cli_failure(self, which_mock, popen_mock) -> None:
        popen_mock.return_value = _FakeAgentProcess(
            "", stderr="something exploded", returncode=1
        )

        with self.assertRaises(LocalAgentError) as ctx:
            _run_claude_agent("prompt", "claude-opus-4-8")

        self.assertIn("something exploded", str(ctx.exception))

    @patch("agentreview.local_ui.subprocess.Popen")
    @patch("agentreview.local_ui.shutil.which", return_value="/usr/bin/claude")
    def test_run_claude_agent_failure_includes_stderr_tail(
        self, which_mock, popen_mock
    ) -> None:
        stderr = "\n".join(f"line {i}" for i in range(1, 31))
        popen_mock.return_value = _FakeAgentProcess("", stderr=stderr, returncode=1)

        with self.assertRaises(LocalAgentError) as ctx:
            _run_claude_agent("prompt", "claude-opus-4-8")

        message = str(ctx.exception)
        self.assertIn("The claude CLI exited with code 1.", message)
        self.assertIn("stderr:", message)
        # keeps the tail of stderr (where errors land), not the beginning
        self.assertIn("line 30", message)
        self.assertNotIn("line 1\n", message)

    @patch("agentreview.local_ui.subprocess.Popen")
    @patch("agentreview.local_ui.shutil.which", return_value="/usr/bin/claude")
    def test_stream_claude_agent_yields_segments_then_done(
        self, which_mock, popen_mock
    ) -> None:
        from agentreview.local_ui import _stream_claude_agent

        stream = "\n".join(
            [
                json.dumps({"type": "system", "subtype": "init", "session_id": "sess-1"}),
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {"content": [{"type": "text", "text": "part one"}]},
                    }
                ),
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {"content": [{"type": "text", "text": "part two"}]},
                    }
                ),
                json.dumps({"type": "result", "is_error": False, "result": "final"}),
            ]
        )
        popen_mock.return_value = _FakeAgentProcess(stream + "\n")

        events = list(_stream_claude_agent("q", "claude-opus-4-8"))

        self.assertEqual(
            [event["type"] for event in events], ["segment", "segment", "done"]
        )
        self.assertEqual(events[0]["segment"], {"type": "text", "text": "part one"})
        self.assertEqual(events[-1]["result"]["response"], "part one\n\npart two")

    @patch("agentreview.local_ui.subprocess.Popen")
    @patch("agentreview.local_ui.shutil.which", return_value="/usr/bin/claude")
    def test_stream_claude_agent_passes_resume_session(
        self, which_mock, popen_mock
    ) -> None:
        from agentreview.local_ui import _stream_claude_agent

        stream = json.dumps({"type": "result", "is_error": False, "result": "ok"})
        popen_mock.return_value = _FakeAgentProcess(stream + "\n")

        list(_stream_claude_agent("q", "claude-opus-4-8", "sess-resume"))

        command = popen_mock.call_args.args[0]
        self.assertEqual(command[command.index("--resume") + 1], "sess-resume")

    @patch("agentreview.local_ui._stream_claude_agent")
    def test_session_state_run_agent_uses_configured_model(self, stream_mock) -> None:
        stream_mock.return_value = iter(
            [{"type": "done", "result": {"response": "ok", "model": "my-model"}}]
        )
        session_state = _LocalReviewSessionState(
            session_id="local-test",
            payload_response=b"{}",
            file_by_key={},
            agent_model="my-model",
        )

        result = session_state.run_agent("hello")

        stream_mock.assert_called_once()
        self.assertEqual(stream_mock.call_args.args[:3], ("hello", "my-model", None))
        self.assertEqual(result["response"], "ok")


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
