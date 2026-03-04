"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { type ReviewComment } from "@/lib/comments/types";
import { loadComments, saveComments, clearComments as clearStorage } from "@/lib/comments/storage";

interface CommentsContextValue {
  comments: ReviewComment[];
  addComment: (comment: Omit<ReviewComment, "id" | "createdAt">) => void;
  removeComment: (id: string) => void;
  clearComments: () => void;
  getCommentsForFile: (filePath: string) => ReviewComment[];
  getCommentsForLine: (filePath: string, lineNumber: number) => ReviewComment[];
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
    (comment: Omit<ReviewComment, "id" | "createdAt">) => {
      const newComment: ReviewComment = {
        ...comment,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      setComments((prev) => [...prev, newComment]);
    },
    []
  );

  const removeComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setComments([]);
    clearStorage(sessionId);
  }, [sessionId]);

  const getCommentsForFile = useCallback(
    (filePath: string) => comments.filter((c) => c.filePath === filePath),
    [comments]
  );

  const getCommentsForLine = useCallback(
    (filePath: string, lineNumber: number) =>
      comments.filter(
        (c) => c.filePath === filePath && c.lineNumber === lineNumber
      ),
    [comments]
  );

  return {
    comments,
    addComment,
    removeComment,
    clearComments: clearAll,
    getCommentsForFile,
    getCommentsForLine,
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
