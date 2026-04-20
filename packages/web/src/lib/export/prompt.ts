import {
  getPayloadSegments,
  type AgentReviewPayload,
  type AgentReviewSegment,
} from "@/lib/payload/types";
import {
  type ReviewComment,
  formatReviewCommentRange,
  getCommentFileId,
  getCommentEndLine,
  getCommentLineContents,
  getCommentStartLine,
  isLineComment,
  isSegmentComment,
} from "@/lib/comments/types";

function getExportSegmentLabel(segment: {
  kind: string;
  label: string;
  commitHash?: string;
  commitMessage?: string;
}): string {
  if (segment.kind === "commit") {
    return segment.commitHash ? `Commit ${segment.commitHash}` : segment.label;
  }
  return segment.label;
}

function getSegmentCommentSectionTitle(segmentId: string): string {
  return segmentId.startsWith("commit:") ? "Commit comments" : "Segment comments";
}

function getFullCommitHash(segmentId: string | undefined): string | null {
  if (!segmentId || !segmentId.startsWith("commit:")) {
    return null;
  }

  const fullHash = segmentId.slice("commit:".length).trim();
  return fullHash.length > 0 ? fullHash : null;
}

function getCommentProvenance(
  comment: ReviewComment,
  segmentId: string,
  segment: AgentReviewSegment | undefined,
  fallbackLabel: string
): { label: string; value: string } {
  const commitHash = comment.commitHash || segment?.commitHash || getFullCommitHash(segmentId);

  if (commitHash) {
    return {
      label: "Amend target",
      value: `Commit ${commitHash}`,
    };
  }

  if (segment?.kind === "uncommitted" || segmentId === "uncommitted") {
    return { label: "Apply in", value: "Uncommitted changes" };
  }

  return { label: "Scope", value: fallbackLabel };
}

function shouldRenderSegmentHeader(
  segmentId: string,
  segment: AgentReviewSegment | undefined,
  sortedSegmentCount: number,
  defaultSegmentId: string | undefined
): boolean {
  if (sortedSegmentCount > 1 || segmentId !== defaultSegmentId) {
    return true;
  }

  return segment?.kind === "commit" || segment?.kind === "uncommitted";
}

function isCommentProvenanceRedundant(
  comment: ReviewComment,
  segmentId: string,
  segment: AgentReviewSegment | undefined
): boolean {
  if (!segment) {
    return false;
  }

  const commentCommitHash = comment.commitHash || getFullCommitHash(comment.segmentId || segmentId);
  const segmentCommitHash = segment.commitHash || getFullCommitHash(segmentId);

  if (segment.kind === "commit") {
    return commentCommitHash === segmentCommitHash;
  }

  if (segment.kind === "uncommitted") {
    return !commentCommitHash;
  }

  return false;
}

export function generateExportPrompt(
  payload: AgentReviewPayload,
  comments: ReviewComment[]
): string {
  if (comments.length === 0) {
    return "No comments to export.";
  }

  const { repo, branch } = payload.meta;
  const segments = getPayloadSegments(payload);
  const defaultSegmentId = segments[0]?.id;
  const segmentOrder = new Map(segments.map((segment, index) => [segment.id, index]));
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const segmentLabels = new Map(
    segments.map((segment) => [segment.id, getExportSegmentLabel(segment)])
  );
  const lineComments = comments.filter(isLineComment);
  const segmentCommentsCount = comments.filter(isSegmentComment).length;
  const uniqueFileCount = new Set(
    lineComments
      .map((comment) => getCommentFileId(comment))
      .filter((fileId): fileId is string => typeof fileId === "string")
  ).size;

  const bySegment = new Map<
    string,
    {
      label: string;
      segmentComments: ReviewComment[];
      files: Map<string, { filePath: string; comments: ReviewComment[] }>;
    }
  >();

  for (const comment of comments) {
    const segmentId = comment.segmentId || defaultSegmentId || "all-changes";
    const segmentLabel =
      segmentLabels.get(segmentId) || comment.segmentLabel || "All changes";
    const segmentEntry = bySegment.get(segmentId) || {
      label: segmentLabel,
      segmentComments: [],
      files: new Map<string, { filePath: string; comments: ReviewComment[] }>(),
    };

    if (isSegmentComment(comment)) {
      segmentEntry.segmentComments.push(comment);
      bySegment.set(segmentId, segmentEntry);
      continue;
    }

    const fileId = getCommentFileId(comment);
    if (!fileId) {
      bySegment.set(segmentId, segmentEntry);
      continue;
    }

    const fileEntry = segmentEntry.files.get(fileId) || {
      filePath: comment.filePath || "Unknown file",
      comments: [],
    };
    fileEntry.comments.push(comment);
    segmentEntry.files.set(fileId, fileEntry);
    bySegment.set(segmentId, segmentEntry);
  }

  const lines: string[] = [
    `# Code Review Comments for ${repo} (branch: ${branch})`,
    "",
    "---",
  ];

  const sortedSegments = [...bySegment.entries()].sort(
    ([leftId], [rightId]) =>
      (segmentOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
      (segmentOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER)
  );

  for (const [segmentId, segmentEntry] of sortedSegments) {
    const segment = segmentById.get(segmentId);
    const renderSegmentHeader = shouldRenderSegmentHeader(
      segmentId,
      segment,
      sortedSegments.length,
      defaultSegmentId
    );

    if (renderSegmentHeader) {
      lines.push("", `## ${segmentEntry.label}`);
    }

    if (segmentEntry.segmentComments.length > 0) {
      lines.push("", `### ${getSegmentCommentSectionTitle(segmentId)}`);
      for (const comment of segmentEntry.segmentComments) {
        const showProvenance =
          !renderSegmentHeader ||
          !isCommentProvenanceRedundant(comment, segmentId, segment);
        lines.push("", `#### ${formatReviewCommentRange(comment)}:`);
        if (showProvenance) {
          const provenance = getCommentProvenance(
            comment,
            segmentId,
            segment,
            segmentEntry.label
          );
          lines.push("", `**${provenance.label}:** ${provenance.value}`);
        }
        lines.push("", `**Comment:** ${comment.body}`);
      }
    }

    for (const { filePath, comments: fileComments } of segmentEntry.files.values()) {
      lines.push("", `### File: ${filePath}`);
      const sorted = [...fileComments].sort(
        (a, b) =>
          getCommentStartLine(a) - getCommentStartLine(b) ||
          getCommentEndLine(a) - getCommentEndLine(b)
      );
      for (const comment of sorted) {
        const showProvenance =
          !renderSegmentHeader ||
          !isCommentProvenanceRedundant(comment, segmentId, segment);
        lines.push("", `#### ${formatReviewCommentRange(comment)}:`);
        if (showProvenance) {
          const provenance = getCommentProvenance(
            comment,
            segmentId,
            segment,
            segmentEntry.label
          );
          lines.push("", `**${provenance.label}:** ${provenance.value}`);
        }
        lines.push(...getCommentLineContents(comment).map((line) => `> ${line}`));
        lines.push("", `**Comment:** ${comment.body}`);
      }
    }

    lines.push("", "---");
  }

  lines.push(
    "",
    "## Summary",
    `- ${comments.length} comment${comments.length === 1 ? "" : "s"} across ${uniqueFileCount} file${uniqueFileCount === 1 ? "" : "s"}${segmentCommentsCount > 0 ? `, including ${segmentCommentsCount} segment-level comment${segmentCommentsCount === 1 ? "" : "s"}` : ""}`
  );

  return lines.join("\n");
}
