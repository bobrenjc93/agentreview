const HEADER = "===AGENTREVIEW:v1===";
const FOOTER = "===END:AGENTREVIEW===";

export function decodePayload(raw: string): unknown {
  const trimmed = raw.trim();

  const headerIdx = trimmed.indexOf(HEADER);
  const footerIdx = trimmed.indexOf(FOOTER);

  if (headerIdx === -1 || footerIdx === -1) {
    throw new Error(
      "Invalid payload: missing delimiters. Expected ===AGENTREVIEW:v1=== ... ===END:AGENTREVIEW==="
    );
  }

  const b64 = trimmed
    .slice(headerIdx + HEADER.length, footerIdx)
    .replace(/\s/g, "");

  if (!b64) {
    throw new Error("Invalid payload: empty content between delimiters");
  }

  try {
    const json = atob(b64);
    return JSON.parse(json);
  } catch {
    throw new Error("Invalid payload: failed to decode base64 or parse JSON");
  }
}
