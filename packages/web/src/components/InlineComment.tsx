"use client";

import { memo, useEffect, useState } from "react";
import {
  type CommentAgentExchange,
  type CommentAgentSegment,
  type ReviewComment,
  formatReviewCommentRange,
  getCommentAnchorId,
} from "@/lib/comments/types";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatSingleCommentForCopy } from "@/lib/export/prompt";
import { AgentReplyBody } from "./AgentMarkdown";
import { InlineCommentForm } from "./InlineCommentForm";

interface InlineCommentProps {
  comment: ReviewComment;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onRetryAgent?: (id: string) => void;
  onAskAgentFollowUp?: (id: string, question: string) => void;
  onRetryAgentFollowUp?: (id: string, exchangeId: string) => void;
  onCancelAgent?: (id: string) => void;
  onSetAgentExpanded?: (id: string, expanded: boolean) => void;
}

function formatAgentNote(parts: {
  model?: string;
  durationMs?: number;
  costUsd?: number;
  startedAt?: string;
  finishedAt?: string;
}): string {
  const note: string[] = [parts.model || "agent"];
  if (typeof parts.durationMs === "number") {
    note.push(`${(parts.durationMs / 1000).toFixed(1)}s`);
  } else if (parts.finishedAt && parts.startedAt) {
    const elapsedMs = Date.parse(parts.finishedAt) - Date.parse(parts.startedAt);
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
      note.push(`${(elapsedMs / 1000).toFixed(1)}s`);
    }
  }
  if (typeof parts.costUsd === "number") {
    note.push(`$${parts.costUsd.toFixed(2)}`);
  }
  return note.join(" · ");
}

function formatElapsedSeconds(elapsedSeconds: number): string {
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function getElapsedSeconds(startedAt?: string): number {
  if (!startedAt) return 0;
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return 0;
  return Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
}

function useElapsedSeconds(startedAt?: string, running = true): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    getElapsedSeconds(startedAt)
  );

  useEffect(() => {
    setElapsedSeconds(getElapsedSeconds(startedAt));
    if (!running) return;
    const interval = window.setInterval(() => {
      setElapsedSeconds(getElapsedSeconds(startedAt));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt, running]);

  return elapsedSeconds;
}

function AgentPendingRow({
  startedAt,
  retryNote,
}: {
  startedAt?: string;
  retryNote?: string;
}) {
  const elapsedSeconds = useElapsedSeconds(startedAt);

  return (
    <>
      <span
        className={`h-3 w-3 shrink-0 animate-spin rounded-full border-2 ${
          retryNote
            ? "border-amber-400/30 border-t-amber-400"
            : "border-cyan-400/30 border-t-cyan-400"
        }`}
      />
      <span className="truncate text-xs text-gray-400">
        {retryNote ? (
          <span className="text-amber-400/90">{retryNote}</span>
        ) : (
          <>
            Agent is thinking…
            <span className="ml-1.5 font-mono tabular-nums text-cyan-400/90">
              {formatElapsedSeconds(elapsedSeconds)}
            </span>
          </>
        )}
      </span>
    </>
  );
}

/**
 * Error state with a prominent retry affordance. Agent errors can carry CLI
 * stderr/stdout detail, so the message renders in a scrollable block that
 * preserves line breaks instead of a single truncated line.
 */
function AgentErrorBody({
  error,
  onRetry,
  retryLabel = "Retry",
}: {
  error?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="mt-2 rounded-md border border-red-400/30 bg-red-400/5 px-2.5 py-2">
      <p className="text-xs font-medium text-red-400">Agent reply failed</p>
      <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-red-300/90">
        {error || "unknown error"}
      </pre>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1.5 rounded border border-gray-600 px-2 py-0.5 text-xs text-blue-400 transition-colors hover:border-blue-400 hover:text-blue-300"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Expanded view of an in-flight run: just the streamed segments so far. The
 * spinner and elapsed time live in the collapsed status row above, so they
 * are not repeated here.
 */
function AgentPendingBody({ segments }: { segments?: CommentAgentSegment[] }) {
  if (!segments || segments.length === 0) {
    return (
      <p className="mt-2 text-xs text-gray-500">Waiting for the agent's first output…</p>
    );
  }

  return (
    <div className="mt-2">
      <AgentReplyBody segments={segments} />
    </div>
  );
}

function AgentReplyThread({
  exchange,
  onRetry,
}: {
  exchange: CommentAgentExchange;
  onRetry?: () => void;
}) {
  return (
    <div className="mt-2 border-t border-gray-700/70 pt-2">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
        You replied
      </p>
      <p className="text-sm text-gray-200 whitespace-pre-wrap">{exchange.question}</p>
      {exchange.status === "pending" ? (
        <>
          {exchange.retryNote && (
            <p className="mt-2 text-xs text-amber-400/90">{exchange.retryNote}</p>
          )}
          <AgentPendingBody segments={exchange.segments} />
        </>
      ) : exchange.status === "error" ? (
        <AgentErrorBody error={exchange.error} onRetry={onRetry} />
      ) : exchange.status === "cancelled" ? (
        <div className="mt-2">
          <p className="text-xs text-gray-500">
            This run was cancelled before it finished.
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              Run again
            </button>
          )}
        </div>
      ) : (
        <div className="mt-2">
          <p className="mb-1 text-[11px] text-cyan-400/90">
            {formatAgentNote(exchange)}
          </p>
          <AgentReplyBody
            segments={exchange.segments}
            fallbackText={exchange.reply}
          />
        </div>
      )}
    </div>
  );
}

function AgentFollowUpForm({
  onSubmit,
}: {
  onSubmit: (question: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [question, setQuestion] = useState("");

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="mt-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
      >
        Reply
      </button>
    );
  }

  function submit() {
    const trimmed = question.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setQuestion("");
    setIsOpen(false);
  }

  return (
    <div className="mt-2">
      <textarea
        autoFocus
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Reply to the agent..."
        className="w-full bg-gray-900 text-gray-200 text-sm border border-gray-700 rounded p-2 resize-none focus:outline-none focus:border-blue-500"
        rows={2}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") {
            setIsOpen(false);
            setQuestion("");
          }
        }}
      />
      <div className="mt-1 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setIsOpen(false);
            setQuestion("");
          }}
          className="px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!question.trim()}
          className="primary-action-button rounded bg-blue-600 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500"
        >
          Reply
        </button>
      </div>
    </div>
  );
}

