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
import shutil
import subprocess
import sys
import tarfile
import tempfile
from threading import Lock
from typing import Callable
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
LOCAL_UI_ARCHIVE_NAME = "local_ui_assets.tar.gz"
LOCAL_UI_BASE_URL_ENV = "BASE_URL"
LOCAL_FALLBACK_SEGMENT_ID = "all-changes"
LOCAL_CACHE_BUSTER_QUERY_KEY = "agentreviewSession"
ProgressReporter = Callable[[str], None]
RefreshPayload = Callable[[ProgressReporter | None], AgentReviewPayload]
LocalFileKey = tuple[str, str]


class LocalUiError(RuntimeError):
    pass


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
    _file_response_cache_by_key: dict[LocalFileKey, bytes] = field(default_factory=dict)
    _lock: Lock = field(default_factory=Lock)

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
    )


def _serve_static_site(
    payload: AgentReviewPayload,
    site_dir: Path,
    *,
    progress: ProgressReporter | None = None,
    refresh_payload: RefreshPayload | None = None,
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
