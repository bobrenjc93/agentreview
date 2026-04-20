export interface AgentReviewPayload {
  version: 1;
  meta: {
    repo: string;
    branch: string;
    baseBranch?: string;
    baseCommit?: string;
    commitHash: string;
    commitMessage: string;
    timestamp: string;
    diffMode: "default" | "staged" | "branch" | "commit";
  };
  files: AgentReviewFile[];
  segments?: AgentReviewSegment[];
}

export interface AgentReviewFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  diff: string;
  source?: string;
  oldSource?: string;
  language?: string;
}

export interface AgentReviewSegment {
  id: string;
  label: string;
  kind: "all" | "commit" | "uncommitted";
  commitHash?: string;
  commitMessage?: string;
  files: AgentReviewFile[];
}

function getFallbackSegmentLabel(payload: AgentReviewPayload): string {
  switch (payload.meta.diffMode) {
    case "staged":
      return "Staged changes";
    case "branch":
      return payload.meta.baseBranch
        ? `All changes since ${payload.meta.baseBranch}`
        : "Branch changes";
    case "commit":
      return payload.meta.baseCommit
        ? `All changes since ${payload.meta.baseCommit}`
        : "Commit changes";
    case "default":
    default:
      return "Uncommitted changes";
  }
}

export function getPayloadSegments(payload: AgentReviewPayload): AgentReviewSegment[] {
  if (payload.segments && payload.segments.length > 0) {
    return payload.segments;
  }

  const kind: AgentReviewSegment["kind"] =
    payload.meta.diffMode === "default" ? "uncommitted" : "all";

  return [
    {
      id: "all-changes",
      label: getFallbackSegmentLabel(payload),
      kind,
      files: payload.files,
    },
  ];
}

export function getSegmentFileId(segmentId: string, filePath: string): string {
  return `${segmentId}::${filePath}`;
}
