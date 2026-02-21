import { type AgentReviewPayload } from "./types";

interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validatePayload(data: unknown): ValidationResult {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Payload must be an object" };
  }

  const obj = data as Record<string, unknown>;

  if (obj.version !== 1) {
    return { valid: false, error: `Unsupported payload version: ${obj.version}` };
  }

  if (!obj.meta || typeof obj.meta !== "object") {
    return { valid: false, error: "Missing or invalid 'meta' field" };
  }

  if (!Array.isArray(obj.files)) {
    return { valid: false, error: "Missing or invalid 'files' field" };
  }

  if (obj.files.length === 0) {
    return { valid: false, error: "Payload contains no files" };
  }

  for (const file of obj.files) {
    if (!file.path || typeof file.path !== "string") {
      return { valid: false, error: "Each file must have a 'path' string" };
    }
    if (!file.diff || typeof file.diff !== "string") {
      return { valid: false, error: `File '${file.path}' is missing a 'diff' string` };
    }
  }

  return { valid: true };
}

export function asPayload(data: unknown): AgentReviewPayload {
  const result = validatePayload(data);
  if (!result.valid) {
    throw new Error(result.error);
  }
  return data as AgentReviewPayload;
}
