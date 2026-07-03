from __future__ import annotations

from dataclasses import dataclass, field
import errno
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
from threading import Lock
from time import monotonic
from typing import Callable, Iterator
from urllib.parse import parse_qs, parse_qsl, unquote, urlencode, urlsplit, urlunsplit
from uuid import uuid4
import webbrowser

from .payload.types import AgentReviewFile, AgentReviewPayload

LOCAL_SERVER_HOST = "127.0.0.1"
LOCAL_SERVER_START_PORT = 44102
LOCAL_SERVER_POLL_INTERVAL_SECONDS = 0.5
LOCAL_REVIEW_PATH = "/review/local"
LOCAL_PAYLOAD_ENDPOINT = "/__agentreview__/payload"
LOCAL_FILE_ENDPOINT = "/__agentreview__/file"
LOCAL_REFRESH_ENDPOINT = "/__agentreview__/refresh"
LOCAL_AGENT_ENDPOINT = "/__agentreview__/agent"
LOCAL_AGENT_CANCEL_ENDPOINT = "/__agentreview__/agent/cancel"
LOCAL_SETTINGS_ENDPOINT = "/__agentreview__/settings"
LOCAL_UI_ARCHIVE_NAME = "local_ui_assets.tar.gz"
LOCAL_UI_BASE_URL_ENV = "BASE_URL"
DEFAULT_AGENT_BACKEND = "claude"
KNOWN_AGENT_BACKENDS = ("claude", "codex")
DEFAULT_AGENT_MODEL = "claude-opus-4-8"
AGENT_BACKEND_ENV = "AGENTREVIEW_AGENT"
AGENT_MODEL_ENV = "AGENTREVIEW_MODEL"
AGENT_EXTRA_ARGS_ENV = "AGENTREVIEW_CLAUDE_ARGS"
CODEX_EXTRA_ARGS_ENV = "AGENTREVIEW_CODEX_ARGS"
AGENT_TIMEOUT_SECONDS = 600
AGENT_MAX_PROMPT_BYTES = 1024 * 1024
AGENT_TOOL_DETAIL_MAX_CHARS = 120
SETTINGS_MAX_BODY_BYTES = 64 * 1024
# the most informative input field per tool, used for one-line tool summaries
AGENT_TOOL_DETAIL_KEYS = {
    "Bash": ["command"],
    "Skill": ["skill", "args"],
    "Task": ["description"],
    "Agent": ["description"],
    "WebFetch": ["url"],
    "WebSearch": ["query"],
    "Grep": ["pattern"],
    "Glob": ["pattern"],
}
AGENT_TOOL_DETAIL_FALLBACK_KEYS = [
    "file_path",
    "path",
    "description",
    "prompt",
    "query",
    "command",
]
# The claude CLI has no command to enumerate models, so this is a curated
# list of aliases/ids it accepts; free-form input is always allowed.
KNOWN_AGENT_MODELS = [
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "opus",
    "sonnet",
    "haiku",
    "fable",
]
# Curated codex model ids; empty string means codex's own default model.
DEFAULT_CODEX_MODEL = "gpt-5.5"
KNOWN_CODEX_MODELS = [
    "gpt-5.5",
    "gpt-5.5-codex",
    "gpt-5.5-codex-mini",
    "gpt-5.1-codex-max",
]
LOCAL_FALLBACK_SEGMENT_ID = "all-changes"
LOCAL_CACHE_BUSTER_QUERY_KEY = "agentreviewSession"
ProgressReporter = Callable[[str], None]
RefreshPayload = Callable[[ProgressReporter | None], AgentReviewPayload]
LocalFileKey = tuple[str, str]


class LocalUiError(RuntimeError):
    pass


class LocalAgentError(RuntimeError):
    pass


def _get_settings_path() -> Path:
    config_home = os.environ.get("XDG_CONFIG_HOME", "").strip() or str(Path.home() / ".config")
    return Path(config_home) / "agentreview" / "settings.json"


