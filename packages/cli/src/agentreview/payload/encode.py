from __future__ import annotations

import base64
import io
import json
from typing import TextIO

from .types import AgentReviewPayload

HEADER = "===AGENTREVIEW:v1==="
FOOTER = "===END:AGENTREVIEW==="


class _WrappedBase64Writer:
    def __init__(self, output: TextIO, *, width: int = 76) -> None:
        self.output = output
        self.width = width
        self._carry = b""
        self._line_length = 0

    def write_text(self, chunk: str) -> None:
        self.write_bytes(chunk.encode())

    def write_bytes(self, chunk: bytes) -> None:
        if not chunk:
            return

        data = self._carry + chunk
        complete_length = (len(data) // 3) * 3
        if complete_length:
            encoded = base64.b64encode(data[:complete_length]).decode("ascii")
            self._write_wrapped(encoded)
        self._carry = data[complete_length:]

    def finish(self) -> None:
        if self._carry:
            encoded = base64.b64encode(self._carry).decode("ascii")
            self._write_wrapped(encoded)
            self._carry = b""

        if self._line_length:
            self.output.write("\n")
            self._line_length = 0

    def _write_wrapped(self, encoded: str) -> None:
        cursor = 0
        while cursor < len(encoded):
            remaining = self.width - self._line_length
            part = encoded[cursor : cursor + remaining]
            self.output.write(part)
            self._line_length += len(part)
            cursor += len(part)
            if self._line_length == self.width:
                self.output.write("\n")
                self._line_length = 0


def _iter_payload_json(payload: AgentReviewPayload):
    yield '{"version":'
    yield str(payload.version)
    yield ',"meta":'
    yield json.dumps(payload.meta.to_dict() if payload.meta else {}, separators=(",", ":"))
    yield ',"files":['

    for index, file in enumerate(payload.files):
        if index:
            yield ","
        yield json.dumps(file.to_dict(), separators=(",", ":"))

    yield "]"

    if payload.segments:
        yield ',"segments":['

        for index, segment in enumerate(payload.segments):
            if index:
                yield ","
            yield json.dumps(segment.to_dict(), separators=(",", ":"))

        yield "]"

    yield "}"


def write_payload(payload: AgentReviewPayload, output: TextIO) -> None:
    output.write(f"{HEADER}\n")
    writer = _WrappedBase64Writer(output)
    for chunk in _iter_payload_json(payload):
        writer.write_text(chunk)
    writer.finish()
    output.write(FOOTER)


def encode_payload(payload: AgentReviewPayload) -> str:
    output = io.StringIO()
    write_payload(payload, output)
    return output.getvalue()
