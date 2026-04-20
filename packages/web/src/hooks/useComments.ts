"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import {
  commentEndsOnLine,
  commentIncludesLine,
  type NewReviewComment,
  type ReviewComment,
  type ReviewCommentSide,
  getCommentFileId,
  isLineComment,
  normalizeReviewComment,
} from "@/lib/comments/types";
import { createClientId } from "@/lib/id";
import { loadComments, saveComments, clearComments as clearStorage } from "@/lib/comments/storage";

interface CommentsContextValue {
  comments: ReviewComment[];
  addComment: (comment: NewReviewComment) => void;
  updateComment: (id: string, body: string) => void;
  removeComment: (id: string) => void;
  removeComments: (ids: string[]) => void;
  clearComments: () => void;
  getCommentsForFile: (fileId: string) => ReviewComment[];
  getCommentsForLine: (
    fileId: string,
    lineNumber: number,
    side?: ReviewCommentSide
  ) => ReviewComment[];
  getCommentsEndingOnLine: (
    fileId: string,
    lineNumber: number,
    side?: ReviewCommentSide
  ) => ReviewComment[];
}

export const CommentsContext = createContext<CommentsContextValue | null>(null);

export function useCommentsProvider(sessionId: string) {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);

  useEffect(() => {
    setComments(loadComments(sessionId));
    setLoadedSessionId(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (loadedSessionId !== sessionId) return;
    saveComments(sessionId, comments);
  }, [sessionId, comments, loadedSessionId]);

  const addComment = useCallback(
    (comment: NewReviewComment) => {
      const newComment = normalizeReviewComment({
        ...comment,
        id: createClientId(),
        createdAt: new Date().toISOString(),
      });
      setComments((prev) => [...prev, newComment]);
    },
    []
  );

  const updateComment = useCallback((id: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;

    setComments((prev) =>
      prev.map((comment) =>
        comment.id === id
          ? normalizeReviewComment({
              ...comment,
              body: trimmed,
            })
          : comment
      )
    );
  }, []);

  const removeComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const removeComments = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const idsToRemove = new Set(ids);
    setComments((prev) => prev.filter((comment) => !idsToRemove.has(comment.id)));
  }, []);

  const clearAll = useCallback(() => {
    setComments([]);
    clearStorage(sessionId);
  }, [sessionId]);

  const getCommentsForFile = useCallback(
    (fileId: string) =>
      comments.filter(
        (comment) => isLineComment(comment) && getCommentFileId(comment) === fileId
      ),
    [comments]
  );

  const getCommentsForLine = useCallback(
    (fileId: string, lineNumber: number, side?: ReviewCommentSide) =>
      comments.filter(
        (comment) =>
          isLineComment(comment) &&
          getCommentFileId(comment) === fileId &&
          (!!side ? commentIncludesLine(comment, lineNumber, side) : false)
      ),
    [comments]
  );

  const getCommentsEndingOnLine = useCallback(
    (fileId: string, lineNumber: number, side?: ReviewCommentSide) =>
      comments.filter(
        (comment) =>
          isLineComment(comment) &&
          getCommentFileId(comment) === fileId &&
          (!!side ? commentEndsOnLine(comment, lineNumber, side) : false)
      ),
    [comments]
  );

  return {
    comments,
    addComment,
    updateComment,
    removeComment,
    removeComments,
    clearComments: clearAll,
    getCommentsForFile,
    getCommentsForLine,
    getCommentsEndingOnLine,
  };
}

export function useComments(): CommentsContextValue {
  const ctx = useContext(CommentsContext);
  if (!ctx) {
    throw new Error(
      "useComments must be used within a CommentsContext provider"
    );
  }
  return ctx;
}