def load_persisted_settings() -> dict:
    try:
        data = json.loads(_get_settings_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_persisted_settings(settings: dict) -> None:
    path = _get_settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


def get_default_agent_model() -> str:
    env_model = os.environ.get(AGENT_MODEL_ENV, "").strip()
    if env_model:
        return env_model

    saved_model = load_persisted_settings().get("model")
    if isinstance(saved_model, str) and saved_model.strip():
        return saved_model.strip()

    return DEFAULT_AGENT_MODEL


def get_default_agent_backend() -> str:
    env_backend = os.environ.get(AGENT_BACKEND_ENV, "").strip().lower()
    if env_backend in KNOWN_AGENT_BACKENDS:
        return env_backend

    saved_backend = load_persisted_settings().get("agent")
    if isinstance(saved_backend, str) and saved_backend.strip().lower() in KNOWN_AGENT_BACKENDS:
        return saved_backend.strip().lower()

    return DEFAULT_AGENT_BACKEND


def get_default_codex_model() -> str:
    saved_model = load_persisted_settings().get("codexModel")
    if isinstance(saved_model, str) and saved_model.strip():
        return saved_model.strip()
    return DEFAULT_CODEX_MODEL


def _truncate_tool_detail(detail: str) -> str:
    collapsed = " ".join(detail.split())
    if len(collapsed) > AGENT_TOOL_DETAIL_MAX_CHARS:
        return collapsed[:AGENT_TOOL_DETAIL_MAX_CHARS] + "…"
    return collapsed


def _summarize_tool_use(block: dict) -> dict | None:
    """One-line summary of a tool_use block, e.g. Bash: git status."""
    name = str(block.get("name") or "tool")
    inputs = block.get("input")
    if not isinstance(inputs, dict):
        inputs = {}

    for key in AGENT_TOOL_DETAIL_KEYS.get(name, []) + AGENT_TOOL_DETAIL_FALLBACK_KEYS:
        value = inputs.get(key)
        if value:
            detail = str(value)
            if key == "skill" and inputs.get("args"):
                detail += f" {inputs['args']}"
            return {"type": "tool", "name": name, "detail": _truncate_tool_detail(detail)}

    if inputs:
        return {
            "type": "tool",
            "name": name,
            "detail": _truncate_tool_detail(json.dumps(inputs)),
        }

    return None


def _process_claude_event(event: dict) -> tuple[list[dict], str | None, dict | None]:
    """Returns (new segments, session id if seen, result event if seen)."""
    segments: list[dict] = []
    session_id: str | None = None
    result_event: dict | None = None

    event_type = event.get("type")
    if event_type == "system" and event.get("subtype") == "init":
        session_id = event.get("session_id")
    elif event_type == "assistant":
        for block in event.get("message", {}).get("content", []) or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text"):
                segments.append({"type": "text", "text": block["text"]})
            elif block.get("type") == "tool_use":
                summary = _summarize_tool_use(block)
                if summary is not None:
                    segments.append(summary)
    elif event_type == "result":
        result_event = event
        session_id = event.get("session_id")

    return segments, session_id, result_event


def _parse_agent_stream(stdout: str) -> tuple[list[dict], dict | None, str | None]:
    segments: list[dict] = []
    result_event: dict | None = None
    session_id: str | None = None

    for event in _iter_json_lines(stdout.splitlines()):
        new_segments, new_session_id, new_result_event = _process_claude_event(event)
        segments.extend(new_segments)
        if new_session_id:
            session_id = new_session_id
        if new_result_event is not None:
            result_event = new_result_event

    return segments, result_event, session_id


def _iter_json_lines(lines) -> "Iterator[dict]":
    for line in lines:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def _spawn_agent(command: list[str], cli_name: str) -> subprocess.Popen:
    try:
        return subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            # own process group so cancellation can kill tool subprocesses
            # too — they inherit the stdout pipe and would otherwise keep it
            # open (and our read loop blocked) after the parent dies
            start_new_session=True,
        )
    except OSError as exc:
        raise LocalAgentError(f"Failed to launch the {cli_name} CLI: {exc}") from exc


