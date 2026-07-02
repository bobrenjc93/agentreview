"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
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
import { buildAgentPrompt, type RunAgent } from "@/lib/comments/agent";
import { createClientId } from "@/lib/id";
import { loadComments, saveComments, clearComments as clearStorage } from "@/lib/comments/storage";

interface CommentsContextValue {
  comments: ReviewComment[];
  addComment: (comment: NewReviewComment, options?: { diffContext?: string }) => void;
  retryAgentReply: (id: string) => void;
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

export function useCommentsProvider(sessionId: string, runAgent?: RunAgent) {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);
  const agentPromptById = useRef(new Map<string, string>());
  const runAgentRef = useRef<RunAgent | undefined>(runAgent);
  runAgentRef.current = runAgent;

  useEffect(() => {
    // Agent runs from a previous page load can never resolve; surface them as errors.
    setComments(
      loadComments(sessionId).map((comment) =>
        comment.agentStatus === "pending"
          ? {
              ...comment,
              agentStatus: "error" as const,
              agentError: "The agent run was interrupted before it finished.",
            }
          : comment
      )
    );
    setLoadedSessionId(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (loadedSessionId !== sessionId) return;
    saveComments(sessionId, comments);
  }, [sessionId, comments, loadedSessionId]);

  const startAgentReply = useCallback((commentId: string, prompt: string) => {
    const run = runAgentRef.current;
    if (!run) return;

    agentPromptById.current.set(commentId, prompt);
    setComments((prev) =>
      prev.map((comment) =>
        comment.id === commentId
          ? {
              ...comment,
              agentStatus: "pending",
              agentStartedAt: new Date().toISOString(),
              agentFinishedAt: undefined,
              agentReply: undefined,
              agentSegments: undefined,
              agentError: undefined,
            }
          : comment
      )
    );

    run(prompt).then(
      (result) => {
        setComments((prev) =>
          prev.map((comment) =>
            comment.id === commentId
              ? {
                  ...comment,
                  agentStatus: "done",
                  agentFinishedAt: new Date().toISOString(),
                  agentReply: result.response,
                  agentSegments: result.segments,
                  agentError: undefined,
                  agentModel: result.model,
                  agentDurationMs: result.durationMs,
                  agentCostUsd: result.costUsd,
                }
              : comment
          )
        );
      },
      (error: unknown) => {
        setComments((prev) =>
          prev.map((comment) =>
            comment.id === commentId
              ? {
                  ...comment,
                  agentStatus: "error",
                  agentError:
                    error instanceof Error
                      ? error.message
                      : "The agent run failed.",
                }
              : comment
          )
        );
      }
    );
  }, []);

  const addComment = useCallback(
    (comment: NewReviewComment, options?: { diffContext?: string }) => {
      const newComment = normalizeReviewComment({
        ...comment,
        id: createClientId(),
        createdAt: new Date().toISOString(),
      });
      setComments((prev) => [...prev, newComment]);
      if (runAgentRef.current) {
        startAgentReply(
          newComment.id,
          buildAgentPrompt(newComment, options?.diffContext)
        );
      }
    },
    [startAgentReply]
  );

  const retryAgentReply = useCallback(
    (id: string) => {
      const prompt = agentPromptById.current.get(id);
      const comment = prompt ? null : comments.find((c) => c.id === id);
      const nextPrompt = prompt ?? (comment ? buildAgentPrompt(comment) : null);
      if (nextPrompt) {
        startAgentReply(id, nextPrompt);
      }
    },
    [comments, startAgentReply]
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
    retryAgentReply,
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
