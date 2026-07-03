import {
  type CommentAgentExchange,
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
  sessionId?: string;
  /** True when the run was cancelled by the user rather than completing. */
  cancelled?: boolean;
}

export function isAgentReplySegment(value: unknown): value is AgentReplySegment {
  if (!value || typeof value !== "object") return false;
  const segment = value as AgentReplySegment;
  if (segment.type === "text") return typeof segment.text === "string";
  if (segment.type === "tool") return typeof segment.name === "string";
  return false;
}

export interface RunAgentOptions {
  /** Continue a prior claude session so follow-ups keep their context. */
  resumeSessionId?: string;
  /** Called with each segment as the agent produces it. */
  onSegment?: (segment: AgentReplySegment) => void;
  /** Short human-readable run description, shown in the CLI's progress logs. */
  label?: string;
  /** Client-chosen token identifying this run so it can be cancelled. */
  runKey?: string;
}

export type CancelAgent = (runKey: string) => Promise<boolean>;

export function buildAgentRunLabel(
  comment: ReviewComment,
  kind: "comment" | "reply" = "comment"
): string {
  const location = isSegmentComment(comment)
    ? comment.segmentLabel || "segment"
    : `${comment.filePath ?? "file"} (${formatReviewCommentRange(comment)})`;
  return kind === "reply" ? `reply on ${location}` : location;
}

export type RunAgent = (
  prompt: string,
  options?: RunAgentOptions
) => Promise<AgentReplyResult>;

const MAX_AGENT_CONTEXT_CHARS = 48_000;

function truncateAgentContext(context: string): string {
  if (context.length <= MAX_AGENT_CONTEXT_CHARS) {
    return context;
  }
  return `${context.slice(0, MAX_AGENT_CONTEXT_CHARS)}\n… (diff truncated)`;
}

const AGENT_ACTION_INSTRUCTIONS =
  "You are running inside the repository being reviewed, with full permission to read and edit files.\n" +
  "- If the comment asks for a change (rewrite, simplify, rename, fix, remove, add, refactor, ...), " +
  "MAKE THE EDIT NOW with your file-editing tools, then reply summarizing what you changed. " +
  "Never answer with what you *would* do or promise future work — 'I'll simplify this' without an " +
  "edit is a failed task. Your reply must describe edits you already made.\n" +
  "- If the comment is purely a question, answer it directly.\n" +
  "- If you genuinely cannot make the change, say so explicitly and explain why.\n" +
  "Keep the reply short and to the point.";

export function buildAgentPrompt(
  comment: ReviewComment,
  diffContext?: string
): string {
  const sections: string[] = [
    "You are acting on a code review comment inside the repository it refers to.",
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

  sections.push(`Reviewer comment:\n${comment.body}`, AGENT_ACTION_INSTRUCTIONS);

  return sections.join("\n\n");
}

/**
 * Prompt for a follow-up reply in an existing thread. When the agent session
 * can be resumed (claude --resume) only the new question is needed; otherwise
 * the prior conversation is replayed inline.
 */
export function buildFollowUpPrompt(
  comment: ReviewComment,
  question: string,
  options: { canResume: boolean; diffContext?: string }
): string {
  if (options.canResume) {
    return (
      `The reviewer replied to your last answer:\n\n${question}\n\n` +
      "If this asks for a change, make the edit now with your file-editing tools and reply " +
      "summarizing what you changed — do not merely promise to do it. Otherwise answer directly and concisely."
    );
  }

  const sections: string[] = [buildAgentPrompt(comment, options.diffContext)];

  if (comment.agentReply) {
    sections.push(`You previously replied:\n${comment.agentReply}`);
  }
  for (const exchange of comment.agentReplies ?? []) {
    if (exchange.status !== "done") continue;
    sections.push(`The reviewer then said:\n${exchange.question}`);
    if (exchange.reply) {
      sections.push(`You replied:\n${exchange.reply}`);
    }
  }

  sections.push(`The reviewer now replies:\n${question}`, AGENT_ACTION_INSTRUCTIONS);

  return sections.join("\n\n");
}

export type { CommentAgentExchange };
