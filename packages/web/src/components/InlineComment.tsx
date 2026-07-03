"use client";

import { useEffect, useRef, useState } from "react";
import {
  type CommentAgentExchange,
  type CommentAgentSegment,
  type ReviewComment,
  formatReviewCommentRange,
  getCommentAnchorId,
} from "@/lib/comments/types";
import { AgentReplyBody } from "./AgentMarkdown";
import { InlineCommentForm } from "./InlineCommentForm";

interface InlineCommentProps {
  comment: ReviewComment;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onRetryAgent?: (id: string) => void;
  onAskAgentFollowUp?: (id: string, question: string) => void;
}

function findScrollParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      parent.scrollHeight > parent.clientHeight
    ) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/**
 * Agent replies stream into comments and change their height. When that
 * happens above the user's viewport it would push their content down;
 * compensate by shifting the scroll container by the same delta before
 * paint so the visible content never moves.
 */
function useScrollAnchorCompensation(ref: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const scroller = findScrollParent(element);
    if (!scroller) return;

    let lastHeight = element.offsetHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = element.offsetHeight;
      const delta = nextHeight - lastHeight;
      lastHeight = nextHeight;
      if (delta === 0) return;

      const elementRect = element.getBoundingClientRect();
      const viewportTop =
        scroller === document.scrollingElement
          ? 0
          : scroller.getBoundingClientRect().top;
      // compare against the element's pre-resize bottom edge: only
      // compensate when the comment was entirely above the viewport
      if (elementRect.bottom - delta <= viewportTop + 1) {
        scroller.scrollTop += delta;
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
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

function AgentPendingIndicator({
  startedAt,
  segments,
}: {
  startedAt?: string;
  segments?: CommentAgentSegment[];
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    getElapsedSeconds(startedAt)
  );

  useEffect(() => {
    setElapsedSeconds(getElapsedSeconds(startedAt));
    const interval = window.setInterval(() => {
      setElapsedSeconds(getElapsedSeconds(startedAt));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  return (
    <div className="mt-2 border-t border-gray-700 pt-2">
      {segments && segments.length > 0 && (
        <div className="mb-2">
          <AgentReplyBody segments={segments} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
        <p className="text-xs text-gray-400">
          Agent is thinking…
          <span className="ml-1.5 font-mono tabular-nums text-cyan-400/90">
            {formatElapsedSeconds(elapsedSeconds)}
          </span>
        </p>
      </div>
    </div>
  );
}

function AgentReplyThread({
  exchange,
}: {
  exchange: CommentAgentExchange;
}) {
  return (
    <div className="mt-2 border-t border-gray-700/70 pt-2">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
        You replied
      </p>
      <p className="text-sm text-gray-200 whitespace-pre-wrap">{exchange.question}</p>
      {exchange.status === "pending" ? (
        <AgentPendingIndicator
          startedAt={exchange.startedAt}
          segments={exchange.segments}
        />
      ) : exchange.status === "error" ? (
        <p className="mt-2 text-xs text-red-400">
          Agent reply failed: {exchange.error || "unknown error"}
        </p>
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
}: {
  comment: ReviewComment;
  onRetryAgent?: (id: string) => void;
  onAskAgentFollowUp?: (id: string, question: string) => void;
}) {
  if (!comment.agentStatus) return null;

  if (comment.agentStatus === "pending") {
    return (
      <AgentPendingIndicator
        startedAt={comment.agentStartedAt}
        segments={comment.agentSegments}
      />
    );
  }

  if (comment.agentStatus === "error") {
    return (
      <div className="mt-2 border-t border-gray-700 pt-2">
        <p className="text-xs text-red-400">
          Agent reply failed: {comment.agentError || "unknown error"}
        </p>
        {onRetryAgent && (
          <button
            type="button"
            onClick={() => onRetryAgent(comment.id)}
            className="mt-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  const exchanges = comment.agentReplies ?? [];
  const hasPendingExchange = exchanges.some(
    (exchange) => exchange.status === "pending"
  );

  return (
    <div className="mt-2 border-t border-gray-700 pt-2">
      <p className="mb-1 text-[11px] text-cyan-400/90">
        {formatAgentNote({
          model: comment.agentModel,
          durationMs: comment.agentDurationMs,
          costUsd: comment.agentCostUsd,
          startedAt: comment.agentStartedAt,
          finishedAt: comment.agentFinishedAt,
        })}
      </p>
      <AgentReplyBody
        segments={comment.agentSegments}
        fallbackText={comment.agentReply}
      />
      {exchanges.map((exchange) => (
        <AgentReplyThread key={exchange.id} exchange={exchange} />
      ))}
      {onAskAgentFollowUp && !hasPendingExchange && (
        <AgentFollowUpForm
          onSubmit={(question) => onAskAgentFollowUp(comment.id, question)}
        />
      )}
    </div>
  );
}

export function InlineComment({
  comment,
  onEdit,
  onDelete,
  onRetryAgent,
  onAskAgentFollowUp,
}: InlineCommentProps) {
  const [isEditing, setIsEditing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useScrollAnchorCompensation(rootRef);

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
      ref={rootRef}
      id={getCommentAnchorId(comment.id)}
      className="bg-gray-800 border border-gray-700 rounded-md p-3 mx-2 my-1 scroll-mt-24"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-gray-500 mb-1">
            {formatReviewCommentRange(comment)}
          </p>
          <p className="text-sm text-gray-200 whitespace-pre-wrap">
            {comment.body}
          </p>
          <AgentReplySection
            comment={comment}
            onRetryAgent={onRetryAgent}
            onAskAgentFollowUp={onAskAgentFollowUp}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
    </div>
  );
}
