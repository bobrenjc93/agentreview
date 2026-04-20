export type ReviewCommentSide = "old" | "new";
export type ReviewCommentKind = "line" | "segment";

interface CommentLineRange {
  startLineNumber: number;
  endLineNumber: number;
}

export interface ReviewComment {
  id: string;
  kind?: ReviewCommentKind;
  fileId?: string;
  filePath?: string;
  segmentId?: string;
  segmentLabel?: string;
  commitHash?: string;
  commitMessage?: string;
  lineNumber?: number;
  startLineNumber?: number;
  endLineNumber?: number;
  oldStartLineNumber?: number;
  oldEndLineNumber?: number;
  newStartLineNumber?: number;
  newEndLineNumber?: number;
  side?: ReviewCommentSide;
  lineContent?: string;
  lineContents?: string[];
  body: string;
  createdAt: string;
}

export type NewReviewComment = Omit<ReviewComment, "id" | "createdAt">;

export function isLineComment(comment: ReviewComment): boolean {
  if (comment.kind === "line") return true;
  if (comment.kind === "segment") return false;
  return (
    typeof comment.fileId === "string" ||
    typeof comment.filePath === "string" ||
    typeof comment.lineNumber === "number" ||
    typeof comment.startLineNumber === "number" ||
    typeof comment.endLineNumber === "number" ||
    typeof comment.oldStartLineNumber === "number" ||
    typeof comment.oldEndLineNumber === "number" ||
    typeof comment.newStartLineNumber === "number" ||
    typeof comment.newEndLineNumber === "number"
  );
}

export function isSegmentComment(comment: ReviewComment): boolean {
  return !isLineComment(comment);
}

function normalizePositiveLineNumber(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.trunc(value);
}

function normalizeLineRange(
  startValue: number | undefined,
  endValue: number | undefined
): CommentLineRange | null {
  const startLineNumber = normalizePositiveLineNumber(startValue);
  if (startLineNumber == null) {
    return null;
  }

  const endLineNumber =
    normalizePositiveLineNumber(endValue) ?? startLineNumber;

  return {
    startLineNumber: Math.min(startLineNumber, endLineNumber),
    endLineNumber: Math.max(startLineNumber, endLineNumber),
  };
}

function getLegacyCommentLineRange(comment: ReviewComment): CommentLineRange | null {
  const startCandidate = comment.startLineNumber ?? comment.lineNumber;
  const endCandidate = comment.endLineNumber ?? startCandidate;
  return normalizeLineRange(startCandidate, endCandidate);
}

function getStoredCommentLineRange(
  comment: ReviewComment,
  side: ReviewCommentSide
): CommentLineRange | null {
  return side === "old"
    ? normalizeLineRange(comment.oldStartLineNumber, comment.oldEndLineNumber)
    : normalizeLineRange(comment.newStartLineNumber, comment.newEndLineNumber);
}

export function getCommentFileId(comment: ReviewComment): string | null {
  if (!isLineComment(comment)) return null;
  return comment.fileId || comment.filePath || null;
}

export function getCommentLineRange(
  comment: ReviewComment,
  side?: ReviewCommentSide
): CommentLineRange | null {
  if (!isLineComment(comment)) {
    return null;
  }

  if (side) {
    return (
      getStoredCommentLineRange(comment, side) ??
      (comment.side === side ? getLegacyCommentLineRange(comment) : null)
    );
  }

  const preferredRange =
    comment.side === "old" || comment.side === "new"
      ? getCommentLineRange(comment, comment.side)
      : null;
  if (preferredRange) {
    return preferredRange;
  }

  const oldRange = getCommentLineRange(comment, "old");
  const newRange = getCommentLineRange(comment, "new");
  if (oldRange && newRange) {
    return oldRange.startLineNumber <= newRange.startLineNumber
      ? oldRange
      : newRange;
  }

  return oldRange ?? newRange ?? getLegacyCommentLineRange(comment);
}

export function hasCommentLineRange(
  comment: ReviewComment,
  side?: ReviewCommentSide
): boolean {
  return getCommentLineRange(comment, side) !== null;
}

export function getCommentStartLine(
  comment: ReviewComment,
  side?: ReviewCommentSide
): number {
  return getCommentLineRange(comment, side)?.startLineNumber ?? 0;
}

export function getCommentEndLine(
  comment: ReviewComment,
  side?: ReviewCommentSide
): number {
  return getCommentLineRange(comment, side)?.endLineNumber ?? 0;
}

export function commentIncludesLine(
  comment: ReviewComment,
  lineNumber: number,
  side: ReviewCommentSide
): boolean {
  const range = getCommentLineRange(comment, side);
  if (!range) {
    return false;
  }

  return (
    range.startLineNumber <= lineNumber && range.endLineNumber >= lineNumber
  );
}

