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
  buildAgentAttemptNote,
  buildAgentPrompt,
  buildAgentRetryWaitNote,
  buildAgentRunLabel,
  buildFollowUpPrompt,
  runAgentWithRetry,
  type CancelAgent,
  type RunAgent,
} from "@/lib/comments/agent";
import { createClientId } from "@/lib/id";
import { loadComments, saveComments, clearComments as clearStorage } from "@/lib/comments/storage";

interface CommentsContextValue {
  comments: ReviewComment[];
  addComment: (comment: NewReviewComment, options?: { diffContext?: string }) => void;
  retryAgentReply: (id: string) => void;
  askAgentFollowUp: (id: string, question: string) => void;
  retryAgentFollowUp: (id: string, exchangeId: string) => void;
  cancelAgentReply: (id: string) => void;
  markAgentSeen: (id: string) => void;
  setAgentExpanded: (id: string, expanded: boolean) => void;
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

export function useCommentsProvider(
  sessionId: string,
  runAgent?: RunAgent,
  cancelAgent?: CancelAgent
) {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);
  const agentPromptById = useRef(new Map<string, string>());
  const agentRunKeyById = useRef(new Map<string, string>());
  // Run keys the user cancelled; lets automatic retries stop during backoff,
  // when there is no server-side process to kill.
  const cancelledRunKeys = useRef(new Set<string>());
  const runAgentRef = useRef<RunAgent | undefined>(runAgent);
  runAgentRef.current = runAgent;
  const cancelAgentRef = useRef<CancelAgent | undefined>(cancelAgent);
  cancelAgentRef.current = cancelAgent;
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
        if (next.agentRetryNote) {
          next = { ...next, agentRetryNote: undefined };
        }
        if (
          next.agentReplies?.some(
            (exchange) => exchange.status === "pending" || exchange.retryNote
          )
        ) {
          next = {
            ...next,
            agentReplies: next.agentReplies?.map((exchange) =>
              exchange.status === "pending"
                ? {
                    ...exchange,
                    status: "error" as const,
                    error: interruptedError,
                    retryNote: undefined,
                  }
                : exchange.retryNote
                  ? { ...exchange, retryNote: undefined }
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
      const runKey = createClientId();
      agentRunKeyById.current.set(commentId, runKey);
      cancelledRunKeys.current.delete(runKey);
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
        agentCancelRequested: undefined,
        agentRetryNote: undefined,
      }));

