import { type AgentReviewPayload } from "@/lib/payload/types";
import {
  type ReviewComment,
  formatReviewCommentRange,
  getCommentEndLine,
  getCommentLineContents,
  getCommentStartLine,
} from "@/lib/comments/types";

export function generateExportPrompt(
  payload: AgentReviewPayload,
  comments: ReviewComment[]
): string {
  if (comments.length === 0) {
    return "No comments to export.";
  }

  const { repo, branch } = payload.meta;

  // Group comments by file
  const byFile = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const existing = byFile.get(comment.filePath) || [];
    existing.push(comment);
    byFile.set(comment.filePath, existing);
  }

  const lines: string[] = [
    `# Code Review Comments for ${repo} (branch: ${branch})`,
    "",
    "Please implement the requested changes.",
    "",
    "---",
  ];

  for (const [filePath, fileComments] of byFile) {
    lines.push("", `## File: ${filePath}`);
    // Sort by line range
    const sorted = [...fileComments].sort(
      (a, b) =>
        getCommentStartLine(a) - getCommentStartLine(b) ||
        getCommentEndLine(a) - getCommentEndLine(b)
    );
    for (const comment of sorted) {
      lines.push(
        "",
        `### ${formatReviewCommentRange(comment)}:`,
        ...getCommentLineContents(comment).map((line) => `> ${line}`),
        "",
        `**Comment:** ${comment.body}`,
      );
    }
    lines.push("", "---");
  }

  lines.push(
    "",
    "## Summary",
    `- ${comments.length} comment${comments.length === 1 ? "" : "s"} across ${byFile.size} file${byFile.size === 1 ? "" : "s"}`
  );

  return lines.join("\n");
}
