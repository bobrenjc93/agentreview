import {
  getPayloadSegments,
  type AgentReviewPayload,
  type AgentReviewSegment,
} from "@/lib/payload/types";

function getSegmentExportLabel(segment: AgentReviewSegment): string {
  if (segment.kind === "commit") {
    return segment.commitHash ? `Commit ${segment.commitHash}` : segment.label;
  }

  if (segment.kind === "uncommitted") {
    return "Uncommitted changes";
  }

  return segment.label;
}

function getDiffChunks(diffs: string[]): string[] {
  return diffs.map((diff) => diff.trimEnd()).filter((chunk) => chunk.length > 0);
}

export function generateExportDiff(payload: AgentReviewPayload): string {
  if (payload.segments && payload.segments.length > 0) {
    const segments = getPayloadSegments(payload);
    const includeHeaders = segments.length > 1;
    const sections = segments
      .map((segment) => {
        const chunks = getDiffChunks(segment.files.map((file) => file.diff));
        if (chunks.length === 0) {
          return null;
        }

        const body = chunks.join("\n\n");
        if (!includeHeaders) {
          return body;
        }

        return `## ${getSegmentExportLabel(segment)}\n\n${body}`;
      })
      .filter((section): section is string => section !== null);

    if (sections.length === 0) {
      return "No diff to export.";
    }

    return `${sections.join("\n\n")}\n`;
  }

  const chunks = getDiffChunks(payload.files.map((file) => file.diff));

  if (chunks.length === 0) {
    return "No diff to export.";
  }

  return `${chunks.join("\n\n")}\n`;
}