      runAgentWithRetry(run, prompt, {
        label,
        runKey,
        onSegment: (segment) => {
          patchComment(commentId, (comment) => ({
            ...comment,
            agentSegments: [...(comment.agentSegments ?? []), segment],
          }));
        },
        isCancelled: () => cancelledRunKeys.current.has(runKey),
        onRetryWait: (retryNumber, delayMs, error) => {
          patchComment(commentId, (comment) => ({
            ...comment,
            agentRetryNote: buildAgentRetryWaitNote(retryNumber, delayMs, error),
          }));
        },
        onAttemptStart: (attemptNumber) => {
          // drop partial output from the failed attempt so streams don't mix
          patchComment(commentId, (comment) => ({
            ...comment,
            agentSegments: undefined,
            agentRetryNote: buildAgentAttemptNote(attemptNumber),
          }));
        },
      }).then(
        (result) => {
          if (result.cancelled) {
            patchComment(commentId, (comment) => ({
              ...comment,
              agentStatus: "cancelled",
              agentFinishedAt: new Date().toISOString(),
              agentCancelRequested: undefined,
              agentRetryNote: undefined,
            }));
            return;
          }
          patchComment(commentId, (comment) => ({
            ...comment,
            agentStatus: "done",
            agentFinishedAt: new Date().toISOString(),
            agentCancelRequested: undefined,
            agentRetryNote: undefined,
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
            agentCancelRequested: undefined,
            agentRetryNote: undefined,
            agentError:
              error instanceof Error ? error.message : "The agent run failed.",
            agentUnseen: true,
          }));
        }
      );
    },
    [patchComment]
  );

  const cancelAgentReply = useCallback(
    (commentId: string) => {
      const cancel = cancelAgentRef.current;
      const runKey = agentRunKeyById.current.get(commentId);
      if (!cancel || !runKey) return;
      // stop any automatic retry loop that is waiting out a backoff
      cancelledRunKeys.current.add(runKey);
      patchComment(commentId, (comment) => ({
        ...comment,
        agentCancelRequested: true,
      }));
      cancel(runKey).then((cancelled) => {
        if (!cancelled) {
          // nothing to kill server-side (already finished or never started);
          // clear the transient state so the row doesn't stick on Cancelling.
          // A retry loop waiting out a backoff still sees the cancelled run
          // key and resolves as cancelled on its own.
          patchComment(commentId, (comment) => ({
            ...comment,
            agentCancelRequested: false,
          }));
        }
      });
    },
    [patchComment]
  );

  const startAgentFollowUpRun = useCallback(
    (commentId: string, exchangeId: string, question: string) => {
      const run = runAgentRef.current;
      if (!run) return;

      const comment = commentsRef.current.find((c) => c.id === commentId);
      if (!comment) return;

      const resumeSessionId = comment.agentSessionId;
      const prompt = buildFollowUpPrompt(comment, question, {
        canResume: !!resumeSessionId,
      });
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

      const runKey = createClientId();
      agentRunKeyById.current.set(commentId, runKey);
      cancelledRunKeys.current.delete(runKey);

      runAgentWithRetry(run, prompt, {
        resumeSessionId,
        label: buildAgentRunLabel(comment, "reply"),
        runKey,
        onSegment: (segment: CommentAgentSegment) => {
          patchExchange((exchange) => ({
            ...exchange,
            segments: [...(exchange.segments ?? []), segment],
          }));
        },
        isCancelled: () => cancelledRunKeys.current.has(runKey),
        onRetryWait: (retryNumber, delayMs, error) => {
          patchExchange((exchange) => ({
            ...exchange,
            retryNote: buildAgentRetryWaitNote(retryNumber, delayMs, error),
          }));
        },
        onAttemptStart: (attemptNumber) => {
          // drop partial output from the failed attempt so streams don't mix
          patchExchange((exchange) => ({
            ...exchange,
            segments: undefined,
            retryNote: buildAgentAttemptNote(attemptNumber),
          }));
        },
      }).then(
        (result) => {
          if (result.cancelled) {
            patchExchange((exchange) => ({
              ...exchange,
              status: "cancelled" as const,
              finishedAt: new Date().toISOString(),
              retryNote: undefined,
            }));
            return;
          }
          patchExchange((exchange) => ({
            ...exchange,
            status: "done" as const,
            finishedAt: new Date().toISOString(),
            reply: result.response,
            segments: result.segments ?? exchange.segments,
            model: result.model,
            durationMs: result.durationMs,
            costUsd: result.costUsd,
            error: undefined,
            retryNote: undefined,
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
            retryNote: undefined,
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

  const askAgentFollowUp = useCallback(
    (commentId: string, question: string) => {
      const trimmed = question.trim();
      if (!runAgentRef.current || !trimmed) return;

      const comment = commentsRef.current.find((c) => c.id === commentId);
      if (!comment || comment.agentStatus !== "done") return;

      const exchangeId = createClientId();
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

      startAgentFollowUpRun(commentId, exchangeId, trimmed);
    },
    [patchComment, startAgentFollowUpRun]
  );

  const retryAgentFollowUp = useCallback(
    (commentId: string, exchangeId: string) => {
      const comment = commentsRef.current.find((c) => c.id === commentId);
      const exchange = comment?.agentReplies?.find((e) => e.id === exchangeId);
      if (!comment || !exchange || exchange.status === "pending") return;

      patchComment(commentId, (current) => ({
        ...current,
        agentReplies: current.agentReplies?.map((e) =>
          e.id === exchangeId
            ? {
                ...e,
                status: "pending" as const,
                startedAt: new Date().toISOString(),
                finishedAt: undefined,
                reply: undefined,
                segments: undefined,
                error: undefined,
                retryNote: undefined,
              }
            : e
        ),
      }));

      startAgentFollowUpRun(commentId, exchangeId, exchange.question);
    },
    [patchComment, startAgentFollowUpRun]
  );

  const markAgentSeen = useCallback(
    (id: string) => {
      patchComment(id, (comment) =>
        comment.agentUnseen ? { ...comment, agentUnseen: false } : comment
      );
    },
    [patchComment]
  );

  const setAgentExpanded = useCallback(
    (id: string, expanded: boolean) => {
      // opening the reply counts as reading it, so clear the unseen flag
      patchComment(id, (comment) => ({
        ...comment,
        agentExpanded: expanded,
        agentUnseen: expanded ? false : comment.agentUnseen,
      }));
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
    retryAgentFollowUp,
    cancelAgentReply,
    markAgentSeen,
    setAgentExpanded,
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
