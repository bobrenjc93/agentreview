"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import {
  commentEndsOnLine,
  commentIncludesLine,
  type CommentAgentSegment,
  type NewReviewComment,
  type ReviewComment,
  type ReviewCommentSide,
  getCommentFileId,
  isLineComment,
  normalizeReviewComment,
} from "@/lib/comments/types";
import {
  buildAgentPrompt,
  buildAgentRunLabel,
  buildFollowUpPrompt,
  type RunAgent,
} from "@/lib/comments/agent";
import { createClientId } from "@/lib/id";
import { loadComments, saveComments, clearComments as clearStorage } from "@/lib/comments/storage";

interface CommentsContextValue {
  comments: ReviewComment[];
  addComment: (comment: NewReviewComment, options?: { diffContext?: string }) => void;
  retryAgentReply: (id: string) => void;
  askAgentFollowUp: (id: string, question: string) => void;
  markAgentSeen: (id: string) => void;
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
  const commentsRef = useRef<ReviewComment[]>(comments);
  commentsRef.current = comments;

  useEffect(() => {
    // Agent runs from a previous page load can never resolve; surface them as errors.
    const interruptedError = "The agent run was interrupted before it finished.";
    setComments(
      loadComments(sessionId).map((comment) => {
        let next = comment;
        if (next.agentStatus === "pending") {
          next = {
            ...next,
            agentStatus: "error" as const,
            agentError: interruptedError,
          };
        }
        if (next.agentReplies?.some((exchange) => exchange.status === "pending")) {
          next = {
            ...next,
            agentReplies: next.agentReplies?.map((exchange) =>
              exchange.status === "pending"
                ? { ...exchange, status: "error" as const, error: interruptedError }
                : exchange
            ),
          };
        }
        return next;
      })
    );
    setLoadedSessionId(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (loadedSessionId !== sessionId) return;
    saveComments(sessionId, comments);
  }, [sessionId, comments, loadedSessionId]);

  const patchComment = useCallback(
    (commentId: string, patch: (comment: ReviewComment) => ReviewComment) => {
      setComments((prev) =>
        prev.map((comment) => (comment.id === commentId ? patch(comment) : comment))
      );
    },
    []
  );

  const startAgentReply = useCallback(
    (commentId: string, prompt: string, label?: string) => {
      const run = runAgentRef.current;
      if (!run) return;

      agentPromptById.current.set(commentId, prompt);
      patchComment(commentId, (comment) => ({
        ...comment,
        agentStatus: "pending",
        agentStartedAt: new Date().toISOString(),
        agentFinishedAt: undefined,
        agentReply: undefined,
        agentSegments: undefined,
        agentError: undefined,
        agentSessionId: undefined,
        agentReplies: undefined,
        agentUnseen: undefined,
      }));

      run(prompt, {
        label,
        onSegment: (segment) => {
          patchComment(commentId, (comment) => ({
            ...comment,
            agentSegments: [...(comment.agentSegments ?? []), segment],
          }));
        },
      }).then(
        (result) => {
          patchComment(commentId, (comment) => ({
            ...comment,
            agentStatus: "done",
            agentFinishedAt: new Date().toISOString(),
            agentReply: result.response,
            agentSegments: result.segments ?? comment.agentSegments,
            agentError: undefined,
            agentModel: result.model,
            agentDurationMs: result.durationMs,
            agentCostUsd: result.costUsd,
            agentSessionId: result.sessionId,
            agentUnseen: true,
          }));
        },
        (error: unknown) => {
          patchComment(commentId, (comment) => ({
            ...comment,
            agentStatus: "error",
            agentError:
              error instanceof Error ? error.message : "The agent run failed.",
            agentUnseen: true,
          }));
        }
      );
    },
    [patchComment]
  );

  const askAgentFollowUp = useCallback(
    (commentId: string, question: string) => {
      const run = runAgentRef.current;
      const trimmed = question.trim();
      if (!run || !trimmed) return;

      const comment = commentsRef.current.find((c) => c.id === commentId);
      if (!comment || comment.agentStatus !== "done") return;

      const resumeSessionId = comment.agentSessionId;
      const prompt = buildFollowUpPrompt(comment, trimmed, {
        canResume: !!resumeSessionId,
      });
      const exchangeId = createClientId();
      const patchExchange = (
        patch: (exchange: NonNullable<ReviewComment["agentReplies"]>[number]) =>
          NonNullable<ReviewComment["agentReplies"]>[number]
      ) => {
        patchComment(commentId, (current) => ({
          ...current,
          agentReplies: current.agentReplies?.map((exchange) =>
            exchange.id === exchangeId ? patch(exchange) : exchange
          ),
        }));
      };

      patchComment(commentId, (current) => ({
        ...current,
        agentReplies: [
          ...(current.agentReplies ?? []),
          {
            id: exchangeId,
            question: trimmed,
            createdAt: new Date().toISOString(),
            status: "pending" as const,
            startedAt: new Date().toISOString(),
          },
        ],
      }));

      run(prompt, {
        resumeSessionId,
        label: buildAgentRunLabel(comment, "reply"),
        onSegment: (segment: CommentAgentSegment) => {
          patchExchange((exchange) => ({
            ...exchange,
            segments: [...(exchange.segments ?? []), segment],
          }));
        },
      }).then(
        (result) => {
          patchExchange((exchange) => ({
            ...exchange,
            status: "done" as const,
            finishedAt: new Date().toISOString(),
            reply: result.response,
            segments: result.segments ?? exchange.segments,
            model: result.model,
            durationMs: result.durationMs,
            costUsd: result.costUsd,
          }));
          patchComment(commentId, (current) => ({
            ...current,
            agentSessionId: result.sessionId ?? current.agentSessionId,
            agentUnseen: true,
          }));
        },
        (error: unknown) => {
          patchExchange((exchange) => ({
            ...exchange,
            status: "error" as const,
            error: error instanceof Error ? error.message : "The agent run failed.",
          }));
          patchComment(commentId, (current) => ({
            ...current,
            agentUnseen: true,
          }));
        }
      );
    },
    [patchComment]
  );

  const markAgentSeen = useCallback(
    (id: string) => {
      patchComment(id, (comment) =>
        comment.agentUnseen ? { ...comment, agentUnseen: false } : comment
      );
    },
    [patchComment]
  );

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
          buildAgentPrompt(newComment, options?.diffContext),
          buildAgentRunLabel(newComment)
        );
      }
    },
    [startAgentReply]
  );

  const retryAgentReply = useCallback(
    (id: string) => {
      const prompt = agentPromptById.current.get(id);
      const comment = comments.find((c) => c.id === id);
      const nextPrompt = prompt ?? (comment ? buildAgentPrompt(comment) : null);
      if (nextPrompt) {
        startAgentReply(
          id,
          nextPrompt,
          comment ? buildAgentRunLabel(comment) : undefined
        );
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
    askAgentFollowUp,
    markAgentSeen,
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