export function commentEndsOnLine(
  comment: ReviewComment,
  lineNumber: number,
  side: ReviewCommentSide
): boolean {
  return getCommentEndLine(comment, side) === lineNumber;
}

export function getCommentLineContents(comment: ReviewComment): string[] {
  if (!isLineComment(comment)) {
    return [];
  }

  if (comment.lineContents && comment.lineContents.length > 0) {
    return comment.lineContents;
  }

  if ((comment.lineContent || "").length > 0) {
    return [comment.lineContent || ""];
  }

  return [""];
}

export function normalizeReviewComment(comment: ReviewComment): ReviewComment {
  if (!isLineComment(comment)) {
    return {
      ...comment,
      kind: "segment",
      fileId: undefined,
      filePath: undefined,
      lineNumber: undefined,
      startLineNumber: undefined,
      endLineNumber: undefined,
      oldStartLineNumber: undefined,
      oldEndLineNumber: undefined,
      newStartLineNumber: undefined,
      newEndLineNumber: undefined,
      side: undefined,
      lineContent: undefined,
      lineContents: undefined,
    };
  }

  const legacyRange = getLegacyCommentLineRange(comment);
  const oldRange = normalizeLineRange(
    comment.oldStartLineNumber ??
      (comment.side === "old" ? legacyRange?.startLineNumber : undefined),
    comment.oldEndLineNumber ??
      (comment.side === "old" ? legacyRange?.endLineNumber : undefined)
  );
  const newRange = normalizeLineRange(
    comment.newStartLineNumber ??
      (comment.side === "new" ? legacyRange?.startLineNumber : undefined),
    comment.newEndLineNumber ??
      (comment.side === "new" ? legacyRange?.endLineNumber : undefined)
  );
  const side =
    comment.side ??
    (oldRange && !newRange ? "old" : newRange && !oldRange ? "new" : undefined);
  const primaryRange =
    (side === "old"
      ? oldRange
      : side === "new"
        ? newRange
        : null) ??
    oldRange ??
    newRange ??
    legacyRange;
  const lineContents = getCommentLineContents(comment);
  const fileId = getCommentFileId(comment);
  const filePath = comment.filePath || fileId || "";

  return {
    ...comment,
    kind: "line",
    fileId: fileId || undefined,
    filePath,
    lineNumber: primaryRange?.startLineNumber,
    startLineNumber: primaryRange?.startLineNumber,
    endLineNumber: primaryRange?.endLineNumber,
    oldStartLineNumber: oldRange?.startLineNumber,
    oldEndLineNumber: oldRange?.endLineNumber,
    newStartLineNumber: newRange?.startLineNumber,
    newEndLineNumber: newRange?.endLineNumber,
    side,
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

function formatSideSpecificCommentRange(
  side: ReviewCommentSide,
  range: CommentLineRange
): string {
  const prefix = side === "old" ? "Old" : "New";
  return range.startLineNumber === range.endLineNumber
    ? `${prefix} ${range.startLineNumber}`
    : `${prefix} ${range.startLineNumber}-${range.endLineNumber}`;
}

export function formatCommentRangeFromParts(parts: {
  side?: ReviewCommentSide;
  oldStartLineNumber?: number;
  oldEndLineNumber?: number;
  newStartLineNumber?: number;
  newEndLineNumber?: number;
}): string {
  const oldRange = normalizeLineRange(
    parts.oldStartLineNumber,
    parts.oldEndLineNumber
  );
  const newRange = normalizeLineRange(
    parts.newStartLineNumber,
    parts.newEndLineNumber
  );

  if (oldRange && newRange) {
    if (
      oldRange.startLineNumber === newRange.startLineNumber &&
      oldRange.endLineNumber === newRange.endLineNumber
    ) {
      return formatCommentRange(
        oldRange.startLineNumber,
        oldRange.endLineNumber
      );
    }

    return `${formatSideSpecificCommentRange("old", oldRange)} / ${formatSideSpecificCommentRange("new", newRange)}`;
  }

  if (oldRange) {
    return formatCommentRange(
      oldRange.startLineNumber,
      oldRange.endLineNumber,
      "old"
    );
  }

  if (newRange) {
    return formatCommentRange(
      newRange.startLineNumber,
      newRange.endLineNumber,
      "new"
    );
  }

  return parts.side ? `Line comment (${parts.side})` : "Line comment";
}

export function formatReviewCommentRange(comment: ReviewComment): string {
  if (isSegmentComment(comment)) {
    return comment.segmentId?.startsWith("commit:")
      ? "Commit comment"
      : "Segment comment";
  }

  return formatCommentRangeFromParts(comment);
}