def _kill_agent_process(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (OSError, ProcessLookupError):
        try:
            proc.kill()
        except OSError:
            pass


def _iter_agent_stdout(proc: subprocess.Popen, deadline: float) -> "Iterator[str]":
    assert proc.stdout is not None
    for line in proc.stdout:
        if monotonic() > deadline:
            _kill_agent_process(proc)
            raise LocalAgentError(
                f"The agent run timed out after {AGENT_TIMEOUT_SECONDS} seconds."
            )
        yield line


def _finish_agent_process(proc: subprocess.Popen, deadline: float) -> tuple[int, str]:
    stderr = proc.stderr.read() if proc.stderr else ""
    try:
        code = proc.wait(timeout=max(1.0, deadline - monotonic()))
    except subprocess.TimeoutExpired as exc:
        _kill_agent_process(proc)
        raise LocalAgentError(
            f"The agent run timed out after {AGENT_TIMEOUT_SECONDS} seconds."
        ) from exc
    return code, stderr


def _stream_claude_agent(
    prompt: str,
    model: str,
    resume_session_id: str | None = None,
    on_spawn: Callable[[subprocess.Popen], None] | None = None,
) -> "Iterator[dict]":
    """Yields {"type": "segment", ...} events as they arrive, then one {"type": "done", ...}."""
    claude = shutil.which("claude")
    if claude is None:
        raise LocalAgentError(
            "The claude CLI was not found on PATH. Install Claude Code to use inline agent replies."
        )

    # --dangerously-skip-permissions lets the agent edit files without an
    # interactive approval prompt (there is no one attached to approve it)
    command = [
        claude,
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
    ]
    if resume_session_id:
        command += ["--resume", resume_session_id]
    if model:
        command += ["--model", model]
    command += shlex.split(os.environ.get(AGENT_EXTRA_ARGS_ENV, ""))

    proc = _spawn_agent(command, "claude")
    if on_spawn is not None:
        on_spawn(proc)
    deadline = monotonic() + AGENT_TIMEOUT_SECONDS
    segments: list[dict] = []
    result_event: dict | None = None
    session_id: str | None = None

    try:
        for event in _iter_json_lines(_iter_agent_stdout(proc, deadline)):
            new_segments, new_session_id, new_result_event = _process_claude_event(event)
            if new_session_id:
                session_id = new_session_id
            if new_result_event is not None:
                result_event = new_result_event
            for segment in new_segments:
                segments.append(segment)
                yield {"type": "segment", "segment": segment}
        code, stderr = _finish_agent_process(proc, deadline)
    finally:
        if proc.poll() is None:
            _kill_agent_process(proc)

    if code != 0 or result_event is None or result_event.get("is_error"):
        detail = ""
        if result_event and result_event.get("result"):
            detail = str(result_event["result"])
        elif stderr.strip():
            detail = stderr.strip().splitlines()[-1]
        message = f"The claude CLI exited with code {code}."
        if detail:
            message = f"{message} {detail}"
        raise LocalAgentError(message)

    text_parts = [segment["text"] for segment in segments if segment["type"] == "text"]
    response_text = "\n\n".join(text_parts) or str(result_event.get("result") or "")

    yield {
        "type": "done",
        "result": {
            "response": response_text,
            "segments": segments,
            "model": model,
            "durationMs": result_event.get("duration_ms"),
            "costUsd": result_event.get("total_cost_usd"),
            "sessionId": session_id,
        },
    }


def _codex_command_detail(command) -> str:
    if isinstance(command, list):
        return _truncate_tool_detail(" ".join(str(part) for part in command))
    return _truncate_tool_detail(str(command))


def _parse_codex_item(item: dict, segments: list[dict]) -> str | None:
    """Map one codex exec item to a segment; returns agent-message text if any."""
    item_type = item.get("type") or item.get("item_type")
    if item_type == "agent_message":
        text = item.get("text") or item.get("message")
        if text:
            segments.append({"type": "text", "text": str(text)})
            return str(text)
    elif item_type == "command_execution":
        detail = _codex_command_detail(item.get("command") or "")
        if detail:
            segments.append({"type": "tool", "name": "shell", "detail": detail})
    elif item_type == "file_change":
        changes = item.get("changes")
        if isinstance(changes, list):
            paths = ", ".join(str(change.get("path", "")) for change in changes if isinstance(change, dict))
        else:
            paths = ""
        segments.append(
            {"type": "tool", "name": "edit", "detail": _truncate_tool_detail(paths or "file change")}
        )
    elif item_type == "web_search":
        query = item.get("query")
        if query:
            segments.append(
                {"type": "tool", "name": "web_search", "detail": _truncate_tool_detail(str(query))}
            )
    elif item_type == "mcp_tool_call":
        name = f"{item.get('server', 'mcp')}.{item.get('tool', 'tool')}"
        segments.append({"type": "tool", "name": name, "detail": ""})
    return None


def _process_codex_event(event: dict) -> tuple[list[dict], str | None, str | None, bool | None]:
    """Returns (new segments, last agent message, thread id, completed flag)."""
    segments: list[dict] = []
    last_message: str | None = None
    thread_id: str | None = None
    completed: bool | None = None

    event_type = event.get("type")
    if event_type == "thread.started":
        thread_id = event.get("thread_id")
    elif event_type == "item.completed" and isinstance(event.get("item"), dict):
        message = _parse_codex_item(event["item"], segments)
        if message:
            last_message = message
    elif event_type == "turn.completed":
        completed = True
    elif event_type == "turn.failed":
        completed = False
    elif isinstance(event.get("msg"), dict):
        # legacy codex exec --json event shape
        msg = event["msg"]
        msg_type = msg.get("type")
        if msg_type == "agent_message" and msg.get("message"):
            last_message = str(msg["message"])
            segments.append({"type": "text", "text": last_message})
        elif msg_type == "exec_command_begin":
            detail = _codex_command_detail(msg.get("command") or "")
            if detail:
                segments.append({"type": "tool", "name": "shell", "detail": detail})
        elif msg_type == "task_complete":
            completed = True
            if msg.get("last_agent_message"):
                last_message = str(msg["last_agent_message"])

    return segments, last_message, thread_id, completed


def _parse_codex_stream(stdout: str) -> tuple[list[dict], str | None, str | None, bool]:
    """Returns (segments, last agent message, thread id, saw a terminal event)."""
    segments: list[dict] = []
    last_message: str | None = None
    thread_id: str | None = None
    completed = False

    for event in _iter_json_lines(stdout.splitlines()):
        new_segments, new_message, new_thread_id, new_completed = _process_codex_event(event)
        segments.extend(new_segments)
        if new_message:
            last_message = new_message
        if new_thread_id:
            thread_id = new_thread_id
        if new_completed is not None:
            completed = new_completed

    return segments, last_message, thread_id, completed


def _stream_codex_agent(
    prompt: str,
    model: str,
    on_spawn: Callable[[subprocess.Popen], None] | None = None,
) -> "Iterator[dict]":
    """Yields {"type": "segment", ...} events as they arrive, then one {"type": "done", ...}."""
    codex = shutil.which("codex")
    if codex is None:
        raise LocalAgentError(
            "The codex CLI was not found on PATH. Install Codex or switch the agent back to claude in Settings."
        )

    # --yolo is codex's equivalent of skipping the approval sandbox so the
    # agent can edit files during a headless run
    command = [codex, "exec", "--json", "--yolo"]
    if model:
        command += ["--model", model]
    command += shlex.split(os.environ.get(CODEX_EXTRA_ARGS_ENV, ""))
    command.append(prompt)

    proc = _spawn_agent(command, "codex")
    if on_spawn is not None:
        on_spawn(proc)
    deadline = monotonic() + AGENT_TIMEOUT_SECONDS
    segments: list[dict] = []
    last_message: str | None = None
    thread_id: str | None = None
    completed = False

    try:
        for event in _iter_json_lines(_iter_agent_stdout(proc, deadline)):
            new_segments, new_message, new_thread_id, new_completed = _process_codex_event(event)
            if new_message:
                last_message = new_message
            if new_thread_id:
                thread_id = new_thread_id
            if new_completed is not None:
                completed = new_completed
            for segment in new_segments:
                segments.append(segment)
                yield {"type": "segment", "segment": segment}
        code, stderr = _finish_agent_process(proc, deadline)
    finally:
        if proc.poll() is None:
            _kill_agent_process(proc)

    if code != 0 or (not completed and last_message is None):
        detail = ""
        if stderr.strip():
            detail = stderr.strip().splitlines()[-1]
        message = f"The codex CLI exited with code {code}."
        if detail:
            message = f"{message} {detail}"
        raise LocalAgentError(message)

    text_parts = [segment["text"] for segment in segments if segment["type"] == "text"]
    response_text = "\n\n".join(text_parts) or (last_message or "")

    yield {
        "type": "done",
        "result": {
            "response": response_text,
            "segments": segments,
            "model": model or "codex default",
            "durationMs": None,
            "costUsd": None,
            "sessionId": thread_id,
        },
    }


def _drain_agent_stream(stream: "Iterator[dict]") -> dict:
    result: dict | None = None
    for event in stream:
        if event.get("type") == "done":
            result = event.get("result")
    if result is None:
        raise LocalAgentError("The agent run produced no result.")
    return result


def _run_claude_agent(prompt: str, model: str) -> dict:
    return _drain_agent_stream(_stream_claude_agent(prompt, model))


def _run_codex_agent(prompt: str, model: str) -> dict:
    return _drain_agent_stream(_stream_codex_agent(prompt, model))


def _report_progress(progress: ProgressReporter | None, message: str) -> None:
    if progress is not None:
        progress(message)


def _new_local_session_id() -> str:
    return f"local-{uuid4().hex}"


def _build_local_payload_response(
    payload: AgentReviewPayload,
    *,
    session_id: str,
) -> tuple[bytes, dict[LocalFileKey, AgentReviewFile]]:
    manifest_payload, file_by_key = _build_local_payload_manifest(payload)
    payload_response = json.dumps(
        {
            "payload": manifest_payload,
            "sessionId": session_id,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    return payload_response, file_by_key


@dataclass
class _LocalReviewSessionState:
    session_id: str
    payload_response: bytes
    file_by_key: dict[LocalFileKey, AgentReviewFile]
    refresh_payload: RefreshPayload | None = None
    progress: ProgressReporter | None = None
    agent_backend: str = DEFAULT_AGENT_BACKEND
    agent_model: str = DEFAULT_AGENT_MODEL
    codex_model: str = DEFAULT_CODEX_MODEL
    _file_response_cache_by_key: dict[LocalFileKey, bytes] = field(default_factory=dict)
    _lock: Lock = field(default_factory=Lock)
    _agent_procs_by_run_key: dict[str, subprocess.Popen] = field(default_factory=dict)
    _cancelled_run_keys: set[str] = field(default_factory=set)

    def get_snapshot(self) -> tuple[str, bytes, dict[LocalFileKey, AgentReviewFile]]:
        with self._lock:
            return self.session_id, self.payload_response, self.file_by_key

    def get_file_response(self, segment_id: str, path: str) -> bytes | None:
        key = (segment_id, path)
        with self._lock:
            cached_response = self._file_response_cache_by_key.get(key)
            if cached_response is not None:
                return cached_response

            file = self.file_by_key.get(key)
            if file is None:
                return None

            response = json.dumps(
                _build_file_details_response(file),
                separators=(",", ":"),
            ).encode("utf-8")
            self._file_response_cache_by_key[key] = response
            return response

    def refresh(self) -> tuple[str, bytes]:
        if self.refresh_payload is None:
            raise LocalUiError("Refreshing is unavailable for this local review session.")

        with self._lock:
            _report_progress(self.progress, "Refreshing the local review payload.")
            payload = self.refresh_payload(self.progress)
            session_id = _new_local_session_id()
            payload_response, file_response_by_key = _build_local_payload_response(
                payload,
                session_id=session_id,
            )
            self.session_id = session_id
            self.payload_response = payload_response
            self.file_by_key = file_response_by_key
            self._file_response_cache_by_key = {}

        _report_progress(self.progress, "Local review refresh is ready.")
        return session_id, payload_response

    def stream_agent(
        self,
        prompt: str,
        resume_session_id: str | None = None,
        label: str | None = None,
        run_key: str | None = None,
    ) -> Iterator[dict]:
        run_id = uuid4().hex[:6]
        run_tag = f"[agent {run_id}]" + (f" {label}" if label else "")
        started = monotonic()

        def register_proc(proc: subprocess.Popen) -> None:
            if run_key is None:
                return
            with self._lock:
                # a cancel may have arrived before the process spawned
                if run_key in self._cancelled_run_keys:
                    _kill_agent_process(proc)
                self._agent_procs_by_run_key[run_key] = proc

        backend, claude_model, codex_model = self.get_agent_config()
        if backend == "codex":
            _report_progress(
                self.progress,
                f"{run_tag} Running codex exec with model {codex_model or 'codex default'}.",
            )
            # codex exec resume is not wired up yet; replies fall back to a
            # fresh run with the conversation embedded in the prompt.
            stream = _stream_codex_agent(prompt, codex_model, register_proc)
        else:
            _report_progress(
                self.progress,
                f"{run_tag} Running claude -p with model {claude_model}.",
            )
            stream = _stream_claude_agent(
                prompt, claude_model, resume_session_id, register_proc
            )

        try:
            yield from stream
        except Exception as exc:
            if run_key is not None and self._consume_cancellation(run_key):
                _report_progress(
                    self.progress,
                    f"{run_tag} The agent run was cancelled after {monotonic() - started:.1f}s.",
                )
                yield {"type": "cancelled"}
                return
            _report_progress(
                self.progress,
                f"{run_tag} The agent run failed after {monotonic() - started:.1f}s: {exc}",
            )
            raise
        finally:
            if run_key is not None:
                with self._lock:
                    self._agent_procs_by_run_key.pop(run_key, None)
                    self._cancelled_run_keys.discard(run_key)
        _report_progress(
            self.progress,
            f"{run_tag} The agent reply is ready ({monotonic() - started:.1f}s).",
        )

    def cancel_agent(self, run_key: str) -> bool:
        with self._lock:
            self._cancelled_run_keys.add(run_key)
            proc = self._agent_procs_by_run_key.get(run_key)
        if proc is None:
            return False
        _kill_agent_process(proc)
        return True

    def _consume_cancellation(self, run_key: str) -> bool:
        with self._lock:
            if run_key in self._cancelled_run_keys:
                self._cancelled_run_keys.discard(run_key)
                return True
            return False

    def run_agent(self, prompt: str) -> dict:
        return _drain_agent_stream(self.stream_agent(prompt))

    def get_agent_config(self) -> tuple[str, str, str]:
        with self._lock:
            return self.agent_backend, self.agent_model, self.codex_model

    def get_settings(self) -> dict:
        backend, claude_model, codex_model = self.get_agent_config()
        return {
            "agent": backend,
            "model": claude_model,
            "codexModel": codex_model,
            "defaultAgent": DEFAULT_AGENT_BACKEND,
            "defaultModel": DEFAULT_AGENT_MODEL,
            "defaultCodexModel": DEFAULT_CODEX_MODEL,
            "knownAgents": list(KNOWN_AGENT_BACKENDS),
            "knownModels": KNOWN_AGENT_MODELS,
            "knownCodexModels": KNOWN_CODEX_MODELS,
        }

    def update_settings(self, settings: dict) -> dict:
        model = settings.get("model")
        if not isinstance(model, str) or not model.strip():
            raise LocalUiError("Settings must include a non-empty model string.")

        backend = settings.get("agent", DEFAULT_AGENT_BACKEND)
        if not isinstance(backend, str) or backend.strip().lower() not in KNOWN_AGENT_BACKENDS:
            raise LocalUiError(
                f"Settings agent must be one of: {', '.join(KNOWN_AGENT_BACKENDS)}."
            )

        codex_model = settings.get("codexModel", "")
        if codex_model is None:
            codex_model = ""
        if not isinstance(codex_model, str):
            raise LocalUiError("Settings codexModel must be a string.")

        normalized_model = model.strip()
        normalized_backend = backend.strip().lower()
        normalized_codex_model = codex_model.strip() or DEFAULT_CODEX_MODEL
        with self._lock:
            self.agent_backend = normalized_backend
            self.agent_model = normalized_model
            self.codex_model = normalized_codex_model

        persisted = load_persisted_settings()
        persisted["agent"] = normalized_backend
        persisted["model"] = normalized_model
        persisted["codexModel"] = normalized_codex_model
        try:
            save_persisted_settings(persisted)
        except OSError as exc:
            raise LocalUiError(f"Failed to persist settings: {exc}") from exc

        active_model = (
            normalized_codex_model if normalized_backend == "codex" else normalized_model
        )
        _report_progress(
            self.progress,
            f"Inline agent set to {normalized_backend} with model {active_model}.",
        )
        return self.get_settings()


class _LocalUiRequestHandler(SimpleHTTPRequestHandler):
    def __init__(
        self,
        *args,
        directory: str,
        session_state: _LocalReviewSessionState,
        **kwargs,
    ) -> None:
        self._session_state = session_state
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self) -> None:
        if self._maybe_serve_payload(send_body=True):
            return
        if self._maybe_serve_file(send_body=True):
            return
        if self._maybe_serve_settings(method="GET"):
            return
        self._rewrite_static_path()
        super().do_GET()

    def do_HEAD(self) -> None:
        if self._maybe_serve_payload(send_body=False):
            return
        if self._maybe_serve_file(send_body=False):
            return
        self._rewrite_static_path()
        super().do_HEAD()

    def do_POST(self) -> None:
        if self._maybe_serve_refresh(send_body=True):
            return
        if self._maybe_serve_agent_cancel():
            return
        if self._maybe_serve_agent():
            return
        if self._maybe_serve_settings(method="POST"):
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args) -> None:
        return

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _maybe_serve_payload(self, *, send_body: bool) -> bool:
        split = urlsplit(self.path)
        if split.path != LOCAL_PAYLOAD_ENDPOINT:
            return False
        session_id, payload_response, _ = self._session_state.get_snapshot()
        if not self._is_valid_session_request(
            split.query,
            session_id=session_id,
            send_body=send_body,
        ):
            return True

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload_response)))
        self.end_headers()
        if send_body:
            self.wfile.write(payload_response)
        return True

    def _maybe_serve_file(self, *, send_body: bool) -> bool:
        split = urlsplit(self.path)
        if split.path != LOCAL_FILE_ENDPOINT:
            return False
        session_id, _, _ = self._session_state.get_snapshot()
        if not self._is_valid_session_request(
            split.query,
            session_id=session_id,
            send_body=send_body,
        ):
            return True

        query = parse_qs(split.query, keep_blank_values=True)
        segment_id = query.get("segmentId", [None])[0]
        path = query.get("path", [None])[0]
        if not segment_id or not path:
            self._send_json_error(
                HTTPStatus.BAD_REQUEST,
                "segmentId and path query parameters are required.",
                send_body=send_body,
            )
            return True

        response = self._session_state.get_file_response(segment_id, path)
        if response is None:
            self._send_json_error(
                HTTPStatus.NOT_FOUND,
                "Requested file contents were not found.",
                send_body=send_body,
            )
            return True

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        if send_body:
            self.wfile.write(response)
        return True

    def _maybe_serve_refresh(self, *, send_body: bool) -> bool:
        split = urlsplit(self.path)
        if split.path != LOCAL_REFRESH_ENDPOINT:
            return False

        session_id, _, _ = self._session_state.get_snapshot()
        if not self._is_valid_session_request(
            split.query,
            session_id=session_id,
            send_body=send_body,
        ):
            return True

        try:
            _, payload_response = self._session_state.refresh()
        except LocalUiError as exc:
            self._send_json_error(
                HTTPStatus.METHOD_NOT_ALLOWED,
                str(exc),
                send_body=send_body,
            )
            return True
        except Exception as exc:
            message = str(exc).strip() or "Failed to refresh the local review payload."
            self._send_json_error(
                HTTPStatus.BAD_REQUEST,
                message,
                send_body=send_body,
            )
            return True

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload_response)))
        self.end_headers()
        if send_body:
            self.wfile.write(payload_response)
        return True

    def _maybe_serve_agent(self) -> bool:
        split = urlsplit(self.path)
        if split.path != LOCAL_AGENT_ENDPOINT:
            return False

        session_id, _, _ = self._session_state.get_snapshot()
        if not self._is_valid_session_request(
            split.query,
            session_id=session_id,
            send_body=True,
        ):
            return True

        content_length = int(self.headers.get("Content-Length") or 0)
        if content_length <= 0 or content_length > AGENT_MAX_PROMPT_BYTES:
            self._send_json_error(
                HTTPStatus.BAD_REQUEST,
                "A JSON body with a prompt is required.",
                send_body=True,
            )
            return True

        try:
            body = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = None

        prompt = body.get("prompt") if isinstance(body, dict) else None
        if not isinstance(prompt, str) or not prompt.strip():
            self._send_json_error(
                HTTPStatus.BAD_REQUEST,
                "A JSON body with a non-empty prompt string is required.",
                send_body=True,
            )
            return True

        resume_session_id = body.get("resumeSessionId") if isinstance(body, dict) else None
        if not isinstance(resume_session_id, str) or not resume_session_id.strip():
            resume_session_id = None

        label = body.get("label") if isinstance(body, dict) else None
        if not isinstance(label, str) or not label.strip():
            label = None
        else:
            label = " ".join(label.split())[:120]

        run_key = body.get("runKey") if isinstance(body, dict) else None
        if not isinstance(run_key, str) or not run_key.strip():
            run_key = None
        else:
            run_key = run_key.strip()[:80]

        # Stream NDJSON: segment events as the agent produces them, then a
        # final done (or error) line. Errors after streaming begins can no
        # longer change the HTTP status, so they ride in the last line.
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.end_headers()

        def write_line(event: dict) -> None:
            self.wfile.write(json.dumps(event, separators=(",", ":")).encode("utf-8") + b"\n")
            self.wfile.flush()

        try:
            for event in self._session_state.stream_agent(
                prompt, resume_session_id, label, run_key
            ):
                write_line(event)
        except BrokenPipeError:
            pass
        except LocalAgentError as exc:
            error_message = str(exc)
            try:
                write_line({"type": "error", "error": error_message})
            except BrokenPipeError:
                pass
        except Exception as exc:
            error_message = str(exc).strip() or "The agent run failed."
            try:
                write_line({"type": "error", "error": error_message})
            except BrokenPipeError:
                pass
        return True

    def _maybe_serve_agent_cancel(self) -> bool:
        split = urlsplit(self.path)
        if split.path != LOCAL_AGENT_CANCEL_ENDPOINT:
            return False

        content_length = int(self.headers.get("Content-Length") or 0)
        body = None
        if 0 < content_length <= SETTINGS_MAX_BODY_BYTES:
            try:
                body = json.loads(self.rfile.read(content_length).decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                body = None

        run_key = body.get("runKey") if isinstance(body, dict) else None
        if not isinstance(run_key, str) or not run_key.strip():
            self._send_json_error(
                HTTPStatus.BAD_REQUEST,
                "A JSON body with a runKey string is required.",
                send_body=True,
            )
            return True

        cancelled = self._session_state.cancel_agent(run_key.strip()[:80])
        self._send_json(HTTPStatus.OK, {"cancelled": cancelled})
        return True

    def _maybe_serve_settings(self, *, method: str) -> bool:
        split = urlsplit(self.path)
        if split.path != LOCAL_SETTINGS_ENDPOINT:
            return False

        if method == "GET":
            self._send_json(HTTPStatus.OK, self._session_state.get_settings())
            return True

        content_length = int(self.headers.get("Content-Length") or 0)
        if content_length <= 0 or content_length > SETTINGS_MAX_BODY_BYTES:
            self._send_json_error(
                HTTPStatus.BAD_REQUEST,
                "A JSON settings body is required.",
                send_body=True,
            )
            return True

        try:
            body = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = None

        if not isinstance(body, dict):
            self._send_json_error(
                HTTPStatus.BAD_REQUEST,
                "A JSON settings object is required.",
                send_body=True,
            )
            return True

        try:
            settings = self._session_state.update_settings(body)
        except LocalUiError as exc:
            self._send_json_error(HTTPStatus.BAD_REQUEST, str(exc), send_body=True)
            return True

        self._send_json(HTTPStatus.OK, settings)
        return True

    def _send_json(self, status: HTTPStatus, payload: dict) -> None:
        response = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def _send_json_error(
        self,
        status: HTTPStatus,
        message: str,
        *,
        send_body: bool,
    ) -> None:
        payload = json.dumps({"error": message}, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if send_body:
            self.wfile.write(payload)

    def _is_valid_session_request(
        self,
        query_string: str,
        *,
        session_id: str,
        send_body: bool,
    ) -> bool:
        request_session_id = parse_qs(query_string, keep_blank_values=True).get(
            LOCAL_CACHE_BUSTER_QUERY_KEY,
            [None],
        )[0]
        if request_session_id is None or request_session_id == session_id:
            return True

        self._send_json_error(
            HTTPStatus.CONFLICT,
            "The local review session is stale. Use Refresh or rerun agentreview --local.",
            send_body=send_body,
        )
        return False

    def _rewrite_static_path(self) -> None:
        directory = Path(self.directory)
        split = urlsplit(self.path)
        request_path = unquote(split.path)
        resolved = _resolve_static_request_path(
            directory,
            request_path,
            prefer_flight_data="_rsc" in parse_qs(split.query, keep_blank_values=True),
        )
        if resolved is not None:
            self.path = f"/{resolved}"


def serve_local_review(
    payload: AgentReviewPayload,
    *,
    progress: ProgressReporter | None = None,
    refresh_payload: RefreshPayload | None = None,
    agent_model: str | None = None,
) -> None:
    _report_progress(progress, "Preparing local review UI assets.")
    archive_path = _find_packaged_site_archive()
    if archive_path is not None:
        _report_progress(progress, "Using bundled local UI assets.")
        with tempfile.TemporaryDirectory(prefix="agentreview-local-") as temp_dir:
            root_dir = Path(temp_dir)
            _report_progress(progress, "Extracting bundled local UI assets.")
            _extract_site_archive(archive_path, root_dir)
            _serve_static_site(
                payload,
                root_dir / "site",
                progress=progress,
                refresh_payload=refresh_payload,
                agent_model=agent_model,
            )
        return

    workspace_root = _find_workspace_root()
    if workspace_root is None:
        raise LocalUiError(
            "Unable to locate bundled local UI assets or an agentreview repository checkout."
        )

    _report_progress(progress, f"Building local UI assets from {workspace_root}.")
    site_dir = _build_workspace_site(workspace_root, progress=progress)
    _serve_static_site(
        payload,
        site_dir,
        progress=progress,
        refresh_payload=refresh_payload,
        agent_model=agent_model,
    )


def _serve_static_site(
    payload: AgentReviewPayload,
    site_dir: Path,
    *,
    progress: ProgressReporter | None = None,
    refresh_payload: RefreshPayload | None = None,
    agent_model: str | None = None,
) -> None:
    if not site_dir.is_dir():
        raise LocalUiError(f"Unable to locate local UI files at {site_dir}.")

    session_id = _new_local_session_id()
    _report_progress(progress, "Preparing the local review payload.")
    payload_response, file_by_key = _build_local_payload_response(
        payload,
        session_id=session_id,
    )
    session_state = _LocalReviewSessionState(
        session_id=session_id,
        payload_response=payload_response,
        file_by_key=file_by_key,
        refresh_payload=refresh_payload,
        progress=progress,
        agent_backend=get_default_agent_backend(),
        agent_model=(agent_model or "").strip() or get_default_agent_model(),
        codex_model=get_default_codex_model(),
    )

    handler = partial(
        _LocalUiRequestHandler,
        directory=str(site_dir),
        session_state=session_state,
    )
    _report_progress(progress, "Starting the local web server.")
    server = _start_http_server(handler)

    try:
        url = _get_local_review_url(
            server.server_address[1],
            cache_buster=session_id,
        )
        _report_progress(progress, f"Opening the browser at {url}.")
        print(f"Local review UI: {url}", file=sys.stderr)
        print("Press Ctrl-C to stop the local server.", file=sys.stderr)
        opened = webbrowser.open(url)
        if not opened:
            _report_progress(progress, "Browser launch failed. Use the printed URL instead.")
            print(f"Open this URL in your browser: {url}", file=sys.stderr)
        server.serve_forever(poll_interval=LOCAL_SERVER_POLL_INTERVAL_SECONDS)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def _start_http_server(handler: type[SimpleHTTPRequestHandler] | partial) -> ThreadingHTTPServer:
    listening_ports = _get_listening_process_ports() if os.environ.get(LOCAL_UI_BASE_URL_ENV) else set()
    for port in range(LOCAL_SERVER_START_PORT, 65536):
        if port in listening_ports:
            continue
        try:
            return ThreadingHTTPServer((LOCAL_SERVER_HOST, port), handler)
        except OSError as exc:
            if exc.errno == errno.EADDRINUSE:
                listening_ports.add(port)
                continue
            raise

    raise LocalUiError(
        f"Unable to find an open local port starting from {LOCAL_SERVER_START_PORT}."
    )


def _has_listening_process_on_port(port: int) -> bool:
    return port in _get_listening_process_ports()


def _get_listening_process_ports() -> set[int]:
    if shutil.which("ss") is not None:
        return _parse_listening_ports_from_ss()

    if shutil.which("lsof") is not None:
        return _parse_listening_ports_from_lsof()

    if shutil.which("netstat") is not None:
        return _parse_listening_ports_from_netstat()

    return set()


def _parse_listening_ports_from_ss() -> set[int]:
    return _parse_listening_ports_from_command(
        ["ss", "-ltnH"],
        parser=_parse_ss_listening_ports,
    )


def _parse_listening_ports_from_lsof() -> set[int]:
    return _parse_listening_ports_from_command(
        ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "n"],
        parser=_parse_lsof_listening_ports,
    )


def _parse_listening_ports_from_netstat() -> set[int]:
    return _parse_listening_ports_from_command(
        ["netstat", "-an"],
        parser=_parse_netstat_listening_ports,
    )


def _parse_listening_ports_from_command(
    command: list[str],
    *,
    parser: Callable[[str], set[int]],
) -> set[int]:
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 and result.returncode != 1:
        return set()
    return parser(result.stdout)


def _parse_ss_listening_ports(output: str) -> set[int]:
    ports: set[int] = set()
    for line in output.splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        port = _extract_port_from_socket_address(fields[3])
        if port is not None:
            ports.add(port)
    return ports


def _parse_lsof_listening_ports(output: str) -> set[int]:
    ports: set[int] = set()
    for line in output.splitlines():
        if not line.startswith("n"):
            continue
        port = _extract_port_from_socket_address(line[1:])
        if port is not None:
            ports.add(port)
    return ports


def _parse_netstat_listening_ports(output: str) -> set[int]:
    ports: set[int] = set()
    for line in output.splitlines():
        upper_line = line.upper()
        if "LISTEN" not in upper_line:
            continue
        fields = line.split()
        if len(fields) < 4:
            continue
        port = _extract_port_from_socket_address(fields[3])
        if port is not None:
            ports.add(port)
    return ports


def _extract_port_from_socket_address(address: str) -> int | None:
    match = re.search(r"(?:[:.])(\d+)$", address.strip())
    if match is None:
        return None
    return int(match.group(1))


def _get_local_review_url(port: int, *, cache_buster: str | None = None) -> str:
    query = ""
    if cache_buster:
        query = urlencode([(LOCAL_CACHE_BUSTER_QUERY_KEY, cache_buster)])

    base_url = os.environ.get(LOCAL_UI_BASE_URL_ENV)
    if not base_url:
        return urlunsplit(
            ("http", f"{LOCAL_SERVER_HOST}:{port}", LOCAL_REVIEW_PATH, query, "")
        )

    split = urlsplit(base_url)
    if not split.scheme or not split.netloc:
        raise LocalUiError(
            f"{LOCAL_UI_BASE_URL_ENV} must be a full URL like http://example.com."
        )

    hostname = split.hostname
    if hostname is None:
        raise LocalUiError(
            f"{LOCAL_UI_BASE_URL_ENV} must include a hostname like http://example.com."
        )

    host = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname

    userinfo = ""
    if split.username:
        userinfo = split.username
        if split.password:
            userinfo += f":{split.password}"
        userinfo += "@"

    netloc = f"{userinfo}{host}:{port}"
    base_path = split.path.rstrip("/")
    next_query_items = parse_qsl(split.query, keep_blank_values=True)
    if cache_buster:
        next_query_items.append((LOCAL_CACHE_BUSTER_QUERY_KEY, cache_buster))
    next_query = urlencode(next_query_items)
    return urlunsplit(
        (split.scheme, netloc, f"{base_path}{LOCAL_REVIEW_PATH}", next_query, "")
    )


def _find_packaged_site_archive() -> Path | None:
    archive_path = Path(__file__).with_name(LOCAL_UI_ARCHIVE_NAME)
    return archive_path if archive_path.is_file() else None


def _extract_site_archive(archive_path: Path, destination: Path) -> None:
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(destination)


def _build_local_payload_manifest(
    payload: AgentReviewPayload,
) -> tuple[dict, dict[LocalFileKey, AgentReviewFile]]:
    manifest = {
        "version": payload.version,
        "meta": payload.meta.to_dict() if payload.meta else {},
        "files": [],
    }
    file_by_key: dict[LocalFileKey, AgentReviewFile] = {}

    if payload.segments:
        manifest["segments"] = [
            _build_local_segment_manifest(segment, file_by_key)
            for segment in payload.segments
        ]
        return manifest, file_by_key

    manifest["files"] = [
        _build_local_file_manifest(
            LOCAL_FALLBACK_SEGMENT_ID,
            file,
            file_by_key,
        )
        for file in payload.files
    ]
    return manifest, file_by_key


def _build_local_segment_manifest(
    segment,
    file_by_key: dict[LocalFileKey, AgentReviewFile],
) -> dict:
    manifest = {
        "id": segment.id,
        "label": segment.label,
        "kind": segment.kind,
        "files": [
            _build_local_file_manifest(segment.id, file, file_by_key)
            for file in segment.files
        ],
    }
    if segment.commit_hash is not None:
        manifest["commitHash"] = segment.commit_hash
    if segment.commit_message is not None:
        manifest["commitMessage"] = segment.commit_message
    return manifest


def _build_local_file_manifest(
    segment_id: str,
    file,
    file_by_key: dict[LocalFileKey, AgentReviewFile],
) -> dict:
    file_by_key[(segment_id, file.path)] = file
    manifest = {
        "path": file.path,
        "status": file.status,
        "diff": file.diff,
    }
    if file.language is not None:
        manifest["language"] = file.language
    return manifest


def _build_file_details_response(file) -> dict:
    response: dict = {}
    if file.source is not None:
        response["source"] = file.source
    if file.old_source is not None:
        response["oldSource"] = file.old_source
    return response


def _resolve_static_request_path(
    directory: Path,
    request_path: str,
    *,
    prefer_flight_data: bool = False,
) -> str | None:
    normalized = request_path.rstrip("/") or "/"
    relative = normalized.lstrip("/")
    candidates: list[str] = []

    if not relative:
        if prefer_flight_data:
            candidates.append("index.txt")
        candidates.append("index.html")
    else:
        candidates.append(relative)
        if "." not in Path(relative).name:
            route_candidates: list[str] = []
            if prefer_flight_data:
                route_candidates.extend([f"{relative}.txt", f"{relative}/index.txt"])
            route_candidates.extend([f"{relative}.html", f"{relative}/index.html"])
            candidates = [*route_candidates, *candidates]

    for candidate in candidates:
        if (directory / candidate).is_file():
            return candidate

    return None


def _build_workspace_site(
    workspace_root: Path,
    *,
    progress: ProgressReporter | None = None,
) -> Path:
    if shutil.which("pnpm") is None:
        raise LocalUiError("Unable to find `pnpm` in PATH. Install pnpm to use --local from a checkout.")

    web_dir = workspace_root / "packages" / "web"
    if not (web_dir / "package.json").is_file():
        raise LocalUiError(f"Unable to locate the web app at {web_dir}.")

    _report_progress(progress, "Cleaning any previous local UI build output.")
    shutil.rmtree(web_dir / ".next", ignore_errors=True)
    shutil.rmtree(web_dir / "out", ignore_errors=True)
    _report_progress(progress, "Running the web build for the local UI.")
    subprocess.run(
        ["pnpm", "--dir", str(workspace_root), "--filter", "@agentreview/web", "build"],
        check=True,
    )
    site_dir = web_dir / "out"
    if not site_dir.is_dir():
        raise LocalUiError(f"Expected static local UI output at {site_dir}.")
    _report_progress(progress, "Local UI assets are ready.")
    return site_dir


def _find_workspace_root() -> Path | None:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "pnpm-workspace.yaml").is_file() and (
            parent / "packages" / "web" / "package.json"
        ).is_file():
            return parent
    return None
