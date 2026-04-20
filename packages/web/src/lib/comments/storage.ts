import {
  type ReviewComment,
  hasCommentLineRange,
  isSegmentComment,
  normalizeReviewComment,
} from "./types";
import {
  clearStoredReview,
  getReviewCommentsStorageKey,
  touchStoredReview,
  withReviewStorageQuotaRetry,
} from "@/lib/storage/reviews";

export function loadComments(sessionId: string): ReviewComment[] {
  if (typeof window === "undefined") return [];
  if (!sessionId) return [];
  try {
    const raw = localStorage.getItem(getReviewCommentsStorageKey(sessionId));
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      clearStoredReview(sessionId);
      return [];
    }

    const comments = parsed
      .filter(
        (comment): comment is ReviewComment =>
          !!comment &&
          typeof comment === "object" &&
          typeof (comment as ReviewComment).body === "string" &&
          typeof (comment as ReviewComment).createdAt === "string" &&
          ((comment as ReviewComment).filePath === undefined ||
            typeof (comment as ReviewComment).filePath === "string") &&
          ((comment as ReviewComment).lineContent === undefined ||
            typeof (comment as ReviewComment).lineContent === "string")
      )
      .map((comment) => normalizeReviewComment(comment))
      .filter(
        (comment) =>
          isSegmentComment(comment) ||
          (typeof comment.filePath === "string" &&
            comment.filePath.length > 0 &&
            hasCommentLineRange(comment))
      );

    if (comments.length === 0) {
      clearStoredReview(sessionId);
      return [];
    }

    touchStoredReview(sessionId);
    return comments;
  } catch {
    return [];
  }
}

export function saveComments(sessionId: string, comments: ReviewComment[]): void {
  if (typeof window === "undefined") return;
  if (!sessionId) return;

  const normalizedComments = comments.map((comment) =>
    normalizeReviewComment(comment)
  );

  if (normalizedComments.length === 0) {
    clearStoredReview(sessionId);
    return;
  }

  try {
    withReviewStorageQuotaRetry(
      () => {
        localStorage.setItem(
          getReviewCommentsStorageKey(sessionId),
          JSON.stringify(normalizedComments)
        );
      },
      { excludeSessionIds: [sessionId] }
    );
    touchStoredReview(sessionId);
  } catch (error) {
    console.error("Failed to persist review comments", error);
  }
}

export function clearComments(sessionId: string): void {
  clearStoredReview(sessionId);
}
