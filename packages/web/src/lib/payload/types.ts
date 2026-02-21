export interface AgentReviewPayload {
  version: 1;
  meta: {
    repo: string;
    branch: string;
    baseBranch?: string;
    commitHash: string;
    commitMessage: string;
    timestamp: string;
    diffMode: "default" | "staged" | "branch";
  };
  files: AgentReviewFile[];
}

export interface AgentReviewFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  diff: string;
  source?: string;
  language?: string;
}
