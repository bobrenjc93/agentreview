import {
  type ReviewComment,
  getCommentEndLine,
  getCommentStartLine,
  normalizeReviewComment,
} from "./types";

const STORAGE_KEY_PREFIX = "agentreview:comments";

function getStorageKey(sessionId: string): string {
  return `${STORAGE_KEY_PREFIX}:${sessionId}`;
}

export function loadComments(sessionId: string): ReviewComment[] {
  if (typeof window === "undefined") return [];
  if (!sessionId) return [];
  try {
    const raw = localStorage.getItem(getStorageKey(sessionId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (comment): comment is ReviewComment =>
          !!comment &&
          typeof comment === "object" &&
          typeof (comment as ReviewComment).filePath === "string" &&
          typeof (comment as ReviewComment).body === "string" &&
          typeof (comment as ReviewComment).createdAt === "string" &&
          typeof (comment as ReviewComment).lineContent === "string"
      )
      .map((comment) => normalizeReviewComment(comment))
      .filter(
        (comment) =>
          getCommentStartLine(comment) > 0 &&
          getCommentEndLine(comment) >= getCommentStartLine(comment)
      );
  } catch {
    return [];
  }
}

export function saveComments(sessionId: string, comments: ReviewComment[]): void {
  if (typeof window === "undefined") return;
  if (!sessionId) return;
  localStorage.setItem(
    getStorageKey(sessionId),
    JSON.stringify(comments.map((comment) => normalizeReviewComment(comment)))
  );
}

export function clearComments(sessionId: string): void {
  if (typeof window === "undefined") return;
  if (!sessionId) return;
  localStorage.removeItem(getStorageKey(sessionId));
}
