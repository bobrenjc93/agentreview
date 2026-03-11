export type ReviewCommentSide = "old" | "new";

export interface ReviewComment {
  id: string;
  filePath: string;
  lineNumber?: number;
  startLineNumber?: number;
  endLineNumber?: number;
  side?: ReviewCommentSide;
  lineContent: string;
  lineContents?: string[];
  body: string;
  createdAt: string;
}

export type NewReviewComment = Omit<ReviewComment, "id" | "createdAt">;

export function getCommentStartLine(comment: ReviewComment): number {
  return comment.startLineNumber ?? comment.lineNumber ?? 0;
}

export function getCommentEndLine(comment: ReviewComment): number {
  return comment.endLineNumber ?? getCommentStartLine(comment);
}

export function getCommentLineContents(comment: ReviewComment): string[] {
  if (comment.lineContents && comment.lineContents.length > 0) {
    return comment.lineContents;
  }

  if (comment.lineContent.length > 0) {
    return [comment.lineContent];
  }

  return [""];
}

export function normalizeReviewComment(comment: ReviewComment): ReviewComment {
  const startLineNumber = getCommentStartLine(comment);
  const endLineNumber = getCommentEndLine(comment);
  const lineContents = getCommentLineContents(comment);

  return {
    ...comment,
    lineNumber: startLineNumber,
    startLineNumber,
    endLineNumber,
    lineContent: comment.lineContent || lineContents[0] || "",
    lineContents,
  };
}

export function formatCommentRange(
  startLineNumber: number,
  endLineNumber: number,
  side?: ReviewCommentSide
): string {
  const label =
    startLineNumber === endLineNumber
      ? `Line ${startLineNumber}`
      : `Lines ${startLineNumber}-${endLineNumber}`;
  return side ? `${label} (${side})` : label;
}

export function formatReviewCommentRange(comment: ReviewComment): string {
  return formatCommentRange(
    getCommentStartLine(comment),
    getCommentEndLine(comment),
    comment.side
  );
}