function AgentReplySection({
  comment,
  onRetryAgent,
  onAskAgentFollowUp,
  onRetryAgentFollowUp,
  onCancelAgent,
  onSetAgentExpanded,
}: {
  comment: ReviewComment;
  onRetryAgent?: (id: string) => void;
  onAskAgentFollowUp?: (id: string, question: string) => void;
  onRetryAgentFollowUp?: (id: string, exchangeId: string) => void;
  onCancelAgent?: (id: string) => void;
  onSetAgentExpanded?: (id: string, expanded: boolean) => void;
}) {
  if (!comment.agentStatus) return null;

  const isExpanded = !!comment.agentExpanded;
  const exchanges = comment.agentReplies ?? [];
  const hasPendingExchange = exchanges.some(
    (exchange) => exchange.status === "pending"
  );
  const isBusy = comment.agentStatus === "pending" || hasPendingExchange;
  const pendingExchange = exchanges.find(
    (exchange) => exchange.status === "pending"
  );
  const failedExchange = exchanges.find(
    (exchange) => exchange.status === "error"
  );
  // last failed follow-up drives the collapsed error row when the initial
  // reply itself succeeded
  const showsFollowUpError =
    comment.agentStatus !== "error" && !isBusy && !!failedExchange;

  // The status row keeps one fixed-height line regardless of agent state, so
  // streaming output and completions never shift the page layout while folded.
  const statusRow = (
    <div className="flex h-6 w-full min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={() => onSetAgentExpanded?.(comment.id, !isExpanded)}
        className="flex h-6 min-w-0 flex-1 items-center gap-2 text-left"
        title={isExpanded ? "Collapse the agent reply" : "Expand the agent reply"}
      >
        <span
          className={`shrink-0 text-[10px] text-gray-500 transition-transform ${
            isExpanded ? "rotate-90" : ""
          }`}
        >
          ▶
        </span>
        {isBusy ? (
          <AgentPendingRow
            startedAt={
              comment.agentStatus === "pending"
                ? comment.agentStartedAt
                : pendingExchange?.startedAt
            }
            retryNote={
              comment.agentStatus === "pending"
                ? comment.agentRetryNote
                : pendingExchange?.retryNote
            }
          />
        ) : comment.agentStatus === "error" || showsFollowUpError ? (
          <>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-400" />
            <span className="truncate text-xs text-red-400">
              Agent reply failed
              {(() => {
                const message =
                  comment.agentStatus === "error"
                    ? comment.agentError
                    : failedExchange?.error;
                const firstLine = message?.split("\n")[0]?.trim();
                return firstLine ? `: ${firstLine}` : "";
              })()}
            </span>
          </>
        ) : comment.agentStatus === "cancelled" ? (
          <>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-gray-500" />
            <span className="truncate text-xs text-gray-500">
              Agent run cancelled
            </span>
          </>
        ) : (
          <>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-400" />
            <span className="truncate text-xs text-gray-400">
              Agent replied
              <span className="ml-1.5 text-cyan-400/90">
                {formatAgentNote({
                  model: comment.agentModel,
                  durationMs: comment.agentDurationMs,
                  costUsd: comment.agentCostUsd,
                  startedAt: comment.agentStartedAt,
                  finishedAt: comment.agentFinishedAt,
                })}
              </span>
              {exchanges.length > 0 && (
                <span className="ml-1.5 text-gray-500">
                  · {exchanges.length} repl{exchanges.length === 1 ? "y" : "ies"}
                </span>
              )}
            </span>
          </>
        )}
      </button>
      {isBusy && onCancelAgent && (
        <button
          type="button"
          onClick={() => onCancelAgent(comment.id)}
          disabled={!!comment.agentCancelRequested}
          className="shrink-0 text-xs text-gray-500 transition-colors hover:text-red-400 disabled:cursor-default disabled:text-gray-600 disabled:hover:text-gray-600"
          title="Stop this agent run"
        >
          {comment.agentCancelRequested ? "Cancelling…" : "Cancel"}
        </button>
      )}
      {!isBusy && comment.agentStatus === "error" && onRetryAgent && (
        <button
          type="button"
          onClick={() => onRetryAgent(comment.id)}
          className="shrink-0 text-xs text-blue-400 transition-colors hover:text-blue-300"
          title="Run the agent again"
        >
          Retry
        </button>
      )}
      {showsFollowUpError && failedExchange && onRetryAgentFollowUp && (
        <button
          type="button"
          onClick={() => onRetryAgentFollowUp(comment.id, failedExchange.id)}
          className="shrink-0 text-xs text-blue-400 transition-colors hover:text-blue-300"
          title="Run the failed follow-up again"
        >
          Retry
        </button>
      )}
    </div>
  );

  return (
    <div className="mt-2 border-t border-gray-700 pt-2">
      {statusRow}
      {isExpanded && (
        <div className="mt-1 pl-5">
          {comment.agentStatus === "pending" ? (
            <AgentPendingBody segments={comment.agentSegments} />
          ) : comment.agentStatus === "error" ? (
            <AgentErrorBody
              error={comment.agentError}
              onRetry={onRetryAgent ? () => onRetryAgent(comment.id) : undefined}
            />
          ) : comment.agentStatus === "cancelled" ? (
            <div className="mt-1">
              {comment.agentSegments && comment.agentSegments.length > 0 && (
                <div className="mb-1">
                  <AgentReplyBody segments={comment.agentSegments} />
                </div>
              )}
              <p className="text-xs text-gray-500">
                This run was cancelled before it finished.
              </p>
              {onRetryAgent && (
                <button
                  type="button"
                  onClick={() => onRetryAgent(comment.id)}
                  className="mt-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  Run again
                </button>
              )}
            </div>
          ) : (
            <div className="mt-1">
              <AgentReplyBody
                segments={comment.agentSegments}
                fallbackText={comment.agentReply}
              />
              {exchanges.map((exchange) => (
                <AgentReplyThread
                  key={exchange.id}
                  exchange={exchange}
                  onRetry={
                    onRetryAgentFollowUp
                      ? () => onRetryAgentFollowUp(comment.id, exchange.id)
                      : undefined
                  }
                />
              ))}
              {onAskAgentFollowUp && !hasPendingExchange && (
                <AgentFollowUpForm
                  onSubmit={(question) => onAskAgentFollowUp(comment.id, question)}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const InlineComment = memo(function InlineComment({
  comment,
  onEdit,
  onDelete,
  onRetryAgent,
  onAskAgentFollowUp,
  onRetryAgentFollowUp,
  onCancelAgent,
  onSetAgentExpanded,
}: InlineCommentProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    if (!isCopied) return;
    const timer = window.setTimeout(() => setIsCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [isCopied]);

  async function copyComment() {
    try {
      await copyTextToClipboard(formatSingleCommentForCopy(comment));
      setIsCopied(true);
    } catch {
      // clipboard unavailable; leave the button state unchanged
    }
  }

  if (isEditing) {
    return (
      <InlineCommentForm
        selectionLabel={formatReviewCommentRange(comment)}
        initialValue={comment.body}
        submitLabel="Save Comment"
        onSubmit={(body) => {
          onEdit(comment.id, body);
          setIsEditing(false);
        }}
        onCancel={() => setIsEditing(false)}
      />
    );
  }

  return (
    <div
      id={getCommentAnchorId(comment.id)}
      className="bg-gray-800 border border-gray-700 rounded-md p-3 mx-2 my-1 scroll-mt-24"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] text-gray-500">
          {formatReviewCommentRange(comment)}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void copyComment()}
            className={`text-xs transition-colors ${
              isCopied ? "text-cyan-300" : "text-gray-500 hover:text-cyan-300"
            }`}
            title="Copy this comment with its file and line numbers"
          >
            {isCopied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="text-gray-500 hover:text-blue-300 text-xs transition-colors"
            title="Edit comment"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDelete(comment.id)}
            className="text-gray-500 hover:text-red-400 text-xs transition-colors"
            title="Delete comment"
          >
            Delete
          </button>
        </div>
      </div>
      <p className="text-sm text-gray-200 whitespace-pre-wrap">
        {comment.body}
      </p>
      <AgentReplySection
        comment={comment}
        onRetryAgent={onRetryAgent}
        onAskAgentFollowUp={onAskAgentFollowUp}
        onRetryAgentFollowUp={onRetryAgentFollowUp}
        onCancelAgent={onCancelAgent}
        onSetAgentExpanded={onSetAgentExpanded}
      />
    </div>
  );
});
