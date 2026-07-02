import {
  type ReviewComment,
  formatReviewCommentRange,
  getCommentLineContents,
  isSegmentComment,
} from "./types";

export interface AgentReplySegment {
  type: "text" | "tool";
  text?: string;
  name?: string;
  detail?: string;
}

export interface AgentReplyResult {
  response: string;
  segments?: AgentReplySegment[];
  model?: string;
  durationMs?: number;
  costUsd?: number;
}

export function isAgentReplySegment(value: unknown): value is AgentReplySegment {
  if (!value || typeof value !== "object") return false;
  const segment = value as AgentReplySegment;
  if (segment.type === "text") return typeof segment.text === "string";
  if (segment.type === "tool") return typeof segment.name === "string";
  return false;
}

export type RunAgent = (prompt: string) => Promise<AgentReplyResult>;

const MAX_AGENT_CONTEXT_CHARS = 48_000;

function truncateAgentContext(context: string): string {
  if (context.length <= MAX_AGENT_CONTEXT_CHARS) {
    return context;
  }
  return `${context.slice(0, MAX_AGENT_CONTEXT_CHARS)}\n… (diff truncated)`;
}

export function buildAgentPrompt(
  comment: ReviewComment,
  diffContext?: string
): string {
  const sections: string[] = [
    "You are assisting with a code review. A reviewer left a comment and expects a direct, concise reply.",
  ];

  if (isSegmentComment(comment)) {
    const scope =
      comment.commitHash != null
        ? `Commit ${comment.commitHash}${comment.commitMessage ? ` — ${comment.commitMessage}` : ""}`
        : comment.segmentLabel || "the current change set";
    sections.push(`The comment applies to: ${scope}`);
  } else {
    sections.push(
      `File: ${comment.filePath ?? "unknown"} (${formatReviewCommentRange(comment)})`
    );
    const lineContents = getCommentLineContents(comment).join("\n");
    if (lineContents.trim().length > 0) {
      sections.push(`Selected lines:\n\`\`\`\n${lineContents}\n\`\`\``);
    }
  }

  if (diffContext && diffContext.trim().length > 0) {
    sections.push(
      `Diff under review:\n\`\`\`diff\n${truncateAgentContext(diffContext)}\n\`\`\``
    );
  }

  sections.push(
    `Reviewer comment:\n${comment.body}`,
    "You are running inside the repository being reviewed, so you may read files for additional context. " +
      "Reply to the reviewer's comment directly. If they ask a question, answer it; if they point out a problem, " +
      "assess it and suggest a fix. Keep the reply short and to the point."
  );

  return sections.join("\n\n");
}
