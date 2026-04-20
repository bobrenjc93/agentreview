import { type AgentReviewPayload } from "./types";

interface ValidationResult {
  valid: boolean;
  error?: string;
}

function validateFiles(files: unknown[], scope: string): ValidationResult {
  for (const file of files) {
    if (!file || typeof file !== "object") {
      return { valid: false, error: `${scope} contains an invalid file entry` };
    }

    const typedFile = file as Record<string, unknown>;
    if (!typedFile.path || typeof typedFile.path !== "string") {
      return { valid: false, error: `${scope} contains a file without a 'path' string` };
    }
    if (!typedFile.diff || typeof typedFile.diff !== "string") {
      return {
        valid: false,
        error: `${scope} contains file '${typedFile.path}' without a 'diff' string`,
      };
    }
  }

  return { valid: true };
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

  const hasSegments = Array.isArray(obj.segments) && obj.segments.length > 0;

  if (obj.files.length === 0 && !hasSegments) {
    return { valid: false, error: "Payload contains no files" };
  }

  if (obj.files.length > 0) {
    const fileValidation = validateFiles(obj.files, "Payload");
    if (!fileValidation.valid) {
      return fileValidation;
    }
  }

  if (obj.segments != null) {
    if (!Array.isArray(obj.segments)) {
      return { valid: false, error: "Invalid 'segments' field" };
    }

    for (const segment of obj.segments) {
      if (!segment || typeof segment !== "object") {
        return { valid: false, error: "Each segment must be an object" };
      }

      const typedSegment = segment as Record<string, unknown>;
      if (!typedSegment.id || typeof typedSegment.id !== "string") {
        return { valid: false, error: "Each segment must have an 'id' string" };
      }
      if (!typedSegment.label || typeof typedSegment.label !== "string") {
        return { valid: false, error: `Segment '${typedSegment.id}' is missing a 'label' string` };
      }
      if (
        typedSegment.kind !== "all" &&
        typedSegment.kind !== "commit" &&
        typedSegment.kind !== "uncommitted"
      ) {
        return { valid: false, error: `Segment '${typedSegment.id}' has an invalid 'kind'` };
      }
      if (!Array.isArray(typedSegment.files)) {
        return { valid: false, error: `Segment '${typedSegment.id}' is missing a 'files' array` };
      }

      const segmentFileValidation = validateFiles(
        typedSegment.files,
        `Segment '${typedSegment.id}'`
      );
      if (!segmentFileValidation.valid) {
        return segmentFileValidation;
      }
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
