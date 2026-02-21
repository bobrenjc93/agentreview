from __future__ import annotations

import base64
import json
import textwrap

from .types import AgentReviewPayload

HEADER = "===AGENTREVIEW:v1==="
FOOTER = "===END:AGENTREVIEW==="


def encode_payload(payload: AgentReviewPayload) -> str:
    raw_json = json.dumps(payload.to_dict(), separators=(",", ":"))
    b64 = base64.b64encode(raw_json.encode()).decode()
    wrapped = "\n".join(textwrap.wrap(b64, width=76))
    return f"{HEADER}\n{wrapped}\n{FOOTER}"
